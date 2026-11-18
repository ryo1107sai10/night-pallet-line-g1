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
import { assertAppRole, digest, keyed, poolFor, scope, tx } from '../dist/core.js'
import { bootstrap, migrate } from '../dist/setup.js'
import { LineAPI, userKey } from '../dist/line.js'
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'

// LIFFなし全機能化（フェーズ3）の結合試験。
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true }
const channelSecret = 'a'.repeat(32)
const pass = 'Only used in local tests!'
const botR = 'U' + '1'.repeat(32)
const botC = 'U' + '5'.repeat(32)
const botL = 'U' + '6'.repeat(32)
const userR = 'U' + '2'.repeat(32)
const userR2 = 'U' + '4'.repeat(32)
const userR3 = 'U' + '9'.repeat(32)
const userC = 'U' + '3'.repeat(32)
const userC2 = 'U' + '8'.repeat(32)
const userC3 = 'U' + 'b'.repeat(32)
const userC4 = 'U' + 'c'.repeat(32)
const userL = 'U' + '7'.repeat(32)
const loginId = '1234567894'
const bots = { 'access-token-recruit': botR, 'access-token-customer': botC, 'access-token-liff': botL }
const clients = { 'access-token-recruit': '1234567890', 'access-token-customer': '1234567892', 'access-token-liff': '1234567893' }
const baseChecks = {
  ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
  non_developer: true, token_verified: true, webhook_verified: true,
}
let pg, owner, pool, server, dir, base, tenant, storeId, admin, line, google
let recruit, customer, liffChannel
const pushes = []
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
function put(path, cookie, data, headers) { return request(path, { method: 'PUT', cookie, data, headers }) }
const read = (sql, values) => tx(pool, async db => { await scope(db, tenant, storeId); return db.query(sql, values) })
const worker = () => workOnce(pool, cfg, line, google)

