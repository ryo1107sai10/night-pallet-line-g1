import type pg from 'pg'
import { type Actor, type Config, type DB, type Route, audit, automationForStore, conflict, scope, seal, tx, unseal } from './core.js'
import { automaticRelationshipReady, channel, channelCredentials, channelTestReady, evidence, testDeliveryConfirmed, LineAPI, userKey } from './line.js'

import { lockDispatch } from './dispatch-lock.js'
import { endScope, locationOf, processCustomerWebhook, runAutomation } from './automation.js'
import { endApplicantScope, processRecruitmentWebhook, runRecruitmentAutomation } from './recruitment-automation.js'
import { INTERVIEW_LINK_MARKER, interviewLinkEligible, issueInterviewLink, issueInterviewLinkToken } from './interview-link.js'
import { CUSTOMER_LINK_MARKER, customerLinkEligible, issueCustomerLink, issueCustomerLinkToken } from './customer-link.js'
import { deliverCampaign } from './campaigns.js'
import { updateRichMenu } from './rich-menus.js'
import { deliverService } from './service-delivery.js'
import { googleFromEnvironment } from './interview-availability.js'
import { runGoogleSync } from './interview-hosts.js'
import {sourceTestProof} from './sources.js'
import {tagTestFacts} from './applicant-tags.js'
export { lockDispatch } from './dispatch-lock.js'

const targets = {
  tenant: { table: 'tenant', constraint: 'true' },
  store: { table: 'store', constraint: 'store_id=$1' },
  channel: { table: 'channel', constraint: 'channel_id=$1' },
} as const

export async function setStop(db: DB, actor: Actor, level: keyof typeof targets, id: string,
  stopped: boolean, revision: number, reason: string, storeId: string | null) {
  await lockDispatch(db, actor.tenant_id)
  const target = targets[level]
  const updated = await db.query(`UPDATE ${target.table} SET stopped=$2,revision=revision+1,delivery_version=delivery_version+1
    WHERE id=$1 AND revision=$3 RETURNING revision`,[id,stopped,revision])
  if (!updated.rowCount) throw conflict()
  let inFlight = 0
  let cancelled = 0
  if (stopped) {
    const args = level === 'tenant' ? [] : [id]
    const automatic = await endScope(db,target.constraint,args,'緊急停止')
    const applicant = await endApplicantScope(db,target.constraint,args,'緊急停止')
    const active = await db.query(`SELECT count(*)::int AS count FROM test_send
      WHERE status='submitting' AND ${target.constraint}`,args)
    inFlight = active.rows[0].count + automatic.inFlight + applicant.inFlight
    const pending = await db.query(`UPDATE test_send SET status='cancelled'
      WHERE status='queued' AND ${target.constraint}`,args)
    cancelled = (pending.rowCount ?? 0) + automatic.ended + applicant.ended
    // Ambiguous prior attempts stay visible as unknown and are never resumed after this stop.
    await db.query(`UPDATE test_send SET next_at='infinity'
      WHERE status IN ('unknown','submitting') AND ${target.constraint}`,args)
    await db.query(`UPDATE campaign SET state='stopped' WHERE state<>'stopped' AND ${target.constraint}`,args)
    for(const queue of ['campaign_delivery','service_delivery']){
      const result=await db.query<{in_flight:number;cancelled:number}>(`WITH pending AS (
        SELECT id,status FROM ${queue} WHERE status IN ('queued','submitting','unknown') AND ${target.constraint}
      ), stopped AS (
        UPDATE ${queue} q SET status=CASE WHEN p.status='queued' THEN 'cancelled' ELSE p.status END,
          next_at='infinity',reason='緊急停止' FROM pending p WHERE q.id=p.id RETURNING p.status
      )
      SELECT count(*) FILTER (WHERE status='submitting')::int AS in_flight,
        count(*) FILTER (WHERE status='queued')::int AS cancelled FROM stopped`,args)
      inFlight+=result.rows[0].in_flight
      cancelled+=result.rows[0].cancelled
    }
  }
  await audit(db,actor.tenant_id,storeId,actor.id,'delivery.'+(stopped?'stop':'resume'),id,reason,{level,inFlight,cancelled})
  return { stopped, revision: updated.rows[0].revision, in_flight: inFlight, cancelled }
}

