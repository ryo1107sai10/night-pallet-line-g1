import type pg from 'pg'
import { z } from 'zod'
import { audit, conflict, Fault, missing, scope, seal, tx, unseal, uuid, type Actor, type Config, type DB, type Route } from './core.js'
import { channel, channelCredentials, channelReady, userKey, type Channel, type LineAPI } from './line.js'
import type { WorkflowSubject } from './forms.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature,storeFeatures } from './store-features.js'

const richMenuId=z.string().regex(/^richmenu-[0-9a-f]{32}$/i)
export const menuInput=z.strictObject({channel:uuid,revision:z.int().nonnegative(),base_menu:richMenuId.nullable(),booked_menu:richMenuId.nullable()})
type MenuInput=z.infer<typeof menuInput>
const contactContext=(channelId:string,purpose:string,subject:string)=>['workflow-contact',channelId,purpose,subject].join(':')

export function contactAddress(cfg:Config,row:{channel_id:string;purpose:string;subject:string;recipient_box:string}){
  return unseal(cfg,contactContext(row.channel_id,row.purpose,row.subject),row.recipient_box)
}

export async function rememberContact(db:DB,cfg:Config,c:Channel,user:string,identity:WorkflowSubject){
  const features=await storeFeatures(db,c.store_id)
  if(!features.rich_menus_enabled&&!features.reminders_enabled&&!features.waitlist_enabled
    &&!features.token_interviews_enabled&&!features.token_customers_enabled)return
  const contact=seal(cfg,contactContext(c.id,identity.purpose,identity.subject),user)
  await db.query(`INSERT INTO workflow_contact (tenant_id,store_id,channel_id,purpose,subject,user_key,recipient_box,last_seen_at,menu_due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),CASE WHEN $8 THEN now() END)
    ON CONFLICT(channel_id,purpose,subject) DO UPDATE SET last_seen_at=excluded.last_seen_at,
      recipient_box=excluded.recipient_box,menu_due_at=excluded.menu_due_at`,
  [c.tenant_id,c.store_id,c.id,identity.purpose,identity.subject,userKey(cfg,c,user),contact,features.rich_menus_enabled])
}

export async function refreshMenu(db:DB,identity:WorkflowSubject){
  await db.query(`UPDATE workflow_contact w SET menu_due_at=now()
    WHERE w.channel_id=$1 AND w.purpose=$2 AND w.subject=$3
      AND EXISTS (SELECT 1 FROM store WHERE id=w.store_id AND rich_menus_enabled)`,
  [identity.channel_id,identity.purpose,identity.subject])
}

export async function listMenus(db:DB,store:string,use:WorkflowSubject['purpose']){
  await requireFeature(db,store,'rich_menus_enabled')
  const {rows:entries}=await db.query(`SELECT c.id,c.label,m.base_menu,m.booked_menu,
    coalesce(m.revision,0) AS revision,m.generation=c.generation AS verified,
    (SELECT count(*)::int FROM workflow_contact w WHERE w.channel_id=c.id AND w.purpose=$1 AND w.menu_status='切替済') AS linked
    FROM channel c LEFT JOIN workflow_menu m ON m.channel_id=c.id AND m.purpose=$1
    WHERE c.purpose IN ($1,'shared') ORDER BY c.label,c.id`,[use])
  return entries
}

export async function validateMenus(db:DB,cfg:Config,api:LineAPI,store:string,use:WorkflowSubject['purpose'],data:MenuInput){
  await requireFeature(db,store,'rich_menus_enabled')
  const c=await channel(db,data.channel)
  if(c.store_id!==store||!['shared',use].includes(c.purpose))throw missing()
  if(!cfg.external||!c.checks.token_verified)throw new Fault(409,'MENU_NOT_READY','公開HTTPS環境で公式LINEのトークンを照合してください。')
  const menus=[...new Set([data.base_menu,data.booked_menu].filter(id=>id!==null))]
  if(menus.length){
    const verified=await Promise.all(menus.map(id=>api.richMenuExists(channelCredentials(cfg,c),id)))
    if(verified.includes(false))throw new Fault(422,'MENU_NOT_FOUND','指定したリッチメニューをこの公式LINEで確認できません。')
  }
  return c.generation
}

