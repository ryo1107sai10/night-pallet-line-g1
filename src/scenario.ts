import type { Request } from 'express'
import { z } from 'zod'
import { simulate, validate } from '../public/studio/engine.mjs'
import { audit, conflict, Fault, missing, keyed, newId, once, purpose, revision, seal, text, uuid, type Actor, type Config, type DB } from './core.js'

import { channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'

const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/)
const base = { id:nodeId, name:z.string().max(100) }
const next = nodeId.or(z.literal(''))
const clock = z.string().max(16)
const nodes = z.discriminatedUnion('type',[
  z.strictObject({...base,type:z.literal('message'),category:z.enum(['service','marketing']),body:z.string().max(5000),next}),
  z.strictObject({...base,type:z.literal('wait'),mode:z.enum(['delay','fixed','business','booking']),minutes:z.int().optional(),
    days:z.int().optional(),time:clock.optional(),next}),
  z.strictObject({...base,type:z.literal('branch'),condition:z.enum(['booked','consent','adult','responded','tag','assigned']),
    tag:z.string().max(80).optional(),yes:next,no:next}),
  z.strictObject({...base,type:z.literal('tag'),tag:z.string().max(80),action:z.enum(['add','remove']).optional(),next}),
  z.strictObject({...base,type:z.literal('task'),note:z.string().max(400),next}),
  z.strictObject({...base,type:z.literal('end')}),
])
const graph = z.strictObject({
  name:z.string().max(100),purpose,trigger:z.string().max(30),channel:uuid,windowStart:clock,windowEnd:clock,
  daily:z.int(),weekly:z.int(),cooldownDays:z.int(),rejoin:z.boolean(),missingAssignee:z.enum(['manager','hold']),
  holidays:z.array(z.int().min(0).max(6)).max(6),entry:next,nodes:z.array(nodes).max(100),
})
const fixture = z.strictObject({
  start:z.string().max(16),bookingAt:z.string().max(16),dayCount:z.int().min(0).max(10000),weekCount:z.int().min(0).max(10000),
  booked:z.boolean(),consent:z.boolean(),adult:z.boolean(),responded:z.boolean(),assigned:z.boolean(),
  stopped:z.boolean(),marketingStopped:z.boolean(),blocked:z.boolean(),human:z.boolean(),cancelled:z.boolean(),
  bookingLinkValid:z.boolean(),eligible:z.boolean().optional(),contractActive:z.boolean().optional(),
  budgetAvailable:z.boolean().optional(),bookingCurrent:z.boolean().optional(),tags:z.array(z.string().max(80)).max(50),
  values:z.strictObject({ name:z.string().max(100),store:z.string().max(120),staff:z.string().max(100),
    booking:z.string().max(120),price:z.string().max(400),booking_url:z.string().max(1000) }),
})
export type Graph = z.infer<typeof graph>
const customerTriggers = new Set(['follow','consent','manual','booking_created','booking_changed','booking_cancelled','visit'])
function canPublish(graph:Graph) {
  if (graph.purpose!=='customer' || !customerTriggers.has(graph.trigger)) {
    throw new Fault(422,'TRIGGER_UNAVAILABLE','この用途・開始イベントの実配信は未対応です。下書きと配信前テストを利用できます。')
  }
}

type Scenario = { id:string; channel_id:string; graph:Graph; revision:number; state:string;
  published_version:number|null; stopped:boolean; updated_at:Date }
type Context = { db:DB; actor:Actor; store:string }

const record = async (db:DB,id:string,lock=false) => {
  const result = await db.query<Scenario>('SELECT * FROM scenario WHERE id=$1'+(lock?' FOR UPDATE':''),[id])
  if (!result.rowCount) throw missing()
  return result.rows[0]
}
const allowedChannel = async (db:DB,data:Graph) => {
  const result = await db.query("SELECT id FROM channel WHERE id=$1 AND (purpose=$2 OR purpose='shared')",[data.channel,data.purpose])
  if (!result.rowCount) throw missing()
}
const complete = (data:Graph) => {
  const errors = validate(data,true)
  if (errors.length) throw new Fault(422,'INVALID_SCENARIO',errors[0].message)
}
export const scenarioList = async ({db}:Context) =>
  (await db.query<Scenario>('SELECT * FROM scenario ORDER BY updated_at DESC,id LIMIT 100')).rows
