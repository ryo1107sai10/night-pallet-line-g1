import type { Request } from 'express'
import { z } from 'zod'
import { liveTriggers, simulate, validate } from '../public/studio/engine.mjs'
import { audit, automationForStore, conflict, Fault, missing, keyed, newId, once, purpose, revision, seal, text, uuid, type Actor, type Config, type DB } from './core.js'

import { channel, channelReady, evidence, testDeliveryConfirmed } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { INTERVIEW_LINK_MARKER } from './interview-link.js'
import { CUSTOMER_LINK_MARKER } from './customer-link.js'
import { allowApplicantTagGraph, graphUsesApplicantTags, validApplicantTagsForRun, tagTestFacts } from './applicant-tags.js'
import { locationOf } from './automation.js'
import { storeFeatures } from './store-features.js'

const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/)
const base = { id:nodeId, name:z.string().max(100) }
const next = nodeId.or(z.literal(''))
const clock = z.string().max(16)
const rule=z.strictObject({condition:z.enum(['booked','consent','adult','responded','tag','assigned']),tag:z.string().max(80).optional(),negated:z.boolean().optional()})
const rich=z.strictObject({kind:z.enum(['image','buttons','card']),title:z.string().max(60).optional(),imageUrl:z.string().max(2000).optional(),buttons:z.array(z.strictObject({label:z.string().max(20),url:z.string().max(2000)})).max(3)})
const nodes = z.discriminatedUnion('type',[
  z.strictObject({...base,type:z.literal('message'),category:z.enum(['service','marketing']),body:z.string().max(5000),rich:rich.optional(),tagGuard:z.strictObject({tag:text(80),exclude:z.array(text(80)).max(30),booked:z.boolean().optional()}).optional(),next}),
  z.strictObject({...base,type:z.literal('wait'),mode:z.enum(['delay','fixed','business','booking']),minutes:z.int().optional(),
    days:z.int().optional(),time:clock.optional(),next}),
  z.strictObject({...base,type:z.literal('branch'),condition:z.enum(['booked','consent','adult','responded','tag','assigned','all','any']),
    rules:z.array(rule).max(8).optional(),tag:z.string().max(80).optional(),yes:next,no:next}),
  z.strictObject({...base,type:z.literal('tag'),tag:z.string().max(80),action:z.enum(['add','remove']).optional(),next}),
  z.strictObject({...base,type:z.literal('task'),note:z.string().max(400),next}),
  z.strictObject({...base,type:z.literal('end')}),
])
const graph = z.strictObject({
  name:z.string().max(100),purpose,trigger:z.string().max(30),triggerTag:z.string().max(80).optional(),channel:uuid,windowStart:clock,windowEnd:clock,
  daily:z.int(),weekly:z.int(),cooldownDays:z.int(),rejoin:z.boolean(),missingAssignee:z.enum(['manager','hold']),
  holidays:z.array(z.int().min(0).max(6)).max(6),entry:next,nodes:z.array(nodes).max(100),
})
const folder=z.string().trim().max(50)
const libraryInput=z.strictObject({graph,folder:folder.optional(),is_template:z.boolean().optional()})
const timelineEvent=z.strictObject({afterMinutes:z.int().min(0).max(525600),action:z.enum(['reply','book','cancel','consent_on','consent_off','handoff_start','handoff_end','block','tag_add','tag_remove']),tag:z.string().max(80).optional(),bookingAt:z.string().max(16).optional()})
const fixture = z.strictObject({
  timeline:z.array(timelineEvent).max(20).optional(),
  start:z.string().max(16),bookingAt:z.string().max(16),dayCount:z.int().min(0).max(10000),weekCount:z.int().min(0).max(10000),
  booked:z.boolean(),consent:z.boolean(),adult:z.boolean(),responded:z.boolean(),assigned:z.boolean(),
  stopped:z.boolean(),marketingStopped:z.boolean(),blocked:z.boolean(),human:z.boolean(),cancelled:z.boolean(),
  bookingLinkValid:z.boolean(),eligible:z.boolean().optional(),contractActive:z.boolean().optional(),
  budgetAvailable:z.boolean().optional(),bookingCurrent:z.boolean().optional(),tags:z.array(z.string().max(80)).max(50),
  values:z.strictObject({ name:z.string().max(100),store:z.string().max(120),staff:z.string().max(100),
    booking:z.string().max(120),price:z.string().max(400),booking_url:z.string().max(1000),
    interview_link:z.string().max(1000).optional(),customer_link:z.string().max(1000).optional() }),
})
export type Graph = z.infer<typeof graph>
function canPublish(graph:Graph) {
  const available = Object.hasOwn(liveTriggers[graph.purpose]??{},graph.trigger)
  if (!available) {
    throw new Fault(422,'TRIGGER_UNAVAILABLE','この用途・開始イベントの実配信は未対応です。下書きと配信前テストを利用できます。')
  }
}

