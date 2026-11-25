import {resolveRichButtons} from '../public/studio/message-format.mjs'
import type pg from 'pg'
import { renderMessage, waitUntil, branchRules, evaluateBranch } from '../public/studio/engine.mjs'
import { audit, keyed, newId, scope, seal, tx, unseal, type Config, type DB, type Route } from './core.js'
import { automaticRelationshipReady, channel, channelCredentials, channelReady, type Channel, type LineAPI } from './line.js'
import { locationOf } from './automation.js'
import { lockDispatch } from './dispatch-lock.js'
import type { Graph } from './scenario.js'
import { messageBudget } from './delivery-budget.js'
import { INTERVIEW_LINK_MARKER, interviewLinkEligible, issueInterviewLinkToken } from './interview-link.js'
import { contactAddress, rememberContact } from './rich-menus.js'
import { emitApplicantEvent } from './applicant-events.js'
import { applicantTags, applyApplicantTagRules, setScenarioTag, tagCampaignForRun, validApplicantTagsForRun } from './applicant-tags.js'
import { deliveryScope } from './delivery-budget.js'
export { emitApplicantEvent } from './applicant-events.js'

// 採用シナリオの実配信（026）。顧客側 automation.ts と同じ構造で、主体だけを
// customer から workflow_contact（purpose='recruitment'）+ applicant_key に替えたもの。
// {{interview_link}} は送信直前に受信者ごと発行するため、step 時点では送信ジョブIDを含む
// プレースホルダURLで描画して封緘し、submit 直前に実URLへ差し替える（テスト送信と同じ発行部品を使う）。
const interviewLinkPlaceholder=(sendId:string)=>'https://link.invalid/interview-link/'+sendId

const minute=60000
const day=1440*minute
type Location = Awaited<ReturnType<typeof locationOf>>
type AEvent = { id:string;applicant_key:string;kind:string;booking_id:string|null;booking_revision:number|null;happened_at:Date;scope_version:string;tag_key:string|null;campaign_id:string|null }
type Contact = { channel_id:string;purpose:string;subject:string;user_key:string;recipient_box:string;
  notices:boolean;notices_changed_at:Date }
type ARun = { id:string;tenant_id:string;store_id:string;channel_id:string;scenario_id:string;applicant_key:string
  node_id:string;wait_node:string|null;due_at:Date;event_kind:string;graph:Graph;booking_id:string|null
  booking_revision:number|null;event_at:Date;campaign_id:string|null;stopped:boolean;ended_at:Date|null;end_reason:string|null }
type AJob = { id:string;enrollment_id:string;applicant_key:string;node_id:string;body_box:string|null;
  category:'service'|'marketing';status:string;generation:number;attempt:number;first_attempt_at:Date;
  next_at:Date|number;reason:string|null }
type IBooking = { id:string;status:string;revision:number;starts_at:Date;applicant_name:string }


export const recruitmentEnabled=(cfg:Config,s:Location,c:Channel)=>cfg.external&&cfg.automation===true&&s.auto_enabled&&
  s.contract_active&&!!s.eligible_at&&!s.stopped&&!s.tenant_stopped&&!c.stopped&&
  (c.purpose==='recruitment'||c.purpose==='shared')

export async function endApplicantRuns(db:DB,channelId:string,applicantKey:string,reason:string) {
  await db.query(`UPDATE applicant_enrollment SET ended_at=now(),end_reason=$3
    WHERE channel_id=$1 AND applicant_key=$2 AND ended_at IS NULL`,[channelId,applicantKey,reason])
  await db.query(`UPDATE applicant_send SET next_at='infinity',reason=$3
    WHERE channel_id=$1 AND applicant_key=$2 AND status IN ('unknown','submitting')`,[channelId,applicantKey,reason])
}