export const scenarioDetail = async ({db}:Context,id:string) => {
  const item = await record(db,id)
  const { rows } = await db.query(`SELECT version,published_at FROM scenario_version
    WHERE scenario_id=$1 ORDER BY version DESC LIMIT 50`,[id])
  return {...item, versions:rows}
}
export const versionDetail = async ({db}:Context,id:string,version:number) => {
  const { rows:[item] } = await db.query('SELECT version,graph,published_at FROM scenario_version WHERE scenario_id=$1 AND version=$2',[id,version])
  if (!item) throw missing()
  return item
}
export async function createScenario({db,actor,store}:Context,cfg:Config,req:Request,key:string) {
  const data = graph.parse(req.body)
  await allowedChannel(db,data)
  return once(db,cfg,actor,'scenario.create',key,{store,data},async()=>{
    const id = newId()
    await db.query(`INSERT INTO scenario(id,tenant_id,store_id,channel_id,created_by,graph)
      VALUES ($1,$2,$3,$4,$5,$6)`,[id,actor.tenant_id,store,data.channel,actor.id,JSON.stringify(data)])
    await audit(db,actor.tenant_id,store,actor.id,'scenario.create',id)
    return record(db,id)
  })
}
export async function saveScenario({db,actor,store}:Context,id:string,input:unknown) {
  const data = z.strictObject({revision,graph}).parse(input)
  await lockDispatch(db,actor.tenant_id)
  const current = await record(db,id,true)
  if (current.revision!==data.revision) throw conflict()
  await allowedChannel(db,data.graph)
  await db.query(`UPDATE scenario SET graph=$2,channel_id=$3,revision=revision+1,state='draft',
    updated_at=now() WHERE id=$1`,[id,JSON.stringify(data.graph),data.graph.channel])
  await audit(db,actor.tenant_id,store,actor.id,'scenario.save',id)
  return record(db,id)
}
export async function transitionScenario({db,actor,store}:Context,id:string,input:unknown) {
  const data = z.strictObject({ revision, action:z.enum(['test','approve','publish','stop','resume']), reason:text(200).optional(),fixture:fixture.optional() }).parse(input)
  await lockDispatch(db,actor.tenant_id)
  const current = await record(db,id,true)
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
      if (state!=='approved') throw conflict()
      canPublish(current.graph)
      complete(current.graph)
      await allowedChannel(db,current.graph)
      version=(version??0)+1
      await db.query(`INSERT INTO scenario_version(tenant_id,store_id,scenario_id,version,graph,published_by)
        VALUES ($1,$2,$3,$4,$5,$6)`,[actor.tenant_id,store,id,version,JSON.stringify(current.graph),actor.id])
      state='draft'
      break
    case 'stop':
    case 'resume':
      if (!version || !data.reason || stopped===(data.action==='stop')) throw conflict()
      stopped=data.action==='stop'
      if (stopped) {
        await db.query(`UPDATE enrollment SET ended_at=now(),end_reason='シナリオ停止'
          WHERE scenario_id=$1 AND ended_at IS NULL`,[id])
        await db.query(`UPDATE automatic_send SET next_at='infinity',reason='シナリオ停止' WHERE
          enrollment_id IN (SELECT id FROM enrollment WHERE scenario_id=$1)
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

export async function scenarioTesters({db}:Context,id:string) {
  const current=await record(db,id)
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

export async function scenarioTestStatus({db}:Context,id:string) {
  await record(db,id)
  const { rows }=await db.query(`SELECT id,status,created_at,line_request_id FROM test_send
    WHERE scenario_id=$1 ORDER BY created_at DESC LIMIT 20`,[id])
  return rows
}

export async function queueScenarioTest(ctx:Context,cfg:Config,id:string,key:string,input:unknown) {
  const {db,actor,store}=ctx
  const data=z.strictObject({revision,node:nodeId,tester:uuid,fixture}).parse(input)
  if (!cfg.external) throw new Fault(409,'HTTPS_REQUIRED','公開HTTPS環境でテスト送信してください。')
  await lockDispatch(db,actor.tenant_id)
  return once(db,cfg,actor,'scenario.test_send',key,{id,...data},async()=>{
    const current=await record(db,id,true)
    if (current.revision!==data.revision || current.stopped) throw conflict()
    complete(current.graph)
    const c=await channel(db,current.channel_id)
    const {rows:[flags]}=await db.query(`SELECT t.stopped OR s.stopped AS stopped FROM store s
      JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[store])
    if (c.stopped || flags.stopped) throw new Fault(409,'DELIVERY_STOPPED','配信が停止中です。')
    const { rows:[proof] }=await db.query(`SELECT t.id,t.user_key FROM tester t
      WHERE t.id=$1 AND t.channel_id=$2 AND t.generation=$3 AND t.purpose=$4 AND t.verified_at IS NOT NULL AND t.expires_at>now()
      AND EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=t.channel_id AND e.user_key=t.user_key
        AND e.kind IN ('follow','message') AND e.generation=t.generation AND
        e.received_at BETWEEN t.verified_at AND t.expires_at AND e.occurred_at BETWEEN t.verified_at AND t.expires_at)
      AND NOT EXISTS (SELECT 1 FROM test_send j WHERE j.tester_id=t.id)
      FOR UPDATE OF t`,[data.tester,c.id,c.generation,current.graph.purpose])
    if (!proof) throw new Fault(404,'TESTER_NOT_AVAILABLE','この店舗・用途の有効なテスト利用者を選択してください。')
    const checks = c.checks
    if (!checks.token_verified || !checks.webhook_verified || !checks.ownership_verified || !checks.provider_verified ||
      !checks.login_published || !checks.redelivery_enabled || !checks.auto_reply_checked || !checks.non_developer) {
      throw new Fault(409,'TEST_NOT_READY','先に公式アカウントのLINE接続を確認してください。')
    }
    const result=await preview(db,store,current.graph,data.fixture)
    const message=result.events.find(event=>event.id===data.node)?.message
    if (!message) throw new Fault(422,'MESSAGE_NOT_SCHEDULED','配信予定があるメッセージを選んでください。')
    const marked='【接続テスト】\n'+message
    if (marked.length>5000) throw new Fault(422,'MESSAGE_TOO_LONG','テストの表示を含めて5000文字以内にしてください。')
    const job=newId()
    await db.query(`INSERT INTO test_send
      (id,tenant_id,store_id,channel_id,tester_id,actor_id,operation_key,generation,scenario_id,scenario_revision,test_body)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[job,actor.tenant_id,store,c.id,proof.id,actor.id,
      keyed(cfg,'scenario-test:'+id+':'+key),c.generation,id,current.revision,seal(cfg,'test-body:'+job,marked)])
    await audit(db,actor.tenant_id,store,actor.id,'scenario.test_queue',id,null,{job,node:data.node})
    return {id:job,status:'queued'}
  })
}
