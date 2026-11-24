import { z } from 'zod'
import { audit, conflict, forbidden, Fault, missing, newId, once, revision, seal, text, unseal, uuid,
  type Actor, type Config, type DB } from './core.js'
import type { Channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { interruptService,queueService } from './service-delivery.js'
import { handoffUntil } from './line-handoff.js'
import { requireFeature } from './store-features.js'

type Use='customer'|'recruitment'|'unclassified'
type Incoming={kind:string;messageId?:string;messageType?:string;body?:string;unsent?:string;when:Date}
type Thread={id:string;tenant_id:string;store_id:string;channel_id:string;purpose:Use;user_key:string;address_box:string;
  assigned_to:string|null;state:'open'|'handling'|'resolved';unread:boolean;last_received_at:Date;revision:number}
export const inboxEdit=z.strictObject({revision,state:z.enum(['open','handling','resolved']),assigned_to:uuid.nullable()})
export const inboxText=z.strictObject({revision,body:text(3500),internal:z.boolean()})
export const handoffInput=z.strictObject({
  revision, minutes:z.union([z.literal(15),z.literal(30),z.literal(60),z.literal(120)]).nullable(),
})
export const inboxClassify=z.strictObject({revision,purpose:z.enum(['customer','recruitment']),reason:text(200)})

export async function recordInboxEvent(db:DB,cfg:Config,c:Channel,key:string,user:string,event:Incoming,enabled:boolean){
  if(event.unsent){
    if(!enabled){
      await db.query('UPDATE inbox_message SET body_box=NULL,withdrawn=true WHERE channel_id=$1 AND remote_id=$2',[c.id,event.unsent])
      return
    }
    await db.query(`INSERT INTO inbox_message (id,tenant_id,store_id,channel_id,remote_id,kind,direction,happened_at,withdrawn)
      VALUES($1,$2,$3,$4,$5,'unsend','incoming',$6,true) ON CONFLICT(channel_id,remote_id)
      DO UPDATE SET body_box=NULL,withdrawn=true`,[newId(),c.tenant_id,c.store_id,c.id,event.unsent,event.when])
    return
  }
  if(!enabled||!event.messageId||!event.messageType)return
  const use=c.purpose==='shared'?'unclassified':c.purpose
  const existing=await db.query(`SELECT 1 FROM inbox_message WHERE channel_id=$1 AND remote_id=$2`,[c.id,event.messageId])
  if(existing.rowCount)return
  const threadId=newId()
  const {rows:[thread]}=await db.query<{id:string}>(`INSERT INTO inbox_thread
    (id,tenant_id,store_id,channel_id,purpose,user_key,address_box,last_received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(channel_id,purpose,user_key) DO UPDATE
    SET last_received_at=greatest(inbox_thread.last_received_at,excluded.last_received_at),unread=true,
      revision=inbox_thread.revision+1,state=CASE WHEN inbox_thread.state='resolved' THEN 'open' ELSE inbox_thread.state END
    RETURNING id`,[threadId,c.tenant_id,c.store_id,c.id,use,key,seal(cfg,'inbox-recipient:'+c.id+':'+key,user),event.when])
  const id=newId()
  await db.query(`INSERT INTO inbox_message (id,tenant_id,store_id,channel_id,thread_id,remote_id,kind,direction,body_box,happened_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'incoming',$8,$9) ON CONFLICT(channel_id,remote_id) DO NOTHING`,
  [id,c.tenant_id,c.store_id,c.id,thread.id,event.messageId,event.messageType,event.body?seal(cfg,'inbox-message:'+id,event.body.slice(0,5000)):null,event.when])
}

async function getThread(db:DB,id:string,use:Use){
  const {rows:[row]}=await db.query<Thread>('SELECT * FROM inbox_thread WHERE id=$1 AND purpose=$2',[id,use])
  if(!row)throw missing()
  return row
}

export async function inboxOverview(db:DB,store:string,use:Use,platformActor?:string){
  await requireFeature(db,store,'inbox_enabled')
  const {rows:threads}=await db.query(`SELECT t.id,t.state,t.unread,t.assigned_to,t.last_received_at,t.revision,ch.label,
    CASE WHEN $1='customer' THEN c.display_name END AS name,h.until_at AS handoff_until
    FROM inbox_thread t JOIN channel ch ON ch.id=t.channel_id
    LEFT JOIN customer c ON $1='customer' AND c.channel_id=t.channel_id AND c.user_key=t.user_key
    LEFT JOIN line_handoff h ON h.channel_id=t.channel_id AND h.user_key=t.user_key AND h.until_at>now()
    WHERE t.purpose=$1 AND t.last_received_at>=now()-interval '12 months'
    ORDER BY t.unread DESC,t.last_received_at DESC,t.id LIMIT 150`,[use])
  const {rows:staff}=await db.query(`SELECT f.id,CASE WHEN f.platform_actor THEN '全体管理者' ELSE f.email END AS email
    FROM staff f WHERE f.disabled_at IS NULL AND (f.password_hash IS NOT NULL OR f.platform_actor AND f.id=$3)
    AND (f.role='admin' OR (f.agency_staff AND f.role IN ('manager',CASE WHEN $1='recruitment' THEN 'recruiter' ELSE 'manager' END)
      AND EXISTS (SELECT 1 FROM store_grant g WHERE g.store_id=$2 AND g.staff_id=f.id))) ORDER BY f.email`,[use,store,platformActor ?? null])
  return {threads,staff}
}

export async function inboxMessages(db:DB,cfg:Config,store:string,use:Use,id:string){
  await requireFeature(db,store,'inbox_enabled')
  await getThread(db,id,use)
  const {rows}=await db.query<{id:string;body_box:string|null;withdrawn:boolean}>(`
    SELECT m.id,m.kind,m.direction,m.body_box,m.happened_at,m.withdrawn,d.status,CASE WHEN f.platform_actor THEN '全体管理者' ELSE f.email END AS staff
    FROM inbox_message m LEFT JOIN service_delivery d ON d.id=m.service_id LEFT JOIN staff f ON f.id=m.actor_id
    WHERE m.thread_id=$1 AND m.happened_at>=now()-interval '12 months' ORDER BY m.happened_at DESC,m.id LIMIT 100`,[id])
  return rows.reverse().map(({body_box,...message})=>({...message,
    body:body_box&&!message.withdrawn?unseal(cfg,'inbox-message:'+message.id,body_box):null}))
}

export async function changeThread(db:DB,actor:Actor,store:string,use:Use,id:string,data:z.infer<typeof inboxEdit>){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'inbox_enabled')
  const thread=await getThread(db,id,use)
  if(thread.revision!==data.revision)throw conflict()
  if(data.state==='handling' && await handoffUntil(db,thread.channel_id,thread.user_key)){
    throw new Fault(409,'MANUAL_HANDOFF','店長の対応を終了してから、担当を変更してください。')
  }
  if(actor.role==='recruiter'&&((thread.assigned_to&&thread.assigned_to!==actor.id)||(data.assigned_to&&data.assigned_to!==actor.id)))throw missing()
  if(data.assigned_to){
    const valid=await db.query(`SELECT 1 FROM staff f WHERE f.id=$1 AND f.disabled_at IS NULL
      AND (NOT f.platform_actor OR f.id=$4)
      AND (f.role='admin' OR (f.agency_staff AND f.role IN ('manager',CASE WHEN $3='recruitment' THEN 'recruiter' ELSE 'manager' END)
        AND EXISTS (SELECT 1 FROM store_grant g WHERE g.store_id=$2 AND g.staff_id=f.id)))`,[data.assigned_to,store,use,actor.platform?actor.id:null])
    if(!valid.rowCount)throw missing()
  }
  if(data.state!=='handling'||data.assigned_to!==thread.assigned_to){
    await interruptService(db,'object_id',id,'担当または対応状態が変更されました',['chat_reply'])
  }
  const {rows:[result]}=await db.query(`UPDATE inbox_thread SET state=$2,assigned_to=$3,unread=false,revision=revision+1
    WHERE id=$1 RETURNING revision`,[id,data.state,data.assigned_to])
  await audit(db,actor.tenant_id,store,actor.id,'inbox.assignment',id,null,{state:data.state,assigned_to:data.assigned_to})
  return result
}

