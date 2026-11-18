import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import { Secret, TOTP } from 'otpauth'
import { createApp } from '../dist/app.js'
import { assertAppRole, digest, poolFor, scope, tx } from '../dist/core.js'
import { bootstrap, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'

// LIFFなし面談予約（固有トークン方式）フェーズ1の結合試験。
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true }
const bot = 'U' + '1'.repeat(32)
const user = 'U' + '2'.repeat(32)
const user2 = 'U' + '3'.repeat(32)
const user3 = 'U' + '4'.repeat(32)
const channelSecret = 'a'.repeat(32)
const accessToken = 'test-channel-token'
const loginId = '1234567891'
const pass = 'Only used in local tests!'
const consoleChecks = {
  ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
  login_published: true, non_developer: true, delivery_confirmed: false,
}
let pg, owner, pool, server, dir, base, tenant, storeId, connection, admin
const pushesLog = []
const signed = raw => createHmac('sha256', channelSecret).update(raw).digest('base64')
const send = (url, options = {}) => fetch(base + url, { redirect: 'error', ...options })
const idempotency = () => ({ 'Idempotency-Key': randomUUID() })
const code = (key, steps = 0) => new TOTP({ secret: Secret.fromBase32(key) }).generate({ timestamp: Date.now() + 30000 * steps })

