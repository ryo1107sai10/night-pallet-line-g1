import {resolveRichButtons} from '../public/studio/message-format.mjs'
import type pg from 'pg'
import { localPart, nextWindow, renderMessage, waitUntil, evaluateBranch } from '../public/studio/engine.mjs'
import { audit, automationForStore, conflict, Fault, newId, scope, seal, tx, unseal, type Actor,type Config,type DB,type Route } from './core.js'
import { automaticRelationshipReady, channel, channelCredentials, channelReady, summary, type Channel, type LineAPI } from './line.js'
import { customerById, emitDelivery, endCustomerRuns, ensureCustomer, stopFromLine, type Customer } from './customer.js'
import { handoffUntil } from './line-handoff.js'
import { lockDispatch } from './dispatch-lock.js'
import type { Graph } from './scenario.js'
import { messageBudget } from './delivery-budget.js'
import { CUSTOMER_LINK_MARKER, customerLinkEligible, issueCustomerLinkToken } from './customer-link.js'
import { endApplicantScope } from './recruitment-automation.js'

// {{customer_link}} と {{booking_url}} は送信直前に受信者ごと発行するため、step 時点では送信ジョブIDを含む
// プレースホルダURLで描画して封緘し、submit 直前に実URLへ差し替える（プレースホルダは決定的に再現できる）。
// {{booking_url}} の着地先も顧客リンク（/account）で、予約の確認・変更・取消がそのまま行える。
const customerLinkPlaceholder=(sendId:string)=>'https://link.invalid/customer-link/'+sendId
const bookingUrlPlaceholder=(sendId:string)=>'https://link.invalid/booking-url/'+sendId
const usesBookingUrl=(body:string)=>/\{\{\s*booking_url\s*\}\}/.test(body)

const minute=60000
const day=1440*minute
type Event = { id:string;customer_id:string;kind:string;booking_id:string|null;booking_revision:number|null;happened_at:Date;scope_version:string }
type Location = { id:string;name:string;timezone:string;cutoff:string;auto_enabled:boolean;eligible_at:Date|null
  contract_active:boolean;auto_enabled_at:Date|null;scope_version:string;monthly_limit:number;stopped:boolean;tenant_stopped:boolean
  tags_enabled:boolean;visits_enabled:boolean;tags_enabled_at:Date|null;visits_enabled_at:Date|null }
type Run = { id:string;tenant_id:string;store_id:string;channel_id:string;scenario_id:string;customer_id:string
  node_id:string;wait_node:string|null;due_at:Date;event_kind:string;graph:Graph;booking_id:string|null
  booking_revision:number|null;event_at:Date;stopped:boolean;ended_at:Date|null;end_reason:string|null }
type Job = { id:string;enrollment_id:string;customer_id:string;node_id:string;body_box:string|null;category:'service'|'marketing'
  status:string;generation:number;attempt:number;first_attempt_at:Date;next_at:Date|number;reason:string|null }
type Booking = { id:string;status:string;revision:number;starts_at:Date;label:string }

export async function processCustomerWebhook(db:DB,cfg:Config,c:Channel,event:{
  event_id:string;generation:number;user_key:string|null;recipient_box:string|null;kind:string
  occurred_at:Date;stop_signal:string|null
}) {
  if (!event.user_key || c.purpose==='recruitment' || event.generation!==c.generation) return
  let customer:Customer|undefined
  if (event.recipient_box) {
    const raw=unseal(cfg,'webhook:'+c.id+':'+event.event_id,event.recipient_box)
    customer=await ensureCustomer(db,cfg,c,raw,false,event.user_key)
  } else {
    customer=(await db.query<Customer>('SELECT * FROM customer WHERE channel_id=$1 AND user_key=$2',[c.id,event.user_key])).rows[0]
  }
  if (!customer) return
  if (event.kind==='message') {
    if (event.stop_signal) await stopFromLine(db,customer,event.stop_signal,event.occurred_at)
    else if (c.purpose==='customer') await db.query(`UPDATE customer SET last_reply_at=$2 WHERE id=$1
      AND (last_reply_at IS NULL OR last_reply_at<$2)`,[customer.id,event.occurred_at])
  }
  if (event.kind==='unfollow') {
    const {rows:[state]}=await db.query('SELECT following,event_at FROM channel_relationship WHERE channel_id=$1 AND user_key=$2',
      [c.id,event.user_key])
    if (state && !state.following && +state.event_at===+event.occurred_at) await endCustomerRuns(db,customer.id,'LINEブロック')
  }
  if (event.kind==='follow' && c.purpose==='customer') {
    await emitDelivery(db,customer,'line:'+event.event_id,'follow',event.occurred_at)
  }
}