export async function endApplicantScope(db:DB, filter:'store_id=$1'|'channel_id=$1'|'true',args:string[],reason:string) {
  const arg='$'+(args.length+1)
  const {rows:[row]}=await db.query(`SELECT count(*)::int AS count FROM applicant_send
    WHERE status='submitting' AND ${filter}`,args)
  const runs=await db.query(`UPDATE applicant_enrollment SET ended_at=now(),end_reason=${arg}
    WHERE ended_at IS NULL AND ${filter}`,[...args,reason])
  await db.query(`UPDATE applicant_send SET next_at='infinity',reason=${arg}
    WHERE status IN ('unknown','submitting') AND ${filter}`,[...args,reason])
  return {inFlight:row.count as number,ended:runs.rowCount??0}
}

async function contactByKey(db:DB,channelId:string,applicantKey:string) {
  const {rows:[contact]}=await db.query<Contact>(`SELECT * FROM workflow_contact
    WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2`,[channelId,applicantKey])
  return contact as Contact|undefined
}
async function contactByUser(db:DB,channelId:string,userKey:string) {
  const {rows:[contact]}=await db.query<Contact>(`SELECT * FROM workflow_contact
    WHERE channel_id=$1 AND purpose='recruitment' AND user_key=$2 ORDER BY last_seen_at DESC LIMIT 1`,
    [channelId,userKey])
  return contact as Contact|undefined
}

// 受信側: 採用OAの友だち追加で連絡先を登録して follow イベントを発行し、
// ブロックと「全配信停止」で進行中のランを終了する（顧客側 processCustomerWebhook の応募者版）。
// 兼用OAでは follow 起点の登録はしない（用途の振り分けができないため）。ブロック・停止の終了は兼用でも行う。
export async function processRecruitmentWebhook(db:DB,cfg:Config,c:Channel,event:{
  event_id:string;generation:number;user_key:string|null;recipient_box:string|null;kind:string
  occurred_at:Date;stop_signal:string|null
}) {
  if (!event.user_key || event.generation!==c.generation) return
  if (event.kind==='unfollow') {
    const contact=await contactByUser(db,c.id,event.user_key)
    if (!contact) return
    const {rows:[state]}=await db.query('SELECT following,event_at FROM channel_relationship WHERE channel_id=$1 AND user_key=$2',
      [c.id,event.user_key])
    if (state && !state.following && +state.event_at===+event.occurred_at) {
      await endApplicantRuns(db,c.id,contact.subject,'LINEブロック')
    }
    return
  }
  if (event.kind==='message' && event.stop_signal==='all') {
    const contact=await contactByUser(db,c.id,event.user_key)
    if (contact) await endApplicantRuns(db,c.id,contact.subject,'LINEから配信停止')
    return
  }
  if (c.purpose!=='recruitment') return
  if (event.kind==='follow' && event.recipient_box) {
    const user=unseal(cfg,'webhook:'+c.id+':'+event.event_id,event.recipient_box)
    const applicantKey=keyed(cfg,'interview:'+c.id+':'+user)
    await rememberContact(db,cfg,c,user,
      {tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.id,purpose:'recruitment',subject:applicantKey})
    await applyApplicantTagRules(db,{tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.id,applicant_key:applicantKey},'follow',event.occurred_at)
    await emitApplicantEvent(db,{tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.id,applicant_key:applicantKey},
      'line:'+event.event_id,'follow',event.occurred_at)
  }
}

