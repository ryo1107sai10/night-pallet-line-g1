import { createHmac, timingSafeEqual } from 'node:crypto'
import { lockDispatch } from './dispatch-lock.js'
import { recordInboxEvent } from './inbox.js'
import type pg from 'pg'
import { z } from 'zod'
import { LineModuleAPI, moduleWebhookPath, requireModule } from './line-module.js'
import {
  type Actor, type Config, type DB, type Route, type LineModuleConfig, Fault, audit, conflict, digest, keyed,
  looseId, missing, newId, purpose, revision, route, scope, seal, text, token,
  tx, unseal, userId, uuid,
} from './core.js'

const httpsUrl = z.url().max(500).refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
})
const credentialFields = {
  access_token: z.string().regex(/^[\x21-\x7e]{15,4096}$/),
  channel_secret: z.string().regex(/^[0-9a-f]{32}$/i),
  token_type: z.enum(['console', 'v2.1']),
}
const credentialsSchema = z.strictObject(credentialFields)
export const connectionSchema = z.strictObject({
  label: text(100), purpose: z.enum(['customer','recruitment','shared']), owner_name: text(160),
  provider_id: text(80), messaging_id: looseId,
  bot_user_id: userId.optional(), account_type: z.enum(['unverified','verified','premium']),
  existing_tools: z.string().trim().max(300).optional(),
  existing_webhook: httpsUrl.optional(), management_authority: text(160), ...credentialFields,
})
export const replaceCredentialsSchema = credentialsSchema.extend({ revision, reason: text(200) })
export const consoleSchema = z.strictObject({ revision, reason: text(200),
  ownership_verified: z.boolean(), provider_verified: z.boolean(), redelivery_enabled: z.boolean(),
  auto_reply_checked: z.boolean(), non_developer: z.boolean(), delivery_confirmed: z.boolean(),
})
type Credentials = z.infer<typeof credentialsSchema>
type SendCredentials = Credentials | {module:LineModuleConfig;bot:string}
type Checks = {
  ownership_verified?: boolean; provider_verified?: boolean; redelivery_enabled?: boolean;
  auto_reply_checked?: boolean; non_developer?: boolean; delivery_confirmed?: boolean;
  token_verified?: boolean; webhook_verified?: boolean;
}
export type Channel = Route & {
  label: string; purpose: 'customer' | 'recruitment' | 'shared'; owner_name: string; provider_id: string | null;
  bot_user_id: string; account_type: string | null;
  existing_tools: string | null; existing_webhook: string | null; management_authority: string;
  credentials: string | null; checks: Checks; stopped: boolean; revision: number; generation: number;
  basic_id:string|null; module_status:'attached'|'active'|'standby'|'detached'|'suspended'|null; module_status_at:Date|null;
}
type ConnectionState = Pick<Channel,'module_channel_id'|'module_status'|'checks'>
export const channelTestReady = (c:ConnectionState) => !!(c.checks.ownership_verified && c.checks.token_verified && c.checks.webhook_verified &&
  (c.module_channel_id ? c.module_status==='active' :
    c.checks.provider_verified && c.checks.redelivery_enabled && c.checks.auto_reply_checked))
export const testDeliveryConfirmed = (c:ConnectionState) => channelTestReady(c) && c.checks.delivery_confirmed===true
export const messagingReady = (c:ConnectionState) => testDeliveryConfirmed(c) &&
  (!!c.module_channel_id || c.checks.non_developer===true)
// 接続済み判定は Messaging API の検収だけで決まる（本人確認はトークン方式）。
export const channelReady = (c:Channel) => messagingReady(c)

export async function channel(db: DB, id: string) {
  const { rows: [row] } = await db.query<Channel>(`SELECT c.*,r.messaging_id,r.module_channel_id,r.module_bot_id FROM channel c
    JOIN channel_route r ON c.id=r.id WHERE c.id=$1`, [id])
  if (!row) throw missing()
  return row
}

const secretContext = (c: Pick<Route,'tenant_id'|'store_id'|'id'>) => `line:${c.tenant_id}:${c.store_id}:${c.id}`
export function channelCredentials(cfg: Config, c: Channel):SendCredentials {
  if (c.module_channel_id) {
    const module = requireModule(cfg)
    if (c.module_channel_id!==module.id) throw lineUnavailable()
    return {module,bot:c.bot_user_id}
  }
  return credentialsSchema.parse(JSON.parse(unseal(cfg, secretContext(c), c.credentials!)))
}

