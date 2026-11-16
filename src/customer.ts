import type pg from 'pg'
import { z } from 'zod'
import { digest, Fault, audit, conflict, missing, newId, revision, route, scope, seal, text, token, tx,
  type Actor, type Config, type DB } from './core.js'
import { channel, LineAPI, userKey, type Channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { applyTagRules } from './customer-tags.js'
import { requireFeature } from './store-features.js'
import { recordSource } from './sources.js'
import { rememberContact } from './rich-menus.js'

export const consentVersion = 'customer-line-v1'
export const customerFields = 'id,channel_id,display_name,memo,assigned_to,verified_20_at,tags,active_chat,service_consent,marketing_consent,all_stop,marketing_stop,last_reply_at,verified_at,revision'
export type Customer = {
  id:string; tenant_id:string; store_id:string; channel_id:string; user_key:string; line_address:string
  display_name:string|null; assigned_to:string|null; verified_20_at:Date|null; tags:string[]
  active_chat:boolean; service_consent:boolean; marketing_consent:boolean; all_stop:boolean
  marketing_stop:boolean; last_reply_at:Date|null; preference_at:Date; revision:number
}
export const preferenceInput = z.strictObject({
  service_consent:z.boolean(),marketing_consent:z.boolean(),all_stop:z.boolean(),
}).refine(value=>!value.all_stop || (!value.service_consent && !value.marketing_consent))
export type Preferences = z.infer<typeof preferenceInput>
export const profileInput = z.strictObject({revision,display_name:z.string().trim().max(100),memo:z.string().max(1000),
  assigned_to:z.uuid().nullable(),verified20:z.boolean(),active_chat:z.boolean(),
  tags:z.array(text(80)).max(30).optional(),reason:text(200)})
export const lineCustomerLogin = z.strictObject({connection:z.uuid(),id_token:z.string().min(20).max(12000),source:z.uuid().optional()})
export const selfPreferenceInput = z.strictObject({preferences:preferenceInput,version:z.literal(consentVersion),revision})
const safeSession = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export async function customerById(db:DB,id:string) {
  const {rows:[customer]}=await db.query<Customer>('SELECT * FROM customer WHERE id=$1',[id])
  if (!customer) throw missing()
  return customer
}

export async function ensureCustomer(db:DB,cfg:Config,c:Channel,user:string,verified=false,existingKey?:string) {
  const key=existingKey??userKey(cfg,c,user)
  const {rows:[customer]}=await db.query<Customer>(`INSERT INTO customer
    (id,tenant_id,store_id,channel_id,user_key,line_address,verified_at)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() END)
    ON CONFLICT(channel_id,user_key) DO UPDATE SET verified_at=coalesce(customer.verified_at,excluded.verified_at)
    RETURNING *`,[newId(),c.tenant_id,c.store_id,c.id,key,seal(cfg,'customer:'+c.id+':'+key,user),verified])
  return customer
}

export async function emitDelivery(db:DB,customer:Customer,key:string,kind:string,time=new Date(),
  booking?:{id:string;revision:number}) {
  const emitted=await db.query(`INSERT INTO delivery_event
    (id,tenant_id,store_id,channel_id,customer_id,origin_key,kind,booking_id,booking_revision,happened_at,scope_version)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,concat_ws(':',t.delivery_version,s.delivery_version,c.delivery_version)
      FROM tenant t JOIN store s ON s.tenant_id=t.id JOIN channel c ON c.store_id=s.id
      WHERE t.id=$2 AND s.id=$3 AND c.id=$4 AND NOT (t.stopped OR s.stopped OR c.stopped)
    ON CONFLICT(channel_id,origin_key) DO NOTHING`,
    [newId(),customer.tenant_id,customer.store_id,customer.channel_id,customer.id,key,kind,booking?.id??null,booking?.revision??null,time])
  if (emitted.rowCount && ['follow','booking_created','visit'].includes(kind)) {
    await applyTagRules(db,customer.id,customer.store_id,kind,time)
  }
}

export async function endCustomerRuns(db:DB,customer:string,reason:string) {
  await db.query(`UPDATE enrollment SET ended_at=now(),end_reason=$2 WHERE customer_id=$1 AND ended_at IS NULL`,[customer,reason])
  await db.query(`UPDATE automatic_send SET next_at='infinity',reason=$2
    WHERE customer_id=$1 AND status IN ('unknown','submitting')`,[customer,reason])
}

async function preferenceEvidence(db:DB,c:Customer,p:Preferences,actor:string|null,
  source:string,at:Date,marketingStop:boolean,eventId=newId()) {
  await db.query(`INSERT INTO preference_event
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[eventId,c.tenant_id,c.store_id,c.id,actor,source,
    consentVersion,p.service_consent,p.marketing_consent,p.all_stop,marketingStop,at])
  return eventId
}

export async function setPreferences(db:DB,c:Customer,p:Preferences,expected:number) {
  const at=new Date()
  const updated = await db.query(`UPDATE customer SET service_consent=$2,marketing_consent=$3,all_stop=$4,
    marketing_stop=NOT $3,preference_at=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$6`,
    [c.id,p.service_consent,p.marketing_consent,p.all_stop,at,expected])
  if (!updated.rowCount) throw conflict()
  const id=await preferenceEvidence(db,c,p,null,'liff',at,!p.marketing_consent)
  if (p.all_stop || (!p.service_consent && c.service_consent) || (!p.marketing_consent && c.marketing_consent)) {
    await endCustomerRuns(db,c.id,'同意撤回または配信停止')
  }
  if (!p.all_stop && ((!c.service_consent&&p.service_consent)||(!c.marketing_consent&&p.marketing_consent))) {
    await emitDelivery(db,c,'consent:'+id,'consent',at)
  }
  return {saved:true}
}

export async function stopFromLine(db:DB,c:Customer,signal:string,eventAt:Date) {
  const p = {service_consent:signal==='all'?false:c.service_consent,marketing_consent:false,
    all_stop:c.all_stop || signal==='all'}
  const result=await db.query(`UPDATE customer SET service_consent=$2,marketing_consent=false,marketing_stop=true,
    all_stop=$3,preference_at=greatest(preference_at,$4),revision=revision+1,updated_at=now()
    WHERE id=$1 AND preference_at<=$4`,[c.id,p.service_consent,p.all_stop,eventAt])
  if (!result.rowCount) return
  await preferenceEvidence(db,c,p,null,'webhook',eventAt,true)
  await endCustomerRuns(db,c.id,'LINEから配信停止')
}

export async function updateProfile(db:DB,actor:Actor,id:string,p:z.infer<typeof profileInput>) {
  await lockDispatch(db,actor.tenant_id)
  const current=await customerById(db,id)
  const tags=p.tags===undefined?current.tags:[...new Set(p.tags)]
  const tagsChanged=tags.length!==current.tags.length || tags.some(tag=>!current.tags.includes(tag))
  if (tagsChanged) await requireFeature(db,current.store_id,'tags_enabled')
  if (p.assigned_to) {
    const {rowCount}=await db.query(`SELECT f.id FROM staff f WHERE f.id=$1 AND f.disabled_at IS NULL
      AND (f.role='admin' OR EXISTS(SELECT 1 FROM store_grant g WHERE g.staff_id=f.id AND g.store_id=scope_store()))`,
      [p.assigned_to])
    if (!rowCount) throw missing()
  }
  const result=await db.query(`UPDATE customer SET display_name=$2,memo=$3,assigned_to=$4,
    verified_20_at=CASE WHEN $5 THEN coalesce(verified_20_at,now()) END,
    active_chat=$6,tags=$7,revision=revision+1,updated_at=now()
    WHERE id=$1 AND revision=$8 RETURNING ${customerFields}`,
    [id,p.display_name||null,p.memo,p.assigned_to,p.verified20,p.active_chat,tags,p.revision])
  if (!result.rowCount) throw conflict()
  await audit(db,actor.tenant_id,current.store_id,
    actor.id,'customer.profile',id,p.reason,{verified20:p.verified20,active_chat:p.active_chat,tags_changed:tagsChanged})
  return result.rows[0]
}

export const customerSessionCookie=(cfg:Config,value:string)=>`night_customer=${value}; Path=/api/v1/customer/;
  HttpOnly; SameSite=Strict; Max-Age=1800`.replace(/\s+/g,' ')+(cfg.external?'; Secure':'')

export async function openCustomerSession(pool:pg.Pool,cfg:Config,line:LineAPI,input:unknown) {
  if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でLINE本人確認を行ってください。')
  const p=lineCustomerLogin.parse(input)
  const c=await tx(pool,async db=>{
    const r=await route(db,p.connection)
    await scope(db,r.tenant_id,r.store_id)
    const found=await channel(db,r.id)
    if (found.purpose==='recruitment'||!found.checks.provider_verified||!found.checks.login_published) throw missing()
    return found
  })
  const user=await line.verifyID(c.login_id,p.id_token)
  const raw=token()
  await tx(pool,async db=>{
    await scope(db,c.tenant_id,c.store_id)
    await lockDispatch(db,c.tenant_id)
    const current=await channel(db,c.id)
    if (current.generation!==c.generation || !current.checks.provider_verified || !current.checks.login_published) throw conflict()
    const record=await ensureCustomer(db,cfg,c,user,true)
    const identity={...record,purpose:'customer' as const,subject:record.id}
    await recordSource(db,identity,p.source)
    await rememberContact(db,cfg,current,user,identity)
    await db.query(`INSERT INTO customer_session(token_hash,tenant_id,store_id,channel_id,customer_id,generation,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,[digest(raw),record.tenant_id,record.store_id,c.id,record.id,c.generation])
    await db.query('DELETE FROM customer_session WHERE expires_at<now() AND channel_id=$1',[c.id])
  })
  return c.id+'.'+raw
}

export async function authenticateCustomer(db:DB,value:string|undefined) {
  const [channelId,raw,extra]=(value??'').split('.')
  const fault=new Fault(401,'CUSTOMER_SESSION','LINEの本人確認をもう一度行ってください。')
  if (extra!==undefined || !z.uuid().safeParse(channelId).success || !safeSession.safeParse(raw).success) throw fault
  const r=await route(db,channelId)
  await scope(db,r.tenant_id,r.store_id)
  await lockDispatch(db,r.tenant_id)
  const {rows:[record]}=await db.query<Customer>(`SELECT c.* FROM customer_session s JOIN customer c ON c.id=s.customer_id
    JOIN channel ch ON ch.id=s.channel_id AND ch.generation=s.generation
    WHERE s.token_hash=$1 AND s.channel_id=$2 AND s.expires_at>now()`,[digest(raw),channelId])
  if (!record) throw fault
  return record
}
