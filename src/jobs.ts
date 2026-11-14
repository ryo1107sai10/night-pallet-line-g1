import type pg from 'pg'
import { type Actor, type Config, type DB, type Route, audit, conflict, scope, tx, unseal } from './core.js'
import { channel, channelCredentials, LineAPI } from './line.js'

import { lockDispatch } from './dispatch-lock.js'
import { endScope, processCustomerWebhook, runAutomation } from './automation.js'
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
    const active = await db.query(`SELECT count(*)::int AS count FROM test_send
      WHERE status='submitting' AND ${target.constraint}`,args)
    inFlight = active.rows[0].count + automatic.inFlight
    const pending = await db.query(`UPDATE test_send SET status='cancelled'
      WHERE status='queued' AND ${target.constraint}`,args)
    cancelled = (pending.rowCount ?? 0) + automatic.ended
    // Ambiguous prior attempts stay visible as unknown and are never resumed after this stop.
    await db.query(`UPDATE test_send SET next_at='infinity'
      WHERE status IN ('unknown','submitting') AND ${target.constraint}`,args)
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
    await processCustomerWebhook(db,cfg,c,event)
    await db.query('UPDATE webhook_event SET processed_at=now(),recipient_box=NULL WHERE channel_id=$1 AND event_id=$2',
      [channelId,event.event_id])
  }
}

async function sendCandidate(db: DB, r: Route, id?: string) {
  const { rows: [job] } = await db.query(`SELECT j.*, t.recipient,t.code_hash,t.user_key,t.expires_at,
    s.stopped AS store_stopped,f.disabled_at,
    (f.role='admin' OR (f.role='manager' AND EXISTS(SELECT 1 FROM store_grant g
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
    || job.scenario_unavailable || !job.may_send || !c.checks.token_verified || !c.checks.webhook_verified
    || !c.checks.ownership_verified || !c.checks.provider_verified || !c.checks.login_published
    || !c.checks.redelivery_enabled || !c.checks.auto_reply_checked || !c.checks.non_developer
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

export async function workOnce(pool: pg.Pool, cfg: Config, api: LineAPI) {
  const { rows } = await pool.query<Route>('SELECT * FROM channel_route ORDER BY id')
  for (const r of rows) {
    await tx(pool, async db => { await scope(db,r.tenant_id,r.store_id); await processEvents(db,cfg,r) })
    await runAutomation(pool,cfg,api,r)
    if (!cfg.external) continue
    const pending = await tx(pool, async db => { await scope(db,r.tenant_id,r.store_id); return claim(db,r) })
    if (!pending) continue
    const { c, job, attempt } = pending
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
      const to = unseal(cfg,'tester:' + current.code_hash,current.recipient)
      const message = current.test_body ? unseal(cfg,'test-body:' + job.id,current.test_body) : undefined
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
        await db.query(`UPDATE channel SET checks=checks-'token_verified'-'webhook_verified',
          revision=revision+1 WHERE id=$1 AND generation=$2`,[c.id,c.generation])
      }
      await audit(db,r.tenant_id,r.store_id,null,'line.test_' + result.status,job.id)
    })
  }
}
