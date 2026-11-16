import type pg from 'pg'
import { newId, scope, seal, tx, unseal, type Config, type DB, type Route } from './core.js'
import { channel, channelCredentials, channelReady, type LineAPI } from './line.js'
import { deliveryScope, messageBudget } from './delivery-budget.js'
import { locationOf } from './automation.js'
import { lockDispatch } from './dispatch-lock.js'
import { storeFeatures } from './store-features.js'
import type { WorkflowSubject } from './forms.js'
import { contactAddress } from './rich-menus.js'

type Kind='interview_confirm'|'interview_reminder'|'interview_waitlist'|'chat_reply'
type Scheduled={kind:Kind;object:string;revision:number;due:Date;expiry:Date;body?:string;actor?:string}
type ServiceJob=WorkflowSubject & {id:string;kind:Kind;object_id:string;object_revision:number;body_box:string|null;
  actor_id:string|null;generation:number;scope_version:string;status:string;attempt:number;next_at:Date|number;expires_at:Date;
  first_attempt_at:Date|null}

export async function queueService(db:DB,cfg:Config,identity:WorkflowSubject,input:Scheduled){
  const c=await channel(db,identity.channel_id)
  const id=newId()
  const {rows:[saved]}=await db.query<{id:string}>(`INSERT INTO service_delivery
    (id,tenant_id,store_id,channel_id,purpose,subject,kind,object_id,object_revision,body_box,actor_id,generation,scope_version,next_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(channel_id,purpose,subject,kind,object_id,object_revision) DO NOTHING RETURNING id`,
  [id,identity.tenant_id,identity.store_id,identity.channel_id,identity.purpose,identity.subject,input.kind,input.object,input.revision,
    input.body===undefined?null:seal(cfg,'service:'+id,input.body),input.actor??null,c.generation,await deliveryScope(db,c.id),input.due,input.expiry])
  return saved?.id
}

export async function interruptService(db:DB,clause:'object_id'|'subject'|'channel_id',value:string,reason:string,kinds:Kind[]){
  await db.query(`UPDATE service_delivery SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    next_at='infinity',reason=$2 WHERE ${clause}=$1 AND kind=ANY($3)
    AND status IN ('queued','submitting','unknown')`,[value,reason,kinds])
}