async function request(path, { method = 'GET', data, cookie, headers = {} } = {}) {
  const response = await send('/api/v1' + path, {
    method,
    headers: {
      Origin: origin, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const setCookie = response.headers.get('set-cookie')
  return { status: response.status, data: await response.json(), cookie: setCookie?.split(';')[0], setCookie }
}
function expect(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.data))
  return result.data
}
function post(path, cookie, data, headers) { return request(path, { method: 'POST', cookie, data, headers }) }
function patch(path, cookie, data, headers) { return request(path, { method: 'PATCH', cookie, data, headers }) }
const read = (sql, values) => tx(pool, async db => { await scope(db, tenant, storeId); return db.query(sql, values) })
const worker = () => workOnce(pool, cfg, line, google)
let line, google

const eventFor = (id, type, who, extra = {}) => ({
  webhookEventId: id, type, timestamp: Date.now(), source: { type: 'user', userId: who }, ...extra,
})
async function inbound(events) {
  const raw = JSON.stringify({ destination: bot, events })
  const response = await send('/api/v1/webhooks/line/' + connection, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signed(raw) }, body: raw,
  })
  assert.equal(response.status, 200)
}
const postback = (id, who) => eventFor(id, 'postback', who, { postback: { data: 'action=interview_link' } })

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-link-'))
  pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'db'), user: 'night_owner', password: 'owner-test',
    port, persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--locale=C', '--encoding=UTF8'],
    postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='], onLog: () => {},
  })
  await pg.initialise()
  await pg.start()
  owner = poolFor(`postgresql://night_owner:owner-test@127.0.0.1:${port}/postgres`)
  await owner.query("CREATE ROLE night_app LOGIN NOBYPASSRLS PASSWORD 'app-test'")
  pool = poolFor(`postgresql://night_app:app-test@127.0.0.1:${port}/postgres`)
  await migrate(owner, 'night_app')
  await assertAppRole(pool)
  const fetchLine = async (url, options) => {
    const address = new URL(url)
    assert.equal(address.origin, 'https://api.line.me')
    switch (address.pathname) {
      case '/v2/oauth/verify':
        assert.equal(options.body.get('access_token'), accessToken)
        return Response.json({ client_id: '1234567890' })
      case '/v2/bot/info':
        return Response.json({ userId: bot })
      case '/oauth2/v2.1/verify': {
        assert.equal(options.body.get('client_id'), loginId)
        return Response.json({ iss: 'https://access.line.me', sub: user, exp: Date.now() / 1000 + 600, aud: loginId })
      }
      case '/v2/bot/message/quota': return Response.json({ type: 'limited', value: 200 })
      case '/v2/bot/message/quota/consumption': return Response.json({ totalUsage: 0 })
      case '/v2/bot/message/push': {
        pushesLog.push(JSON.parse(options.body))
        return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-id' } })
      }
      default: throw Error('Unexpected path ' + address.pathname)
    }
  }
  line = new LineAPI(fetchLine)
  google = new InterviewGoogle(cfg, { clientId: 'calendar-client', secret: 'calendar-secret' },
    async () => Response.json({ calendars: {} }))
  server = createApp(pool, cfg, line, google).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = 'http://127.0.0.1:' + server.address().port

  const invite = await bootstrap(owner, cfg, { slug: 'link', name: 'リンク法人', email: 'chief@example.test' })
  expect(await post('/auth/activate', null, { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const auth = await post('/auth/login', null, { tenant: 'link', email: 'chief@example.test', password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  admin = auth.cookie
  tenant = expect(await request('/session', { cookie: admin }), 200).tenant.id
  storeId = expect(await post('/stores', admin, {
    name: 'リンク店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
    timezone: 'Asia/Tokyo', cutoff: '06:00',
  }, idempotency()), 201).id
  connection = expect(await post('/stores/' + storeId + '/connections', admin, {
    label: '採用OA', purpose: 'recruitment', owner_name: 'リンク法人', provider_id: 'provider',
    messaging_id: '1234567890', login_id: loginId, liff_id: loginId + '-test',
    account_type: 'unverified', management_authority: '検証用', channel_secret: channelSecret,
    access_token: accessToken, token_type: 'console',
  }, idempotency()), 201).id
  await tx(pool, async db => {
    await scope(db, tenant, storeId)
    await db.query('UPDATE channel SET checks=$2 WHERE id=$1', [connection, {
      ...consoleChecks, delivery_confirmed: true, token_verified: true, webhook_verified: true,
    }])
    await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
      auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`, [storeId])
  })
  const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin }), 200)
  expect(await patch('/stores/' + storeId + '/features', admin, {
    ...settings, reminders_enabled: true, rich_menus_enabled: true, token_interviews_enabled: true,
    recruitment_enabled: true,
  }), 200)
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const jstDate = days => {
  const at = new Date(Date.now() + days * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}
let slotId, slotDate, bookingId, manageRaw

test('postback でトークンが発行され、PushでURLが届き、再送では二重発行しない', async () => {
  await inbound([eventFor('link-follow-1', 'follow', user)])
  const payload = [postback('link-postback-1', user)]
  await inbound(payload)
  await inbound(payload) // 同一 webhookEventId の再送
  await worker()
  await worker()
  const tokens = await read('SELECT * FROM interview_link_token WHERE channel_id=$1', [connection])
  assert.equal(tokens.rowCount, 1)
  assert.equal(tokens.rows[0].used_at, null)
  const deliveries = await read("SELECT * FROM service_delivery WHERE kind='interview_link'")
  assert.equal(deliveries.rowCount, 1)
  const linkPush = pushesLog.find(item => item.to === user && item.messages[0].text.includes('/reserve/'))
  assert.ok(linkPush, '予約URLのPushが届くこと')
  const raw = linkPush.messages[0].text.match(/\?t=([A-Za-z0-9_-]{43})/)[1]
  assert.equal(digest(raw), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')
})

test('引換→カレンダー→予約確定でトークン消費・採用ケース・確定通知（D4リンク同梱）が連動する', async () => {
  slotDate = jstDate(4)
  slotId = expect(await post('/stores/' + storeId + '/interviews/slots', admin, {
    channel: connection, starts_at: slotDate + 'T18:00:00+09:00', ends_at: slotDate + 'T18:30:00+09:00',
    instructions: '会場案内', published: true,
  }, idempotency()), 201).id
  const tokens = await read('SELECT * FROM interview_link_token WHERE channel_id=$1', [connection])
  const linkPush = pushesLog.find(item => item.to === user && item.messages[0].text.includes('/reserve/'))
  const raw = linkPush.messages[0].text.match(/\?t=([A-Za-z0-9_-]{43})/)[1]

  const bad = await post('/interview-link/' + connection + '/redeem', null, { token: 'A'.repeat(43) })
  assert.equal(bad.status, 401)
  assert.equal(bad.data.code, 'LINK_INVALID')

  const redeemed = await post('/interview-link/' + connection + '/redeem', null, { token: raw })
  expect(redeemed, 200)
  assert.ok(redeemed.cookie?.startsWith('night_interview='))
  const sessions = await read("SELECT audience,link_token_hash FROM interview_session WHERE channel_id=$1", [connection])
  assert.ok(sessions.rows.some(row => row.audience === 'token' && row.link_token_hash === tokens.rows[0].token_hash))

  const calendar = expect(await request('/interview/calendar?start=' + slotDate, { cookie: redeemed.cookie }), 200)
  assert.ok(calendar.slots.some(slot => slot.id === slotId && slot.available))
  expect(await request('/interview/notices', { cookie: redeemed.cookie }), 200)
  expect(await request('/interview/notices', { method: 'PUT', cookie: redeemed.cookie, data: { enabled: true } }), 200)

  const booking = expect(await post('/interview/bookings', redeemed.cookie, { slot: slotId, name: '応募者' }), 201)
  bookingId = booking.id
  const after = await read('SELECT * FROM interview_link_token WHERE channel_id=$1 ORDER BY created_at', [connection])
  const original = after.rows.find(row => row.token_hash === tokens.rows[0].token_hash)
  assert.ok(original.used_at, '予約確定で元のトークンが消費されること')
  const manage = after.rows.find(row => row.booking_id === bookingId)
  assert.ok(manage, 'D4: 変更・取消用トークンが発行されること')
  const cases = await read('SELECT * FROM recruitment_case')
  assert.equal(cases.rowCount, 1, '採用ケースが作成されること')
  const confirm = await read("SELECT body_box FROM service_delivery WHERE kind='interview_confirm'")
  assert.equal(confirm.rowCount, 1)
  assert.ok(confirm.rows[0].body_box, '確定通知に管理リンク（封緘）が同梱されること')

  // LIFF経路のセッションでも同じ予約が見える（applicant_key が合流すること）
  const liff = await post('/interview/login', null, { connection, id_token: 'signed-token-first-user' })
  expect(liff, 200)
  const liffCalendar = expect(await request('/interview/calendar?start=' + slotDate, { cookie: liff.cookie }), 200)
  assert.ok(liffCalendar.bookings.some(item => item.id === bookingId))

  await worker()
  await worker()
  const confirmPush = pushesLog.find(item => item.to === user && item.messages[0].text.includes('面談予約が確定しました。'))
  assert.ok(confirmPush, '確定通知Pushが届くこと')
  const manageMatch = confirmPush.messages[0].text.match(/\?t=([A-Za-z0-9_-]{43})/)
  assert.ok(manageMatch, '確定通知に変更・取消URLが同梱されること')
  manageRaw = manageMatch[1]
  assert.equal(digest(manageRaw), manage.token_hash)

  const used = await post('/interview-link/' + connection + '/redeem', null, { token: raw })
  assert.equal(used.status, 410)
  assert.equal(used.data.code, 'LINK_USED')
})

test('期限切れトークンは LINK_EXPIRED で拒否される', async () => {
  const raw = randomBytes(32).toString('base64url')
  await tx(pool, async db => {
    await scope(db, tenant, storeId)
    const c = (await db.query('SELECT generation FROM channel WHERE id=$1', [connection])).rows[0]
    await db.query(`INSERT INTO interview_link_token
      (id,token_hash,tenant_id,store_id,channel_id,generation,user_key,applicant_key,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'test-user-key','test-applicant-key',now()-interval '1 minute')`,
      [randomUUID(), digest(raw), tenant, storeId, connection, c.generation])
  })
  const result = await post('/interview-link/' + connection + '/redeem', null, { token: raw })
  assert.equal(result.status, 410)
  assert.equal(result.data.code, 'LINK_EXPIRED')
})

test('D4リンクからは既存予約の取消ができる', async () => {
  const redeemed = await post('/interview-link/' + connection + '/redeem', null, { token: manageRaw })
  expect(redeemed, 200)
  const calendar = expect(await request('/interview/calendar?start=' + slotDate, { cookie: redeemed.cookie }), 200)
  const booking = calendar.bookings.find(item => item.id === bookingId)
  assert.ok(booking)
  expect(await patch('/interview/bookings/' + bookingId, redeemed.cookie,
    { action: 'cancel', revision: booking.revision }), 200)
})

test('ブロック中ユーザーと機能フラグOFFでは発行されない', async () => {
  const count = async () => (await read('SELECT count(*)::int AS n FROM interview_link_token')).rows[0].n
  const before = await count()
  const t0 = Date.now()
  await inbound([
    eventFor('link-follow-3', 'follow', user3, { timestamp: t0 }),
    eventFor('link-unfollow-3', 'unfollow', user3, { timestamp: t0 + 1000 }),
    eventFor('link-postback-3', 'postback', user3, { timestamp: t0 + 2000, postback: { data: 'action=interview_link' } }),
  ])
  await worker()
  assert.equal(await count(), before, 'ブロック中は発行されないこと')
  await inbound([eventFor('link-follow-2', 'follow', user2)])
  await worker()
  const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin }), 200)
  expect(await patch('/stores/' + storeId + '/features', admin, { ...settings, token_interviews_enabled: false }), 200)
  await inbound([postback('link-postback-2', user2)])
  await worker()
  const afterCount = (await read('SELECT count(*)::int AS n FROM interview_link_token')).rows[0].n
  assert.equal(afterCount, before, 'フラグOFFでは発行されないこと')
  expect(await patch('/stores/' + storeId + '/features', admin, {
    ...expect(await request('/stores/' + storeId + '/features', { cookie: admin }), 200),
    token_interviews_enabled: true, guest_interviews_enabled: true,
  }), 200)
})

test('ゲスト経路（audience=guest）の既存挙動は変わらない', async () => {
  const session = await post('/guest-interview/' + connection + '/session', null, {})
  expect(session, 201)
  assert.ok(session.cookie?.startsWith('night_guest_interview='))
  const calendar = expect(await request('/guest-interview/' + connection + '/calendar?start=' + slotDate,
    { cookie: session.cookie }), 200)
  assert.ok(calendar.slots.some(slot => slot.id === slotId))
})