async function enrollApplicants(db:DB,c:Channel,s:Location,cfg:Config) {
  const {rows}=await db.query<AEvent>(`SELECT * FROM applicant_event WHERE channel_id=$1 AND handled_at IS NULL
    ORDER BY happened_at,id LIMIT 30 FOR UPDATE SKIP LOCKED`,[c.id])
  for (const ev of rows) {
    if (recruitmentEnabled(cfg,s,c) && channelReady(c) && s.auto_enabled_at && +ev.happened_at>=+s.auto_enabled_at &&
      +ev.happened_at<=Date.now() && +ev.happened_at>Date.now()-day) {
      const identity={channel_id:c.id,applicant_key:ev.applicant_key}
      const tagEvent=['tag_added','tag_campaign'].includes(ev.kind)
      const campaign=ev.campaign_id?await tagCampaignForRun(db,ev.campaign_id,identity):null
      if(tagEvent&&(ev.scope_version!==await deliveryScope(db,c.id)||ev.kind==='tag_campaign'&&!campaign||ev.kind==='tag_added'&&(!ev.tag_key||!(await applicantTags(db,identity)).includes(ev.tag_key)))){
        await db.query('UPDATE applicant_event SET handled_at=now() WHERE id=$1',[ev.id]);continue
      }
      const {rows:scenarios}=await db.query<{id:string;published_version:number;graph:Graph}>(`SELECT q.id,v.version AS published_version,v.graph
        FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=CASE WHEN $4::uuid IS NOT NULL THEN $5 ELSE q.published_version END
        WHERE ($4::uuid IS NULL OR q.id=$4) AND q.stopped=false AND v.published_at<=$1 AND q.delivery_floor<=$1 AND v.graph->>'channel'=$2 AND v.graph->>'purpose'='recruitment'
        AND v.graph->>'trigger'=$3 AND ($3<>'tag_added' OR v.graph->>'triggerTag'=$6)`,[ev.happened_at,c.id,ev.kind,campaign?.scenario_id??null,campaign?.scenario_version??null,ev.tag_key])
      // Only the actual triggering tag's scenarios need contact/catalog reads.
      const contact=scenarios.length?await contactByKey(db,c.id,ev.applicant_key):undefined
      for (const item of scenarios) {
        if(!await validApplicantTagsForRun(db,c.store_id,item.graph,ev.happened_at))continue
        // 顧客側の同意チェックに相当するものとして、通知の同意（notices）がある応募者だけを登録する。
        if (!contact || !contact.notices) continue
        const last=await db.query(`SELECT starts_at,ended_at FROM applicant_enrollment WHERE scenario_id=$1 AND applicant_key=$2
          ORDER BY starts_at DESC LIMIT 1`,[item.id,ev.applicant_key])
        const previous=last.rows[0]
        if (previous && (!item.graph.rejoin || !previous.ended_at ||
          Date.now()-+previous.ended_at<item.graph.cooldownDays*day) &&
          !['interview_changed','interview_cancelled','tag_campaign'].includes(ev.kind)) continue
        if(ev.kind==='tag_campaign'&&previous&&!previous.ended_at)continue
        await db.query(`INSERT INTO applicant_enrollment (id,tenant_id,store_id,channel_id,scenario_id,version,event_id,
          applicant_key,booking_id,booking_revision,node_id,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(scenario_id,event_id) DO NOTHING`,[newId(),c.tenant_id,c.store_id,c.id,item.id,item.published_version,
          ev.id,ev.applicant_key,ev.booking_id,ev.booking_revision,item.graph.entry,ev.happened_at])
      }
    }
    await db.query('UPDATE applicant_event SET handled_at=now() WHERE id=$1',[ev.id])
  }
  return rows.length
}

const runSelect=`SELECT e.*,v.graph,q.stopped,evt.kind AS event_kind,evt.happened_at AS event_at,evt.campaign_id FROM applicant_enrollment e
  JOIN scenario_version v ON v.scenario_id=e.scenario_id AND v.version=e.version
  JOIN scenario q ON q.id=e.scenario_id JOIN applicant_event evt ON evt.id=e.event_id`