const eventFor = (id, type, who, extra = {}) => ({
  webhookEventId: id, type, timestamp: Date.now(), source: { type: 'user', userId: who }, ...extra,
})
async function inbound(connection, destination, events) {
  const raw = JSON.stringify({ destination, events })
  const response = await send('/api/v1/webhooks/line/' + connection, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signed(raw) }, body: raw,
  })
  assert.equal(response.status, 200)
}
async function setChecks(connection, checks) {
  await tx(pool, async db => {
    await scope(db, tenant, storeId)
    await db.query('UPDATE channel SET checks=$2 WHERE id=$1', [connection, checks])
  })
}
async function connectionSummary(connection) {
  const list = expect(await request('/stores/' + storeId + '/connections', { cookie: admin }), 200)
  return list.find(item => item.id === connection)
}
async function setFeatures(patchData) {
  const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin }), 200)
  return expect(await patch('/stores/' + storeId + '/features', admin, { ...settings, ...patchData }), 200)
}

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-p3-'))
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
  await migrate(owner, 'night_app')
  await assertAppRole(pool)
  const fetchLine = async (url, options) => {
    const address = new URL(url)
    assert.equal(address.origin, 'https://api.line.me')
    switch (address.pathname) {
      case '/v2/oauth/verify':
        return Response.json({ client_id: clients[options.body.get('access_token')] })
      case '/v2/bot/info': {
        const tokenValue = options.headers.Authorization?.replace('Bearer ', '')
        return Response.json({ userId: bots[tokenValue] })
      }
      case '/oauth2/v2.1/verify': {
        assert.equal(options.body.get('client_id'), loginId)
        return Response.json({ iss: 'https://access.line.me', sub: userL, exp: Date.now() / 1000 + 600, aud: loginId })
      }
      case '/v2/bot/message/quota': return Response.json({ type: 'limited', value: 200 })
      case '/v2/bot/message/quota/consumption': return Response.json({ totalUsage: 0 })
      case '/v2/bot/message/push': {
        const body = JSON.parse(options.body)
        pushes.push({ to: body.to, text: body.messages[0].text })
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

  const invite = await bootstrap(owner, cfg, { slug: 'p3', name: '検証法人', email: 'chief@example.test' })
  expect(await post('/auth/activate', null, { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const auth = await post('/auth/login', null, { tenant: 'p3', email: 'chief@example.test', password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  admin = auth.cookie
  tenant = expect(await request('/session', { cookie: admin }), 200).tenant.id
  storeId = expect(await post('/stores', admin, {
    name: '検証店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
    timezone: 'Asia/Tokyo', cutoff: '06:00',
  }, idempotency()), 201).id
  const common = {
    owner_name: '検証法人', provider_id: 'provider', account_type: 'unverified',
    management_authority: '検証用', channel_secret: channelSecret, token_type: 'console',
  }
  // LIFFなし（login_id / liff_id を送らない）で登録する2チャネル
  recruit = expect(await post('/stores/' + storeId + '/connections', admin, {
    ...common, label: '採用OA（LIFFなし）', purpose: 'recruitment',
    messaging_id: '1234567890', access_token: 'access-token-recruit',
  }, idempotency()), 201).id
  customer = expect(await post('/stores/' + storeId + '/connections', admin, {
    ...common, label: '顧客OA（LIFFなし）', purpose: 'customer',
    messaging_id: '1234567892', access_token: 'access-token-customer',
  }, idempotency()), 201).id
  // 従来どおり LIFF を設定したチャネル
  liffChannel = expect(await post('/stores/' + storeId + '/connections', admin, {
    ...common, label: '採用OA（LIFFあり）', purpose: 'recruitment',
    messaging_id: '1234567893', login_id: loginId, liff_id: loginId + '-test', access_token: 'access-token-liff',
  }, idempotency()), 201).id
  await tx(pool, async db => {
    await scope(db, tenant, storeId)
    await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
      auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`, [storeId])
  })
  await setFeatures({
    visits_enabled: true, forms_enabled: true, sources_enabled: true, interviews_enabled: true,
    recruitment_enabled: true, reminders_enabled: true, rich_menus_enabled: true,
    token_interviews_enabled: true, token_customers_enabled: true,
  })
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('項目1: LIFFなしでチャネル登録でき、LIFFの不整合な組み合わせは拒否される', async () => {
  const summaryR = await connectionSummary(recruit)
  assert.equal(summaryR.liff_id, null)
  assert.equal(summaryR.login_id, null)
  assert.equal(summaryR.liff_url, null)
  assert.equal(summaryR.status, 'pending')
  const common = {
    owner_name: '検証法人', provider_id: 'provider', account_type: 'unverified',
    management_authority: '検証用', channel_secret: channelSecret, token_type: 'console',
    label: '不正な接続', purpose: 'recruitment', access_token: 'access-token-recruit',
  }
  const prefix = '/stores/' + storeId + '/connections'
  // LIFF IDだけ（ログインチャネルIDなし）は拒否
  expect(await post(prefix, admin, { ...common, messaging_id: '1234567890', liff_id: loginId + '-test' }, idempotency()), 400)
  // LIFF IDの接頭辞がログインチャネルIDと一致しない場合は拒否
  expect(await post(prefix, admin, {
    ...common, messaging_id: '1234567890', login_id: loginId, liff_id: '1234567899-test',
  }, idempotency()), 400)
  // ログインチャネルIDとMessaging APIチャネルIDの同一指定は拒否
  expect(await post(prefix, admin, {
    ...common, messaging_id: '1234567890', login_id: '1234567890', liff_id: '1234567890-test',
  }, idempotency()), 400)
  // LIFFなしチャネルでは LIFF 画面は開けない（従来どおり 409）
  expect(await request('/liff/' + recruit), 409)
})

test('項目1+2: LIFFなしチャネルでテスターをメッセージ方式で確認し、接続済みまで進める', async () => {
  await setChecks(recruit, { ...baseChecks, delivery_confirmed: false })
  const prefix = '/stores/' + storeId + '/connections/' + recruit
  const invite = expect(await post(prefix + '/tests', admin, { purpose: 'recruitment' }, idempotency()), 201)
  assert.equal(invite.liff_url, null, 'LIFFなしでは招待URLは発行されない')
  // テスターがトークで「接続テスト {code}」を送信すると本人確認が完了する（LIFF不要）
  await inbound(recruit, botR, [
    eventFor('p3-code', 'message', userR, { message: { type: 'text', text: '接続テスト ' + invite.code } }),
  ])
  await inbound(recruit, botR, [
    eventFor('p3-hello', 'message', userR, { message: { type: 'text', text: '確認しました' } }),
    eventFor('p3-follow', 'follow', userR),
  ])
  const listed = expect(await request(prefix + '/tests', { cookie: admin }), 200)
  const tester = listed.find(item => item.id === invite.id)
  assert.ok(tester.verified_at, 'メッセージ方式で本人確認済みになること')
  assert.equal(tester.received, true, '受信の証跡が立つこと')
  const job = expect(await post(prefix + '/tests/' + invite.id + '/send', admin, {}, idempotency()), 202)
  await worker()
  const afterSend = expect(await request(prefix + '/tests', { cookie: admin }), 200)
  assert.equal(afterSend.find(item => item.id === invite.id).send_status, 'accepted')
  assert.ok(job.id)
  // ログイン公開（login_published）が false でも、残りの検収が揃えば「接続済み」になる
  const current = await connectionSummary(recruit)
  const confirmed = expect(await patch(prefix + '/console', admin, {
    ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
    login_published: false, non_developer: true, delivery_confirmed: true,
    reason: '検証端末で確認', revision: current.revision,
  }), 200)
  assert.equal(confirmed.status, 'connected')
  assert.equal(confirmed.checks.tester_verified, true)
})

test('項目1回帰: LIFFありチャネルはログイン公開とLIFF本人確認が揃うまで接続済みにならない', async () => {
  // テスター発行の時点ではログイン公開まで記録済みにする（実運用の順序どおり）。
  // 「接続済み」にならないことは、後のコンソール保存で login_published を外して確認する。
  await setChecks(liffChannel, { ...baseChecks, login_published: true, delivery_confirmed: false })
  const prefix = '/stores/' + storeId + '/connections/' + liffChannel
  const invite = expect(await post(prefix + '/tests', admin, { purpose: 'recruitment' }, idempotency()), 201)
  assert.ok(invite.liff_url, 'LIFFありでは従来どおり招待URLが発行される')
  expect(await post('/auth/line/verify', null, {
    connection: liffChannel, purpose: 'recruitment', code: invite.code,
    id_token: 'signed-token-from-line-platform', allow_test_message: true,
  }), 200)
  await inbound(liffChannel, botL, [eventFor('p3-liff-follow', 'follow', userL)])
  expect(await post(prefix + '/tests/' + invite.id + '/send', admin, {}, idempotency()), 202)
  await worker()
  const consoleBody = {
    ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
    non_developer: true, delivery_confirmed: true, reason: '検証端末で確認',
  }
  const pending = expect(await patch(prefix + '/console', admin, {
    ...consoleBody, login_published: false, revision: (await connectionSummary(liffChannel)).revision,
  }), 200)
  assert.equal(pending.status, 'pending', 'ログイン未公開の間は接続済みにならないこと')
  const connected = expect(await patch(prefix + '/console', admin, {
    ...consoleBody, login_published: true, revision: (await connectionSummary(liffChannel)).revision,
  }), 200)
  assert.equal(connected.status, 'connected')
})

test('項目3: 顧客リンクの postback→Push→引換で来店予約・配信設定・フォームがLIFFなしで使える', async () => {
  await setChecks(customer, { ...baseChecks, delivery_confirmed: true })
  await inbound(customer, botC, [eventFor('p3-c-follow', 'follow', userC)])
  await worker()
  await inbound(customer, botC, [
    eventFor('p3-c-postback', 'postback', userC, { postback: { data: 'action=customer_link' } }),
  ])
  await worker()
  await worker()
  const tokens = await read('SELECT * FROM link_token WHERE channel_id=$1', [customer])
  assert.equal(tokens.rowCount, 1)
  assert.equal(tokens.rows[0].purpose, 'customer')
  const deliveries = await read("SELECT * FROM service_delivery WHERE kind='customer_link'")
  assert.equal(deliveries.rowCount, 1)
  const linkPush = pushes.find(item => item.to === userC && item.text.includes('/account/'))
  assert.ok(linkPush, '顧客リンクのPushが届くこと')
  const raw = linkPush.text.match(/\?t=([A-Za-z0-9_-]{43})/)[1]
  assert.equal(digest(raw), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')

  const bad = await post('/customer-link/' + customer + '/redeem', null, { token: 'A'.repeat(43) })
  assert.equal(bad.status, 401)
  assert.equal(bad.data.code, 'LINK_INVALID')
  const redeemed = await post('/customer-link/' + customer + '/redeem', null, { token: raw })
  expect(redeemed, 200)
  assert.ok(redeemed.cookie?.startsWith('night_customer='))
  const sessions = await read('SELECT customer_id FROM customer_session WHERE channel_id=$1', [customer])
  assert.equal(sessions.rowCount, 1)
  assert.equal(sessions.rows[0].customer_id, tokens.rows[0].subject)

  const account = expect(await request('/customer/account', { cookie: redeemed.cookie }), 200)
  assert.equal(account.store, '検証店')
  // 来店予約の申込み
  const at = Date.now() + 2 * 86400000
  const slot = expect(await post('/stores/' + storeId + '/slots', admin, {
    label: '夜の部', starts_at: new Date(at).toISOString(), ends_at: new Date(at + 3600000).toISOString(),
    capacity: 2, published: true,
  }, idempotency()), 201).id
  const booking = expect(await post('/customer/bookings', redeemed.cookie, { slot, party: 2 }), 201)
  assert.equal(booking.status, 'pending')
  // 配信設定の変更
  const fresh = expect(await request('/customer/account', { cookie: redeemed.cookie }), 200)
  expect(await patch('/customer/preferences', redeemed.cookie, {
    version: fresh.policy_version, revision: fresh.revision,
    preferences: { service_consent: true, marketing_consent: false, all_stop: false },
  }), 200)
  // ワークフローフォームの表示と回答
  const form = expect(await put('/stores/' + storeId + '/workflows/customer/forms', admin, {
    channel: customer, revision: 0, title: '来店前フォーム', description: 'ご回答ください', published: true,
    fields: [{ key: 'name', label: 'お名前', kind: 'text', required: true, options: [] }],
  }, idempotency()), 200)
  const shown = expect(await request('/customer/form', { cookie: redeemed.cookie }), 200)
  assert.equal(shown.id, form.id)
  expect(await post('/customer/form', redeemed.cookie, {
    form: form.id, revision: form.revision, answers: { name: '顧客' },
  }), 201)
  const responses = await read("SELECT * FROM workflow_response WHERE purpose='customer'")
  assert.equal(responses.rowCount, 1)
})

test('項目4: 流入元をLIFFなしチャネルのトークン発行時に紐づけ、引換で帰属が記録される（採用）', async () => {
  const workflow = '/stores/' + storeId + '/workflows/recruitment'
  // LIFFなしチャネルでも流入元を作成できる（従来は LIFF 必須で 404 だった）
  const entry = expect(await post(workflow + '/sources', admin, { channel: recruit, label: '求人媒体X' }, idempotency()), 201)
  const report = expect(await request(workflow + '/sources?days=30', { cookie: admin }), 200)
  const found = report.entries.find(item => item.id === entry.id)
  assert.equal(found.url, null, 'LIFFなしでは入口URLは LIFF URL にならない')
  assert.equal(found.postback, 'action=interview_link&source=' + entry.id)
  assert.ok(report.channels.some(item => item.id === recruit), 'LIFFなしチャネルも流入元の対象になる')

  await inbound(recruit, botR, [eventFor('p3-r2-follow', 'follow', userR2)])
  await inbound(recruit, botR, [
    eventFor('p3-r2-postback', 'postback', userR2, { postback: { data: 'action=interview_link&source=' + entry.id } }),
  ])
  await worker()
  const tokens = await read(
    'SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2',
    [recruit, keyed(cfg, 'interview:' + recruit + ':' + userR2)])
  assert.equal(tokens.rowCount, 1)
  assert.equal(tokens.rows[0].source_id, entry.id, 'トークンに流入元が紐づくこと')
  const linkPush = pushes.find(item => item.to === userR2 && item.text.includes('/reserve/'))
  const raw = linkPush.text.match(/\?t=([A-Za-z0-9_-]{43})/)[1]
  expect(await post('/interview-link/' + recruit + '/redeem', null, { token: raw }), 200)
  const attribution = await read(
    'SELECT * FROM workflow_attribution WHERE channel_id=$1 AND purpose=$2', [recruit, 'recruitment'])
  assert.equal(attribution.rowCount, 1)
  assert.equal(attribution.rows[0].source_id, entry.id)
  assert.equal(attribution.rows[0].subject, keyed(cfg, 'interview:' + recruit + ':' + userR2))

  // 実在しない流入元IDは黙って捨てられ、トークンは流入元なしで発行される
  await inbound(recruit, botR, [eventFor('p3-r3-follow', 'follow', userR3)])
  await inbound(recruit, botR, [
    eventFor('p3-r3-postback', 'postback', userR3, { postback: { data: 'action=interview_link&source=' + randomUUID() } }),
  ])
  await worker()
  const bogus = await read(
    'SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2',
    [recruit, keyed(cfg, 'interview:' + recruit + ':' + userR3)])
  assert.equal(bogus.rowCount, 1)
  assert.equal(bogus.rows[0].source_id, null)
})

test('項目4: 顧客リンクでも流入元が帰属に記録される', async () => {
  const workflow = '/stores/' + storeId + '/workflows/customer'
  const entry = expect(await post(workflow + '/sources', admin, { channel: customer, label: '店頭QR' }, idempotency()), 201)
  await inbound(customer, botC, [eventFor('p3-c2-follow', 'follow', userC2)])
  await worker()
  await inbound(customer, botC, [
    eventFor('p3-c2-postback', 'postback', userC2, { postback: { data: 'action=customer_link&source=' + entry.id } }),
  ])
  await worker()
  const tokens = await read('SELECT * FROM link_token WHERE channel_id=$1 AND source_id=$2', [customer, entry.id])
  assert.equal(tokens.rowCount, 1)
  const linkPush = pushes.find(item => item.to === userC2 && item.text.includes('/account/'))
  const raw = linkPush.text.match(/\?t=([A-Za-z0-9_-]{43})/)[1]
  expect(await post('/customer-link/' + customer + '/redeem', null, { token: raw }), 200)
  const attribution = await read(
    'SELECT * FROM workflow_attribution WHERE channel_id=$1 AND purpose=$2', [customer, 'customer'])
  assert.equal(attribution.rowCount, 1)
  assert.equal(attribution.rows[0].source_id, entry.id)
  assert.equal(attribution.rows[0].subject, tokens.rows[0].subject)
})

test('項目3ガード: ブロック中ユーザーと機能フラグOFFでは顧客リンクは発行されない', async () => {
  const count = async () => (await read('SELECT count(*)::int AS n FROM link_token WHERE channel_id=$1', [customer])).rows[0].n
  const before = await count()
  const t0 = Date.now()
  await inbound(customer, botC, [
    eventFor('p3-c3-follow', 'follow', userC3, { timestamp: t0 }),
    eventFor('p3-c3-unfollow', 'unfollow', userC3, { timestamp: t0 + 1000 }),
    eventFor('p3-c3-postback', 'postback', userC3, {
      timestamp: t0 + 2000, postback: { data: 'action=customer_link' },
    }),
  ])
  await worker()
  assert.equal(await count(), before, 'ブロック中は発行されないこと')
  await setFeatures({ token_customers_enabled: false })
  await inbound(customer, botC, [eventFor('p3-c4-follow', 'follow', userC4)])
  await inbound(customer, botC, [
    eventFor('p3-c4-postback', 'postback', userC4, { postback: { data: 'action=customer_link' } }),
  ])
  await worker()
  assert.equal(await count(), before, 'フラグOFFでは発行されないこと')
  await setFeatures({ token_customers_enabled: true })
})