export async function saveMenus(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'],data:MenuInput,generation:number){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'rich_menus_enabled')
  const c=await channel(db,data.channel)
  if(c.generation!==generation)throw conflict()
  const result=data.revision===0
    ? await db.query(`INSERT INTO workflow_menu (base_menu,booked_menu,generation,channel_id,purpose,tenant_id,store_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(channel_id,purpose) DO NOTHING RETURNING revision`,
      [data.base_menu,data.booked_menu,generation,c.id,use,actor.tenant_id,store])
    : await db.query(`UPDATE workflow_menu SET base_menu=$1,booked_menu=$2,generation=$3,revision=revision+1
      WHERE channel_id=$4 AND purpose=$5 AND revision=$6 RETURNING revision`,[data.base_menu,data.booked_menu,generation,c.id,use,data.revision])
  if(!result.rowCount)throw conflict()
  await db.query('UPDATE workflow_contact SET menu_due_at=now() WHERE channel_id=$1 AND purpose=$2',[c.id,use])
  await audit(db,actor.tenant_id,store,actor.id,'line.rich_menu.save',c.id,null,{purpose:use})
  return result.rows[0]
}

type Contact={channel_id:string;subject:string;purpose:WorkflowSubject['purpose'];recipient_box:string;user_key:string;
  base_menu:string|null;booked_menu:string|null;generation:number}
export async function updateRichMenu(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route){
  if(!cfg.external||!cfg.automation)return
  await tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    if(!(await storeFeatures(db,r.store_id)).rich_menus_enabled)return
    const c=await channel(db,r.id)
    const {rows:[state]}=await db.query(`SELECT s.stopped OR t.stopped AS stopped
      FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[r.store_id])
    if(c.stopped||state.stopped||!channelReady(c))return
    const {rows:[w]}=await db.query<Contact>(`SELECT w.*,m.base_menu,m.booked_menu,m.generation FROM workflow_contact w
      JOIN workflow_menu m ON m.channel_id=w.channel_id AND m.purpose=w.purpose AND m.generation=$2
      WHERE w.channel_id=$1 AND w.menu_due_at<=now()
        AND NOT EXISTS (SELECT 1 FROM workflow_contact newer WHERE newer.channel_id=w.channel_id
          AND newer.user_key=w.user_key AND newer.last_seen_at>w.last_seen_at)
      ORDER BY w.menu_due_at LIMIT 1 FOR UPDATE OF w`,[r.id,c.generation])
    if(!w)return
    const {rows:[booked]}=await (w.purpose==='customer'
      ? db.query(`SELECT s.starts_at FROM visit_booking b JOIN booking_slot s ON s.id=b.slot_id
        WHERE b.customer_id=$1 AND b.status='confirmed' AND s.starts_at>now() ORDER BY s.starts_at LIMIT 1`,[w.subject])
      : db.query(`SELECT s.starts_at FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
        WHERE b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed' AND s.starts_at>now() ORDER BY s.starts_at LIMIT 1`,[r.id,w.subject]))
    const menu=booked?w.booked_menu??w.base_menu:w.base_menu
    const result=await api.bindRichMenu(channelCredentials(cfg,c),contactAddress(cfg,w),menu)
      .catch(()=>({ok:false,retry:true}))
    await db.query(`UPDATE workflow_contact SET menu_status=$4,
      menu_due_at=CASE WHEN $5 THEN now()+interval '5 minutes' ELSE $6 END WHERE channel_id=$1 AND purpose=$2 AND subject=$3`,
    [r.id,w.purpose,w.subject,result.ok?'切替済':result.retry?'再試行待ち':'LINEで切り替えできませんでした',result.retry,
      result.ok?booked?.starts_at??null:null])
  })
}