async function advance(db:DB,run:ARun,next:string,at=new Date(),note?:{kind:string;detail:string}) {
  if(note){
    await db.query(`WITH moved AS (
      UPDATE applicant_enrollment SET node_id=$2,due_at=$3,wait_node=NULL WHERE id=$1
      RETURNING tenant_id,store_id,channel_id,id
    ) INSERT INTO applicant_note(tenant_id,store_id,channel_id,enrollment_id,kind,node_id,detail)
      SELECT tenant_id,store_id,channel_id,id,$4,$5,$6 FROM moved`,
      [run.id,next,at,note.kind,run.node_id,note.detail])
  }else await db.query('UPDATE applicant_enrollment SET node_id=$2,due_at=$3,wait_node=NULL WHERE id=$1',[run.id,next,at])
  run.node_id=next;run.due_at=at;run.wait_node=null
}
async function end(db:DB,run:ARun,why:string) {
  await db.query(`WITH ended AS (
    UPDATE applicant_enrollment SET ended_at=now(),end_reason=$2 WHERE id=$1 AND ended_at IS NULL
  ) INSERT INTO applicant_note(tenant_id,store_id,channel_id,enrollment_id,kind,node_id,detail)
    VALUES($3,$4,$5,$1,'end',$6,$2)`,[run.id,why,run.tenant_id,run.store_id,run.channel_id,run.node_id])
  run.ended_at=new Date();run.end_reason=why
}

// Read contact and the relevant reservation in one fresh snapshot, not a
// shared cache. A missing row on either side remains independently visible.
async function applicantFacts(db:DB,run:ARun) {
  const {rows:[row]}=await db.query<Contact & {booking_id:string|null;booking_revision:number;booking_status:string;booking_starts_at:Date;applicant_name:string}>(`
    SELECT w.*,b.id AS booking_id,b.revision AS booking_revision,b.status AS booking_status,
      b.starts_at AS booking_starts_at,b.applicant_name
    FROM (SELECT 1) base
    LEFT JOIN LATERAL (
      SELECT channel_id,purpose,subject,user_key,recipient_box,notices,notices_changed_at FROM workflow_contact
      WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT b.id,b.revision,b.status,s.starts_at,b.applicant_name
      FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
      WHERE b.channel_id=$1 AND b.applicant_key=$2 AND
      (($3::uuid IS NOT NULL AND b.id=$3) OR ($3::uuid IS NULL AND b.status='confirmed' AND s.starts_at>now()))
      ORDER BY s.starts_at LIMIT 1
    ) b ON true`,[run.channel_id,run.applicant_key,run.booking_id])
  const contact:Contact|undefined=row.channel_id?{
    channel_id:row.channel_id,purpose:row.purpose,subject:row.subject,user_key:row.user_key,
    recipient_box:row.recipient_box,notices:row.notices,notices_changed_at:row.notices_changed_at
  }:undefined
  const booking:IBooking|undefined=row.booking_id?{
    id:row.booking_id,revision:row.booking_revision,status:row.booking_status,
    starts_at:row.booking_starts_at,applicant_name:row.applicant_name
  }:undefined
  return {contact,booking}
}

async function liveValues(db:DB,cfg:Config,s:Location,c:Channel,run:ARun,body:string,booking?:IBooking):
  Promise<{values:Record<string,string>,bookingLinkValid:boolean}> {
  // Avoid fetching personal details or formatting dates that the message
  // does not reference. The renderer still enforces all required variables.
  const needsName=/\{\{\s*name\s*\}\}/.test(body)
  let name=needsName?(booking?.applicant_name??''):''
  if (needsName&&!name) {
    const {rows:[latest]}=await db.query<{applicant_name:string}>(`SELECT applicant_name FROM interview_booking
      WHERE channel_id=$1 AND applicant_key=$2 ORDER BY updated_at DESC LIMIT 1`,[c.id,run.applicant_key])
    name=latest?.applicant_name??''
  }
  if (needsName&&!name) {
    const {rows:[rc]}=await db.query<{display_name_box:string|null}>(`SELECT display_name_box FROM recruitment_case
      WHERE channel_id=$1 AND applicant_key=$2`,[c.id,run.applicant_key])
    if (rc?.display_name_box) {
      try { name=unseal(cfg,'recruitment-name:'+c.id+':'+run.applicant_key,rc.display_name_box) } catch { name='' }
    }
  }
  const display=booking&&/\{\{\s*booking\s*\}\}/.test(body)?new Intl.DateTimeFormat('ja-JP',{timeZone:s.timezone,dateStyle:'long',timeStyle:'short'}).format(booking.starts_at):''
  // booking_url / customer_link は応募者には発行先がないため常に空（本文で使われていれば描画側が保留にする）。
  // interview_link は呼び出し側がプレースホルダで上書きする（送信直前に実URLを発行して差し替える）。
  return {values:{name,store:s.name,staff:'',booking:display,price:'',booking_url:'',customer_link:''},bookingLinkValid:false}
}