async function processEvents(db: DB,cfg:Config,r:Route) {
  await lockDispatch(db,r.tenant_id)
  const c=await channel(db,r.id)
  const channelId=r.id
  const { rows } = await db.query(`SELECT * FROM webhook_event WHERE channel_id=$1 AND processed_at IS NULL
    ORDER BY occurred_at,event_id LIMIT 100 FOR UPDATE SKIP LOCKED`,[channelId])
  for (const event of rows) {
    if (event.user_key && ['follow','refollow','unfollow'].includes(event.kind)) {
      await db.query(`INSERT INTO channel_relationship VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(channel_id,user_key) DO UPDATE SET event_at=excluded.event_at,following=excluded.following
        WHERE excluded.event_at>channel_relationship.event_at OR
          (excluded.event_at=channel_relationship.event_at AND excluded.following=false)`,
      [event.tenant_id,event.store_id,event.channel_id,event.user_key,event.occurred_at,event.kind!=='unfollow'])
    }
    // 接続前から友だちだった人には follow イベントが届かず、channel_relationship に行ができない。
    // user_key は source.type='user'（1対1）のイベントにだけ付くため、1対1のメッセージ・
    // postback・接続テスト文が届いた時点で、その人が友だちであることは確定する。
    // 行が無い場合に限って補完し、既存行は決して上書きしない（遅れて届いた古いメッセージで
    // ブロック済みの人を復活させない）。裏返しとして、unfollow 行があるのに再追加イベントを
    // 取りこぼした場合は自動では回復しない（既知の限界として許容する）。
    if (event.user_key && ['message','postback','test_link'].includes(event.kind)) {
      const inferred = await db.query(`INSERT INTO channel_relationship VALUES($1,$2,$3,$4,$5,true)
        ON CONFLICT(channel_id,user_key) DO NOTHING`,
      [event.tenant_id,event.store_id,event.channel_id,event.user_key,event.occurred_at])
      if (inferred.rowCount) await audit(db,event.tenant_id,event.store_id,null,
        'relationship.inferred',event.channel_id,null,
        {channel_id:event.channel_id,kind:event.kind,event_id:event.event_id})
    }
    if (event.kind==='postback'&&event.action==='interview_link'&&event.user_key&&event.recipient_box) {
      await tryIssueInterviewLink(db,cfg,c,event)
    }
    if (event.kind==='message'&&['interview_link','customer_link'].includes(event.action)&&event.user_key&&event.recipient_box&&
        automationForStore(cfg,c.store_id,c.tenant_id)&&Date.now()-+event.occurred_at<10*60000) {
      const store=await locationOf(db,c.store_id)
      if(store.auto_enabled&&store.auto_enabled_at&&+event.occurred_at>=+store.auto_enabled_at&&
        store.contract_active&&store.eligible_at&&channelTestReady(c)){
        if(event.action==='interview_link')await tryIssueInterviewLink(db,cfg,c,event)
        else await tryIssueCustomerLink(db,cfg,c,event)
      }
    }
    if (event.kind==='postback'&&event.action==='customer_link'&&event.user_key&&event.recipient_box) {
      await tryIssueCustomerLink(db,cfg,c,event)
    }
    await processCustomerWebhook(db,cfg,c,event)
    await processRecruitmentWebhook(db,cfg,c,event)
    if(event.user_key&&event.stop_signal==='all')await db.query(`UPDATE workflow_contact SET notices=false
      WHERE channel_id=$1 AND user_key=$2 AND notices_changed_at<=$3`,[c.id,event.user_key,event.occurred_at])
    await db.query('UPDATE webhook_event SET processed_at=now(),recipient_box=NULL WHERE channel_id=$1 AND event_id=$2',
      [channelId,event.event_id])
  }
}

export async function processChannelEvents(pool:pg.Pool,cfg:Config,r:Route) {
  await tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await processEvents(db,cfg,r)
  })
}

// 面談予約リンク: リッチメニューの postback から予約リンクを発行する。
// 発行条件（友だち状態・機能フラグ・停止状態）は interviewLinkEligible で共通判定する。
// 兼用OAでも action=interview_link の postback からは発行する（フェーズ4: allowShared=true）。
async function tryIssueInterviewLink(db: DB,cfg:Config,c:Awaited<ReturnType<typeof channel>>,event:{
  event_id:string;generation:number;user_key:string|null;recipient_box:string|null;source_id:string|null
}) {
  if (!event.user_key) return
  if (!await interviewLinkEligible(db,c,event.generation,event.user_key,true)) return
  const user=unseal(cfg,'webhook:'+c.id+':'+event.event_id,event.recipient_box!)
  await issueInterviewLink(db,cfg,c,user,event.source_id ?? undefined)
}

