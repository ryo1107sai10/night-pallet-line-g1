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
import { bootstrap, inviteSupervisor, migrate } from '../dist/setup.js'
import { LineAPI, userKey } from '../dist/line.js'
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'

// E2E検収（LIFF撤去後の最終状態）。一続きの物語として検証する:
// 店舗の立ち上げ→Messaging APIのみの接続→通常のやり取り→面談予約の一生→
// 顧客側の来店予約・設定→ステップ配信の実URL差し替え。
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。LIFFは一切使わない。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true }
const channelSecret = 'a'.repeat(32)
const pass = 'Only used in local tests!'
const botR = 'U' + '1'.repeat(32)
const botC = 'U' + '5'.repeat(32)
const userT = 'U' + '2'.repeat(32)   // 採用OAのテスター
const userTC = 'U' + '7'.repeat(32)  // 顧客OAのテスター
const userA = 'U' + '3'.repeat(32)   // 応募者
const userC = 'U' + '4'.repeat(32)   // 顧客（やり取り・来店予約）
const userC2 = 'U' + '8'.repeat(32)  // 顧客（ステップ配信の受信者）
const userT2 = 'U' + '9'.repeat(32)  // シナリオテスト送信のテスター
const bots = { 'e2e-token-recruit': botR, 'e2e-token-customer': botC }
const clients = { 'e2e-token-recruit': '1234567890', 'e2e-token-customer': '1234567892' }
const webhookEndpoints = {}
const manualChecks = {
  ownership_verified: true, provider_verified: true, redelivery_enabled: true,
  auto_reply_checked: true, non_developer: true,
}
let pg, owner, pool, server, dir, base, line, google
let platform, master, tenant, storeId, created
let recruit, customer
const pushes = []
const signed = raw => createHmac('sha256', channelSecret).update(raw).digest('base64')
const send = (url, options = {}) => fetch(base + url, { redirect: 'error', ...options })
const idempotency = () => ({ 'Idempotency-Key': randomUUID() })
const code = (key, steps = 0) => new TOTP({ secret: Secret.fromBase32(key) })
  .generate({ timestamp: Date.now() + 30000 * steps })

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
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await worker() }
const pushesTo = who => pushes.filter(item => item.to === who)
const rawOf = text => text?.match(/\?t=([A-Za-z0-9_-]{43})/)?.[1]

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
async function activate(invite, email, tenantSlug, loginPath = '/auth/login') {
  expect(await post('/auth/activate', null,
    { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const auth = await post(loginPath, null,
    { tenant: tenantSlug, email, password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  assert.ok(auth.cookie)
  return auth.cookie
}
const jstDate = days => {
  const at = new Date(Date.now() + days * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-e2e-'))
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
      case '/v2/bot/channel/webhook/endpoint': {
        const tokenValue = options.headers.Authorization?.replace('Bearer ', '')
        return Response.json({ endpoint: webhookEndpoints[tokenValue], active: true })
      }
      case '/v2/bot/channel/webhook/test':
        return Response.json({ success: true })
      case '/v2/bot/message/quota': return Response.json({ type: 'limited', value: 200 })
      case '/v2/bot/message/quota/consumption': return Response.json({ totalUsage: 0 })
      case '/v2/bot/message/push': {
        const body = JSON.parse(options.body)
        pushes.push({ to: body.to, text: body.messages[0].text ?? '' })
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

  // 舞台: エール（agency）と北村さん（platform）。店舗の立ち上げ自体は段落1で検証する。
  const agencyInvite = await bootstrap(owner, cfg, { slug: 'aile', name: 'エール', email: 'chief@example.test' })
  await activate(agencyInvite, 'chief@example.test', 'aile')
  const supervisorInvite = await inviteSupervisor(owner, cfg,
    { slug: 'lilu', name: 'リルコーポレーション', displayName: '北村さん', email: 'kitamura@example.test', agency: 'aile' })
  platform = await activate(supervisorInvite, 'kitamura@example.test', 'lilu', '/auth/platform/login')
  assert.match(platform, /^night_platform=/)
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('段落1: 北村さんの登録ウィザードで法人・店舗ができ、エールが初期設定を進められる', async () => {
  const input = { legal_name: '検収法人', store_name: '検収店', email: 'ops@example.test' }
  created = expect(await post('/platform/registrations', platform, input, idempotency()), 201)
  assert.match(created.tenant.slug, /^corp-[0-9a-f]{16}$/)
  assert.equal(created.store.name, '検収店')
  assert.ok(created.invite.invite_code && created.invite.setup_key, 'エール担当への招待が発行されること')
  assert.equal(created.urls.master, origin + '/master/')
  tenant = created.tenant.id
  storeId = created.store.id

  const progress = expect(await request('/platform/registrations/progress', { cookie: platform }), 200)
  const entry = progress.find(item => item.tenant.id === tenant)
  assert.equal(entry.stage, 'master_pending')
  assert.equal(entry.master.activated, false)

  master = await activate(created.invite, 'ops@example.test', created.tenant.slug)
  const session = expect(await request('/session', { cookie: master }), 200)
  assert.equal(session.tenant.legal_name, '検収法人')
  assert.deepEqual(session.stores.map(store => store.id), [storeId])

  const base = '/stores/' + storeId
  const setup = () => request(base + '/setup', { cookie: master })
  let state = expect(await setup(), 200)
  assert.deepEqual(state.steps, { profile: false, features: false, hours: false, line: false })
  assert.equal(state.completed_at, null)

  // ステップ1: 店舗情報（未設定プレースホルダを実入力に置き換える）
  const profiled = expect(await patch(base, master, {
    name: '検収店', address: '東京都新宿区', business_type: '接客飲食', responsible: '店長',
    timezone: 'Asia/Tokyo', cutoff: '06:00', revision: state.profile.store_revision,
  }), 200)
  expect(await post(base + '/setup/confirm', master, { step: 'profile', revision: state.revision }), 200)

  // 配信の前提: 店舗情報が固まった後に適格性確認を行う
  // （店舗情報を後から変えると適格性は自動で外れる仕様のため、この順序が必須）。
  // 契約・自動配信の有効化は、接続済みチャネルが要るため段落2で行う。
  expect(await patch(base + '/eligibility', master,
    { verified: true, reference: '検収用の適格性確認', revision: profiled.revision }), 200)

  // ステップ2: 使う機能（トークン方式の面談・顧客リンクを含む）
  const settings = expect(await request(base + '/features', { cookie: master }), 200)
  expect(await patch(base + '/features', master, {
    ...settings, visits_enabled: true, interviews_enabled: true, recruitment_enabled: true,
    reminders_enabled: true, inbox_enabled: true, rich_menus_enabled: true,
    token_interviews_enabled: true, token_customers_enabled: true,
  }), 200)
  state = expect(await setup(), 200)
  expect(await post(base + '/setup/confirm', master, { step: 'features', revision: state.revision }), 200)

  // ステップ3: 面談の受付時間 19:00-23:00
  state = expect(await setup(), 200)
  expect(await patch(base + '/interviews/hours', master,
    { start: 1140, end: 1380, revision: state.hours.revision }), 200)
  state = expect(await setup(), 200)
  expect(await post(base + '/setup/confirm', master, { step: 'hours', revision: state.revision }), 200)

  state = expect(await setup(), 200)
  assert.deepEqual(state.steps, { profile: true, features: true, hours: true, line: false })
  // LINE接続が済むまでは完了できない
  const incomplete = await post(base + '/setup/complete', master, { revision: state.revision })
  expect(incomplete, 409)
  assert.equal(incomplete.data.code, 'SETUP_INCOMPLETE')
})

// Messaging APIのみの接続を、API操作だけで「接続済み」まで進める共通手順。
async function connectChannel(connection, destination, testerUser, purpose) {
  const prefix = '/stores/' + storeId + '/connections/' + connection
  const summary = async () => expect(await request('/stores/' + storeId + '/connections', { cookie: master }), 200)
    .find(item => item.id === connection)
  expect(await post(prefix + '/check-token', master, { revision: (await summary()).revision }), 200)
  expect(await post(prefix + '/check-webhook', master, { revision: (await summary()).revision }), 200)
  expect(await patch(prefix + '/console', master, {
    ...manualChecks, delivery_confirmed: false, reason: '公式管理画面で照合', revision: (await summary()).revision,
  }), 200)
  const invite = expect(await post(prefix + '/tests', master, { purpose }, idempotency()), 201)
  assert.ok(!('liff_url' in invite), 'テスター招待にLIFF URLが含まれないこと')
  await inbound(connection, destination, [
    eventFor('e2e-code-' + testerUser, 'message', testerUser,
      { message: { type: 'text', text: '接続テスト ' + invite.code } }),
  ])
  await inbound(connection, destination, [eventFor('e2e-follow-' + testerUser, 'follow', testerUser)])
  await flush(2)
  const listed = expect(await request(prefix + '/tests', { cookie: master }), 200)
  const tester = listed.find(item => item.id === invite.id)
  assert.ok(tester.verified_at, 'メッセージ方式（接続テスト {code}）で本人確認が完了すること')
  assert.equal(tester.received, true, '受信の証跡が立つこと')
  const pushesBefore = pushesTo(testerUser).length
  expect(await post(prefix + '/tests/' + invite.id + '/send', master, {}, idempotency()), 202)
  await flush(2)
  const afterSend = expect(await request(prefix + '/tests', { cookie: master }), 200)
  assert.equal(afterSend.find(item => item.id === invite.id).send_status, 'accepted',
    'テスト送信がLINEに受け付けられること')
  assert.ok(pushesTo(testerUser).length > pushesBefore, 'テスト送信がテスターに届くこと')
  const confirmed = expect(await patch(prefix + '/console', master, {
    ...manualChecks, delivery_confirmed: true, reason: '検証端末で受信を確認', revision: (await summary()).revision,
  }), 200)
  assert.equal(confirmed.status, 'connected', '接続が「接続済み」になること')
  assert.equal(confirmed.checks.tester_verified, true)
  return invite.id
}

test('段落2: Messaging APIのみの接続がメッセージ方式の確認で接続済みになり、初期設定が完了する', async () => {
  const common = {
    owner_name: '検収法人', provider_id: 'provider', account_type: 'unverified',
    management_authority: '管理権限を確認済み', channel_secret: channelSecret, token_type: 'console',
  }
  recruit = expect(await post('/stores/' + storeId + '/connections', master, {
    ...common, label: '採用OA', purpose: 'recruitment',
    messaging_id: '1234567890', access_token: 'e2e-token-recruit',
  }, idempotency()), 201).id
  customer = expect(await post('/stores/' + storeId + '/connections', master, {
    ...common, label: '顧客OA', purpose: 'customer',
    messaging_id: '1234567892', access_token: 'e2e-token-customer',
  }, idempotency()), 201).id
  webhookEndpoints['e2e-token-recruit'] = origin + '/api/v1/webhooks/line/' + recruit
  webhookEndpoints['e2e-token-customer'] = origin + '/api/v1/webhooks/line/' + customer
  const summaryR = expect(await request('/stores/' + storeId + '/connections', { cookie: master }), 200)
    .find(item => item.id === recruit)
  assert.ok(!('liff_id' in summaryR) && !('login_id' in summaryR), '接続にLIFF項目が存在しないこと')
  assert.equal(summaryR.status, 'pending')

  await connectChannel(recruit, botR, userT, 'recruitment')
  await connectChannel(customer, botC, userTC, 'customer')

  // LINEステップが自動で確定し、セットアップを完了できる
  const base = '/stores/' + storeId
  const state = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.equal(state.steps.line, true)
  expect(await post(base + '/setup/complete', master, { revision: state.revision }), 200)
  const done = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.ok(done.completed_at, '初期設定ウィザードが完了状態になること')
  const progress = expect(await request('/platform/registrations/progress', { cookie: platform }), 200)
  const entry = progress.find(item => item.tenant.id === tenant)
  assert.equal(entry.stores[0].setup.completed, true)
  assert.equal(entry.stage, 'verified')

  // 接続済みチャネルができたので、契約・自動配信を有効化する（以降の配信の前提）
  const latest = expect(await request(base + '/setup', { cookie: master }), 200)
  expect(await patch(base + '/automation', master, {
    revision: latest.profile.store_revision, enabled: true, contract: true,
    monthly_limit: 100, reason: '検収開始',
  }), 200)
})

test('段落3: 顧客のメッセージが受信箱に保存され、管理側の返信がPushで届く', async () => {
  await inbound(customer, botC, [eventFor('e2e-c-follow', 'follow', userC)])
  await flush(2)
  const customers = await read('SELECT id FROM customer WHERE channel_id=$1 AND user_key=$2',
    [customer, userKey(cfg, { id: customer }, userC)])
  assert.equal(customers.rowCount, 1, '友だち追加で顧客台帳に登録されること')

  const text = '明日の予約について教えてください'
  await inbound(customer, botC, [
    eventFor('e2e-c-message', 'message', userC, { message: { id: 'e2e-msg-1', type: 'text', text } }),
  ])
  await flush(2)
  const inboxPath = '/stores/' + storeId + '/workflows/customer/inbox'
  const overview = expect(await request(inboxPath, { cookie: master }), 200)
  assert.equal(overview.threads.length, 1, '受信箱にスレッドができること')
  const thread = overview.threads[0]
  assert.equal(thread.unread, true)
  const messages = expect(await request(inboxPath + '/' + thread.id, { cookie: master }), 200)
  assert.ok(messages.some(item => item.direction === 'incoming' && item.body === text),
    '顧客のテキストがそのまま保存されること')

  const actor = expect(await request('/session', { cookie: master }), 200).actor
  const handling = expect(await patch(inboxPath + '/' + thread.id, master,
    { revision: thread.revision, state: 'handling', assigned_to: actor.id }), 200)
  const reply = 'お問い合わせありがとうございます。明日19時にお待ちしております。'
  expect(await post(inboxPath + '/' + thread.id, master,
    { revision: handling.revision, body: reply, internal: false }, idempotency()), 201)
  await flush(2)
  assert.ok(pushesTo(userC).some(item => item.text === reply), '管理側の返信（Push）が顧客に届くこと')
  const sent = expect(await request(inboxPath + '/' + thread.id, { cookie: master }), 200)
  assert.ok(sent.some(item => item.direction === 'outgoing' && item.status === 'accepted'),
    '送信が受け付け済みとして履歴に残ること')
})

let slotA, slotB, dateA, dateB, bookingId, manageRaw, applicantCookie

test('段落4: 面談枠の公開から、トークンURL・予約・採用ケース・確定通知までつながる', async () => {
  dateA = jstDate(4)
  slotA = expect(await post('/stores/' + storeId + '/interviews/slots', master, {
    channel: recruit, starts_at: dateA + 'T19:30:00+09:00', ends_at: dateA + 'T20:00:00+09:00',
    instructions: '会場案内', published: true,
  }, idempotency()), 201).id

  await inbound(recruit, botR, [eventFor('e2e-a-follow', 'follow', userA)])
  await inbound(recruit, botR, [
    eventFor('e2e-a-postback', 'postback', userA, { postback: { data: 'action=interview_link' } }),
  ])
  await flush(2)
  const tokens = await read('SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2',
    [recruit, keyed(cfg, 'interview:' + recruit + ':' + userA)])
  assert.equal(tokens.rowCount, 1, 'postbackで面談トークンが発行されること')
  const linkPush = pushesTo(userA).find(item => item.text.includes('/reserve/'))
  assert.ok(linkPush, '面談リンク（トークンURL）がPushで届くこと')
  assert.ok(!linkPush.text.includes('liff.line.me'), 'LIFF URLが混入しないこと')
  const raw = rawOf(linkPush.text)
  assert.ok(raw)
  assert.equal(digest(raw), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')

  const redeemed = await post('/interview-link/' + recruit + '/redeem', null, { token: raw })
  expect(redeemed, 200)
  assert.ok(redeemed.cookie?.startsWith('night_interview='))
  applicantCookie = redeemed.cookie
  expect(await put('/interview/notices', applicantCookie, { enabled: true }), 200)

  const calendar = expect(await request('/interview/calendar?start=' + dateA, { cookie: applicantCookie }), 200)
  assert.ok(calendar.slots.some(slot => slot.id === slotA && slot.available), '公開した面談枠がカレンダーに出ること')

  const booking = expect(await post('/interview/bookings', applicantCookie, { slot: slotA, name: '応募者' }), 201)
  bookingId = booking.id
  const cases = await read('SELECT * FROM recruitment_case')
  assert.equal(cases.rowCount, 1, '予約に連動して採用ケースが作成されること')
  const after = await read('SELECT * FROM interview_link_token WHERE channel_id=$1 ORDER BY created_at', [recruit])
  assert.ok(after.rows.find(row => row.token_hash === tokens.rows[0].token_hash).used_at,
    '予約確定で元のトークンが消費されること')
  const manage = after.rows.find(row => row.booking_id === bookingId)
  assert.ok(manage, '変更・取消用トークンが発行されること')

  await flush(3)
  const confirmPush = pushesTo(userA).find(item => item.text.includes('面談予約が確定しました。'))
  assert.ok(confirmPush, '確定通知がPushで届くこと')
  manageRaw = rawOf(confirmPush.text)
  assert.ok(manageRaw, '確定通知に変更・取消URLが同梱されること')
  assert.equal(digest(manageRaw), manage.token_hash)
})

test('段落5: リマインド対象になり、確定通知のリンクから変更・取消ができる', async () => {
  const reminders = await read(
    "SELECT id,status,next_at FROM service_delivery WHERE kind='interview_reminder' AND object_id=$1", [bookingId])
  assert.equal(reminders.rowCount, 1, 'リマインドが予約に連動して登録されること')
  assert.equal(reminders.rows[0].status, 'queued')
  assert.ok(new Date(reminders.rows[0].next_at) > new Date(), 'リマインドの送信予定が未来に設定されること')

  const redeemed = await post('/interview-link/' + recruit + '/redeem', null, { token: manageRaw })
  expect(redeemed, 200)
  const manageCookie = redeemed.cookie

  dateB = jstDate(5)
  slotB = expect(await post('/stores/' + storeId + '/interviews/slots', master, {
    channel: recruit, starts_at: dateB + 'T20:30:00+09:00', ends_at: dateB + 'T21:00:00+09:00',
    instructions: '会場案内', published: true,
  }, idempotency()), 201).id
  const beforeChange = await read('SELECT revision FROM interview_booking WHERE id=$1', [bookingId])
  expect(await patch('/interview/bookings/' + bookingId, manageCookie,
    { action: 'reschedule', revision: beforeChange.rows[0].revision, slot: slotB }), 200)
  const calendar = expect(await request('/interview/calendar?start=' + dateA, { cookie: manageCookie }), 200)
  const moved = calendar.bookings.find(item => item.id === bookingId)
  assert.ok(moved && moved.slot_id === slotB && moved.status === 'confirmed', '日程変更が反映されること')

  const reminderRows = await read(
    "SELECT status FROM service_delivery WHERE kind='interview_reminder' AND object_id=$1 ORDER BY next_at", [bookingId])
  assert.ok(reminderRows.rows.some(row => row.status === 'cancelled'), '変更前のリマインドは取り消されること')
  const next = reminderRows.rows.filter(row => row.status === 'queued')
  assert.equal(next.length, 1, '変更後の日程でリマインドが組み直されること')

  // 送信時刻を迎えた状態を再現して、実際にリマインドが届くことを確認する
  await tx(owner, async db => {
    await scope(db, tenant, storeId)
    await db.query("UPDATE service_delivery SET next_at=now() WHERE kind='interview_reminder' AND object_id=$1 AND status='queued'", [bookingId])
  })
  await flush(2)
  assert.ok(pushesTo(userA).some(item => item.text.includes('面談のリマインドです。')),
    'リマインドがPushで届くこと')

  const beforeCancel = await read('SELECT revision,status FROM interview_booking WHERE id=$1', [bookingId])
  expect(await patch('/interview/bookings/' + bookingId, manageCookie,
    { action: 'cancel', revision: beforeCancel.rows[0].revision }), 200)
  const afterCancel = await read('SELECT status FROM interview_booking WHERE id=$1', [bookingId])
  assert.equal(afterCancel.rows[0].status, 'cancelled', '取消が反映されること')
  const finalCalendar = expect(await request('/interview/calendar?start=' + dateA, { cookie: manageCookie }), 200)
  assert.ok(finalCalendar.bookings.some(item => item.id === bookingId && item.status === 'cancelled'))
})

let customerCookie

test('段落6: 顧客リンクから /account を開き、来店予約と設定変更ができる', async () => {
  await inbound(customer, botC, [
    eventFor('e2e-c-postback', 'postback', userC, { postback: { data: 'action=customer_link' } }),
  ])
  await flush(2)
  const linkPush = pushesTo(userC).find(item => item.text.includes('/account/'))
  assert.ok(linkPush, '顧客リンクがPushで届くこと')
  assert.ok(!linkPush.text.includes('liff.line.me'), 'LIFF URLが混入しないこと')
  const redeemed = await post('/customer-link/' + customer + '/redeem', null, { token: rawOf(linkPush.text) })
  expect(redeemed, 200)
  assert.ok(redeemed.cookie?.startsWith('night_customer='))
  customerCookie = redeemed.cookie

  const account = expect(await request('/customer/account', { cookie: customerCookie }), 200)
  assert.equal(account.store, '検収店')

  const at = Date.now() + 2 * 86400000
  const slot = expect(await post('/stores/' + storeId + '/slots', master, {
    label: '来店枠', starts_at: new Date(at).toISOString(), ends_at: new Date(at + 3600000).toISOString(),
    capacity: 2, published: true,
  }, idempotency()), 201).id
  const booking = expect(await post('/customer/bookings', customerCookie, { slot, party: 2 }), 201)
  assert.equal(booking.status, 'pending', '来店予約を申し込めること')

  const fresh = expect(await request('/customer/account', { cookie: customerCookie }), 200)
  expect(await patch('/customer/preferences', customerCookie, {
    version: fresh.policy_version, revision: fresh.revision,
    preferences: { service_consent: true, marketing_consent: false, all_stop: false },
  }), 200)
  const stored = await read('SELECT service_consent,marketing_consent FROM customer WHERE channel_id=$1 AND user_key=$2',
    [customer, userKey(cfg, { id: customer }, userC)])
  assert.deepEqual([stored.rows[0].service_consent, stored.rows[0].marketing_consent], [true, false],
    '配信設定の変更が保存されること')
})

test('段落7: ステップ配信でリンク変数が発行済みの実URLに差し替わって届く', async () => {
  // (a) 顧客シナリオの実配信: {{customer_link}} と {{booking_url}}
  const root = '/stores/' + storeId + '/scenarios'
  const graph = {
    name: '検収・予約確定案内', purpose: 'customer', trigger: 'booking_created', channel: customer,
    windowStart: '00:00', windowEnd: '23:59', daily: 5, weekly: 10, cooldownDays: 30, rejoin: false,
    missingAssignee: 'manager', holidays: [], entry: 'update',
    nodes: [
      { id: 'update', type: 'message', name: '確定のお知らせ', category: 'service',
        body: '{{store}}でご予約が確定しました。来店予約・設定はこちら: {{customer_link}} 予約の確認・変更はこちら: {{booking_url}}',
        next: 'end' },
      { id: 'end', type: 'end', name: '完了' },
    ],
  }
  const createdScenario = expect(await post(root, master, graph, idempotency()), 201)
  const transition = root + '/' + createdScenario.id + '/transition'
  const pubFixture = {
    start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: true, consent: true,
    adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
    human: false, cancelled: false, bookingLinkValid: true, tags: [],
    values: {
      name: 'テスト利用者', store: '検収店', staff: '', booking: '11月18日 22:00', price: '',
      booking_url: 'https://example.test/booking', customer_link: 'https://example.test/account/sample',
    },
  }
  const tested = expect(await post(transition, master,
    { revision: createdScenario.revision, action: 'test', fixture: pubFixture }), 200)
  const approved = expect(await post(transition, master, { revision: tested.revision, action: 'approve' }), 200)
  expect(await post(transition, master, { revision: approved.revision, action: 'publish' }), 200)

  await inbound(customer, botC, [eventFor('e2e-c2-follow', 'follow', userC2)])
  await flush(2)
  await inbound(customer, botC, [
    eventFor('e2e-c2-postback', 'postback', userC2, { postback: { data: 'action=customer_link' } }),
  ])
  await flush(2)
  const firstLink = pushesTo(userC2).find(item => item.text.includes('/account/'))
  assert.ok(firstLink, '同意取得用の顧客リンクが届くこと')
  const login = await post('/customer-link/' + customer + '/redeem', null, { token: rawOf(firstLink.text) })
  expect(login, 200)
  const account2 = expect(await request('/customer/account', { cookie: login.cookie }), 200)
  expect(await patch('/customer/preferences', login.cookie, {
    version: account2.policy_version, revision: account2.revision,
    preferences: { service_consent: true, marketing_consent: false, all_stop: false },
  }), 200)
  const at = Date.now() + 3 * 86400000
  const visitSlot = expect(await post('/stores/' + storeId + '/slots', master, {
    label: '配信検証枠', starts_at: new Date(at).toISOString(), ends_at: new Date(at + 3600000).toISOString(),
    capacity: 5, published: true,
  }, idempotency()), 201).id
  const visit = expect(await post('/customer/bookings', login.cookie, { slot: visitSlot, party: 2 }), 201)
  expect(await patch('/stores/' + storeId + '/bookings/' + visit.id, master,
    { revision: 1, slot: visitSlot, party: 2, status: 'confirmed', reason: '店舗が確認' }), 200)
  await flush(5)
  const delivered = pushesTo(userC2).find(item => item.text.includes('ご予約が確定しました'))
  assert.ok(delivered, '実配信のメッセージが届くこと')
  assert.ok(!delivered.text.includes('{{'), '変数マーカーが残らないこと: ' + delivered.text)
  assert.ok(!delivered.text.includes('link.invalid'), 'プレースホルダが送られないこと')
  assert.ok(!delivered.text.includes('liff.line.me'), 'LIFF URLが混入しないこと')
  assert.ok(!delivered.text.includes('/account/sample') && !delivered.text.includes('example.test/booking'),
    'フィクスチャのダミーURLが送られないこと')
  const deliveredRaw = rawOf(delivered.text)
  assert.ok(deliveredRaw, '発行済みの実URLが差し込まれること: ' + delivered.text)
  assert.ok(delivered.text.includes('/account/' + customer + '?t=' + deliveredRaw))
  const customerId = (await read('SELECT id FROM customer WHERE channel_id=$1 AND user_key=$2',
    [customer, userKey(cfg, { id: customer }, userC2)])).rows[0].id
  const issued = await read('SELECT token_hash FROM link_token WHERE channel_id=$1 AND subject=$2',
    [customer, customerId])
  assert.ok(issued.rows.some(row => row.token_hash === digest(deliveredRaw)),
    '差し替えられたURLが実際に発行されたトークンであること')
  expect(await post('/customer-link/' + customer + '/redeem', null, { token: deliveredRaw }), 200)

  // (b) 採用シナリオのテスト送信: {{interview_link}}
  const testerPrefix = '/stores/' + storeId + '/connections/' + recruit
  const testerInvite = expect(await post(testerPrefix + '/tests', master, { purpose: 'recruitment' }, idempotency()), 201)
  // コード送信と友だち追加は分ける（確認時刻より後のイベントがテスト送信の証跡になる仕様）
  await inbound(recruit, botR, [
    eventFor('e2e-t2-code', 'message', userT2,
      { message: { type: 'text', text: '接続テスト ' + testerInvite.code } }),
  ])
  await inbound(recruit, botR, [eventFor('e2e-t2-follow', 'follow', userT2)])
  await flush(2)
  const rGraph = {
    name: '検収・面談案内', purpose: 'recruitment', trigger: 'form', channel: recruit,
    windowStart: '00:00', windowEnd: '23:59', daily: 1, weekly: 3, cooldownDays: 30, rejoin: false,
    missingAssignee: 'manager', holidays: [], entry: 'welcome',
    nodes: [
      { id: 'welcome', type: 'message', name: '面談のご案内', category: 'service',
        body: '{{name}}さん、面談のご案内です。面談予約はこちら: {{interview_link}}', next: 'end' },
      { id: 'end', type: 'end', name: '終了' },
    ],
  }
  const rScenario = expect(await post(root, master, rGraph, idempotency()), 201)
  const fixture = {
    start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: false, consent: true,
    adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
    human: false, cancelled: false, bookingLinkValid: true, tags: [],
    values: {
      name: '応募者', store: '検収店', staff: '', booking: '', price: '', booking_url: '',
      interview_link: 'https://example.test/reserve/sample',
    },
  }
  const job = expect(await post(root + '/' + rScenario.id + '/test-sends', master,
    { revision: rScenario.revision, node: 'welcome', tester: testerInvite.id, fixture }, idempotency()), 202)
  await flush(3)
  const sent = pushesTo(userT2).filter(item => item.text.includes('面談のご案内です'))
  assert.equal(sent.length, 1, 'テスト送信が1通届くこと')
  const text = sent[0].text
  assert.ok(!text.includes('{{'), '変数マーカーが残らないこと: ' + text)
  assert.ok(!text.includes('example.test/reserve/sample'), 'ダミーURLが送られないこと')
  assert.ok(!text.includes('liff.line.me'), 'LIFF URLが混入しないこと')
  const sentRaw = rawOf(text)
  assert.ok(sentRaw, '発行済みの実URLが差し込まれること: ' + text)
  assert.ok(text.includes('/reserve/' + recruit + '?t=' + sentRaw))
  const rTokens = await read('SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2',
    [recruit, keyed(cfg, 'interview:' + recruit + ':' + userT2)])
  assert.ok(rTokens.rows.some(row => row.token_hash === digest(sentRaw)),
    '差し替えられたURLが実際に発行されたトークンであること')
  assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'accepted')
  expect(await post('/interview-link/' + recruit + '/redeem', null, { token: sentRaw }), 200)
})