async function messageFor(db:DB,cfg:Config,job:ServiceJob,timezone:string,liffId:string){
  if(job.kind==='chat_reply'){
    const {rows:[thread]}=await db.query<{address_box:string;user_key:string}>(`
      SELECT t.address_box,t.user_key FROM inbox_thread t JOIN staff f ON f.id=t.assigned_to
      WHERE t.id=$1 AND t.channel_id=$2 AND t.purpose=$3 AND t.state='handling' AND t.assigned_to=$4
        AND f.disabled_at IS NULL AND (f.role='admin' OR (f.role IN ('manager',CASE WHEN t.purpose='recruitment' THEN 'recruiter' ELSE 'manager' END)
          AND EXISTS (SELECT 1 FROM store_grant g WHERE g.store_id=t.store_id AND g.staff_id=f.id)))
        AND (t.last_received_at>now()-interval '7 days' OR EXISTS (
          SELECT 1 FROM channel_relationship r WHERE r.channel_id=t.channel_id AND r.user_key=t.user_key AND r.following))
        AND NOT coalesce((SELECT kind='unfollow' FROM webhook_event e WHERE e.channel_id=t.channel_id AND e.user_key=t.user_key
          AND kind IN ('follow','refollow','unfollow') ORDER BY occurred_at DESC,(kind='unfollow') DESC LIMIT 1),false)`,
    [job.object_id,job.channel_id,job.purpose,job.actor_id])
    if(!thread||!job.body_box)return
    return {to:unseal(cfg,'inbox-recipient:'+job.channel_id+':'+thread.user_key,thread.address_box),
      body:unseal(cfg,'service:'+job.id,job.body_box)}
  }
  const {rows:[contact]}=await db.query<{user_key:string;recipient_box:string;notices:boolean}>(`
    SELECT user_key,recipient_box,notices FROM workflow_contact WHERE channel_id=$1 AND purpose=$2 AND subject=$3`,
  [job.channel_id,job.purpose,job.subject])
  if(!contact?.notices)return
  const {rows:[activity]}=await db.query<{kind:string;stop:boolean}>(`SELECT
    (SELECT kind FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND kind IN ('follow','refollow','unfollow')
      ORDER BY occurred_at DESC,(kind='unfollow') DESC LIMIT 1) AS kind,
    EXISTS (SELECT 1 FROM webhook_event e WHERE e.channel_id=$1 AND e.user_key=$2 AND e.stop_signal='all' AND e.processed_at IS NULL
      AND e.occurred_at>=coalesce((SELECT notices_changed_at FROM workflow_contact WHERE channel_id=$1 AND purpose='recruitment' AND subject=$3),'-infinity')) AS stop`,
  [job.channel_id,contact.user_key,job.subject])
  if(!activity.kind||activity.kind==='unfollow'||activity.stop)return
  const to=contactAddress(cfg,{...job,recipient_box:contact.recipient_box})
  const link='https://liff.line.me/'+liffId+'?use=recruitment'
  if(job.kind==='interview_waitlist'){
    const slot=unseal(cfg,'service:'+job.id,job.body_box!)
    const {rowCount}=await db.query(`SELECT 1 FROM interview_waitlist w JOIN interview_slot s ON s.id=$3 AND s.channel_id=w.channel_id
      WHERE w.channel_id=$1 AND w.applicant_key=$2 AND w.until_at>=s.starts_at AND s.starts_at>now() AND w.method=s.method
      AND s.published AND NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.channel_id=w.channel_id AND b.status='confirmed'
        AND (b.slot_id=s.id OR (b.applicant_key=w.applicant_key AND EXISTS (SELECT 1 FROM interview_slot f WHERE f.id=b.slot_id AND f.starts_at>now()))))`,
    [job.channel_id,job.subject,slot])
    if(!rowCount)return
    return {to,body:'面談の受付枠に変更がありました。LINE内の面談予約画面で最新の空き状況をご確認ください。\n'+link}
  }
  const {rows:[booking]}=await db.query<{starts_at:Date;method:string;instructions:string}>(`SELECT s.starts_at,s.method,s.instructions
    FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
    WHERE b.id=$1 AND b.channel_id=$2 AND b.applicant_key=$3 AND b.revision=$4 AND b.status='confirmed' AND s.starts_at>now()`,
  [job.object_id,job.channel_id,job.subject,job.object_revision])
  if(!booking)return
  const at=new Intl.DateTimeFormat('ja-JP',{dateStyle:'long',timeStyle:'short',timeZone:timezone}).format(booking.starts_at)
  const prefix=job.kind==='interview_reminder'?'面談のリマインドです。':'面談予約が確定しました。'
  return {to,body:[prefix,at+'（'+(booking.method==='onsite'?'対面':'オンライン')+'）',booking.instructions,link].join('\n')}
}

export async function serviceHistory(db:DB,purpose:WorkflowSubject['purpose']){
  return (await db.query(`SELECT id,kind,status,next_at,first_attempt_at,accepted_at,line_request_id,reason
    FROM service_delivery WHERE purpose=$1 ORDER BY coalesce(first_attempt_at,least(next_at,expires_at)) DESC LIMIT 100`,[purpose])).rows
}

async function markStopped(db:DB,job:ServiceJob,reason:string){
  await db.query("UPDATE service_delivery SET status=$2,next_at='infinity',reason=$3 WHERE id=$1",
    [job.id,job.attempt>1?'unknown':'cancelled',reason])
}

