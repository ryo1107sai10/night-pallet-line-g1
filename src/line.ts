import { createHmac, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import {
  type Actor, type Config, type DB, type Route, Fault, audit, conflict, digest, keyed,
  looseId, missing, newId, opaque, purpose, revision, route, scope, seal, text, token,
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
  provider_id: text(80), messaging_id: looseId, login_id: looseId, liff_id: z.string().regex(/^\d{5,20}-[A-Za-z0-9]+$/),
  bot_user_id: userId, account_type: z.enum(['unverified','verified','premium']),
  existing_tools: z.string().trim().max(300).optional(),
  existing_webhook: httpsUrl.optional(), management_authority: text(160), ...credentialFields,
}).refine(data => data.liff_id.startsWith(data.login_id + '-') && data.login_id !== data.messaging_id,
  { path: ['liff_id'], message: 'LIFF IDとLINEログインチャネルIDを確認してください。' })
export const replaceCredentialsSchema = credentialsSchema.extend({ revision, reason: text(200) })
export const consoleSchema = z.strictObject({ revision, reason: text(200),
  ownership_verified: z.boolean(), provider_verified: z.boolean(), redelivery_enabled: z.boolean(),
  auto_reply_checked: z.boolean(), login_published: z.boolean(), non_developer: z.boolean(), delivery_confirmed: z.boolean(),
})
type Credentials = z.infer<typeof credentialsSchema>
type Checks = {
  ownership_verified?: boolean; provider_verified?: boolean; redelivery_enabled?: boolean;
  auto_reply_checked?: boolean; login_published?: boolean; non_developer?: boolean; delivery_confirmed?: boolean;
  token_verified?: boolean; webhook_verified?: boolean;
}
export type Channel = Route & {
  label: string; purpose: 'customer' | 'recruitment' | 'shared'; owner_name: string; provider_id: string;
  login_id: string; liff_id: string; bot_user_id: string; account_type: string;
  existing_tools: string | null; existing_webhook: string | null; management_authority: string;
  credentials: string; checks: Checks; stopped: boolean; revision: number; generation: number;
}

export async function channel(db: DB, id: string) {
  const { rows: [row] } = await db.query<Channel>(`SELECT c.*,r.messaging_id FROM channel c
    JOIN channel_route r ON c.id=r.id WHERE c.id=$1`, [id])
  if (!row) throw missing()
  return row
}

const secretContext = (c: Route) => `line:${c.tenant_id}:${c.store_id}:${c.id}`
export function channelCredentials(cfg: Config, c: Channel) {
  return credentialsSchema.parse(JSON.parse(unseal(cfg, secretContext(c), c.credentials)))
}