export async function locationOf(db:DB,id:string) {
  const {rows:[entry]}=await db.query<Location>(`SELECT s.id,s.name,s.timezone,to_char(s.cutoff,'HH24:MI') AS cutoff,
    s.auto_enabled,s.auto_enabled_at,s.eligible_at,s.contract_active,s.monthly_limit,s.stopped,
    s.tags_enabled,s.visits_enabled,s.tags_enabled_at,s.visits_enabled_at,
    t.stopped AS tenant_stopped,concat_ws(':',t.delivery_version,s.delivery_version) AS scope_version
    FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[id])
  return entry
}

export const isEnabled=(cfg:Config,s:Location,c:Channel)=>cfg.external&&cfg.automation===true&&s.auto_enabled&&s.contract_active&&
  !!s.eligible_at&&!s.stopped&&!s.tenant_stopped&&!c.stopped&&c.purpose!=='recruitment'
const featureStop=(s:Location,graph:Graph,event:string,happenedAt:Date)=>{
  if ((!s.visits_enabled || (s.visits_enabled_at && happenedAt<s.visits_enabled_at)) &&
    ['booking_created','booking_changed','booking_cancelled','visit'].includes(event)) return '来店予約が停止または切り替えられました'
  if ((!s.tags_enabled || (s.tags_enabled_at && happenedAt<s.tags_enabled_at)) &&
    graph.nodes.some(node=>node.type==='tag'||(node.type==='branch'&&node.condition==='tag'))) return '顧客タグが停止または切り替えられました'
  return null
}

export async function endScope(db:DB, filter:'store_id=$1'|'channel_id=$1'|'true',args:string[],reason:string) {
  const arg='$'+(args.length+1)
  const {rows:[row]}=await db.query(`SELECT count(*)::int AS count FROM automatic_send
    WHERE status='submitting' AND ${filter}`,args)
  const runs=await db.query(`UPDATE enrollment SET ended_at=now(),end_reason=${arg}
    WHERE ended_at IS NULL AND ${filter}`,[...args,reason])
  await db.query(`UPDATE automatic_send SET next_at='infinity',reason=${arg}
    WHERE status IN ('unknown','submitting') AND ${filter}`,[...args,reason])
  return {inFlight:row.count as number,ended:runs.rowCount??0}
}

export async function updateAutomation(db:DB,cfg:Config,actor:Actor,id:string,input:{
  revision:number;enabled:boolean;contract:boolean;monthly_limit:number;reason:string
}) {
  await lockDispatch(db,actor.tenant_id)
  const location=await locationOf(db,id)
  if(input.enabled){
    if(!automationForStore(cfg,id,actor.tenant_id))throw new Fault(409,'AUTOMATION_SERVER_DISABLED','この店舗の配信処理がまだ許可されていません。管理窓口に確認してください。')
    if(!input.contract)throw new Fault(409,'AUTOMATION_CONTRACT_REQUIRED','先に店舗の契約とLINE運用許可を確認してください。')
    if(!location.eligible_at)throw new Fault(409,'AUTOMATION_ELIGIBILITY_REQUIRED','先に店舗の利用適格性を確認して保存してください。')
  }
  if (input.enabled) {
    // 採用専用OAだけの店舗でも自動配信を有効化できる（採用シナリオの実配信 026）。
    const {rows}=await db.query('SELECT id FROM channel')
    let verified=false
    for (const row of rows) if ((await summary(db,cfg,await channel(db,row.id))).status==='connected') verified=true
    if (!verified) throw new Fault(409,'AUTOMATION_LINE_NOT_READY','公式LINEの送受信テストと端末への到着確認が完了していません。公式LINEの接続画面で確認してください。')
  }
  const updated=await db.query(`UPDATE store SET auto_enabled=$2,contract_active=$3,monthly_limit=$4,
    auto_enabled_at=CASE WHEN $2 AND NOT auto_enabled THEN clock_timestamp() ELSE auto_enabled_at END,
    delivery_version=CASE WHEN auto_enabled<>$2 OR contract_active<>$3 THEN delivery_version+1 ELSE delivery_version END,
    revision=revision+1 WHERE id=$1 AND revision=$5 RETURNING revision`,
    [id,input.enabled,input.contract,input.monthly_limit,input.revision])
  if (!updated.rowCount) throw conflict()
  if(!input.enabled||!input.contract)await db.query("UPDATE recruitment_intake_run SET stage='cancelled',answers_box=NULL WHERE store_id=$1 AND stage NOT IN ('complete','cancelled')",[id])
  if (!input.enabled || !input.contract) {
    await endScope(db,'store_id=$1',[id],'店舗の自動配信を無効化')
    await endApplicantScope(db,'store_id=$1',[id],'店舗の自動配信を無効化')
  }
  await audit(db,actor.tenant_id,id,actor.id,'automation.settings',id,input.reason,
    {enabled:input.enabled,contract:input.contract,monthly_limit:input.monthly_limit})
  return updated.rows[0]
}

async function enroll(db:DB,c:Channel,s:Location,cfg:Config) {
  const {rows}=await db.query<Event>(`SELECT * FROM delivery_event WHERE channel_id=$1 AND handled_at IS NULL
    ORDER BY happened_at,id LIMIT 30 FOR UPDATE SKIP LOCKED`,[c.id])
  const {rows:[channelState]}=await db.query('SELECT delivery_version FROM channel WHERE id=$1',[c.id])
  const scopeVersion=s.scope_version+':'+channelState.delivery_version
  for (const ev of rows) {
    if (isEnabled(cfg,s,c) && channelReady(c) && s.auto_enabled_at && +ev.happened_at>=+s.auto_enabled_at && +ev.happened_at<=Date.now() &&
      +ev.happened_at>Date.now()-day) {
      const {rows:scenarios}=await db.query<{id:string;published_version:number;graph:Graph}>(`SELECT q.id,q.published_version,v.graph
        FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version
        WHERE q.stopped=false AND v.published_at<=$1 AND q.delivery_floor<=$1 AND v.graph->>'channel'=$2 AND v.graph->>'purpose'='customer'
        AND v.graph->>'trigger'=$3`,[ev.happened_at,c.id,ev.kind])
      for (const item of scenarios) {
        if (featureStop(s,item.graph,ev.kind,ev.happened_at)) continue
        const cst=await customerById(db,ev.customer_id)
        if (cst.all_stop || !cst.service_consent&&!cst.marketing_consent) continue
        const last=await db.query(`SELECT starts_at,ended_at FROM enrollment WHERE scenario_id=$1 AND customer_id=$2
          ORDER BY starts_at DESC LIMIT 1`,[item.id,cst.id])
        const previous=last.rows[0]
        if (previous && (!item.graph.rejoin || !previous.ended_at ||
          Date.now()-+previous.ended_at<item.graph.cooldownDays*day) &&
          !['booking_changed','booking_cancelled'].includes(ev.kind)) continue
        await db.query(`INSERT INTO enrollment (id,tenant_id,store_id,channel_id,scenario_id,version,event_id,
          customer_id,booking_id,booking_revision,node_id,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(scenario_id,event_id) DO NOTHING`,[newId(),c.tenant_id,c.store_id,c.id,item.id,item.published_version,
          ev.id,cst.id,ev.booking_id,ev.booking_revision,item.graph.entry,ev.happened_at])
      }
    }
    await db.query('UPDATE delivery_event SET handled_at=now() WHERE id=$1',[ev.id])
  }
}

const runSelect=`SELECT e.*,v.graph,q.stopped,evt.kind AS event_kind,evt.happened_at AS event_at FROM enrollment e
  JOIN scenario_version v ON v.scenario_id=e.scenario_id AND v.version=e.version
  JOIN scenario q ON q.id=e.scenario_id JOIN delivery_event evt ON evt.id=e.event_id`

async function note(db:DB,run:Run,kind:string,detail:string) {
  await db.query(`INSERT INTO delivery_note(tenant_id,store_id,channel_id,enrollment_id,kind,node_id,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[run.tenant_id,run.store_id,run.channel_id,run.id,kind,run.node_id,detail])
}
async function advance(db:DB,run:Run,next:string,at=new Date()) {
  await db.query('UPDATE enrollment SET node_id=$2,due_at=$3,wait_node=NULL WHERE id=$1',[run.id,next,at])
}
async function end(db:DB,run:Run,why:string) {
  await db.query(`UPDATE enrollment SET ended_at=now(),end_reason=$2 WHERE id=$1 AND ended_at IS NULL`,[run.id,why])
  await note(db,run,'end',why)
}

async function currentBooking(db:DB,run:Run,cst:Customer) {
  const {rows:[linked]}=await db.query<Booking>(`SELECT b.id,b.revision,b.status,s.starts_at,s.label FROM visit_booking b
    JOIN booking_slot s ON s.id=b.slot_id WHERE b.customer_id=$1 AND
    (($2::uuid IS NOT NULL AND b.id=$2) OR ($2::uuid IS NULL AND b.status='confirmed' AND s.starts_at>now()))
    ORDER BY s.starts_at LIMIT 1`,[cst.id,run.booking_id])
  return linked
}

async function liveValues(db:DB,cfg:Config,s:Location,c:Channel,cst:Customer,booking?:Booking):
  Promise<{values:Record<string,string>,bookingLinkValid:boolean}> {
  let staff=''
  if (cst.assigned_to) {
    const {rows:[owner]}=await db.query(`SELECT f.id FROM staff f WHERE f.id=$1 AND f.disabled_at IS NULL
      AND (f.role='admin' OR (f.agency_staff AND EXISTS (SELECT 1 FROM store_grant g WHERE g.staff_id=f.id AND g.store_id=$2)))`,[cst.assigned_to,s.id])
    if (owner) staff='店舗担当者'
  }
  const display=booking?new Intl.DateTimeFormat('ja-JP',{timeZone:s.timezone,dateStyle:'long',timeStyle:'short'}).format(booking.starts_at):''
  // booking_url は呼び出し側がプレースホルダで上書きする（送信直前に顧客リンクを発行して差し替える）。
  return {values:{name:cst.display_name??'',store:s.name,staff,booking:display,price:'',
    booking_url:''},bookingLinkValid:false}
}

async function barred(db:DB,cfg:Config,s:Location,c:Channel,run:Run,cst:Customer,
  booking:Booking|undefined,category:'service'|'marketing') {
  if (!isEnabled(cfg,s,c) || !channelReady(c)) return '店舗またはLINE接続の配信条件が未成立'
  if (run.stopped||run.ended_at) return 'シナリオ停止'
  const disabled=featureStop(s,run.graph,run.event_kind,run.event_at)
  if (disabled) return disabled
  if (run.event_kind==='booking_cancelled' && category!=='service') return '予約取消では業務案内だけを送信できます'
  if (run.booking_id && (!booking||booking.revision!==run.booking_revision)) return '予約が更新されました'
  if (cst.all_stop) return '全配信停止'
  if (!await automaticRelationshipReady(db,c,cst.user_key)) return '友だち状態を確認できないかブロックされています'
  const pending=await db.query(`SELECT 1 FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND stop_signal IS NOT NULL
    AND processed_at IS NULL AND occurred_at>= $3 AND ($4 OR stop_signal='all') LIMIT 1`,
    [c.id,cst.user_key,cst.preference_at,category==='marketing'])
  if (pending.rowCount) return 'LINEで配信停止を受信'
  const handling=await db.query(`SELECT 1 FROM inbox_thread x JOIN store s ON s.id=x.store_id WHERE x.channel_id=$1
    AND x.user_key=$2 AND x.purpose='customer' AND x.state='handling' AND s.inbox_enabled`,[c.id,cst.user_key])
  if (await handoffUntil(db,c.id,cst.user_key)) return '店長対応中'
  if (cst.active_chat||handling.rowCount) return '有人対応中'
  if (category==='service') return cst.service_consent?null:'業務案内の同意がありません'
  if (!cst.marketing_consent||cst.marketing_stop) return '販促の同意がありません'
  if (!cst.verified_20_at) return '20歳以上の確認がありません'
  if (run.event_kind==='follow' && (booking || (cst.last_reply_at&&+cst.last_reply_at>=+run.event_at))) {
    return '予約済みまたは返信済み'
  }
  return null
}

async function allowance(db:DB,s:Location,run:Run,cst:Customer,category:string,except?:string) {
  return messageBudget(db,s,cst.id,category==='marketing'?run.graph:undefined,except)
}

async function step(db:DB,cfg:Config,s:Location,c:Channel,run:Run):Promise<Job|null> {
  const node=run.graph.nodes.find(n=>n.id===run.node_id)
  if (!node || run.stopped || !isEnabled(cfg,s,c)) { await end(db,run,'シナリオ停止または配信無効');return null }
  const disabled=featureStop(s,run.graph,run.event_kind,run.event_at)
  if (disabled) {await end(db,run,disabled);return null}
  const p=await customerById(db,run.customer_id)
  const booking=await currentBooking(db,run,p)
  if (p.all_stop || run.booking_id && booking?.revision!==run.booking_revision) {
    await end(db,run,'配信停止または旧予約版')
    return null
  }
  await db.query(`INSERT INTO delivery_note(tenant_id,store_id,channel_id,enrollment_id,kind,node_id,detail) VALUES($1,$2,$3,$4,'studio_visit',$5,'ステップ到達') ON CONFLICT DO NOTHING`,[run.tenant_id,run.store_id,run.channel_id,run.id,node.id])
  if (node.type==='end') {await end(db,run,'完了');return null}
  if (node.type==='wait') {
    if (run.wait_node===node.id) await advance(db,run,node.next,run.due_at)
    else {
      const anchor=+run.due_at
      const time=waitUntil(node,anchor,s.timezone,s.cutoff,booking?+booking.starts_at:null)
      if (time===null || time<anchor || node.mode==='booking' && time<Date.now()-30*minute) {
        await end(db,run,'待機の基準時刻を過ぎたため保留')
      } else await db.query('UPDATE enrollment SET due_at=$2,wait_node=$3 WHERE id=$1',[run.id,new Date(time),node.id])
    }
    return null
  }
  if (node.type==='branch') {
    const states={booked:booking?.status==='confirmed',consent:p.service_consent,adult:!!p.verified_20_at,
      responded:!!p.last_reply_at,assigned:!!p.assigned_to,tag:p.tags.includes(node.tag??'')}
    const passed=evaluateBranch(node,states,p.tags)
    await note(db,run,'branch',passed?'はい':'いいえ')
    await advance(db,run,passed?node.yes:node.no,run.due_at)
    return null
  }
  if (node.type==='tag'||node.type==='task') {
    if (node.type==='tag') {
      if (node.action==='remove') await db.query(`UPDATE customer SET tags=array_remove(tags,$2),revision=revision+1,updated_at=now()
        WHERE id=$1 AND $2=ANY(tags)`,[p.id,node.tag])
      else await db.query(`UPDATE customer SET tags=array_append(tags,$2),revision=revision+1,updated_at=now()
        WHERE id=$1 AND NOT $2=ANY(tags) AND cardinality(tags)<30`,[p.id,node.tag])
    }
    await note(db,run,node.type,node.type==='tag'?(node.action==='remove'?'解除：':'付与：')+node.tag:node.note)
    await advance(db,run,node.next,run.due_at)
    return null
  }
  const reason=await barred(db,cfg,s,c,run,p,booking,node.category)
  const now=Date.now()
  const due=node.category==='marketing'?nextWindow(now,run.graph,s.timezone):now
  const expired=now-+run.due_at>30*minute
  if (!reason && !expired && due!==null && due>now) {
    await db.query('UPDATE enrollment SET due_at=$2 WHERE id=$1',[run.id,new Date(due)])
    return null
  }
  const id=newId()
  const person=await liveValues(db,cfg,s,c,p,booking)
  // 来店予約・設定URLは実URLをこの時点では発行せず、プレースホルダで封緘する（発行は submit 直前）。
  // 発行条件を満たさない場合は、このメッセージを保留してURLを送らない（面談のシナリオ経路と同じ挙動）。
  let linkHeld:string|null=null
  if (node.body.includes(CUSTOMER_LINK_MARKER)) {
    if (await customerLinkEligible(db,c,c.generation,p.user_key,true)) {
      person.values.customer_link=customerLinkPlaceholder(id)
    } else linkHeld='来店予約・設定URLの発行条件を満たしていません'
  }
  // 予約変更URLも実URLをこの時点では発行せず、プレースホルダで封緘する（発行は submit 直前）。
  // 予約がない、または発行条件を満たさない場合は、このメッセージを保留してURLを送らない。
  if (!linkHeld && usesBookingUrl(node.body)) {
    if (booking && await customerLinkEligible(db,c,c.generation,p.user_key,true)) {
      person.values.booking_url=bookingUrlPlaceholder(id)
      person.bookingLinkValid=true
    } else linkHeld='予約変更URLの発行条件を満たしていません'
  }
  const exclude=reason || (expired||due===null?'予定時刻を過ぎたため保留':null) || linkHeld ||
    await allowance(db,s,run,p,node.category)
  const rendered=renderMessage(node.body,person)
  if (exclude || !rendered.message) {
    await note(db,run,'held',exclude??rendered.reason??'差し込み値がありません')
    await advance(db,run,node.next,run.due_at)
    return null
  }
  const result=await db.query<Job>(`INSERT INTO automatic_send(id,tenant_id,store_id,channel_id,enrollment_id,
    customer_id,node_id,body_box,category,generation,status,next_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting',now()+interval '45 seconds')
    ON CONFLICT(enrollment_id,node_id) DO NOTHING RETURNING *`,
    [id,c.tenant_id,c.store_id,c.id,run.id,p.id,node.id,seal(cfg,'automatic:'+id,rendered.message),node.category,c.generation])
  return result.rows[0]??null
}

async function chooseJob(db:DB,cfg:Config,c:Channel,s:Location) {
  const {rows:[retry]}=await db.query<Job>(`SELECT * FROM automatic_send WHERE channel_id=$1
    AND status IN ('submitting','unknown') AND next_at<=now() ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[c.id])
  if (retry) {
    const {rows:[job]}=await db.query<Job>(`UPDATE automatic_send SET status='submitting',
      attempt=attempt+1,next_at=now()+interval '45 seconds' WHERE id=$1 RETURNING *`,[retry.id])
    return job
  }
  const {rows}=await db.query<Run>(runSelect+` WHERE e.channel_id=$1 AND e.ended_at IS NULL AND e.due_at<=now()
    AND NOT EXISTS (SELECT 1 FROM automatic_send x WHERE x.enrollment_id=e.id AND x.node_id=e.node_id)
    ORDER BY e.due_at,e.id LIMIT 20 FOR UPDATE OF e SKIP LOCKED`,[c.id])
  for (const run of rows) {
    const job=await step(db,cfg,s,c,run)
    if (job) return job
  }
  return null
}

export async function runAutomation(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route) {
  const scoped=<T>(work:(db:DB)=>Promise<T>)=>tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    return work(db)
  })
  const job=await scoped(async db=>{
    const c=await channel(db,r.id)
    const s=await locationOf(db,r.store_id)
    await enroll(db,c,s,cfg)
    if (!cfg.external || !cfg.automation) return null
    return chooseJob(db,cfg,c,s)
  })
  if (!job) return
  const quota=await tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    const c=await channel(db,r.id)
    if (!channelReady(c) || c.generation!==job.generation) return null
    return c
  })
  let remaining:number|null=null
  if (quota) {
    try {remaining=await api.quota(channelCredentials(cfg,quota))}
    catch { /* External quota verification is required before a new LINE request. */ }
  }
  const submitted=await scoped(async db=>{
    const {rows:[fresh]}=await db.query<Job>('SELECT * FROM automatic_send WHERE id=$1 FOR UPDATE',[job.id])
    if (fresh.status!=='submitting'||fresh.attempt!==job.attempt) return null
    const {rows:[run]}=await db.query<Run>(runSelect+' WHERE e.id=$1',[job.enrollment_id])
    const p=await customerById(db,job.customer_id)
    const c=await channel(db,r.id)
    const s=await locationOf(db,r.store_id)
    const booking=await currentBooking(db,run,p)
    const current=run.graph.nodes.find(node=>node.id===job.node_id)
    const person=await liveValues(db,cfg,s,c,p,booking)
    // 封緘時と同じプレースホルダで再描画し、差し込み値の同一性を照合する（実URLはまだ発行しない）。
    if (current?.type==='message' && current.body.includes(CUSTOMER_LINK_MARKER)) {
      person.values.customer_link=customerLinkPlaceholder(job.id)
    }
    if (current?.type==='message' && usesBookingUrl(current.body) && booking) {
      person.values.booking_url=bookingUrlPlaceholder(job.id)
      person.bookingLinkValid=true
    }
    const expected=current?.type==='message' ? renderMessage(current.body,person).message : undefined
    const body=job.body_box?unseal(cfg,'automatic:'+job.id,job.body_box):''
    const time=Date.now()
    const reason=fresh.next_at===Infinity?'停止または予約変更後のジョブ':
      job.attempt>3 || time-+job.first_attempt_at>30*minute?'再試行期限を超過':
      c.generation!==job.generation?'LINE認証情報が変更されました':expected!==body?'差し込み値が変更されました':
      (job.category==='marketing' && nextWindow(time,run.graph,s.timezone)!==time)?'配信可能時間外':
      (await barred(db,cfg,s,c,run,p,booking,job.category)) || await allowance(db,s,run,p,job.category,job.id) ||
      (remaining===null?'LINEの通数を確認できません':remaining<=0?'LINEの月間通数に達しました':null)
    if (reason) {
      await db.query(`UPDATE automatic_send SET status=$2,reason=$3,next_at='infinity',body_box=NULL WHERE id=$1`,
        [job.id,job.attempt===1?'cancelled':'unknown',reason])
      await end(db,run,reason)
      return null
    }
    const to=unseal(cfg,'customer:'+c.id+':'+p.user_key,p.line_address)
    let sendBody=body
    const richLinks:Record<string,string>={}
    const placeholders=[customerLinkPlaceholder(job.id),bookingUrlPlaceholder(job.id)].filter(p=>body.includes(p))
    if (placeholders.length) {
      // 来店予約・設定URL／予約変更URLは送信の直前に受信者ごと発行する（トークンの3時間期限は送信時点から数える）。
      // 発行条件を満たさなくなっていた場合は、プレースホルダのまま送らず送信を取りやめる。
      const abort=async (why:string)=>{
        await db.query(`UPDATE automatic_send SET status=$2,reason=$3,next_at='infinity',body_box=NULL WHERE id=$1`,
          [job.id,job.attempt===1?'cancelled':'unknown',why])
        await end(db,run,why)
        return null
      }
      if (!await customerLinkEligible(db,c,c.generation,p.user_key,true)) {
        return abort(body.includes(customerLinkPlaceholder(job.id))
          ?'来店予約・設定URLの発行条件を満たしません':'予約変更URLの発行条件を満たしません')
      }
      const link=await issueCustomerLinkToken(db,cfg,c,to)
      await audit(db,c.tenant_id,c.store_id,null,'customer_link.issue',link.id,null,
        {channel_id:c.id,source:'scenario_auto',enrollment_id:run.id})
      richLinks[CUSTOMER_LINK_MARKER]=link.url
      sendBody=placeholders.reduce((text,p)=>text.split(p).join(link.url),body)
      if (sendBody.length>5000) return abort('差し込み後に5000文字を超えています')
    }
    let richFormat
    try{richFormat=resolveRichButtons(current?.type==='message'?current.rich:undefined,richLinks)}catch{
      const reason='予約ボタンのURLを確認できません'
      await db.query(`UPDATE automatic_send SET status=$2,reason=$3,next_at='infinity',body_box=NULL WHERE id=$1`,[job.id,job.attempt===1?'cancelled':'unknown',reason])
      await end(db,run,reason);return null
    }
    return {run,next:current?.type==='message'?current.next:'',promise:api.push(channelCredentials(cfg,c),to,job.id,sendBody,richFormat)
      .catch(()=>({status:'unknown',requestId:null,authError:false}))}
  })
  if (!submitted) return
  const result=await submitted.promise
  await scoped(async db=>{
    const finalStatus=job.attempt>1 && result.status==='failed'?'unknown':result.status
    const {rows:[resultRow]}=await db.query(`UPDATE automatic_send SET status=$2,line_request_id=$3,
      reason=coalesce(reason,CASE WHEN $2='failed' THEN 'LINEが送信要求を拒否'
        WHEN $5 THEN '再試行が拒否されたため初回の結果を確認できません' END),
      accepted_at=CASE WHEN $2='accepted' THEN now() ELSE accepted_at END,
      body_box=CASE WHEN next_at='infinity' OR $2<>'unknown' OR attempt>=3 OR $5 THEN NULL ELSE body_box END,
      next_at=CASE WHEN next_at='infinity' OR $2<>'unknown' OR attempt>=3 OR $5 THEN 'infinity'
       ELSE now()+interval '1 minute' * attempt END
      WHERE id=$1 AND attempt=$4 AND status='submitting' RETURNING next_at`,[job.id,finalStatus,result.requestId,job.attempt,job.attempt>1 && result.status==='failed'])
    if (!resultRow) return
    if (result.authError) await db.query(`UPDATE channel SET checks=checks-'token_verified'-'webhook_verified',
      revision=revision+1 WHERE id=$1 AND generation=$2`,[r.id,job.generation])
    if (result.status==='accepted') {
      await note(db,submitted.run,'accepted','LINE受付済')
      await advance(db,submitted.run,submitted.next)
    } else if (resultRow.next_at===Infinity) await end(db,submitted.run,finalStatus==='failed'?'送信失敗':'送信結果不明')
  })
}