export async function createChannel(db: DB, cfg: Config, actor: Actor, store: string,
  data: z.infer<typeof connectionSchema> & {bot_user_id:string}) {
  const c = { id: newId(), tenant_id: actor.tenant_id, store_id: store, messaging_id: data.messaging_id }
  await db.query('INSERT INTO channel_route(id,tenant_id,store_id,messaging_id) VALUES($1,$2,$3,$4)',
    [c.id,c.tenant_id,c.store_id,c.messaging_id])
  const { access_token, channel_secret, token_type } = data
  await db.query(`INSERT INTO channel(id,tenant_id,store_id,label,purpose,owner_name,provider_id,
    bot_user_id,account_type,existing_webhook,existing_tools,management_authority,credentials)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [c.id,c.tenant_id,c.store_id,data.label,data.purpose,data.owner_name,data.provider_id,
      data.bot_user_id,data.account_type,data.existing_webhook ?? null,data.existing_tools ?? null,
      data.management_authority,seal(cfg,secretContext(c),JSON.stringify({access_token,channel_secret,token_type}))])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.register',c.id)
  return { id: c.id }
}

export async function replaceCredentials(db: DB, cfg: Config, actor: Actor, c: Channel,
  data: z.infer<typeof replaceCredentialsSchema>) {
  if (c.module_channel_id) throw missing()
  const { access_token, channel_secret, token_type, reason } = data
  const update = await db.query(`UPDATE channel SET credentials=$2, generation=generation+1,
    checks=checks-'token_verified'-'webhook_verified'-'delivery_confirmed', revision=revision+1 WHERE id=$1 AND revision=$3`,
    [c.id,seal(cfg,secretContext(c),JSON.stringify({access_token,channel_secret,token_type})),data.revision])
  if (!update.rowCount) throw conflict()
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.rotate_credentials',c.id,reason)
}

const testerLifetime = "interval '2 hours'"

// A signed chat message can arrive before tester verification, within the same invitation.
export const connectionTestEvent = `e.channel_id=t.channel_id AND e.user_key=t.user_key AND e.generation=t.generation
  AND t.verified_at IS NOT NULL
  AND ((e.kind='message' AND e.received_at>=t.expires_at-${testerLifetime}
      AND e.occurred_at>=t.expires_at-${testerLifetime})
    OR (e.kind='follow' AND e.received_at>=t.verified_at AND e.occurred_at>=t.verified_at))
  AND e.received_at<=least(t.expires_at,now()) AND e.occurred_at<=least(t.expires_at,now())`

type Evidence = {tester_verified:boolean;receive_verified:boolean;send_accepted:boolean}
// テスター本人確認はメッセージ方式（接続テスト {code}）で verified_at が立つ。
const testerVerified = `EXISTS(SELECT 1 FROM tester WHERE channel_id=c.id AND generation=c.generation AND verified_at IS NOT NULL)`
const evidenceColumns = `${testerVerified} AS tester_verified,
    EXISTS(SELECT 1 FROM tester t JOIN webhook_event e ON ${connectionTestEvent}
      WHERE t.channel_id=c.id AND t.generation=c.generation) AS receive_verified,
    EXISTS(SELECT 1 FROM test_send WHERE channel_id=c.id AND generation=c.generation AND status='accepted' AND scenario_id IS NULL) AS send_accepted`

export async function evidence(db:DB,c:Channel) {
  const {rows:[result]}=await db.query<Evidence>(`SELECT ${evidenceColumns}
    FROM (VALUES($1::uuid,$2::integer)) AS c(id,generation)`,[c.id,c.generation])
  return result
}

function verifiedConnection(c:ConnectionState,checks:Checks & Evidence) {
  if (c.module_channel_id) return messagingReady(c) && checks.receive_verified && checks.send_accepted
  const base = ['ownership_verified','provider_verified','redelivery_enabled','auto_reply_checked','non_developer',
    'token_verified','webhook_verified','receive_verified','send_accepted','delivery_confirmed']
  if (!base.every(key=>checks[key as keyof typeof checks]===true)) return false
  // 本人確認はテスター確認（メッセージ方式）の実績で判定する。
  return checks.tester_verified===true
}

export async function connectionProgress(db:DB,connection?:string) {
  const {rows}=await db.query<ConnectionState & Evidence & {id:string;store_id:string}>(`SELECT
    c.id,c.store_id,c.checks,c.module_status,r.module_channel_id,${evidenceColumns}
    FROM channel c JOIN channel_route r ON r.id=c.id
    WHERE ($1::uuid IS NULL OR c.id=$1) ORDER BY c.label,c.id`,[connection ?? null])
  return rows.map(({id,store_id,...state})=>({id,store_id,verified:verifiedConnection(state,{...state.checks,...state})}))
}

export async function summary(db: DB, cfg: Config, c: Channel) {
  const { credentials, module_bot_id, ...safe } = c
  const checks = { ...c.checks, ...await evidence(db,c) }
  const complete = verifiedConnection(c,checks)
  return { ...safe, checks, status: complete ? 'connected' : 'pending',
    webhook_url: cfg.origin + (c.module_channel_id ? moduleWebhookPath : '/api/v1/webhooks/line/' + c.id),
  }
}

export class LineAPI {
  readonly modules:LineModuleAPI
  constructor(private request: typeof fetch = fetch) {
    this.modules = new LineModuleAPI(request)
  }

  private async headers(cred:SendCredentials) {
    return 'module' in cred ? this.modules.headers(cred.module,cred.bot) : { Authorization:'Bearer '+cred.access_token }
  }
  private async call(path: string, options: RequestInit = {}) {
    try {
      return await this.request('https://api.line.me' + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(6000),
      })
    } catch {
      throw new Fault(502,'LINE_UNAVAILABLE','LINEとの通信結果を確認できません。',true)
    }
  }

  async botIdForChannel(messagingId: string, cred: Credentials) {
    const endpoint = '/oauth2/v2.1/verify?' + new URLSearchParams({ access_token: cred.access_token })
    const verified = await (cred.token_type === 'v2.1'
      ? this.call(endpoint)
      : this.call('/v2/oauth/verify',{method:'POST',body:new URLSearchParams({access_token:cred.access_token})}))
    if (verified.status === 429 || verified.status >= 500) throw lineUnavailable()
    if (!verified.ok || String((await verified.json()).client_id) !== messagingId) return null
    const bot = await this.call('/v2/bot/info', { headers: { Authorization: 'Bearer ' + cred.access_token } })
    if (bot.status === 429 || bot.status >= 500) throw lineUnavailable()
    if (!bot.ok) return null
    const identity = userId.safeParse((await bot.json()).userId)
    return identity.success ? identity.data : null
  }

  async checkToken(c: Channel, cred: SendCredentials) {
    if ('module' in cred) return (await this.modules.bot(cred.module,cred.bot)).userId===c.bot_user_id
    return !!c.messaging_id && await this.botIdForChannel(c.messaging_id,cred) === c.bot_user_id
  }

  async checkWebhook(cred: SendCredentials, expected: string) {
    if ('module' in cred) return false
    const authorization = { Authorization: 'Bearer ' + cred.access_token }
    const settings = await this.call('/v2/bot/channel/webhook/endpoint', { headers: authorization })
    if (settings.status === 429 || settings.status >= 500) throw lineUnavailable()
    if (!settings.ok) return false
    const configured = await settings.json()
    if (configured.endpoint !== expected || configured.active !== true) return false
    const result = await this.call('/v2/bot/channel/webhook/test', { method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}' })
    if (result.status === 429 || result.status >= 500) throw lineUnavailable()
    return result.ok && (await result.json()).success === true
  }

  async quota(cred: SendCredentials) {
    const headers = await this.headers(cred)
    const [limit,consumption] = await Promise.all([
      this.call('/v2/bot/message/quota',{headers}), this.call('/v2/bot/message/quota/consumption',{headers}),
    ])
    if (!limit.ok || !consumption.ok) throw lineUnavailable()
    const ceiling = z.discriminatedUnion('type',[
      z.object({type:z.literal('none')}),z.object({type:z.literal('limited'),value:z.int().nonnegative()}),
    ]).parse(await limit.json())
    const used = z.object({totalUsage:z.int().nonnegative()}).parse(await consumption.json()).totalUsage
    return ceiling.type==='none'?Infinity:Math.max(0,ceiling.value-used)
  }

  async richMenuExists(cred:SendCredentials,id:string){
    const response=await this.call('/v2/bot/richmenu/'+encodeURIComponent(id),
      {headers:await this.headers(cred)})
    if(response.status>=500||response.status===429)throw lineUnavailable()
    return response.ok
  }

  async bindRichMenu(cred:SendCredentials,user:string,id:string|null){
    const endpoint='/v2/bot/user/'+encodeURIComponent(user)+'/richmenu'
    const response=await this.call(id?endpoint+'/'+encodeURIComponent(id):endpoint,{
      method:id?'POST':'DELETE',headers:await this.headers(cred),
    })
    return {ok:response.ok||!id&&response.status===404,retry:response.status>=500||response.status===429}
  }

  async push(cred: SendCredentials, recipient: string, attemptID: string, testBody='Night PRO LINEの接続テストです。') {
    const authorization = 'module' in cred ? await this.headers(cred) : {Authorization:'Bearer '+cred.access_token}
    const response = await this.call('/v2/bot/message/push', { method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json',
        'X-Line-Retry-Key': attemptID },
      body: JSON.stringify({ to: recipient, messages: [{type:'text',text:testBody}] }),
    })
    const acceptedId = response.headers.get('x-line-accepted-request-id')
    const requestId = response.headers.get('x-line-request-id')
    if (response.ok || (response.status === 409 && acceptedId)) {
      return { status: 'accepted', requestId: acceptedId ?? requestId }
    }
    if (response.status >= 500) return { status: 'unknown', requestId }
    return { status: 'failed', requestId, authError: [401,403].includes(response.status), statusCode: response.status }
  }
}

const lineUnavailable = () => new Fault(502,'LINE_UNAVAILABLE','LINEとの通信結果を確認できません。',true)
const signatureError = () => new Fault(401,'INVALID_WEBHOOK','Webhookを確認できません。')
const moduleUserId = z.union([userId,z.string().regex(/^LU[0-9a-f]{32}-U[0-9a-f]{32}$/i)])
const eventSchema = z.object({ webhookEventId: text(100), type: text(100), timestamp: z.int().min(0).max(8640000000000000),
  mode:z.enum(['active','standby']).optional(),
  module:z.object({type:z.string(),botId:userId}).optional(),
  follow:z.object({isUnblocked:z.boolean().optional()}).optional(),
  message:z.object({type:z.string().max(100),id:z.string().max(100).optional(),text:z.string().optional()}).optional(),
  postback:z.object({data:text(500)}).optional(),
  unsend:z.object({messageId:z.string().max(100)}).optional(),
  source: z.object({ type: z.string(), userId: moduleUserId.optional() }).optional(),
})
const webhookSchema = z.object({ destination: userId, events: z.array(eventSchema).max(500) })
export const userKey = (cfg: Config, c: Channel, user: string) => keyed(cfg,`line-user:${c.id}:${user}`)

function decodeWebhook(raw:Buffer,signature:string,secret:string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw signatureError()
  const expected = createHmac('sha256',secret).update(raw).digest()
  if (!timingSafeEqual(expected,Buffer.from(signature,'base64'))) throw signatureError()
  let payload:unknown
  try { payload=JSON.parse(raw.toString('utf8')) } catch { throw signatureError() }
  const parsed=webhookSchema.safeParse(payload)
  if (!parsed.success) throw signatureError()
  return parsed.data
}

export async function receiveWebhook(pool:pg.Pool,cfg:Config,id:string,raw:Buffer,signature:string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw signatureError()
  return tx(pool,async db=>{
    const r=await route(db,id)
    if (r.module_channel_id) throw missing()
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    const c=await channel(db,id)
    const cred=channelCredentials(cfg,c)
    if ('module' in cred) throw signatureError()
    const payload=decodeWebhook(raw,signature,cred.channel_secret)
    if (payload.destination!==c.bot_user_id) throw signatureError()
    if (await recordWebhookEvents(db,cfg,c,payload.events,await inboxEnabled(db,c.store_id))) return r
  })
}

export async function receiveModuleWebhook(pool:pg.Pool,cfg:Config,raw:Buffer,signature:string) {
  const module=requireModule(cfg)
  const payload=decodeWebhook(raw,signature,module.secret)
  if (!payload.events.length) return
  return tx(pool,async db=>{
    const {rows:[r]}=await db.query<Route>('SELECT * FROM channel_route WHERE module_channel_id=$1 AND module_bot_id=$2',
      [module.id,payload.destination])
    if (!r) return
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    const c=await channel(db,r.id)
    const inbox=await inboxEnabled(db,c.store_id)
    const events=payload.events.sort((a,b)=>a.timestamp-b.timestamp)
    let requestedLink=false
    for (const event of events) {
      if (event.timestamp>Date.now()+5*60000 || !event.mode || event.timestamp<+(c.module_status_at ?? 0)) continue
      if (event.module && event.module.botId!==c.bot_user_id) continue
      const state=event.module?.type==='detached'?'detached':
        event.type==='botSuspended'?'suspended':
        event.type==='deactivated'||event.mode==='standby'?'standby':'active'
      if (c.module_status==='detached' || c.module_status==='suspended' && state!=='detached' && event.type!=='botResumed') continue
      if (state!==c.module_status) {
        const interrupted=state!=='active'
        const {rows:[updated]}=await db.query<Pick<Channel,'checks'|'generation'|'module_status_at'>>(`UPDATE channel
          SET module_status=$2,module_status_at=$3,revision=revision+1,generation=generation+CASE WHEN $4 THEN 1 ELSE 0 END,
            checks=CASE WHEN $4 THEN checks-'webhook_verified'-'delivery_confirmed'
              ELSE checks || '{"webhook_verified":true}'::jsonb END WHERE id=$1 RETURNING checks,generation,module_status_at`,
        [r.id,state,new Date(event.timestamp),interrupted])
        Object.assign(c,updated,{module_status:state})
      } else if (state==='active' && !c.checks.webhook_verified) {
        await db.query(`UPDATE channel SET checks=checks || '{"webhook_verified":true}'::jsonb,revision=revision+1 WHERE id=$1`,[r.id])
        c.checks.webhook_verified=true
      }
      if ((state==='active' && !['module','activated','botResumed'].includes(event.type)) ||
        (state==='standby' && event.type==='unsend')) {
        if (await recordWebhookEvents(db,cfg,c,[event],inbox)) requestedLink=true
      }
    }
    if (requestedLink) return r
  })
}

async function inboxEnabled(db:DB,store:string) {
  const {rows:[row]}=await db.query<{inbox_enabled:boolean}>('SELECT inbox_enabled FROM store WHERE id=$1',[store])
  return row.inbox_enabled
}

async function recordWebhookEvents(db:DB,cfg:Config,c:Channel,events:z.infer<typeof eventSchema>[],inbox:boolean) {
  let requestedLink=false
  for (const event of events) {
    if (event.timestamp>Date.now()+5*60000) continue
    const source=event.source?.type==='user' ? event.source.userId : undefined
    const user=source && (c.module_channel_id || userId.safeParse(source).success) ? source : undefined
    const key=user ? userKey(cfg,c,user) : null
    const kind=event.type==='follow'&&event.follow?.isUnblocked?'refollow':event.type
    const phrase=event.message?.type==='text'?event.message.text?.trim():null
    const stopSignal=phrase==='全配信停止'?'all':phrase==='販促停止'?'marketing':null
    // postback は認識した action と、実在する流入元IDだけを保存する（生データは保存しない）。
    const params=kind==='postback'&&event.postback?new URLSearchParams(event.postback.data):null
    const actionParam=params?.get('action')
    const action=actionParam==='interview_link'||actionParam==='customer_link'?actionParam:
      kind==='message'&&user&&phrase==='面談予約'&&c.purpose!=='customer'?'interview_link':null
    let sourceId:string|null=null
    const sourceParam=params?.get('source')
    if (action&&sourceParam&&uuid.safeParse(sourceParam).success) {
      // 流入元はこのチャネル・用途のものだけを信用する。不正なIDは黙って捨てる。
      const {rowCount}=await db.query('SELECT 1 FROM workflow_source WHERE id=$1 AND channel_id=$2 AND purpose=$3',
        [sourceParam,c.id,action==='interview_link'?'recruitment':'customer'])
      if (rowCount) sourceId=sourceParam
    }
    // 兼用OAでは action が用途の振り分けそのものになるため、どちらのリンク postback でも宛先を封緘する（フェーズ4）。
    // 採用OAの友だち追加でも宛先を封緘する: 採用シナリオの実配信（026）が follow を起点に
    // workflow_contact を登録し、応募者を特定するために必要（従来は postback 時のみ封緘していた）。
    const recipient=key&&user&&((['customer','recruitment'].includes(c.purpose)&&['follow','refollow'].includes(kind))||
      (c.purpose==='recruitment'&&action==='interview_link')||
      (c.purpose==='customer'&&action==='customer_link')||
      (c.purpose==='shared'&&(action==='interview_link'||action==='customer_link')))
      ? seal(cfg,'webhook:'+c.id+':'+event.webhookEventId,user) : null
    const eventPurpose=c.purpose==='shared'?'unclassified':c.purpose
    // テスター本人確認はメッセージ方式（接続テスト {code}）で行う。
    const test=phrase?.match(/^接続テスト ([A-Za-z0-9_-]{43})$/)
    const written=await db.query(`INSERT INTO webhook_event(tenant_id,store_id,channel_id,event_id,generation,
      occurred_at,kind,purpose,user_key,recipient_box,stop_signal,action,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(channel_id,event_id) DO NOTHING`,
    [c.tenant_id,c.store_id,c.id,event.webhookEventId,c.generation,new Date(event.timestamp),test?'test_link':kind,eventPurpose,key,recipient,stopSignal,action,sourceId])
    if (!written.rowCount || !key || !user) continue
    if (recipient && action && (kind==='message'||kind==='postback') &&
        Date.now()-event.timestamp<10*60000) requestedLink=true
    if (test) {
      const hash=digest(test[1])
      await db.query(`UPDATE tester SET verified_at=now(),user_key=$2,recipient=$3 WHERE code_hash=$1 AND channel_id=$4
        AND generation=$5 AND expires_at>now() AND verified_at IS NULL`,[hash,key,seal(cfg,'tester:'+hash,user),c.id,c.generation])
    } else if (kind==='message'&&inbox||kind==='unsend') {
      await recordInboxEvent(db,cfg,c,key,user,{kind,messageId:event.message?.id,messageType:event.message?.type,
        body:event.message?.type==='text'?event.message.text:undefined,unsent:event.unsend?.messageId,when:new Date(event.timestamp)},inbox)
    }
  }
  return requestedLink
}

export async function issueTester(db: DB, actor: Actor, c: Channel, usage: z.infer<typeof purpose>) {
  if (c.purpose !== 'shared' && c.purpose !== usage) throw missing()
  if (!c.checks.ownership_verified || (c.module_channel_id ? c.module_status==='detached'||c.module_status==='suspended' :
    !c.checks.provider_verified)) {
    throw new Fault(409,'CONSOLE_CHECKS_REQUIRED','所有権とプロバイダーを確認してください。')
  }
  const id = newId()
  const code = token()
  const result = await db.query(`INSERT INTO tester (id,tenant_id,store_id,channel_id,generation,purpose,
    code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+${testerLifetime}) RETURNING expires_at`,
    [id,c.tenant_id,c.store_id,c.id,c.generation,usage,digest(code)])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.tester_invite',id,null,{purpose:usage})
  return { id, code, expires_at: result.rows[0].expires_at }
}

export async function queueTest(db: DB, actor: Actor, c: Channel, testerId: string, key: string) {
  const { rows: [previous] } = await db.query(`SELECT id,tester_id,status FROM test_send
    WHERE scenario_id IS NULL AND channel_id=$1 AND actor_id=$2 AND operation_key=$3`,[c.id,actor.id,key])
  if (previous) {
    if (previous.tester_id !== testerId) throw conflict()
    return { id: previous.id, status: previous.status }
  }
  const { rows: [tester] } = await db.query(`SELECT * FROM tester WHERE id=$1 AND channel_id=$2
    AND generation=$3 AND verified_at IS NOT NULL AND expires_at>now() FOR UPDATE`,[testerId,c.id,c.generation])
  if (!tester) throw missing()
  const existing = await db.query('SELECT id,status,scenario_id FROM test_send WHERE tester_id=$1', [testerId])
  if (existing.rows[0]?.scenario_id) throw conflict()
  if (existing.rowCount) return {id:existing.rows[0].id,status:existing.rows[0].status}
  const { rows: [e] } = await db.query(`SELECT EXISTS(SELECT 1 FROM webhook_event e WHERE ${connectionTestEvent}) AS heard,
    EXISTS(SELECT 1 FROM channel_relationship WHERE channel_id=t.channel_id AND user_key=t.user_key AND following=false) AS blocked
    FROM tester t WHERE t.id=$1`,[tester.id])
  if (!e.heard || e.blocked || !c.checks.token_verified || !c.checks.webhook_verified ||
    (c.module_channel_id && !channelTestReady(c))) {
    throw new Fault(409,'TEST_NOT_READY','疎通確認後、認証したテスト利用者から公式アカウントへメッセージを送ってください。')
  }
  const id = newId()
  await db.query(`INSERT INTO test_send
    (id,tenant_id,store_id,channel_id,tester_id,actor_id,operation_key,generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,c.tenant_id,c.store_id,c.id,testerId,actor.id,key,c.generation])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.test_queue',id)
  return { id, status: 'queued' }
}
