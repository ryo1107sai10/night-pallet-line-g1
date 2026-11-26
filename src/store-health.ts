import {audit,automationForStore,conflict,digest,Fault,forbidden,missing,scope,type Actor,type Config,type DB} from './core.js'
import {channel,channelCredentials,connectionProgress,type LineAPI} from './line.js'
import {googleBusy,type InterviewGoogle} from './interview-availability.js'
import {platformPrincipal,supervisedTenantIds} from './platform.js'
import {deliveryNeedsAttention} from './service-delivery.js'
import {z} from 'zod'

export const acceptanceInput=z.strictObject({fingerprint:z.string().regex(/^[0-9a-f]{64}$/),received:z.literal(true),application:z.literal(true),booking:z.literal(true),overlap:z.literal(true),notification:z.literal(true)})
type State='ready'|'action'|'off'|'warning'
type Check={id:string;label:string;state:State;detail:string;destination:string;required:boolean}
type ChannelRow={id:string;label:string;basic_id:string|null;stopped:boolean;revision:number;generation:number;purpose:string}
type Probe={fingerprint:string;line_status:'ok'|'issue'|'not_set'|'partial';calendar_status:'ok'|'issue'|'not_set'|'off';checked_at:Date}
type HealthRow={id:string;name:string;tenant_name:string;revision:number;tenant_revision:number;stopped:boolean;
 auto_enabled:boolean;contract_active:boolean;eligible:boolean;auto_started:boolean;forms_enabled:boolean;recruitment_enabled:boolean;
 interviews_enabled:boolean;google_calendar_enabled:boolean;token_interviews_enabled:boolean;reminders_enabled:boolean;
 channels:ChannelRow[];forms:number;scenarios:number;drafts:number;intakes:number;slots:number;failures:number;overdue:number;
 calendar:string|null;published_fingerprint:unknown;probe:Probe|null;acceptance:{fingerprint:string;checked_at:Date}|null;last_received:Date|null}
export type HealthView={tenant:string;company:string;id:string;name:string;checks:Check[];progress:{done:number;total:number};ready:boolean;
 acceptance_ready:boolean;fingerprint:string;accepted_at:Date|null;probe_at:Date|null;probe_current:boolean;last_received:Date|null;channels:ChannelRow[]}
const check=(id:string,label:string,state:State,detail:string,destination:string,required=true):Check=>({id,label,state,detail,destination,required})