export async function classifyThread(db:DB,actor:Actor,store:string,id:string,data:z.infer<typeof inboxClassify>){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'inbox_enabled')
  const thread=await getThread(db,id,'unclassified')
  if(thread.revision!==data.revision)throw conflict()
  const {rows:[target]}=await db.query<{id:string}>(`SELECT id FROM inbox_thread WHERE channel_id=$1 AND user_key=$2 AND purpose=$3`,
    [thread.channel_id,thread.user_key,data.purpose])
  if(target){
    await db.query('UPDATE inbox_message SET thread_id=$2 WHERE thread_id=$1',[id,target.id])
    await db.query("UPDATE inbox_thread SET state='resolved',unread=false,revision=revision+1 WHERE id=$1",[id])
    await db.query(`UPDATE inbox_thread SET unread=true,last_received_at=greatest(last_received_at,$2),revision=revision+1,
      state=CASE WHEN state='resolved' THEN 'open' ELSE state END WHERE id=$1`,[target.id,thread.last_received_at])
  }else await db.query("UPDATE inbox_thread SET purpose=$2,revision=revision+1 WHERE id=$1",[id,data.purpose])
  await audit(db,actor.tenant_id,store,actor.id,'inbox.classify',id,data.reason,{purpose:data.purpose})
  return {classified:true}
}