async function applicantBarred(db:DB,cfg:Config,s:Location,c:Channel,run:ARun,
  contact:Contact|undefined,booking:IBooking|undefined,tagPolicyChecked=false) {
  if (!recruitmentEnabled(cfg,s,c) || !channelReady(c)) return '店舗またはLINE接続の配信条件が未成立'
  if (run.stopped||run.ended_at) return 'シナリオ停止'
  // The claim already checked the catalog and campaign under the same lock.
  // The independent pre-send transaction always performs both checks again.
  if(!tagPolicyChecked){
    if(!await validApplicantTagsForRun(db,c.store_id,run.graph,run.event_at))return '採用タグ機能が停止または変更されました'
    if(run.campaign_id&&!await tagCampaignForRun(db,run.campaign_id,run))return 'タグ条件が変更されたか絞り込み配信が停止されました'
  }
  if (run.booking_id && (!booking||booking.revision!==run.booking_revision)) return '予約が更新されました'
  if (!contact) return '応募者の連絡先がありません'
  if (!contact.notices) return '通知の同意がありません'
  const node=run.graph.nodes.find(n=>n.id===run.node_id)
  if(node?.type==='message'&&node.tagGuard){
    const guard=node.tagGuard,tags=await applicantTags(db,run)
    if(!tags.includes(guard.tag)||guard.exclude.some(key=>tags.includes(key)))return '送信直前の採用タグ条件に一致しません'
    if(guard.booked!==undefined&&guard.booked!==(booking?.status==='confirmed'))return '送信直前の面談予約条件に一致しません'
  }
  if (!await automaticRelationshipReady(db,c,contact.user_key)) return '友だち状態を確認できないかブロックされています'
  const {rows:[guards]}=await db.query<{pending_stop:boolean;handoff:boolean;handling:boolean;replied:boolean}>(`SELECT
    EXISTS(SELECT 1 FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND stop_signal IS NOT NULL
      AND processed_at IS NULL AND occurred_at>=$3) AS pending_stop,
    EXISTS(SELECT 1 FROM line_handoff WHERE channel_id=$1 AND user_key=$2 AND until_at>now()) AS handoff,
    EXISTS(SELECT 1 FROM inbox_thread x JOIN store s ON s.id=x.store_id WHERE x.channel_id=$1
      AND x.user_key=$2 AND x.purpose='recruitment' AND x.state='handling' AND s.inbox_enabled) AS handling,
    ($4::boolean AND EXISTS(SELECT 1 FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND kind='message'
      AND occurred_at>=$5)) AS replied`,[c.id,contact.user_key,contact.notices_changed_at,run.event_kind==='follow',run.event_at])
  if(guards.pending_stop)return 'LINEで配信停止を受信'
  if(guards.handoff)return '店長対応中'
  if(guards.handling)return '有人対応中'
  if(run.event_kind==='follow'&&(booking||guards.replied))return '予約済みまたは返信済み'
  return null
}