// 顧客向けリンク: リッチメニューの postback から来店予約・設定用リンクを発行する（フェーズ3・項目3）。
// 発行条件は customerLinkEligible（友だち状態・機能フラグ・停止状態）で共通判定する。
// 兼用OAでも action=customer_link の postback からは発行する（フェーズ4: allowShared=true）。
async function tryIssueCustomerLink(db: DB,cfg:Config,c:Awaited<ReturnType<typeof channel>>,event:{
  event_id:string;generation:number;user_key:string|null;recipient_box:string|null;source_id:string|null
}) {
  if (!event.user_key) return
  if (!await customerLinkEligible(db,c,event.generation,event.user_key,true)) return
  const user=unseal(cfg,'webhook:'+c.id+':'+event.event_id,event.recipient_box!)
  await issueCustomerLink(db,cfg,c,user,event.source_id ?? undefined)
}

// フローD: シナリオのテスト送信に含まれる面談予約URLマーカーを、送信直前に受信者ごとの実URLへ置き換える。
// 発行はこの送信トランザクション内で行うため、トークンの3時間期限は送信時点から数えられる。
// ガードを満たさない場合は null を返し、呼び出し側は送信自体を取りやめる（マーカーやダミーURLは送らない）。
async function resolveScenarioInterviewLink(db: DB,cfg:Config,c:Awaited<ReturnType<typeof channel>>,
  job:{scenario_id:string|null;generation:number},message:string,user:string) {
  if (!job.scenario_id) return null
  const {rows:[sc]}=await db.query<{graph:{purpose?:string}}>('SELECT graph FROM scenario WHERE id=$1',[job.scenario_id])
  if (sc?.graph?.purpose!=='recruitment') return null
  if (!await interviewLinkEligible(db,c,job.generation,userKey(cfg,c,user),true)) return null
  const link=await issueInterviewLinkToken(db,cfg,c,user)
  await audit(db,c.tenant_id,c.store_id,null,'interview_link.issue',link.id,null,
    {channel_id:c.id,source:'scenario_test',scenario_id:job.scenario_id})
  const resolved=message.split(INTERVIEW_LINK_MARKER).join(link.url)
  return resolved.length<=5000?resolved:null
}

// フローD（顧客版）: シナリオのテスト送信に含まれる来店予約・設定URLマーカーを、送信直前に受信者ごとの実URLへ置き換える。
// 顧客シナリオは兼用OAにも配信できるため、発行ガードは兼用OAも許可する（allowShared=true）。
// ガードを満たさない場合は null を返し、呼び出し側は送信自体を取りやめる（面談側と同じ挙動）。
async function resolveScenarioCustomerLink(db: DB,cfg:Config,c:Awaited<ReturnType<typeof channel>>,
  job:{scenario_id:string|null;generation:number},message:string,user:string) {
  if (!job.scenario_id) return null
  const {rows:[sc]}=await db.query<{graph:{purpose?:string}}>('SELECT graph FROM scenario WHERE id=$1',[job.scenario_id])
  if (sc?.graph?.purpose!=='customer') return null
  if (!await customerLinkEligible(db,c,job.generation,userKey(cfg,c,user),true)) return null
  const link=await issueCustomerLinkToken(db,cfg,c,user)
  await audit(db,c.tenant_id,c.store_id,null,'customer_link.issue',link.id,null,
    {channel_id:c.id,source:'scenario_test',scenario_id:job.scenario_id})
  const resolved=message.split(CUSTOMER_LINK_MARKER).join(link.url)
  return resolved.length<=5000?resolved:null
}

async function sourceTestMessage(db:DB,cfg:Config,c:Awaited<ReturnType<typeof channel>>,job:{id:string;source_id:string;tester_id:string;generation:number;test_body:string|null},user:string){
  if(c.purpose!=='recruitment'||c.module_channel_id||!testDeliveryConfirmed(c)||!(await evidence(db,c)).send_accepted)return null
  const key=userKey(cfg,c,user)
  const {rowCount}=await db.query(`SELECT 1 FROM tester t JOIN workflow_source w ON w.id=$3 AND w.channel_id=t.channel_id AND w.store_id=t.store_id AND w.purpose='recruitment'
    JOIN store s ON s.id=w.store_id WHERE ${sourceTestProof} AND t.id=$4 AND t.user_key=$5 AND w.active AND s.sources_enabled`,[c.id,c.generation,job.source_id,job.tester_id,key])
  if(!rowCount||!await automaticRelationshipReady(db,c,key)||!await interviewLinkEligible(db,c,job.generation,key))return null
  if(job.test_body)return unseal(cfg,'test-body:'+job.id,job.test_body)
  const link=await issueInterviewLinkToken(db,cfg,c,user,job.source_id)
  const body='【Night PRO LINE 流入経路テスト】\nこれは検証専用です。リンクを開くと流入分析に記録されます（来店不要）。\n'+link.url
  await db.query('UPDATE test_send SET test_body=$2 WHERE id=$1',[job.id,seal(cfg,'test-body:'+job.id,body)])
  await audit(db,c.tenant_id,c.store_id,null,'source.test.link',job.source_id,null,{job:job.id,link:link.id})
  return body
}