export async function changeHandoff(db:DB,actor:Actor,store:string,use:Use,id:string,data:z.infer<typeof handoffInput>){
  if(!['admin','manager'].includes(actor.role))throw forbidden()
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'inbox_enabled')
  const thread=await getThread(db,id,use)
  if(thread.revision!==data.revision)throw conflict()
  let until:Date|null=null
  if(data.minutes!==null){
    const {rows:[saved]}=await db.query<{until_at:Date}>(`INSERT INTO line_handoff (tenant_id,store_id,channel_id,user_key,until_at)
      VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5))
      ON CONFLICT(channel_id,user_key) DO UPDATE SET until_at=excluded.until_at RETURNING until_at`,
    [actor.tenant_id,store,thread.channel_id,thread.user_key,data.minutes])
    until=saved.until_at
    // Replies queued by the agency must not compete with the store manager.
    const {rows:threads}=await db.query<{id:string}>(`UPDATE inbox_thread
      SET state=CASE WHEN state='handling' THEN 'open' ELSE state END,revision=revision+1
      WHERE channel_id=$1 AND user_key=$2 RETURNING id`,[thread.channel_id,thread.user_key])
    for(const entry of threads)await interruptService(db,'object_id',entry.id,'店長へ引き継ぎ',['chat_reply'])
  }else{
    await db.query('DELETE FROM line_handoff WHERE channel_id=$1 AND user_key=$2',[thread.channel_id,thread.user_key])
    await db.query('UPDATE inbox_thread SET revision=revision+1 WHERE channel_id=$1 AND user_key=$2',[thread.channel_id,thread.user_key])
  }
  await audit(db,actor.tenant_id,store,actor.id,until?'inbox.handoff_started':'inbox.handoff_ended',id,null,{until})
  return {handoff_until:until}
}

export async function writeInbox(db:DB,cfg:Config,actor:Actor,store:string,use:Use,id:string,key:string,data:z.infer<typeof inboxText>){
  return once(db,cfg,actor,'inbox.write',key,{store,use,id,data},async()=>{
    await lockDispatch(db,actor.tenant_id)
    await requireFeature(db,store,'inbox_enabled')
    const thread=await getThread(db,id,use)
    if(thread.revision!==data.revision)throw conflict()
    if(use==='unclassified'||thread.assigned_to!==actor.id||thread.state!=='handling')throw missing()
    if(!data.internal && await handoffUntil(db,thread.channel_id,thread.user_key)){
      throw new Fault(409,'MANUAL_HANDOFF','店長が対応中です。返信はLINE公式アカウントアプリから行ってください。')
    }
    const message=newId()
    const expiry=new Date(Date.now()+15*60000)
    let job:string|undefined
    if(!data.internal){
      job=await queueService(db,cfg,{tenant_id:thread.tenant_id,store_id:thread.store_id,channel_id:thread.channel_id,
        purpose:use,subject:thread.id},{kind:'chat_reply',object:thread.id,revision:thread.revision+1,due:new Date(),expiry,body:data.body,actor:actor.id})
    }
    await db.query(`INSERT INTO inbox_message (id,tenant_id,store_id,channel_id,thread_id,service_id,actor_id,direction,kind,body_box,happened_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'text',$9,now())`,[message,thread.tenant_id,thread.store_id,thread.channel_id,thread.id,job??null,
    actor.id,data.internal?'internal':'outgoing',seal(cfg,'inbox-message:'+message,data.body)])
    await db.query('UPDATE inbox_thread SET revision=revision+1,unread=false WHERE id=$1',[id])
    await audit(db,actor.tenant_id,store,actor.id,data.internal?'inbox.note':'inbox.reply',id)
    return {id:message,status:data.internal?'saved':'queued',channel:job?thread.channel_id:undefined}
  })
}
