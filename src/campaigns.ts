import type pg from 'pg'
import { z } from 'zod'
import { localInstant, localPart, nextWindow } from '../public/studio/engine.mjs'
import { audit, conflict, Fault, missing, newId, once, scope, seal, text, tx, unseal, uuid,
  type Actor, type Config, type DB, type Route } from './core.js'
import { channel, channelCredentials, channelReady, type LineAPI } from './line.js'
import { requireFeature, storeFeatures } from './store-features.js'
import { lockDispatch } from './dispatch-lock.js'
import { isEnabled, locationOf } from './automation.js'
import { deliveryScope, messageBudget } from './delivery-budget.js'

const clock=z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
const criteriaSchema=z.strictObject({
  tags:z.array(text(80)).max(30),match:z.enum(['all','any']),
  last_visit_days:z.int().min(1).max(365).nullable(),assigned_to:uuid.nullable(),
  windowStart:clock,windowEnd:clock,
}).refine(entry=>entry.windowStart!==entry.windowEnd)
export const campaignInput=z.strictObject({channel:uuid,title:text(100),body:text(3500),
  scheduled_at:z.iso.datetime({offset:true}),criteria:criteriaSchema})
export const approvalInput=z.strictObject({recipients:z.int().nonnegative(),approved:z.boolean()})
type Criteria=z.infer<typeof criteriaSchema>
type Campaign={id:string;channel_id:string;title:string;criteria:Criteria;exclusions:Record<string,number>;scheduled_at:Date;
  generation:number;scope_version:string;state:'draft'|'approved'|'stopped';body_box:string}
const frequency={daily:1,weekly:3}
const day=86400000
function campaignWindow(at:number,criteria:Criteria,timezone:string){
  if(criteria.windowStart<criteria.windowEnd)return nextWindow(at,{...criteria,holidays:[]},timezone)
  const local=localPart(at,timezone)
  if(local.time>=criteria.windowStart||local.time<criteria.windowEnd)return at
  return localInstant(local.date+'T'+criteria.windowStart,timezone)
}

async function target(db:DB,channelId:string,filter:Criteria,customer?:string){
  const {rows}=await db.query<{id:string;reason:string|null;address:string;user_key:string}>(`SELECT c.id,c.user_key,c.line_address AS address,
    CASE WHEN c.all_stop OR c.marketing_stop OR NOT c.marketing_consent THEN '販促同意なし・配信停止'
      WHEN c.verified_20_at IS NULL THEN '20歳以上の確認なし'
      WHEN c.active_chat OR EXISTS (SELECT 1 FROM inbox_thread x JOIN store s ON s.id=x.store_id WHERE
        x.channel_id=c.channel_id AND x.user_key=c.user_key AND x.purpose='customer' AND x.state='handling' AND s.inbox_enabled) THEN '有人対応中'
      WHEN (SELECT e.kind FROM webhook_event e WHERE e.channel_id=c.channel_id AND e.user_key=c.user_key
        AND e.kind IN ('follow','refollow','unfollow') AND e.occurred_at<=now()
        ORDER BY e.occurred_at DESC,(e.kind='unfollow') DESC LIMIT 1) NOT IN ('follow','refollow')
        OR NOT EXISTS (SELECT 1 FROM channel_relationship r WHERE r.channel_id=c.channel_id AND r.user_key=c.user_key AND r.following)
        THEN '友だち状態を確認できない'
      WHEN EXISTS (SELECT 1 FROM webhook_event e WHERE e.channel_id=c.channel_id AND e.user_key=c.user_key
        AND e.stop_signal IS NOT NULL AND e.processed_at IS NULL AND e.occurred_at>=c.preference_at) THEN '停止依頼を受信'
    END AS reason FROM customer c WHERE c.channel_id=$1 AND ($2::uuid IS NULL OR c.id=$2)
      AND (cardinality($3::text[])=0 OR CASE WHEN $4='all' THEN c.tags @> $3 ELSE c.tags && $3 END)
      AND ($5::uuid IS NULL OR c.assigned_to=$5)
      AND ($6::int IS NULL OR (SELECT max(s.starts_at) FROM visit_booking b JOIN booking_slot s ON s.id=b.slot_id
        WHERE b.customer_id=c.id AND b.status='visited')<=now()-make_interval(days=>$6))`,
  [channelId,customer??null,filter.tags,filter.match,filter.assigned_to,filter.last_visit_days])
  return rows
}

async function findCampaign(db:DB,id:string){
  const {rows:[campaign]}=await db.query<Campaign>('SELECT * FROM campaign WHERE id=$1',[id])
  if(!campaign)throw missing()
  return campaign
}