async function healthRows(db:DB,tenant:string,only:string){
 // Several reservation and form tables intentionally require exact store scope.
 // Never loosen their RLS just to produce an aggregate dashboard.
 await scope(db,tenant,only)
 const {rows}=await db.query<HealthRow>(`SELECT s.id,s.name,t.legal_name AS tenant_name,s.revision,t.revision AS tenant_revision,
 (s.stopped OR t.stopped) AS stopped,s.auto_enabled,s.contract_active,s.eligible_at IS NOT NULL AS eligible,s.auto_enabled_at IS NOT NULL AS auto_started,
 s.forms_enabled,s.recruitment_enabled,s.interviews_enabled,s.google_calendar_enabled,s.token_interviews_enabled,s.reminders_enabled,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'basic_id',c.basic_id,'stopped',c.stopped,'revision',c.revision,'generation',c.generation,'purpose',c.purpose) ORDER BY c.id)
   FROM channel c WHERE c.store_id=s.id AND c.purpose IN ('recruitment','shared')),'[]') AS channels,
 (SELECT count(*)::int FROM workflow_form f JOIN channel c ON c.id=f.channel_id WHERE f.store_id=s.id AND f.purpose='recruitment' AND f.published AND NOT c.stopped) AS forms,
 (SELECT count(*)::int FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version
   JOIN channel c ON c.id=q.channel_id WHERE q.store_id=s.id AND NOT q.stopped AND NOT c.stopped AND v.graph->>'purpose'='recruitment') AS scenarios,
 (SELECT count(*)::int FROM scenario q WHERE q.store_id=s.id AND q.graph->>'purpose'='recruitment' AND q.published_version IS NULL) +
 (SELECT count(*)::int FROM recruitment_intake i WHERE i.store_id=s.id AND i.live IS NULL) AS drafts,
 (SELECT count(*)::int FROM recruitment_intake i JOIN channel c ON c.id=i.channel_id WHERE i.store_id=s.id AND i.live IS NOT NULL AND NOT c.stopped) AS intakes,
 (SELECT count(*)::int FROM interview_slot f JOIN channel c ON c.id=f.channel_id WHERE f.store_id=s.id AND f.method='onsite' AND f.published AND f.starts_at>now() AND NOT c.stopped
   AND NOT EXISTS(SELECT 1 FROM interview_booking b WHERE b.slot_id=f.id AND b.status='confirmed')
   AND NOT EXISTS(SELECT 1 FROM interview_block b WHERE b.store_id=s.id AND b.starts_at<f.ends_at AND b.ends_at>f.starts_at)) AS slots,
 (SELECT count(*)::int FROM service_delivery d WHERE d.store_id=s.id AND d.purpose='recruitment' AND d.first_attempt_at>=now()-interval '7 days' AND ${deliveryNeedsAttention}) +
 (SELECT count(*)::int FROM applicant_send a WHERE a.store_id=s.id AND a.first_attempt_at>=now()-interval '7 days' AND a.status IN ('failed','unknown')) AS failures,
 (SELECT count(*)::int FROM service_delivery d WHERE d.store_id=s.id AND d.purpose='recruitment' AND d.status IN ('queued','submitting') AND d.next_at<now()-interval '3 minutes' AND d.expires_at>now()) AS overdue,
 coalesce((SELECT calendar_id FROM interview_shared_calendar WHERE store_id=s.id),(SELECT calendar_id FROM interview_google_calendar WHERE store_id=s.id)) AS calendar,
 jsonb_build_array(s.interview_hours_revision,
   (SELECT jsonb_agg(jsonb_build_array(f.id,f.revision) ORDER BY f.id) FROM workflow_form f WHERE f.store_id=s.id AND f.purpose='recruitment' AND f.published),
   (SELECT jsonb_agg(jsonb_build_array(q.id,q.published_version,q.stopped) ORDER BY q.id) FROM scenario q WHERE q.store_id=s.id AND q.graph->>'purpose'='recruitment' AND q.published_version IS NOT NULL),
   (SELECT jsonb_agg(jsonb_build_array(i.channel_id,i.live_revision) ORDER BY i.channel_id) FROM recruitment_intake i WHERE i.store_id=s.id AND i.live IS NOT NULL),
   (SELECT linked_at FROM interview_shared_calendar WHERE store_id=s.id),
   (SELECT md5(refresh_box) FROM interview_google_calendar WHERE store_id=s.id)
 ) AS published_fingerprint,
 (SELECT to_jsonb(h) FROM store_health_check h WHERE h.store_id=s.id) AS probe,
 (SELECT jsonb_build_object('fingerprint',a.fingerprint,'checked_at',a.checked_at) FROM store_acceptance a WHERE a.store_id=s.id) AS acceptance,
 (SELECT max(e.received_at) FROM webhook_event e WHERE e.store_id=s.id) AS last_received
 FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.id=$2) ORDER BY s.name,s.id`,[tenant,only??null])
 return rows
}
function makeView(cfg:Config,google:InterviewGoogle,tenant:string,r:HealthRow,verified:Map<string,boolean>):HealthView{
 const fingerprint=digest(JSON.stringify([tenant,r.id,r.revision,r.tenant_revision,r.channels.map(c=>[c.id,c.revision,c.generation,c.stopped,verified.get(c.id)===true]),r.calendar??google.sharedCalendar(r.id)??null,r.published_fingerprint]))
 const probe=r.probe?.fingerprint===fingerprint?r.probe:null
 const probeCurrent=!!probe&&Date.now()-new Date(probe.checked_at).getTime()<86400000
 const linked=!!(r.calendar||google.sharedCalendar(r.id))
 const active=r.channels.filter(c=>!c.stopped),connected=active.filter(c=>verified.get(c.id))
 const lineOK=active.length>0&&connected.length===active.length&&probe?.line_status!=='issue'&&probe?.line_status!=='partial'
 const calOK=r.google_calendar_enabled&&linked&&probe?.calendar_status!=='issue'
 const automation=r.contract_active&&r.eligible&&r.auto_enabled&&r.auto_started&&!r.stopped&&automationForStore(cfg,r.id,tenant)
 const checks=[
  check('contract','契約・採用機能',r.contract_active&&r.eligible&&r.recruitment_enabled?'ready':'action',r.contract_active&&r.eligible&&r.recruitment_enabled?'契約・利用条件・採用機能は確認済み。':'契約・利用条件・採用機能を確認してください。','store'),
  check('line','公式LINE',lineOK?'ready':'action',!r.channels.length?'採用LINEが未登録です。':probe?.line_status==='issue'?'最新の疎通照合で問題が見つかりました。':probe?.line_status==='partial'?'一部の接続について実照合が未完了です。個別のLINE設定を確認してください。':active.length===0?'登録LINEが停止中です。':connected.length!==active.length?`稼働対象 ${active.length}件中 ${connected.length}件が接続検収済み。`:probe?.line_status==='ok'?'接続検収・直近の疎通照合ともに確認済み。':`接続検収済み ${connected.length}件。最新の疎通は「実際の接続を確認」で照合できます。`,'line'),
  check('calendar','Googleカレンダー',calOK?'ready':'action',!r.google_calendar_enabled?'Google照合がオフです。':!linked?'店舗専用カレンダーを接続してください。':probe?.calendar_status==='issue'?'最新の空き時間照合に失敗しました。権限・共有設定を確認してください。':probe?.calendar_status==='ok'?'実際の空き時間照合に成功しました。':'接続情報は登録済み。最新の疎通を確認できます。','calendar'),
  check('forms','応募フォーム',r.forms_enabled&&r.forms>0?'ready':'action',r.forms_enabled&&r.forms>0?`公開中 ${r.forms}件。`:r.intakes?'フォーム機能や公開状態を確認してください。':'公開フォームがありません。LINEトーク型は公開時に自動作成されます。','forms'),
  check('steps','ステップ配信',r.scenarios+r.intakes>0?'ready':'action',r.scenarios+r.intakes>0?`公開中 ${r.scenarios+r.intakes}件・未公開 ${r.drafts}件。`:`公開中0件・下書き${r.drafts}件。`,'studio'),
  check('slots','対面面談枠',r.interviews_enabled&&r.token_interviews_enabled&&r.slots>0?'ready':'action',r.interviews_enabled&&r.token_interviews_enabled&&r.slots>0?`公開・未予約の枠 ${r.slots}件（Googleの空きは予約時に再確認）。`:'対面枠・予約機能を設定してください。','calendar'),
  check('automation','通常自動配信',automation&&r.reminders_enabled?'ready':'action',r.stopped?'店舗または法人の配信が停止中です。':!r.reminders_enabled?'面談通知がオフです。':automation?'通常配信の設定条件は有効です。':'契約、配信ON、利用条件またはサーバー許可を確認してください。','store'),
  check('delivery','送信エラー',r.failures||r.overdue?'warning':'ready',`直近7日の失敗・結果不明 ${r.failures}件、3分以上の送信待ち ${r.overdue}件。`,'delivery',false),
 ]
 const settingsReady=checks.filter(c=>c.required).every(c=>c.state==='ready')
 const acceptanceReady=settingsReady&&probeCurrent&&probe?.line_status==='ok'&&probe?.calendar_status==='ok'
 const accepted=r.acceptance?.fingerprint===fingerprint
 checks.push(check('test','応募・面談実機確認',accepted&&settingsReady?'ready':'action',accepted&&settingsReady?'現在の設定で実機確認を記録済み。':accepted?'実機確認記録あり。最新の接続確認・設定状況を再確認してください。':r.acceptance?'設定が変更されました。実機確認をやり直してください。':'接続・応募・対面予約・通知・重複不可を実端末で確認してください。','test'))
 const required=checks.filter(c=>c.required),done=required.filter(c=>c.state==='ready').length
 return {tenant,company:r.tenant_name,id:r.id,name:r.name,checks,progress:{done,total:required.length},ready:done===required.length&&!r.failures&&!r.overdue,
 acceptance_ready:acceptanceReady,fingerprint,accepted_at:accepted?new Date(r.acceptance!.checked_at):null,probe_at:r.probe?new Date(r.probe.checked_at):null,probe_current:!!probeCurrent,last_received:r.last_received,channels:r.channels}
}
async function tenantHealth(db:DB,cfg:Config,google:InterviewGoogle,tenant:string,only?:string){
 await scope(db,tenant,undefined,true)
 const {rows:ids}=await db.query<{id:string}>('SELECT id FROM store WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY name,id',[tenant,only??null])
 const result=[]
 for(const {id} of ids){
   const [r]=await healthRows(db,tenant,id)
   if(!r)continue
   const all=await connectionProgress(db),verified=new Map(all.map(c=>[c.id,c.verified]))
   result.push(makeView(cfg,google,tenant,r,verified))
 }
 return result
}
export async function masterHealth(db:DB,cfg:Config,google:InterviewGoogle,actor:Actor){
 if(actor.role!=='admin'||(!actor.agency&&!actor.platform))throw forbidden()
 return tenantHealth(db,cfg,google,actor.tenant_id)
}
export async function platformHealth(db:DB,cfg:Config,google:InterviewGoogle,credential:string|undefined){
 const p=await platformPrincipal(db,credential),ids=await supervisedTenantIds(db,p),out:HealthView[]=[]
 for(const tenant of ids)out.push(...await tenantHealth(db,cfg,google,tenant))
 await scope(db,p.tenant_id,undefined,true)
 return out
}
export async function storeHealth(db:DB,cfg:Config,google:InterviewGoogle,actor:Actor,store:string){
 if(actor.role!=='admin'||(!actor.agency&&!actor.platform))throw forbidden()
 const row=(await tenantHealth(db,cfg,google,actor.tenant_id,store))[0]
 if(!row)throw missing()
 return row
}
export async function probeStore(db:DB,cfg:Config,google:InterviewGoogle,line:LineAPI,actor:Actor,store:string){
 const view=await storeHealth(db,cfg,google,actor,store)
 await scope(db,actor.tenant_id,store)
 const active=view.channels.filter(c=>!c.stopped)
 // Bounded and explicitly initiated: never send LINE messages or change external settings.
 const probeOne=async(meta:ChannelRow)=>{
  try{const c=await channel(db,meta.id),cred=channelCredentials(cfg,c)
   if(!await line.checkToken(c,cred))return 'issue'
   if(c.module_channel_id)return 'partial'
   return await line.checkWebhook(cred,cfg.origin+'/api/v1/webhooks/line/'+c.id)?'ok':'issue'
  }catch{return 'issue'}
 }
 const details:string[]=[],started=Date.now()
 for(let i=0;i<active.length;i+=4){
  if(i&&Date.now()-started>24000)break
  details.push(...await Promise.all(active.slice(i,i+4).map(probeOne)))
 }
 const ls=!active.length?'not_set':details.includes('issue')?'issue':details.length<active.length||details.includes('partial')?'partial':'ok'
 const {rows:[calendar]}=await db.query<{enabled:boolean;linked:boolean}>(`SELECT google_calendar_enabled AS enabled,
   EXISTS(SELECT 1 FROM interview_shared_calendar WHERE store_id=$1) OR EXISTS(SELECT 1 FROM interview_google_calendar WHERE store_id=$1) AS linked FROM store WHERE id=$1`,[store])
 let gs:'ok'|'issue'|'off'|'not_set'='not_set'
 if(!calendar.enabled)gs='off'
 else if(!calendar.linked&&!google.sharedCalendar(store))gs='not_set'
 else try{await googleBusy(db,google,store,{starts_at:new Date(),ends_at:new Date(Date.now()+3600000)},undefined,true);gs='ok'}catch{gs='issue'}
 const current=await storeHealth(db,cfg,google,actor,store)
 if(current.fingerprint!==view.fingerprint)throw conflict()
 await scope(db,actor.tenant_id,store)
 await db.query(`INSERT INTO store_health_check(tenant_id,store_id,fingerprint,line_status,calendar_status)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,store_id) DO UPDATE SET fingerprint=excluded.fingerprint,line_status=excluded.line_status,calendar_status=excluded.calendar_status,checked_at=now()`,[actor.tenant_id,store,view.fingerprint,ls,gs])
 await audit(db,actor.tenant_id,store,actor.id,'store.health.probe',store,null,{line:ls,calendar:gs})
 return storeHealth(db,cfg,google,actor,store)
}
export async function recordStoreAcceptance(db:DB,cfg:Config,google:InterviewGoogle,actor:Actor,store:string,input:z.infer<typeof acceptanceInput>){
 const row=await storeHealth(db,cfg,google,actor,store)
 if(row.fingerprint!==input.fingerprint)throw conflict()
 if(!row.acceptance_ready)throw new Fault(409,'HEALTH_NOT_READY','設定と実際の接続照合が済んでから実機確認を記録してください。')
 await scope(db,actor.tenant_id,store)
 await db.query(`INSERT INTO store_acceptance(tenant_id,store_id,fingerprint,checked_by) VALUES($1,$2,$3,$4)
 ON CONFLICT(tenant_id,store_id) DO UPDATE SET fingerprint=excluded.fingerprint,checked_by=excluded.checked_by,checked_at=now()`,[actor.tenant_id,store,row.fingerprint,actor.id])
 await audit(db,actor.tenant_id,store,actor.id,'store.health.acceptance',store,null,{confirmed_by_user:true})
 return storeHealth(db,cfg,google,actor,store)
}