export async function deliverService(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route){
  if(!cfg.external||!cfg.automation)return
  const locked=<T>(work:(db:DB)=>Promise<T>)=>tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    return work(db)
  })
  const claim=await locked(async db=>{
    const {rows:[pending]}=await db.query<ServiceJob>(`SELECT * FROM service_delivery
      WHERE channel_id=$1 AND status IN ('queued','submitting','unknown') AND next_at<=now()
      ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[r.id])
    if(!pending)return
    if(pending.attempt>=3||+pending.expires_at<=Date.now()||
      pending.first_attempt_at&&Date.now()-+pending.first_attempt_at>=30*60000){
      await db.query("UPDATE service_delivery SET status=$2,next_at='infinity',reason='配信期限切れ' WHERE id=$1",
        [pending.id,pending.attempt?'unknown':'cancelled'])
      return
    }
    const {rows:[job]}=await db.query<ServiceJob>(`UPDATE service_delivery SET status='submitting',
      attempt=attempt+1,first_attempt_at=coalesce(first_attempt_at,now()),next_at=now()+interval '45 seconds'
      WHERE id=$1 RETURNING *`,[pending.id])
    return {job,c:await channel(db,r.id)}
  })
  if(!claim)return
  const {job,c}=claim
  let quota:number|null=null
  try{quota=await api.quota(channelCredentials(cfg,c))}catch{/* LINE quota must be available before a send. */}
  const send=await locked(async db=>{
    const {rows:[fresh]}=await db.query<ServiceJob>('SELECT * FROM service_delivery WHERE id=$1 FOR UPDATE',[job.id])
    if(fresh.status!=='submitting'||fresh.attempt!==job.attempt)return
    const connection=await channel(db,r.id)
    const location=await locationOf(db,r.store_id)
    const features=await storeFeatures(db,r.store_id)
    const enabled=job.kind==='chat_reply'?features.inbox_enabled:
      job.kind==='interview_waitlist'?features.waitlist_enabled&&features.interviews_enabled:features.reminders_enabled
    const belongs=connection.purpose==='shared'||connection.purpose===job.purpose
    const ready=enabled&&belongs&&channelReady(connection)&&job.generation===connection.generation&&
      !connection.stopped&&!location.stopped&&!location.tenant_stopped&&location.contract_active&&!!location.eligible_at
    if(fresh.next_at===Infinity||+job.expires_at<=Date.now()||!ready||job.scope_version!==await deliveryScope(db,r.id)){
      await markStopped(db,fresh,'店舗設定・停止状態・認証が変更されました')
      return
    }
    const message=await messageFor(db,cfg,job,location.timezone,connection.liff_id)
    const hold=!message?'予約または通知の同意が変更されました':
      await messageBudget(db,location,null,undefined,job.id)||
      (quota===null?'LINEの通数を確認できません':quota<=0?'LINEの月間通数に達しました':null)
    if(!message||hold){await markStopped(db,fresh,hold??'通知対象外');return}
    return {promise:api.push(channelCredentials(cfg,connection),message.to,job.id,message.body)
      .catch(()=>({status:'unknown',requestId:null,authError:false}))}
  })
  if(!send)return
  const result=await send.promise
  await locked(async db=>{
    const status=job.attempt>1&&result.status==='failed'?'unknown':result.status
    await db.query(`UPDATE service_delivery SET status=$3,line_request_id=$4,
      accepted_at=CASE WHEN $3='accepted' THEN now() ELSE accepted_at END,
      next_at=CASE WHEN $3='unknown' AND $6 AND attempt<3 AND next_at<>'infinity' THEN now()+interval '1 minute' ELSE 'infinity' END,
      reason=coalesce(reason,$5) WHERE id=$1 AND attempt=$2 AND status='submitting'`,
    [job.id,job.attempt,status,result.requestId,status==='failed'?'LINEが送信要求を拒否':null,result.status==='unknown'])
  })
}