export async function campaignOverview(db:DB,cfg:Config,store:string){
  await requireFeature(db,store,'campaigns_enabled')
  const {rows:channels}=await db.query(`SELECT id,label FROM channel WHERE purpose<>'recruitment' ORDER BY label,id`)
  const {rows:filters}=await db.query(`SELECT name,tags,match_mode AS match FROM customer_tag_filter
    WHERE EXISTS (SELECT 1 FROM store WHERE id=$1 AND tags_enabled) ORDER BY name`,[store])
  const {rows:entries}=await db.query<Campaign & {counts:Record<string,number>;channel_label:string}>(`
    SELECT a.*,c.label AS channel_label,coalesce(result.counts,'{}'::jsonb) AS counts FROM campaign a JOIN channel c ON c.id=a.channel_id
    LEFT JOIN LATERAL (SELECT jsonb_object_agg(status,n) AS counts FROM
      (SELECT status,count(*)::int AS n FROM campaign_delivery WHERE campaign_id=a.id GROUP BY status) stats) result ON true
    ORDER BY a.created_at DESC,a.id LIMIT 60`)
  return {channels,filters,entries:entries.map(({body_box,...entry})=>({...entry,body:unseal(cfg,'campaign:'+entry.id,body_box)}))}
}

export async function prepareCampaign(db:DB,cfg:Config,actor:Actor,store:string,key:string,data:z.infer<typeof campaignInput>){
  return once(db,cfg,actor,'campaign.prepare',key,{store,data},async()=>{
    await lockDispatch(db,actor.tenant_id)
    await requireFeature(db,store,'campaigns_enabled')
    if(data.criteria.tags.length)await requireFeature(db,store,'tags_enabled')
    const c=await channel(db,data.channel)
    if(c.purpose==='recruitment'||c.store_id!==store)throw missing()
    const time=Date.parse(data.scheduled_at)
    if(time<Date.now()-60000||time>Date.now()+30*day)throw new Fault(422,'CAMPAIGN_DATE','配信予定は現在から30日以内で指定してください。')
    const recipients=await target(db,c.id,data.criteria)
    const exclusions:Record<string,number>={}
    const eligible=[]
    for(const recipient of recipients){
      if(recipient.reason)exclusions[recipient.reason]=(exclusions[recipient.reason]??0)+1
      else eligible.push(recipient.id)
    }
    const id=newId()
    await db.query(`INSERT INTO campaign (id,tenant_id,store_id,channel_id,title,body_box,criteria,exclusions,created_by,
      scheduled_at,generation,scope_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id,c.tenant_id,store,c.id,data.title,seal(cfg,'campaign:'+id,data.body),data.criteria,exclusions,actor.id,data.scheduled_at,c.generation,
      await deliveryScope(db,c.id)])
    await db.query(`INSERT INTO campaign_delivery (id,tenant_id,store_id,channel_id,campaign_id,customer_id,next_at)
      SELECT gen_random_uuid(),$1,$2,$3,$4,recipient,$5 FROM unnest($6::uuid[]) AS recipient`,
    [c.tenant_id,store,c.id,id,data.scheduled_at,eligible])
    await audit(db,c.tenant_id,store,actor.id,'campaign.prepare',id,null,{eligible:eligible.length,exclusions})
    return {id,eligible:eligible.length,exclusions}
  })
}

export async function approveCampaign(db:DB,cfg:Config,actor:Actor,store:string,id:string,data:z.infer<typeof approvalInput>){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'campaigns_enabled')
  const draft=await findCampaign(db,id)
  if(draft.state!=='draft'||draft.scheduled_at.getTime()+day<=Date.now()||!data.approved)throw conflict()
  if(draft.criteria.tags.length)await requireFeature(db,store,'tags_enabled')
  const c=await channel(db,draft.channel_id)
  const location=await locationOf(db,store)
  if(!isEnabled(cfg,location,c)||!channelReady(c)||draft.generation!==c.generation||draft.scope_version!==await deliveryScope(db,c.id)){
    throw new Fault(409,'CAMPAIGN_NOT_READY','店舗の自動配信・契約・LINE接続を確認し、送信対象を作り直してください。')
  }
  const {rows:[count]}=await db.query<{n:number}>(`SELECT count(*)::int AS n FROM campaign_delivery WHERE campaign_id=$1 AND status='queued'`,[id])
  if(!count.n||count.n!==data.recipients)throw conflict()
  await db.query(`UPDATE campaign SET state='approved',approved_by=$2,approved_at=now() WHERE id=$1`,[id,actor.id])
  await audit(db,actor.tenant_id,store,actor.id,'campaign.approve',id,null,{recipients:count.n})
  return {approved:true}
}

export async function stopCampaign(db:DB,actor:Actor,store:string,id:string){
  await lockDispatch(db,actor.tenant_id)
  await findCampaign(db,id)
  await db.query("UPDATE campaign SET state='stopped' WHERE id=$1",[id])
  await db.query(`UPDATE campaign_delivery SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    reason='管理者が配信を停止',next_at='infinity' WHERE campaign_id=$1 AND status IN ('queued','submitting','unknown')`,[id])
  await audit(db,actor.tenant_id,store,actor.id,'campaign.stop',id)
  return {stopped:true}
}

type Job={id:string;campaign_id:string;customer_id:string;attempt:number;status:string;next_at:Date|number}
export async function deliverCampaign(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route){
  if(!cfg.external||!cfg.automation)return
  const locked=<T>(work:(db:DB)=>Promise<T>)=>tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    return work(db)
  })
  const claimed=await locked(async db=>{
    if(!(await storeFeatures(db,r.store_id)).campaigns_enabled)return
    const {rows:[job]}=await db.query<Job>(`SELECT d.* FROM campaign_delivery d JOIN campaign a ON a.id=d.campaign_id
      WHERE d.channel_id=$1 AND a.state='approved' AND d.status IN ('queued','submitting','unknown') AND d.next_at<=now()
      ORDER BY d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,[r.id])
    if(!job)return
    const draft=await findCampaign(db,job.campaign_id)
    const c=await channel(db,r.id)
    const location=await locationOf(db,r.store_id)
    const next=campaignWindow(Date.now(),draft.criteria,location.timezone)
    const expiry=draft.scheduled_at.getTime()+day
    if(next!==null&&next> Date.now()&&next<expiry){
      await db.query('UPDATE campaign_delivery SET next_at=$2 WHERE id=$1',[job.id,new Date(next)])
      return
    }
    const unavailable=next===null||next>=expiry||Date.now()>=expiry||job.attempt>=3||
      !isEnabled(cfg,location,c)||!channelReady(c)||draft.generation!==c.generation||draft.scope_version!==await deliveryScope(db,c.id)
    if(unavailable){
      await db.query("UPDATE campaign_delivery SET status=$2,reason='停止・期限切れ・接続条件の変更',next_at='infinity' WHERE id=$1",
        [job.id,job.attempt?'unknown':'cancelled'])
      return
    }
    const budget=await messageBudget(db,location,job.customer_id,frequency,job.id)
    if(budget){
      await db.query("UPDATE campaign_delivery SET status=$2,reason=$3,next_at='infinity' WHERE id=$1",
        [job.id,job.attempt?'unknown':'cancelled',budget])
      return
    }
    const {rows:[fresh]}=await db.query<Job>(`UPDATE campaign_delivery SET status='submitting',attempt=attempt+1,
      first_attempt_at=coalesce(first_attempt_at,now()),next_at=now()+interval '45 seconds' WHERE id=$1 RETURNING *`,[job.id])
    return {job:fresh,c}
  })
  if(!claimed)return
  const {job,c}=claimed
  let quota:number|null=null
  try{quota=await api.quota(channelCredentials(cfg,c))}catch{/* Confirm LINE quota before sending. */}
  const sending=await locked(async db=>{
    const {rows:[fresh]}=await db.query<Job>('SELECT * FROM campaign_delivery WHERE id=$1 FOR UPDATE',[job.id])
    if(fresh.status!=='submitting'||fresh.attempt!==job.attempt)return
    const draft=await findCampaign(db,job.campaign_id)
    const connection=await channel(db,r.id)
    const location=await locationOf(db,r.store_id)
    const features=await storeFeatures(db,r.store_id)
    const [recipient]=await target(db,r.id,draft.criteria,job.customer_id)
    const now=Date.now()
    const reason=fresh.next_at===Infinity||draft.state!=='approved'||!features.campaigns_enabled||
      draft.criteria.tags.length&&!features.tags_enabled||draft.generation!==connection.generation||
      draft.scope_version!==await deliveryScope(db,connection.id)||!isEnabled(cfg,location,connection)||!channelReady(connection)
      ?'店舗設定・停止状態・認証が変更されました'
      :now>=draft.scheduled_at.getTime()+day||campaignWindow(now,draft.criteria,location.timezone)!==now?'配信期限または配信時間外'
      :!recipient?'絞り込み条件の対象外':recipient.reason||await messageBudget(db,location,job.customer_id,frequency,job.id)||
        (quota===null?'LINEの通数を確認できません':quota<=0?'LINEの月間通数に達しました':null)
    if(reason){
      await db.query("UPDATE campaign_delivery SET status=$2,reason=$3,next_at='infinity' WHERE id=$1",
        [job.id,job.attempt===1?'cancelled':'unknown',reason])
      return
    }
    const to=unseal(cfg,'customer:'+connection.id+':'+recipient.user_key,recipient.address)
    return {promise:api.push(channelCredentials(cfg,connection),to,job.id,unseal(cfg,'campaign:'+draft.id,draft.body_box))
      .catch(()=>({status:'unknown',requestId:null,authError:false}))}
  })
  if(!sending)return
  const result=await sending.promise
  await locked(async db=>{
    const status=job.attempt>1&&result.status==='failed'?'unknown':result.status
    await db.query(`UPDATE campaign_delivery SET status=$3,line_request_id=$4,
      accepted_at=CASE WHEN $3='accepted' THEN now() ELSE accepted_at END,
      next_at=CASE WHEN $3='unknown' AND $6 AND attempt<3 AND next_at<>'infinity' THEN now()+interval '1 minute' ELSE 'infinity' END,
      reason=coalesce(reason,$5) WHERE id=$1 AND attempt=$2 AND status='submitting'`,
    [job.id,job.attempt,status,result.requestId,status==='failed'?'LINEが送信要求を拒否':null,result.status==='unknown'])
  })
}