type Scenario = { id:string; channel_id:string; graph:Graph; revision:number; state:string;
  published_version:number|null; stopped:boolean; updated_at:Date; folder:string; is_template:boolean; draft_matches_published:boolean; published_channel:string|null; published_name:string|null }
type Context = { db:DB; actor:Actor; store:string }

const scenarioProjection=`SELECT s.*,coalesce(s.graph=v.graph,false) AS draft_matches_published,v.graph->>'channel' AS published_channel,v.graph->>'name' AS published_name
  FROM scenario s LEFT JOIN scenario_version v ON v.scenario_id=s.id AND v.version=s.published_version`
const record = async (db:DB,store:string,id:string,lock=false) => {
  const result = await db.query<Scenario>(scenarioProjection+' WHERE s.store_id=$1 AND s.id=$2'+(lock?' FOR UPDATE OF s':''),[store,id])
  if (!result.rowCount) throw missing()
  return result.rows[0]
}
const allowedChannel = async (db:DB,store:string,data:Graph) => {
  const result = await db.query("SELECT id FROM channel WHERE id=$1 AND (purpose=$2 OR purpose='shared') AND store_id=$3",[data.channel,data.purpose,store])
  if (!result.rowCount) throw missing()
}
const complete = (data:Graph) => {
  const errors = validate(data,true)
  if (errors.length) throw new Fault(422,'INVALID_SCENARIO',errors[0].message)
}
export const scenarioList = async ({db,store}:Context,summary=false) => {
  const projection=summary?`SELECT s.id,s.channel_id,s.revision,s.state,s.published_version,s.stopped,s.updated_at,s.folder,s.is_template,
    jsonb_build_object('name',s.graph->>'name','purpose',s.graph->>'purpose','channel',s.graph->>'channel','node_count',jsonb_array_length(s.graph->'nodes')) AS graph,
    coalesce(s.graph=v.graph,false) AS draft_matches_published,v.graph->>'channel' AS published_channel,v.graph->>'name' AS published_name
    FROM scenario s LEFT JOIN scenario_version v ON v.scenario_id=s.id AND v.version=s.published_version`:scenarioProjection
  return (await db.query<Scenario>(projection+' WHERE s.store_id=$1 ORDER BY s.updated_at DESC,s.id LIMIT 100',[store])).rows
}
export const scenarioDetail = async ({db,store}:Context,id:string) => {
  const item = await record(db,store,id)
  const { rows } = await db.query(`SELECT version,published_at FROM scenario_version
    WHERE scenario_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 50`,[id,store])
  return {...item, versions:rows}
}
export const versionDetail = async ({db,store}:Context,id:string,version:number) => {
  const { rows:[item] } = await db.query('SELECT version,graph,published_at FROM scenario_version WHERE scenario_id=$1 AND version=$2 AND store_id=$3',[id,version,store])
  if (!item) throw missing()
  return item
}
export async function createScenario({db,actor,store}:Context,cfg:Config,req:Request,key:string) {
  const wrapped=libraryInput.safeParse(req.body)
  const data=wrapped.success?wrapped.data.graph:graph.parse(req.body)
  const settings=wrapped.success?{folder:wrapped.data.folder??'',is_template:wrapped.data.is_template??false}:{folder:'',is_template:false}
  await allowedChannel(db,store,data)
  return once(db,cfg,actor,'scenario.create',key,wrapped.success?{store,data,settings}:{store,data},async()=>{
    const id = newId()
    await db.query(`INSERT INTO scenario(id,tenant_id,store_id,channel_id,created_by,graph,folder,is_template)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,actor.tenant_id,store,data.channel,actor.id,JSON.stringify(data),settings.folder,settings.is_template])
    await audit(db,actor.tenant_id,store,actor.id,'scenario.create',id)
    return record(db,store,id)
  })
}
export async function saveScenario({db,actor,store}:Context,id:string,input:unknown) {
  const data = z.strictObject({revision,graph}).parse(input)
  await lockDispatch(db,actor.tenant_id)
  const current = await record(db,store,id,true)
  if (current.revision!==data.revision) throw conflict()
  await allowedChannel(db,store,data.graph)
  await db.query(`UPDATE scenario SET graph=$2,channel_id=$3,revision=revision+1,state='draft',
    updated_at=now() WHERE id=$1`,[id,JSON.stringify(data.graph),data.graph.channel])
  await audit(db,actor.tenant_id,store,actor.id,'scenario.save',id)
  return record(db,store,id)
}
export async function saveScenarioFolder({db,actor,store}:Context,id:string,input:unknown){
  const data=z.strictObject({revision,folder}).parse(input)
  await lockDispatch(db,actor.tenant_id)
  const result=await db.query('UPDATE scenario SET folder=$2,revision=revision+1 WHERE id=$1 AND revision=$3 AND store_id=$4 RETURNING id',[id,data.folder,data.revision,store])
  if(!result.rowCount)throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'scenario.folder',id)
  return scenarioDetail({db,actor,store},id)
}

// Metrics are per immutable published version and actual enrolments, never draft guesses.
export async function scenarioMetrics(context:Context,id:string,requested?:number){
  const {db,store}=context,current=await record(db,store,id)
  const version=requested??current.published_version
  if(!version)return {version:null,total:0,completed:0,active:0,ended:0,nodes:[]}
  const v=await versionDetail(context,id,version)
  const published=v.graph as Graph
  const customer=published.purpose==='customer'
  const e=customer?'enrollment':'applicant_enrollment',n=customer?'delivery_note':'applicant_note',s=customer?'automatic_send':'applicant_send',events=customer?'delivery_event':'applicant_event',subject=customer?'customer_id':'applicant_key',booking=customer?'booking_created':'interview_booked'
  const {rows:[summary]}=await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE ended_at IS NULL)::int AS active,
    count(*) FILTER(WHERE end_reason='完了')::int AS completed,count(*) FILTER(WHERE ended_at IS NOT NULL AND end_reason IS DISTINCT FROM '完了')::int AS ended
    FROM ${e} WHERE scenario_id=$1 AND version=$2 AND starts_at>=now()-interval '30 days'`,[id,version])
  const {rows}=await db.query(`WITH runs AS (SELECT * FROM ${e} WHERE scenario_id=$1 AND version=$2 AND starts_at>=now()-interval '30 days'),
    observed AS (SELECT r.id AS run_id,r.node_id,least(r.due_at,now()) AS at FROM runs r WHERE r.node_id IS NOT NULL
     UNION ALL SELECT r.id,n.node_id,n.occurred_at FROM runs r JOIN ${n} n ON n.enrollment_id=r.id WHERE n.node_id IS NOT NULL
     UNION ALL SELECT r.id,j.node_id,j.first_attempt_at FROM runs r JOIN ${s} j ON j.enrollment_id=r.id
     UNION ALL SELECT r.id,$3::text,r.starts_at FROM runs r),
    reach AS (SELECT run_id,node_id,min(at) at FROM observed GROUP BY run_id,node_id),
    metrics AS (SELECT q.node_id,count(*)::int AS reached,
      count(*) FILTER(WHERE r.node_id=q.node_id AND r.ended_at IS NULL)::int AS waiting,
      count(*) FILTER(WHERE r.node_id=q.node_id AND r.ended_at IS NOT NULL AND r.end_reason IS DISTINCT FROM '完了')::int AS ended,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ${events} ev WHERE ev.channel_id=r.channel_id AND ev.${subject}=r.${subject} AND ev.kind=$4 AND ev.happened_at>=q.at AND ev.happened_at<=now()))::int AS booked_after
      FROM reach q JOIN runs r ON r.id=q.run_id GROUP BY q.node_id),
    delivery AS (SELECT j.node_id,count(*) FILTER(WHERE j.status='accepted')::int AS accepted,
      count(*) FILTER(WHERE j.status IN ('failed','unknown','cancelled'))::int AS not_accepted FROM ${s} j JOIN runs r ON r.id=j.enrollment_id GROUP BY j.node_id)
    SELECT metrics.*,coalesce(delivery.accepted,0) AS accepted,coalesce(delivery.not_accepted,0) AS not_accepted FROM metrics LEFT JOIN delivery USING(node_id)`,[id,version,v.graph.entry,booking])
  return {version,...summary,nodes:published.nodes.map(node=>({node_id:node.id,name:node.name,type:node.type,reached:0,waiting:0,ended:0,accepted:0,not_accepted:0,booked_after:0,...rows.find(r=>r.node_id===node.id)}))}
}
export async function studioPresence(context:Context,id:string,input:unknown){
  const {db,actor,store}=context,current=await record(db,store,id)
  const {client,leave}=z.strictObject({client:uuid,leave:z.boolean().optional()}).parse(input)
  await db.query("DELETE FROM studio_editor WHERE scenario_id=$1 AND (seen_at<now()-interval '2 minutes' OR (staff_id=$2 AND client_id=$3 AND $4::boolean))",[id,actor.id,client,!!leave])
  if(!leave)await db.query(`INSERT INTO studio_editor(tenant_id,store_id,scenario_id,staff_id,client_id) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(scenario_id,staff_id,client_id) DO UPDATE SET seen_at=now()`,[actor.tenant_id,store,id,actor.id,client])
  const {rows:[r]}=await db.query(`SELECT count(DISTINCT staff_id) FILTER(WHERE staff_id<>$2)::int AS other_people,count(*) FILTER(WHERE staff_id=$2 AND client_id<>$3)::int AS other_tabs FROM studio_editor
    WHERE scenario_id=$1 AND seen_at>=now()-interval '2 minutes'`,[id,actor.id,client])
  return {...r,revision:current.revision}
}

// Readiness is advisory and scoped to the stored graph. It neither enables
// automation nor replaces the recipient-level checks at the actual send.
export async function scenarioReadiness(context:Context,cfg:Config,id:string){
  const current=await record(context.db,context.store,id)
  const {db,store,actor}=context
  const [loc,features]=await Promise.all([locationOf(db,store),storeFeatures(db,store)])
  const assess=async (g:Graph)=>{
    const issues:{code:string;message:string;target:'line'|'settings'|'forms'|'interviews'|'tags';severity:'stop'|'blocked'|'advice'}[]=[]
    const add=(code:string,message:string,target:typeof issues[number]['target'],severity:typeof issues[number]['severity']='blocked')=>issues.push({code,message,target,severity})
    if(!automationForStore(cfg,store,actor.tenant_id))add('process','サーバーの自動配信がこの店舗では有効ではありません。','settings')
    if(!loc.contract_active)add('contract','店舗の契約・配信許可を確認してください。','settings')
    if(!loc.eligible_at)add('eligibility','店舗の利用条件の確認が未完了です。','settings')
    if(!loc.auto_enabled||!loc.auto_enabled_at)add('automation','店舗の自動配信がオフです。','settings')
    if(loc.stopped||loc.tenant_stopped)add('store_stop','店舗または法人の配信が停止中です。','settings','stop')
    if(current.stopped)add('scenario_stop','このシナリオは停止中です。','settings','stop')
    const match=await db.query("SELECT id FROM channel WHERE store_id=$1 AND id=$2 AND (purpose=$3 OR purpose='shared')",[store,g.channel,g.purpose])
    if(!match.rowCount)add('channel','用途に合う公式LINEが登録されていません。','line')
    else{
      const c=await channel(db,g.channel)
      if(c.stopped)add('line_stop','公式LINEの配信が停止中です。','line','stop')
      if(!channelReady(c)||(!c.module_channel_id&&!c.credentials)||(c.module_channel_id&&cfg.lineModule?.id!==c.module_channel_id))add('line','公式LINEの接続・一般利用者への送信確認が未完了です。','line')
      if(g.purpose==='recruitment'&&['follow','form'].includes(g.trigger)&&
        (await db.query('SELECT 1 FROM recruitment_intake WHERE channel_id=$1 AND live IS NOT NULL',[g.channel])).rowCount)
        add('intake_duplicate','LINEトーク型の面談テンプレートが公開中です。開始案内の重複を避けるため先に停止してください。','settings')
      if(g.trigger==='form'){
        if(!features.forms_enabled)add('forms_off','回答フォームがオフです。','forms')
        const {rows:[form]}=await db.query('SELECT EXISTS(SELECT 1 FROM workflow_form WHERE store_id=$1 AND channel_id=$2 AND purpose=$3 AND published AND NOT chat_only) AS present',[store,g.channel,g.purpose])
        if(!form.present)add('form_missing','この公式LINEに公開済みの回答フォームがありません。','forms')
      }
      const messages=g.nodes.filter(n=>n.type==='message')
      const uses=(key:string)=>messages.some(n=>new RegExp('\\{\\{\\s*'+key+'\\s*\\}\\}').test(n.body)||n.rich?.buttons.some(b=>b.url==='{{'+key+'}}'))
      const interview=g.purpose==='recruitment'&&(g.trigger.startsWith('interview_')||uses('interview_link'))
      if(interview&&!features.interviews_enabled)add('interviews_off','面談予約がオフです。','interviews')
      if(g.purpose==='recruitment'&&uses('interview_link')){
        if(!features.token_interviews_enabled)add('interview_url','LINEトークからの面談予約がオフです。','interviews')
        const {rows:[slots]}=await db.query("SELECT EXISTS(SELECT 1 FROM interview_slot WHERE store_id=$1 AND channel_id=$2 AND published AND starts_at>now() AND method='onsite') AS present",[store,g.channel])
        if(!slots.present)add('slots','今後の公開面談枠がありません。面談枠を確認してください。','interviews','advice')
        if(features.google_calendar_enabled){
          const {rows:[calendar]}=await db.query('SELECT EXISTS(SELECT 1 FROM interview_google_calendar WHERE store_id=$1) OR EXISTS(SELECT 1 FROM interview_shared_calendar WHERE store_id=$1) AS connected',[store])
          if(!calendar.connected)add('calendar','Googleカレンダーの照合設定を確認してください。','interviews','advice')
        }
      }
      if(g.purpose==='customer'&&(uses('customer_link')||uses('booking_url'))&&!features.token_customers_enabled)add('customer_url','LINEトークからの来店予約・設定がオフです。','settings')
      if(g.purpose==='customer'&&['booking_created','booking_changed','booking_cancelled','visit'].includes(g.trigger)&&!features.visits_enabled)add('visits','来店予約がオフです。','settings')
      const usesTags=g.nodes.some(n=>n.type==='tag'||(n.type==='branch'&&(n.condition==='tag'||n.rules?.some(r=>r.condition==='tag')))||(n.type==='message'&&!!n.tagGuard))
      if(g.purpose==='recruitment'&&graphUsesApplicantTags(g)&&!await validApplicantTagsForRun(db,store,g,new Date()))add('tags','応募・選考管理、採用タグ、または指定したタグの有効状態を確認してください。','tags')
      if(g.purpose==='customer'&&usesTags&&!features.tags_enabled)add('tags','顧客タグがオフです。','tags')
    }
    return {channel:g.channel,purpose:g.purpose,status:issues.some(i=>i.severity==='stop')?'stopped':issues.some(i=>i.severity==='blocked')?'blocked':'ready',issues}
  }
  const published=current.published_version?await versionDetail(context,id,current.published_version):null
  return {revision:current.revision,draft:await assess(current.graph),published:published?await assess(published.graph as Graph):null}
}

export async function publicationReview(context:Context,id:string){
  const {db,store}=context,current=await record(db,store,id)
  const published=current.published_version?await versionDetail(context,id,current.published_version):null
  // Compare immutable live graphs, rather than the editable drafts.
  const {rows:related}=await db.query<{id:string;name:string;version:number}>(`SELECT s.id,v.graph->>'name' AS name,v.version
    FROM scenario s JOIN scenario_version v ON v.scenario_id=s.id AND v.version=s.published_version
    WHERE s.id<>$1 AND NOT s.stopped AND v.graph->>'channel'=$2 AND v.graph->>'purpose'=$3 AND v.graph->>'trigger'=$4
      AND ($4<>'tag_added' OR v.graph->>'triggerTag'=$5)
    ORDER BY s.updated_at DESC LIMIT 20`,[id,current.graph.channel,current.graph.purpose,current.graph.trigger,current.graph.triggerTag??''])
  return {revision:current.revision,published,related}
}

async function rejectIntakeConflict(db:DB,g:Graph){
  if(g.purpose==='recruitment'&&['follow','form'].includes(g.trigger)&&
    (await db.query('SELECT 1 FROM recruitment_intake WHERE channel_id=$1 AND live IS NOT NULL',[g.channel])).rowCount)
      throw new Fault(409,'INTAKE_DUPLICATE','LINEトーク型の面談テンプレートと開始案内が重複します。')
}
export async function transitionScenario({db,actor,store}:Context,id:string,input:unknown) {
  const data = z.strictObject({ revision, action:z.enum(['test','approve','publish','stop','resume']), reason:text(200).optional(),fixture:fixture.optional() }).parse(input)
  await lockDispatch(db,actor.tenant_id)
  const current = await record(db,store,id,true)
  if (current.revision!==data.revision) throw conflict()
  let { state, stopped, published_version:version } = current
  let evidence: { planned:number; held:number } | undefined
  switch (data.action) {
    case 'test': {
      complete(current.graph)
      if (state!=='draft') throw conflict()
      if (!data.fixture) throw new Fault(422,'SIMULATION_REQUIRED','配信前テストを実行してください。')
      const result = await preview(db,store,current.graph,data.fixture)
      evidence={planned:result.count,held:result.events.filter(event=>event.state==='held').length}
      state='tested'
      break
    }
    case 'approve':
      if (state!=='tested') throw conflict()
      state='approved'
      break
    case 'publish':
      if(current.is_template)throw new Fault(409,'TEMPLATE_ONLY','テンプレートは配信されません。新しいシナリオへ複製して公開してください。')
      if (state!=='approved') throw conflict()
      canPublish(current.graph)
      await rejectIntakeConflict(db,current.graph)
      complete(current.graph)
      await allowedChannel(db,store,current.graph)
      await allowApplicantTagGraph(db,actor,store,current.graph)
      version=(version??0)+1
      await db.query(`INSERT INTO scenario_version(tenant_id,store_id,scenario_id,version,graph,published_by)
        VALUES ($1,$2,$3,$4,$5,$6)`,[actor.tenant_id,store,id,version,JSON.stringify(current.graph),actor.id])
      state='draft'
      break
    case 'stop':
    case 'resume':
      if (!version || !data.reason || stopped===(data.action==='stop')) throw conflict()
      stopped=data.action==='stop'
      if(!stopped){
        const {rows:[published]}=await db.query<{graph:Graph}>('SELECT graph FROM scenario_version WHERE scenario_id=$1 AND version=$2',[id,version])
        if(published)await rejectIntakeConflict(db,published.graph)
      }
      if (stopped) {
        await db.query(`UPDATE enrollment SET ended_at=now(),end_reason='シナリオ停止'
          WHERE scenario_id=$1 AND ended_at IS NULL`,[id])
        await db.query(`UPDATE automatic_send SET next_at='infinity',reason='シナリオ停止' WHERE
          enrollment_id IN (SELECT id FROM enrollment WHERE scenario_id=$1)
          AND status IN ('submitting','unknown')`,[id])
        await db.query(`UPDATE applicant_enrollment SET ended_at=now(),end_reason='シナリオ停止'
          WHERE scenario_id=$1 AND ended_at IS NULL`,[id])
        await db.query(`UPDATE applicant_send SET next_at='infinity',reason='シナリオ停止' WHERE
          enrollment_id IN (SELECT id FROM applicant_enrollment WHERE scenario_id=$1)
          AND status IN ('submitting','unknown')`,[id])
      }
      break
  }
  await db.query(`UPDATE scenario SET state=$2,stopped=$3,published_version=$4,revision=revision+1,updated_at=now(),
    delivery_floor=CASE WHEN $5 THEN clock_timestamp() ELSE delivery_floor END
    WHERE id=$1`,[id,state,stopped,version,data.action==='resume'])
  await audit(db,actor.tenant_id,store,actor.id,'scenario.'+data.action,id,data.reason??null,{version,...evidence})
  return scenarioDetail({db,actor,store},id)
}

async function preview(db:DB,store:string,graph:Graph,sample:z.infer<typeof fixture>) {
  const { rows:[location] } = await db.query(
    "SELECT timezone,to_char(cutoff,'HH24:MI') AS cutoff FROM store WHERE id=$1",[store])
  const result = simulate(graph,{...sample,zone:location.timezone,cutoff:location.cutoff})
  if (result.errors.length) throw new Fault(422,'INVALID_SIMULATION',result.errors[0].message)
  return result
}

export async function scenarioTesters({db,store}:Context,id:string) {
  const current=await record(db,store,id)
  const c=await channel(db,current.channel_id)
  const { rows } = await db.query(`SELECT t.id,t.verified_at,t.expires_at FROM tester t
    WHERE t.channel_id=$1 AND t.purpose=$2 AND t.generation=$3 AND t.verified_at IS NOT NULL AND t.expires_at>now()
    AND EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=t.channel_id AND e.user_key=t.user_key
      AND e.kind IN ('follow','message') AND e.generation=t.generation
      AND e.received_at BETWEEN t.verified_at AND t.expires_at AND e.occurred_at BETWEEN t.verified_at AND t.expires_at)
    AND NOT EXISTS (SELECT 1 FROM test_send j WHERE j.tester_id=t.id)
    ORDER BY t.verified_at DESC LIMIT 30`,[c.id,current.graph.purpose,c.generation])
  return rows
}

export async function scenarioTestStatus({db,store}:Context,id:string) {
  await record(db,store,id)
  const { rows }=await db.query(`SELECT id,status,created_at,line_request_id FROM test_send
    WHERE scenario_id=$1 ORDER BY created_at DESC LIMIT 20`,[id])
  return rows
}

export async function queueScenarioTest(ctx:Context,cfg:Config,id:string,key:string,input:unknown) {
  const {db,actor,store}=ctx
  const data=z.strictObject({revision,node:nodeId,tester:uuid,fixture,actual_tags:z.boolean().optional()}).parse(input)
  if(data.fixture.timeline?.length)throw new Fault(422,'TIMELINE_SIMULATION_ONLY','時系列イベント付きテストは模擬専用です。実LINEテストはイベントを空にして実行してください。')
  if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でテスト送信してください。')
  await lockDispatch(db,actor.tenant_id)
  return once(db,cfg,actor,'scenario.test_send',key,{id,...data},async()=>{
    const current=await record(db,store,id,true)
    if (current.revision!==data.revision || current.stopped) throw conflict()
    complete(current.graph)
    const c=await channel(db,current.channel_id)
    const {rows:[flags]}=await db.query(`SELECT t.stopped OR s.stopped AS stopped FROM store s
      JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[store])
    if (c.stopped || flags.stopped) throw new Fault(409,'DELIVERY_STOPPED','配信が停止中です。')
    const { rows:[proof] }=await db.query(`SELECT t.id,t.user_key,t.verified_at FROM tester t
      WHERE t.id=$1 AND t.channel_id=$2 AND t.generation=$3 AND t.purpose=$4 AND t.verified_at IS NOT NULL AND t.expires_at>now()
      AND EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=t.channel_id AND e.user_key=t.user_key
        AND e.kind IN ('follow','message') AND e.generation=t.generation AND
        e.received_at BETWEEN t.verified_at AND t.expires_at AND e.occurred_at BETWEEN t.verified_at AND t.expires_at)
      AND NOT EXISTS (SELECT 1 FROM test_send j WHERE j.tester_id=t.id)
      FOR UPDATE OF t`,[data.tester,c.id,c.generation,current.graph.purpose])
    if (!proof) throw new Fault(404,'TESTER_NOT_AVAILABLE','この店舗・用途の有効なテスト利用者を選択してください。')
    const checks = c.checks
    // 通常の自動配信には一般利用者の検収が引き続き必要。採用の試験送信だけは、
    // 接続テストのLINE受付と端末到達を確認済みのチャネルで、改めて本人確認した
    // 同じ店舗・用途のテスター1人に限定する。公開や契約状態は変更しない。
    const verifiedTestOnly=current.graph.purpose==='recruitment'&&!c.module_channel_id&&
      testDeliveryConfirmed(c)&&(await evidence(db,c)).send_accepted
    if (!checks.token_verified || !checks.webhook_verified || !checks.ownership_verified || !checks.provider_verified ||
      !checks.redelivery_enabled || !checks.auto_reply_checked || (!checks.non_developer&&!verifiedTestOnly)) {
      throw new Fault(409,'TEST_NOT_READY','先に公式アカウントのLINE接続を確認してください。')
    }
    const selected=current.graph.nodes.find(n=>n.id===data.node)
    let guard=null, testFixture=data.fixture
    if(data.actual_tags){
      if(current.graph.purpose!=='recruitment'||current.graph.trigger!=='tag_campaign'||!current.published_version||selected?.type!=='message'||!selected.tagGuard)
        throw new Fault(422,'TAG_TEST_GRAPH_REQUIRED','公開した採用タグ絞り込みテンプレートのメッセージを選んでください。')
      guard=selected.tagGuard
      const facts=await tagTestFacts(db,c,proof.user_key,guard,proof.verified_at)
      if(!facts)throw new Fault(409,'TAG_TEST_CONDITIONS','テスター本人の現在のタグ・予約・対応状態が配信条件と一致しません。')
      testFixture={...data.fixture,tags:facts.tags,booked:facts.booked}
    }
    const result=await preview(db,store,current.graph,testFixture)
    const message=result.events.find(event=>event.id===data.node)?.message
    if (!message) throw new Fault(422,'MESSAGE_NOT_SCHEDULED','配信予定があるメッセージを選んでください。')
    // 面談予約URL・来店予約・設定URLはシミュレーション用のダミー値をマーカーに戻して封緘し、送信直前に受信者ごとの実URLへ差し替える。
    const dummyInterview=current.graph.purpose==='recruitment'?data.fixture.values.interview_link:undefined
    const dummyCustomer=current.graph.purpose==='customer'?data.fixture.values.customer_link:undefined
    let body=message
    if (dummyInterview) body=body.split(dummyInterview).join(INTERVIEW_LINK_MARKER)
    if (dummyCustomer) body=body.split(dummyCustomer).join(CUSTOMER_LINK_MARKER)
    const marked=(guard?'【絞り込み検証】':'【接続テスト】')+'\n'+body
    if (marked.length>5000) throw new Fault(422,'MESSAGE_TOO_LONG','テストの表示を含めて5000文字以内にしてください。')
    const job=newId()
    await db.query(`INSERT INTO test_send
      (id,tenant_id,store_id,channel_id,tester_id,actor_id,operation_key,generation,scenario_id,scenario_revision,test_body,tag_test_guard,test_rich_box)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[job,actor.tenant_id,store,c.id,proof.id,actor.id,
      keyed(cfg,'scenario-test:'+id+':'+key),c.generation,id,current.revision,seal(cfg,'test-body:'+job,marked),guard===null?null:JSON.stringify(guard),selected?.type==='message'&&selected.rich?seal(cfg,'test-rich:'+job,JSON.stringify(selected.rich)):null])
    await audit(db,actor.tenant_id,store,actor.id,'scenario.test_queue',id,null,{job,node:data.node})
    return {id:job,status:'queued'}
  })
}