export async function createChannel(db: DB, cfg: Config, actor: Actor, store: string,
  data: z.infer<typeof connectionSchema>) {
  const c = { id: newId(), tenant_id: actor.tenant_id, store_id: store, messaging_id: data.messaging_id }
  await db.query('INSERT INTO channel_route VALUES($1,$2,$3,$4)',
    [c.id,c.tenant_id,c.store_id,c.messaging_id])
  const { access_token, channel_secret, token_type } = data
  await db.query(`INSERT INTO channel(id,tenant_id,store_id,label,purpose,owner_name,provider_id,
    login_id,liff_id,bot_user_id,account_type,existing_webhook,existing_tools,management_authority,credentials)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [c.id,c.tenant_id,c.store_id,data.label,data.purpose,data.owner_name,data.provider_id,data.login_id,
      data.liff_id,data.bot_user_id,data.account_type,data.existing_webhook ?? null,data.existing_tools ?? null,
      data.management_authority,seal(cfg,secretContext(c),JSON.stringify({access_token,channel_secret,token_type}))])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.register',c.id)
  return { id: c.id }
}

export async function replaceCredentials(db: DB, cfg: Config, actor: Actor, c: Channel,
  data: z.infer<typeof replaceCredentialsSchema>) {
  const { access_token, channel_secret, token_type, reason } = data
  const update = await db.query(`UPDATE channel SET credentials=$2, generation=generation+1,
    checks=checks-'token_verified'-'webhook_verified'-'delivery_confirmed', revision=revision+1 WHERE id=$1 AND revision=$3`,
    [c.id,seal(cfg,secretContext(c),JSON.stringify({access_token,channel_secret,token_type})),data.revision])
  if (!update.rowCount) throw conflict()
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.rotate_credentials',c.id,reason)
}

export async function evidence(db: DB, c: Channel) {
  const { rows: [result] } = await db.query(`SELECT
    EXISTS(SELECT 1 FROM tester WHERE channel_id=$1 AND generation=$2 AND verified_at IS NOT NULL) AS liff_verified,
    EXISTS(SELECT 1 FROM webhook_event e JOIN tester t ON e.channel_id=t.channel_id AND e.user_key=t.user_key
      WHERE e.channel_id=$1 AND e.generation=$2 AND e.kind IN ('follow','message')
        AND t.generation=$2 AND t.verified_at IS NOT NULL
        AND e.received_at BETWEEN t.verified_at AND t.expires_at
        AND e.occurred_at BETWEEN t.verified_at AND t.expires_at) AS receive_verified,
    EXISTS(SELECT 1 FROM test_send WHERE channel_id=$1 AND generation=$2 AND status='accepted') AS send_accepted`,
    [c.id,c.generation])
  return result as { liff_verified: boolean; receive_verified: boolean; send_accepted: boolean }
}

export async function summary(db: DB, cfg: Config, c: Channel) {
  const { credentials, ...safe } = c
  const checks = { ...c.checks, ...await evidence(db,c) }
  const complete = ['ownership_verified','provider_verified','redelivery_enabled','auto_reply_checked',
    'login_published','non_developer','token_verified','webhook_verified','liff_verified','receive_verified',
    'send_accepted','delivery_confirmed'].every(check => checks[check as keyof typeof checks] === true)
  return { ...safe, checks, status: complete ? 'connected' : 'pending',
    webhook_url: cfg.origin + '/api/v1/webhooks/line/' + c.id,
    liff_url: cfg.origin + '/liff/' + c.id,
  }
}

export class LineAPI {
  constructor(private request: typeof fetch = fetch) {}
  private async call(path: string, options: RequestInit = {}) {
    try {
      return await this.request('https://api.line.me' + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(6000),
      })
    } catch {
      throw new Fault(502,'LINE_UNAVAILABLE','LINEとの通信結果を確認できません。',true)
    }
  }

  async checkToken(c: Channel, cred: Credentials) {
    const endpoint = '/oauth2/v2.1/verify?' + new URLSearchParams({ access_token: cred.access_token })
    const verified = await (cred.token_type === 'v2.1'
      ? this.call(endpoint)
      : this.call('/v2/oauth/verify',{method:'POST',body:new URLSearchParams({access_token:cred.access_token})}))
    if (verified.status === 429 || verified.status >= 500) throw lineUnavailable()
    if (!verified.ok || String((await verified.json()).client_id) !== c.messaging_id) return false
    const bot = await this.call('/v2/bot/info', { headers: { Authorization: 'Bearer ' + cred.access_token } })
    if (bot.status === 429 || bot.status >= 500) throw lineUnavailable()
    return bot.ok && (await bot.json()).userId === c.bot_user_id
  }

  async checkWebhook(cred: Credentials, expected: string) {
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

  async verifyID(loginId: string, idToken: string) {
    const response = await this.call('/oauth2/v2.1/verify', { method: 'POST',
      body: new URLSearchParams({ client_id: loginId, id_token: idToken }),
    })
    if (response.status >= 500 || response.status === 429) throw lineUnavailable()
    if (!response.ok) throw invalidLiff()
    const verified = z.object({ iss: z.literal('https://access.line.me'), aud: z.literal(loginId),
      exp: z.number(), sub: userId }).safeParse(await response.json())
    if (!verified.success || verified.data.exp <= Date.now()/1000) throw invalidLiff()
    return verified.data.sub
  }

  async push(cred: Credentials, recipient: string, attemptID: string) {
    const response = await this.call('/v2/bot/message/push', { method: 'POST',
      headers: { Authorization: 'Bearer ' + cred.access_token, 'Content-Type': 'application/json',
        'X-Line-Retry-Key': attemptID },
      body: JSON.stringify({ to: recipient, messages: [{type:'text',text:'NIGHT pallet LINEの接続テストです。'}] }),
    })
    const acceptedId = response.headers.get('x-line-accepted-request-id')
    const requestId = response.headers.get('x-line-request-id')
    if (response.ok || (response.status === 409 && acceptedId)) {
      return { status: 'accepted', requestId: acceptedId ?? requestId }
    }
    if (response.status >= 500) return { status: 'unknown', requestId }
    return { status: 'failed', requestId, authError: [401,403].includes(response.status) }
  }
}

const lineUnavailable = () => new Fault(502,'LINE_UNAVAILABLE','LINEとの通信結果を確認できません。',true)
const invalidLiff = () => new Fault(401,'INVALID_LIFF','LINEの本人確認またはテストコードを確認してください。')
const signatureError = () => new Fault(401,'INVALID_WEBHOOK','Webhookを確認できません。')
const eventSchema = z.object({ webhookEventId: text(100), type: text(100), timestamp: z.int().min(0).max(8640000000000000),
  source: z.object({ type: z.string(), userId: userId.optional() }).optional(),
})
const webhookSchema = z.object({ destination: userId, events: z.array(eventSchema).max(500) })
const userKey = (cfg: Config, c: Channel, user: string) => keyed(cfg,`line-user:${c.id}:${user}`)

export async function receiveWebhook(pool: pg.Pool, cfg: Config, id: string, raw: Buffer, signature: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw signatureError()
  await tx(pool, async db => {
    const r = await route(db,id)
    await scope(db,r.tenant_id,r.store_id)
    const c = await channel(db,id)
    const actual = Buffer.from(signature,'base64')
    const expected = createHmac('sha256',channelCredentials(cfg,c).channel_secret).update(raw).digest()
    if (!timingSafeEqual(expected,actual)) throw signatureError()
    let payload: unknown
    try { payload = JSON.parse(raw.toString('utf8')) } catch { throw signatureError() }
    const parsed = webhookSchema.safeParse(payload)
    if (!parsed.success || parsed.data.destination !== c.bot_user_id) throw signatureError()
    for (const event of parsed.data.events) {
      const key = event.source?.type === 'user' && event.source.userId
        ? userKey(cfg,c,event.source.userId) : null
      const eventPurpose = c.purpose === 'shared' ? 'unclassified' : c.purpose
      await db.query(`INSERT INTO webhook_event(tenant_id,store_id,channel_id,event_id,generation,
        occurred_at,kind,purpose,user_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(channel_id,event_id) DO NOTHING`,
        [c.tenant_id,c.store_id,id,event.webhookEventId,c.generation,new Date(event.timestamp),event.type,eventPurpose,key])
    }
  })
}

export async function issueTester(db: DB, actor: Actor, c: Channel, usage: z.infer<typeof purpose>) {
  if (c.purpose !== 'shared' && c.purpose !== usage) throw missing()
  if (!c.checks.ownership_verified || !c.checks.provider_verified || !c.checks.login_published) {
    throw new Fault(409,'CONSOLE_CHECKS_REQUIRED','所有権、プロバイダーおよびLINEログインの公開を確認してください。')
  }
  const id = newId()
  const code = token()
  const result = await db.query(`INSERT INTO tester (id,tenant_id,store_id,channel_id,generation,purpose,
    code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 hours') RETURNING expires_at`,
    [id,c.tenant_id,c.store_id,c.id,c.generation,usage,digest(code)])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.tester_invite',id,null,{purpose:usage})
  return { id, code, expires_at: result.rows[0].expires_at, liff_url: 'https://liff.line.me/' + c.liff_id }
}

export const verifyLiffSchema = z.strictObject({
  connection: uuid, purpose, code: opaque, id_token: z.string().min(20).max(12000),
  allow_test_message: z.literal(true),
})

export async function verifyLiff(pool: pg.Pool, cfg: Config, api: LineAPI, data: z.infer<typeof verifyLiffSchema>) {
  const setup = await tx(pool, async db => {
    const r = await route(db,data.connection)
    await scope(db,r.tenant_id,r.store_id)
    const c = await channel(db,r.id)
    const result = await db.query(`SELECT id FROM tester WHERE channel_id=$1 AND code_hash=$2 AND generation=$3
      AND purpose=$4 AND expires_at>now() AND verified_at IS NULL`,[c.id,digest(data.code),c.generation,data.purpose])
    if (!result.rowCount) throw invalidLiff()
    return c
  })
  const recipient = await api.verifyID(setup.login_id,data.id_token)
  await tx(pool, async db => {
    await scope(db,setup.tenant_id,setup.store_id)
    const result = await db.query(`UPDATE tester t SET verified_at=now(),user_key=$2,recipient=$3
      FROM channel c WHERE t.code_hash=$1 AND t.channel_id=c.id AND c.id=$4 AND t.generation=c.generation
        AND t.expires_at>now() AND t.verified_at IS NULL RETURNING t.id`,
      [digest(data.code),userKey(cfg,setup,recipient),seal(cfg,'tester:' + digest(data.code),recipient),setup.id])
    if (!result.rowCount) throw invalidLiff()
    await audit(db,setup.tenant_id,setup.store_id,null,'line.liff_verified',result.rows[0].id,null,{purpose:data.purpose})
  })
  return { verified: true }
}

export async function queueTest(db: DB, actor: Actor, c: Channel, testerId: string, key: string) {
  const { rows: [previous] } = await db.query(`SELECT id,tester_id,status FROM test_send
    WHERE channel_id=$1 AND actor_id=$2 AND operation_key=$3`,[c.id,actor.id,key])
  if (previous) {
    if (previous.tester_id !== testerId) throw conflict()
    return { id: previous.id, status: previous.status }
  }
  const { rows: [tester] } = await db.query(`SELECT * FROM tester WHERE id=$1 AND channel_id=$2
    AND generation=$3 AND verified_at IS NOT NULL AND expires_at>now() FOR UPDATE`,[testerId,c.id,c.generation])
  if (!tester) throw missing()
  const existing = await db.query('SELECT id,status FROM test_send WHERE tester_id=$1', [testerId])
  if (existing.rowCount) return existing.rows[0]
  const { rows: [e] } = await db.query(`SELECT EXISTS(SELECT 1 FROM webhook_event WHERE channel_id=$1
    AND generation=$2 AND user_key=$3 AND received_at BETWEEN $4 AND now()
    AND occurred_at BETWEEN $4 AND now() AND kind IN ('follow','message')) AS heard,
    EXISTS(SELECT 1 FROM channel_relationship WHERE channel_id=$1 AND user_key=$3 AND following=false) AS blocked`,
    [c.id,c.generation,tester.user_key,tester.verified_at])
  if (!e.heard || e.blocked || !c.checks.token_verified || !c.checks.webhook_verified) {
    throw new Fault(409,'TEST_NOT_READY','疎通確認後、認証したテスト利用者から公式アカウントへメッセージを送ってください。')
  }
  const id = newId()
  await db.query(`INSERT INTO test_send
    (id,tenant_id,store_id,channel_id,tester_id,actor_id,operation_key,generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,c.tenant_id,c.store_id,c.id,testerId,actor.id,key,c.generation])
  await audit(db,c.tenant_id,c.store_id,actor.id,'line.test_queue',id)
  return { id, status: 'queued' }
}