async function sendCandidate(db: DB, r: Route, id?: string) {
  const { rows: [job] } = await db.query(`SELECT j.*, t.recipient,t.code_hash,t.user_key,t.expires_at,t.verified_at,
    s.stopped AS store_stopped,f.disabled_at,
    (f.role='admin' OR (f.role='manager' AND f.agency_staff AND EXISTS(SELECT 1 FROM store_grant g
      WHERE g.store_id=j.store_id AND g.staff_id=j.actor_id))) AS may_send,
    n.stopped AS tenant_stopped,
    (j.scenario_id IS NOT NULL AND (q.id IS NULL OR q.stopped OR q.revision<>j.scenario_revision OR q.channel_id<>j.channel_id))
      AS scenario_unavailable,
    EXISTS(SELECT 1 FROM channel_relationship WHERE channel_id=$1 AND user_key=t.user_key
      AND following=false) AS blocked,
    coalesce((SELECT e.kind='unfollow' FROM webhook_event e
      WHERE e.channel_id=$1 AND e.user_key=t.user_key AND e.kind IN ('follow','refollow','unfollow')
      ORDER BY e.occurred_at DESC, (e.kind='unfollow') DESC LIMIT 1),false) AS pending_block
    FROM test_send j JOIN tester t ON t.id=j.tester_id JOIN store s ON s.id=j.store_id
    JOIN staff f ON f.id=j.actor_id JOIN tenant n ON n.id=j.tenant_id
    LEFT JOIN scenario q ON q.id=j.scenario_id
    WHERE j.channel_id=$1 AND ($2::uuid IS NULL OR j.id=$2) AND j.status IN ('queued','unknown','submitting')
      AND ($2 IS NOT NULL OR j.next_at<=now() OR (j.status='submitting' AND j.attempted_at<now()-interval '45 seconds'))
    ORDER BY j.next_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[r.id,id ?? null])
  return job
}

function mustHold(c: Awaited<ReturnType<typeof channel>>, job: NonNullable<Awaited<ReturnType<typeof sendCandidate>>>) {
  const expired = new Date(job.expires_at).getTime() <= Date.now()
  const interrupted = job.next_at === Infinity
  return expired || interrupted || c.stopped || job.store_stopped || job.tenant_stopped || job.blocked || job.pending_block || job.disabled_at
    || job.scenario_unavailable || !job.may_send || !channelTestReady(c)
    || c.generation !== job.generation
}

async function claim(db: DB, r: Route) {
  await lockDispatch(db,r.tenant_id)
  const c = await channel(db,r.id)
  const job = await sendCandidate(db,r)
  if (!job) return
  const wasAttempted = job.attempt > 0
  if (mustHold(c,job) || job.attempt >= 3) {
    await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,
      [job.id,wasAttempted ? 'unknown' : 'cancelled'])
    return
  }
  const { rows: [attempt] } = await db.query(`UPDATE test_send SET status='submitting',attempt=attempt+1,
    attempted_at=clock_timestamp(),next_at=now()+interval '45 seconds' WHERE id=$1 RETURNING attempt`,[job.id])
  return { c, job, attempt: attempt.attempt }
}

export async function workOnce(pool: pg.Pool, cfg: Config, api: LineAPI,google=googleFromEnvironment(cfg)) {
  const { rows } = await pool.query<Route>('SELECT * FROM channel_route ORDER BY id')
  for (const r of rows) {
    const storeCfg={...cfg,automation:automationForStore(cfg,r.store_id,r.tenant_id)}
    if (r.module_channel_id && (!cfg.external || r.module_channel_id!==cfg.lineModule?.id)) continue
    await processChannelEvents(pool,cfg,r)
    await runAutomation(pool,storeCfg,api,r)
    const recruitmentProgress=await runRecruitmentAutomation(pool,storeCfg,api,r)
    await deliverCampaign(pool,storeCfg,api,r)
    await updateRichMenu(pool,storeCfg,api,r)
    await runGoogleSync(pool,google,r)
    await deliverService(pool,storeCfg,api,r)
    // A small bounded batch keeps recruitment scenarios moving, without
    // delaying LINE inbox replies and booking notices or spinning when idle.
    const finishRecruitmentBefore=Date.now()+12000
    if(recruitmentProgress)for(let i=0;i<4&&Date.now()<finishRecruitmentBefore;i++){if(!await runRecruitmentAutomation(pool,storeCfg,api,r))break}
    if (!cfg.external) continue
    const pending = await tx(pool, async db => { await scope(db,r.tenant_id,r.store_id); return claim(db,r) })
    if (!pending) continue
    const { c, job, attempt } = pending
    if (r.module_channel_id) {
      const credentials=channelCredentials(cfg,c)
      if ('module' in credentials) await api.modules.headers(credentials.module,credentials.bot).catch(()=>undefined)
    }
    // Persist the attempt first. Start the call while holding the same lock as stop;
    // release the lock without waiting for LINE's response.
    const submission = await tx(pool,async db=>{
      await scope(db,r.tenant_id,r.store_id)
      await lockDispatch(db,r.tenant_id)
      const fresh = await channel(db,r.id)
      const current = await sendCandidate(db,r,job.id)
      if (!current || current.status !== 'submitting' || current.attempt !== attempt) return
      if (mustHold(fresh,current)) {
        await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,
          [job.id,attempt===1 ? 'cancelled' : 'unknown'])
        return
      }
      if(current.tag_test_guard&&!await tagTestFacts(db,fresh,current.user_key,current.tag_test_guard,current.verified_at)){
        await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,[job.id,attempt===1?'cancelled':'unknown'])
        await audit(db,r.tenant_id,r.store_id,null,'scenario.tag_test_held',job.id,null,{channel_id:r.id})
        return
      }
      const to = unseal(cfg,'tester:' + current.code_hash,current.recipient)
      let message = current.test_body ? unseal(cfg,'test-body:' + job.id,current.test_body) : undefined
      if(current.source_id){
        const body=await sourceTestMessage(db,cfg,fresh,current,to)
        if(!body){await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,[job.id,attempt===1?'cancelled':'unknown']);return}
        message=body
      }
      if (message?.includes(INTERVIEW_LINK_MARKER)) {
        // 面談予約URLは送信直前に受信者ごとに発行する。条件を満たさない場合はURLを送らず送信を取りやめる。
        const resolved = await resolveScenarioInterviewLink(db,cfg,fresh,current,message,to)
        if (!resolved) {
          await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,
            [job.id,attempt===1?'cancelled':'unknown'])
          await audit(db,r.tenant_id,r.store_id,null,'interview_link.scenario_held',job.id,null,{channel_id:r.id})
          return
        }
        message = resolved
      }
      if (message?.includes(CUSTOMER_LINK_MARKER)) {
        // 来店予約・設定URLも送信直前に受信者ごとに発行する。条件を満たさない場合はURLを送らず送信を取りやめる。
        const resolved = await resolveScenarioCustomerLink(db,cfg,fresh,current,message,to)
        if (!resolved) {
          await db.query(`UPDATE test_send SET status=$2,next_at='infinity' WHERE id=$1`,
            [job.id,attempt===1?'cancelled':'unknown'])
          await audit(db,r.tenant_id,r.store_id,null,'customer_link.scenario_held',job.id,null,{channel_id:r.id})
          return
        }
        message = resolved
      }
      return { promise: api.push(channelCredentials(cfg,fresh),to,job.id,message)
        .catch(()=>({ status:'unknown',requestId:null,authError:false })) }
    })
    if (!submission) continue
    const result = await submission.promise
    await tx(pool,async db => {
      await scope(db,r.tenant_id,r.store_id)
      if (result.authError) await lockDispatch(db,r.tenant_id)
      const updated = await db.query(`UPDATE test_send SET status=$3,line_request_id=$4,
        next_at=CASE WHEN next_at='infinity' OR $3<>'unknown' OR attempt>=3 THEN 'infinity'
          ELSE now()+interval '1 minute' END WHERE id=$1 AND attempt=$2 AND status='submitting' RETURNING id`,
        [job.id,attempt,result.status,result.requestId])
      if (!updated.rowCount) return
      if (result.authError) {
        await db.query(`UPDATE channel SET checks=checks-$3::text[],
          revision=revision+1 WHERE id=$1 AND generation=$2`,
        [c.id,c.generation,c.module_channel_id?['token_verified','webhook_verified','delivery_confirmed']:['token_verified','webhook_verified']])
      }
      await audit(db,r.tenant_id,r.store_id,null,'line.test_' + result.status,job.id)
    })
  }
}