async function step(db:DB,cfg:Config,s:Location,c:Channel,run:ARun):Promise<AJob|null> {
  const node=run.graph.nodes.find(n=>n.id===run.node_id)
  if (!node || run.stopped || !recruitmentEnabled(cfg,s,c)) { await end(db,run,'シナリオ停止または配信無効');return null }
  if(!await validApplicantTagsForRun(db,c.store_id,run.graph,run.event_at)||run.campaign_id&&!await tagCampaignForRun(db,run.campaign_id,run)){await end(db,run,'採用タグ機能または配信条件の変更');return null}
  const {contact,booking}=await applicantFacts(db,run)
  if ((contact && !contact.notices) || run.booking_id && booking?.revision!==run.booking_revision) {
    await end(db,run,'配信停止または旧予約版')
    return null
  }
  await db.query(`INSERT INTO applicant_note(tenant_id,store_id,channel_id,enrollment_id,kind,node_id,detail) VALUES($1,$2,$3,$4,'studio_visit',$5,'ステップ到達') ON CONFLICT DO NOTHING`,[run.tenant_id,run.store_id,run.channel_id,run.id,node.id])
  if (node.type==='end') {await end(db,run,'完了');return null}
  if (node.type==='wait') {
    if (run.wait_node===node.id) await advance(db,run,node.next,run.due_at)
    else {
      const anchor=+run.due_at
      const time=waitUntil(node,anchor,s.timezone,s.cutoff,booking?+booking.starts_at:null)
      if (time===null || time<anchor || node.mode==='booking' && time<Date.now()-30*minute) {
        await end(db,run,'待機の基準時刻を過ぎたため保留')
      } else {
        await db.query('UPDATE applicant_enrollment SET due_at=$2,wait_node=$3 WHERE id=$1',[run.id,new Date(time),node.id])
        run.due_at=new Date(time);run.wait_node=node.id
      }
    }
    return null
  }
  if (node.type==='branch') {
    let responded=false
    if (contact && branchRules(node).some(r=>r.condition==='responded')) {
      const reply=await db.query(`SELECT 1 FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND kind='message' LIMIT 1`,
        [c.id,contact.user_key])
      responded=!!reply.rowCount
    }
    const tags=branchRules(node).some(r=>r.condition==='tag')?await applicantTags(db,run):[]
    const states={booked:booking?.status==='confirmed',consent:!!contact?.notices,adult:false,
      responded,assigned:false}
    const passed=evaluateBranch(node,states,tags)
    await advance(db,run,passed?node.yes:node.no,run.due_at,{kind:'branch',detail:passed?'はい':'いいえ'})
    return null
  }
  if (node.type==='tag'||node.type==='task') {
    if(node.type==='tag'){
      const saved=await setScenarioTag(db,run,node.tag,node.action!=='remove')
      if(!saved){await end(db,run,'採用タグが無効になりました');return null}
      await advance(db,run,node.next,run.due_at,{kind:'tag',detail:(node.action==='remove'?'解除：':'付与：')+node.tag})
    }else await advance(db,run,node.next,run.due_at,{kind:'task',detail:node.note})
    return null
  }
  const reason=await applicantBarred(db,cfg,s,c,run,contact,booking,true)
  const now=Date.now()
  const expired=now-+run.due_at>(run.campaign_id?day:30*minute)
  const id=newId()
  const person=await liveValues(db,cfg,s,c,run,node.body,booking)
  // 面談予約URLは実URLをこの時点では発行せず、プレースホルダで封緘する（発行は submit 直前）。
  // 発行条件を満たさない場合は、このメッセージを保留してURLを送らない（テスト送信と同じ挙動）。
  let linkHeld:string|null=null
  if (node.body.includes(INTERVIEW_LINK_MARKER)) {
    if (contact && await interviewLinkEligible(db,c,c.generation,contact.user_key,true)) {
      person.values.interview_link=interviewLinkPlaceholder(id)
    } else linkHeld='面談予約URLの発行条件を満たしていません'
  }
  const exclude=reason || (expired?'予定時刻を過ぎたため保留':null) || linkHeld ||
    await messageBudget(db,s,null,undefined)
  const rendered=renderMessage(node.body,person)
  if (exclude || !rendered.message) {
    await advance(db,run,node.next,run.due_at,{kind:'held',detail:exclude??rendered.reason??'差し込み値がありません'})
    return null
  }
  const result=await db.query<AJob>(`INSERT INTO applicant_send(id,tenant_id,store_id,channel_id,enrollment_id,
    applicant_key,node_id,body_box,category,generation,status,next_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting',now()+interval '45 seconds')
    ON CONFLICT(enrollment_id,node_id) DO NOTHING RETURNING *`,
    [id,c.tenant_id,c.store_id,c.id,run.id,run.applicant_key,node.id,seal(cfg,'applicant:'+id,rendered.message),node.category,c.generation])
  return result.rows[0]??null
}

async function chooseJob(db:DB,cfg:Config,c:Channel,s:Location,campaignOnly=false) {
  const {rows:[retry]}=await db.query<AJob>(`SELECT * FROM applicant_send WHERE channel_id=$1
    AND status IN ('submitting','unknown') AND next_at<=now()
    AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM applicant_enrollment n JOIN applicant_event e ON e.id=n.event_id WHERE n.id=applicant_send.enrollment_id AND e.campaign_id IS NOT NULL))
    ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[c.id,campaignOnly])
  if (retry) {
    const {rows:[job]}=await db.query<AJob>(`UPDATE applicant_send SET status='submitting',
      attempt=attempt+1,next_at=now()+interval '45 seconds' WHERE id=$1 RETURNING *`,[retry.id])
    return {job,advanced:true}
  }
  const {rows}=await db.query<ARun>(runSelect+` WHERE e.channel_id=$1 AND e.ended_at IS NULL AND e.due_at<=now()
    AND (NOT $2::boolean OR evt.campaign_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM applicant_send x WHERE x.enrollment_id=e.id AND x.node_id=e.node_id)
    ORDER BY e.due_at,e.id LIMIT 20 FOR UPDATE OF e SKIP LOCKED`,[c.id,campaignOnly])
  // Drain zero-delay nodes under the existing tenant dispatch lock. A future
  // wait is a hard boundary; bounded passes release the lock between claims.
  const finishBefore=Date.now()+3000
  let advanced=false,steps=0
  for (const run of rows) {
    while (!run.ended_at && +run.due_at<=Date.now() && steps<64 && Date.now()<finishBefore) {
      const before=[run.node_id,+run.due_at,run.wait_node,run.ended_at]
      steps++
      const job=await step(db,cfg,s,c,run)
      if (job) return {job,advanced:true}
      if(before[0]===run.node_id&&before[1]===+run.due_at&&before[2]===run.wait_node&&before[3]===run.ended_at)break
      advanced=true
    }
    if(steps>=64||Date.now()>=finishBefore)break
  }
  return {job:null,advanced}
}

export async function runRecruitmentAutomation(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route,campaignOnly=false) {
  const scoped=<T>(work:(db:DB)=>Promise<T>)=>tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    return work(db)
  })
  const {job,worked,connection}=await scoped(async db=>{
    const c=await channel(db,r.id)
    if (c.purpose==='customer') return {job:null,worked:false,connection:null}
    const s=await locationOf(db,r.store_id)
    const enrolled=campaignOnly?0:await enrollApplicants(db,c,s,cfg)
    if (!cfg.external || !cfg.automation) return {job:null,worked:enrolled>0,connection:null}
    const chosen=await chooseJob(db,cfg,c,s,campaignOnly)
    return {job:chosen.job,worked:enrolled>0||chosen.advanced,connection:c}
  })
  if (!job) return worked
  // Reuse the committed claim's connection for the read-only quota check,
  // just as service delivery does. Sending still requires a fresh generation,
  // connection and all guards in the independent locked submission below.
  let remaining:number|null=null
  if (connection&&channelReady(connection)&&connection.generation===job.generation) {
    try {remaining=await api.quota(channelCredentials(cfg,connection))}
    catch { /* External quota verification is required before a new LINE request. */ }
  }
  const submitted=await scoped(async db=>{
    const {rows:[fresh]}=await db.query<AJob>('SELECT * FROM applicant_send WHERE id=$1 FOR UPDATE',[job.id])
    if (fresh.status!=='submitting'||fresh.attempt!==job.attempt) return null
    const {rows:[run]}=await db.query<ARun>(runSelect+' WHERE e.id=$1',[job.enrollment_id])
    const c=await channel(db,r.id)
    const s=await locationOf(db,r.store_id)
    const {contact,booking}=await applicantFacts(db,run)
    const current=run.graph.nodes.find(node=>node.id===job.node_id)
    const person=await liveValues(db,cfg,s,c,run,current?.type==='message'?current.body:'',booking)
    // 封緘時と同じプレースホルダで再描画し、差し込み値の同一性を照合する（実URLはまだ発行しない）。
    if (current?.type==='message' && current.body.includes(INTERVIEW_LINK_MARKER)) {
      person.values.interview_link=interviewLinkPlaceholder(job.id)
    }
    const expected=current?.type==='message' ? renderMessage(current.body,person).message : undefined
    const body=job.body_box?unseal(cfg,'applicant:'+job.id,job.body_box):''
    const time=Date.now()
    const reason=fresh.next_at===Infinity?'停止または予約変更後のジョブ':
      job.attempt>3 || time-+job.first_attempt_at>30*minute?'再試行期限を超過':
      c.generation!==job.generation?'LINE認証情報が変更されました':expected!==body?'差し込み値が変更されました':
      (await applicantBarred(db,cfg,s,c,run,contact,booking)) || await messageBudget(db,s,null,undefined,job.id) ||
      (remaining===null?'LINEの通数を確認できません':remaining<=0?'LINEの月間通数に達しました':null)
    if (reason) {
      await db.query(`UPDATE applicant_send SET status=$2,reason=$3,next_at='infinity',body_box=NULL WHERE id=$1`,
        [job.id,job.attempt===1?'cancelled':'unknown',reason])
      await end(db,run,reason)
      return null
    }
    const to=contactAddress(cfg,contact!)
    let sendBody=body
    const richLinks:Record<string,string>={}
    if (body.includes(interviewLinkPlaceholder(job.id))) {
      // 面談予約URLは送信の直前に受信者ごと発行する（トークンの3時間期限は送信時点から数える）。
      // 発行条件を満たさなくなっていた場合は、プレースホルダのまま送らず送信を取りやめる。
      const abort=async (why:string)=>{
        await db.query(`UPDATE applicant_send SET status=$2,reason=$3,next_at='infinity',body_box=NULL WHERE id=$1`,
          [job.id,job.attempt===1?'cancelled':'unknown',why])
        await end(db,run,why)
        return null
      }
      if (!await interviewLinkEligible(db,c,c.generation,contact!.user_key,true)) {
        return abort('面談予約URLの発行条件を満たしません')
      }
      const link=await issueInterviewLinkToken(db,cfg,c,to)
      await audit(db,c.tenant_id,c.store_id,null,'interview_link.issue',link.id,null,
        {channel_id:c.id,source:'scenario_auto',enrollment_id:run.id})
      richLinks[INTERVIEW_LINK_MARKER]=link.url
      sendBody=body.split(interviewLinkPlaceholder(job.id)).join(link.url)
      if (sendBody.length>5000) return abort('差し込み後に5000文字を超えています')
    }
    return {run,next:current?.type==='message'?current.next:'',promise:api.push(channelCredentials(cfg,c),to,job.id,sendBody,resolveRichButtons(current?.type==='message'?current.rich:undefined,richLinks))
      .catch(()=>({status:'unknown',requestId:null,authError:false}))}
  })
  if (!submitted) return true
  const result=await submitted.promise
  await scoped(async db=>{
    const finalStatus=job.attempt>1 && result.status==='failed'?'unknown':result.status
    const {rows:[resultRow]}=await db.query(`UPDATE applicant_send SET status=$2,line_request_id=$3,
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
      await advance(db,submitted.run,submitted.next,new Date(),{kind:'accepted',detail:'LINE受付済'})
    } else if (resultRow.next_at===Infinity) await end(db,submitted.run,finalStatus==='failed'?'送信失敗':'送信結果不明')
  })
  return true
}
