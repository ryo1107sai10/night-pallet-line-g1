import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID} from 'node:crypto'
import { mkdtemp, rm} from 'node:fs/promises'
import { createServer} from 'node:net'
import { tmpdir} from 'node:os'
import { join} from 'node:path'
import { after, before, test} from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import { Secret, TOTP} from 'otpauth'
import { createApp} from '../dist/app.js'
import { assertAppRole, digest, keyed, poolFor, scope, tx} from '../dist/core.js'
import { bootstrap, migrate} from '../dist/setup.js'
import { LineAPI, userKey} from '../dist/line.js'
import { InterviewGoogle} from '../dist/interview-availability.js'
import { workOnce} from '../dist/jobs.js'
import { starter, validate, renderMessage} from '../public/studio/engine.mjs'

// LIFF不要化フェーズ4前半の結合試験。
// 作業1-1: 兼用OA（shared）での postback 発行（interview_link / customer_link）。
// 作業1-2: 顧客リンクのシナリオ差し込み変数 {{customer_link}}（テスト送信＋実配信 automation）。
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true}
const channelSecret = 'a'.repeat(32)
const pass = 'Only used in local tests!'
const botC = 'U' + '5'.repeat(32)
const botS = 'U' + '6'.repeat(32)
const userS1 = 'U' + '2'.repeat(32)
const userS2 = 'U' + '3'.repeat(32)
const userS3 = 'U' + '4'.repeat(32)
const userT1 = 'U' + '7'.repeat(32)
const userT2 = 'U' + '8'.repeat(32)
const userA1 = 'U' + '9'.repeat(32)
const userA2 = 'U' + 'a'.repeat(32)
const userA3 = 'U' + 'b'.repeat(32)
const userSH = 'U' + 'c'.repeat(32)
const bots = { 'access-token-customer': botC, 'access-token-shared': botS}
const clients = { 'access-token-customer': '1234567892', 'access-token-shared': '1234567896'}
const consoleChecks = {
ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
login_published: true, non_developer: true, delivery_confirmed: true,
token_verified: true, webhook_verified: true,
}
const dummyCustomer = 'https://example.test/account/sample'
let pg, owner, pool, server, dir, base, tenant, storeId, admin, line, google
let customerCh, sharedCh, testScenarioId, testScenarioRevision
const pushes = []
const signed = raw => createHmac('sha256', channelSecret).update(raw).digest('base64')
const send = (url, options = {}) => fetch(base + url, { redirect: 'error',...options})
const idempotency = () => ({ 'Idempotency-Key': randomUUID()})
const code = (key, steps = 0) => new TOTP({ secret: Secret.fromBase32(key)}).generate({ timestamp: Date.now() + 30000 * steps})

async function request(path, { method = 'GET', data, cookie, headers = {}} = {}) {
const response = await send('/api/v1' + path, {
method,
headers: {
Origin: origin,...(data === undefined? {}: { 'Content-Type': 'application/json'}),
...(cookie? { Cookie: cookie}: {}),...headers,
},
body: data === undefined? undefined: JSON.stringify(data),
})
const setCookie = response.headers.get('set-cookie')
return { status: response.status, data: await response.json(), cookie: setCookie?.split(';')[0], setCookie}
}
function expect(result, status) {
assert.equal(result.status, status, JSON.stringify(result.data))
return result.data
}
function post(path, cookie, data, headers) { return request(path, { method: 'POST', cookie, data, headers})}
function patch(path, cookie, data, headers) { return request(path, { method: 'PATCH', cookie, data, headers})}
const read = (sql, values) => tx(pool, async db => { await scope(db, tenant, storeId); return db.query(sql, values)})
const worker = () => workOnce(pool, cfg, line, google)
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await worker()}

const eventFor = (id, type, who, extra = {}) => ({
webhookEventId: id, type, timestamp: Date.now(), source: { type: 'user', userId: who},...extra,
})
async function inbound(connection, destination, events) {
const raw = JSON.stringify({ destination, events})
const response = await send('/api/v1/webhooks/line/' + connection, {
method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signed(raw)}, body: raw,
})
assert.equal(response.status, 200)
}
async function setFeatures(patchData) {
const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin}), 200)
return expect(await patch('/stores/' + storeId + '/features', admin, {...settings,...patchData}), 200)
}
const pushesTo = who => pushes.filter(item => item.to === who)
const rawOf = text => text.match(/\?t=([A-Za-z0-9_-]{43})/)?.[1]
const customerIdOf = async (connection, who) =>
(await read('SELECT id FROM customer WHERE channel_id=$1 AND user_key=$2',
[connection, userKey(cfg, { id: connection}, who)])).rows[0]?.id

// テスターを作成→LIFF検証→友だち追加まで済ませ、シナリオのテスト送信先として使える状態にする。
async function prepareTester(conn, who) {
const prefix = '/stores/' + storeId + '/connections/' + conn
const invite = expect(await post(prefix + '/tests', admin, { purpose: 'customer'}, idempotency()), 201)
expect(await post('/auth/line/verify', null, {
connection: conn, purpose: 'customer', code: invite.code,
id_token: 'idtoken:' + who, allow_test_message: true,
}), 200)
await inbound(conn, conn === customerCh? botC: botS, [eventFor('follow-' + who, 'follow', who)])
await worker()
return invite.id
}

const fixture = {
start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: false, consent: true,
adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
human: false, cancelled: false, bookingLinkValid: true, tags: [],
values: {
name: '顧客', store: '検証店', staff: '', booking: '', price: '',
booking_url: 'https://example.test/booking', customer_link: dummyCustomer,
},
}
async function queueScenarioSend(scenario, revision, tester) {
return expect(await post('/stores/' + storeId + '/scenarios/' + scenario + '/test-sends', admin,
{ revision, node: 'welcome', tester, fixture}, idempotency()), 202)
}

async function publishScenario(graph) {
const root = '/stores/' + storeId + '/scenarios'
const start = expect(await post(root, admin, graph, idempotency()), 201)
const url = root + '/' + start.id + '/transition'
const pubFixture = {
start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: true, consent: true,
adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
human: false, cancelled: false, bookingLinkValid: true, tags: [],
values: {
name: 'テスト利用者', store: '検証店', staff: '', booking: '11月18日 22:00', price: '',
booking_url: 'https://example.test/booking', customer_link: dummyCustomer,
},
}
const next = expect(await post(url, admin, { revision: start.revision, action: 'test', fixture: pubFixture}), 200)
const approved = expect(await post(url, admin, { revision: next.revision, action: 'approve'}), 200)
return expect(await post(url, admin, { revision: approved.revision, action: 'publish'}), 200)
}

const linkScenarioGraph = (channel, name) => ({
name, purpose: 'customer', trigger: 'booking_created', channel,
windowStart: '00:00', windowEnd: '23:59', daily: 5, weekly: 10, cooldownDays: 30, rejoin: false,
missingAssignee: 'manager', holidays: [], entry: 'update',
nodes: [
{
id: 'update', type: 'message', name: '確定のお知らせ', category: 'service',
body: '{{store}}でご予約が確定しました。来店予約・設定はこちら: {{customer_link}}', next: 'end',
},
{ id: 'end', type: 'end', name: '完了'},
],
})

// 来店枠は店舗内で時間帯が重複できないため、呼ぶ側で days をずらすこと。
async function makeSlot(label, days = 2) {
const at = Date.now() + days * 86400000
return expect(await post('/stores/' + storeId + '/slots', admin, {
label, starts_at: new Date(at).toISOString(), ends_at: new Date(at + 3600000).toISOString(),
capacity: 5, published: true,
}, idempotency()), 201).id
}
async function consentWith(cookie) {
const account = expect(await request('/customer/account', { cookie}), 200)
expect(await patch('/customer/preferences', cookie, {
revision: account.revision, version: account.policy_version,
preferences: { service_consent: true, marketing_consent: false, all_stop: false},
}), 200)
}
async function bookAndConfirm(cookie, slot) {
const booking = expect(await post('/customer/bookings', cookie, { slot, party: 2}), 201)
expect(await patch('/stores/' + storeId + '/bookings/' + booking.id, admin, {
revision: 1, slot, party: 2, status: 'confirmed', reason: '店舗が確認',
}), 200)
return booking
}

before(async () => {
const probe = createServer().listen(0, '127.0.0.1')
await new Promise(resolve => probe.once('listening', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
dir = await mkdtemp(join(tmpdir(), 'night-p4-'))
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
return Response.json({ client_id: clients[options.body.get('access_token')]})
case '/v2/bot/info': {
const tokenValue = options.headers.Authorization?.replace('Bearer ', '')
return Response.json({ userId: bots[tokenValue]})
}
case '/oauth2/v2.1/verify': {
const idToken = options.body.get('id_token')?? ''
return Response.json({
iss: 'https://access.line.me', aud: options.body.get('client_id'),
sub: idToken.startsWith('idtoken:')? idToken.slice('idtoken:'.length): userS1,
exp: Date.now() / 1000 + 600,
})
}
case '/v2/bot/message/quota': return Response.json({ type: 'limited', value: 200})
case '/v2/bot/message/quota/consumption': return Response.json({ totalUsage: 0})
case '/v2/bot/message/push': {
const body = JSON.parse(options.body)
pushes.push({ to: body.to, text: body.messages[0].text})
return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-id'}})
}
default: throw Error('Unexpected path ' + address.pathname)
}
}
line = new LineAPI(fetchLine)
google = new InterviewGoogle(cfg, { clientId: 'calendar-client', secret: 'calendar-secret'},
async () => Response.json({ calendars: {}}))
server = createApp(pool, cfg, line, google).listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
base = 'http://127.0.0.1:' + server.address().port

const invite = await bootstrap(owner, cfg, { slug: 'p4', name: '検証法人', email: 'chief@example.test'})
expect(await post('/auth/activate', null, { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1)}), 200)
const auth = await post('/auth/login', null, { tenant: 'p4', email: 'chief@example.test', password: pass, code: code(invite.setup_key)})
expect(auth, 200)
admin = auth.cookie
tenant = expect(await request('/session', { cookie: admin}), 200).tenant.id
storeId = expect(await post('/stores', admin, {
name: '検証店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
timezone: 'Asia/Tokyo', cutoff: '06:00',
}, idempotency()), 201).id
const common = {
owner_name: '検証法人', provider_id: 'provider', account_type: 'unverified',
management_authority: '検証用', channel_secret: channelSecret, token_type: 'console',
}
customerCh = expect(await post('/stores/' + storeId + '/connections', admin, {
...common, label: '顧客OA', purpose: 'customer',
messaging_id: '1234567892', login_id: '1234567894', liff_id: '1234567894-test',
access_token: 'access-token-customer',
}, idempotency()), 201).id
sharedCh = expect(await post('/stores/' + storeId + '/connections', admin, {
...common, label: '兼用OA', purpose: 'shared',
messaging_id: '1234567896', login_id: '1234567895', liff_id: '1234567895-test',
access_token: 'access-token-shared',
}, idempotency()), 201).id
await tx(pool, async db => {
await scope(db, tenant, storeId)
await db.query('UPDATE channel SET checks=$2 WHERE id=ANY($1)', [[customerCh, sharedCh], consoleChecks])
await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`, [storeId])
})
await setFeatures({
visits_enabled: true, interviews_enabled: true, recruitment_enabled: true,
reminders_enabled: true, rich_menus_enabled: true,
token_interviews_enabled: true, token_customers_enabled: true,
})

const graph = {
name: '来店案内（テスト送信用）', purpose: 'customer', trigger: 'follow', channel: customerCh,
windowStart: '00:00', windowEnd: '23:59', daily: 1, weekly: 3, cooldownDays: 30, rejoin: false,
missingAssignee: 'manager', holidays: [], entry: 'welcome',
nodes: [
{
id: 'welcome', type: 'message', name: '来店のご案内', category: 'service',
body: '{{name}}さん、来店予約・設定はこちら: {{customer_link}}', next: 'end',
},
{ id: 'end', type: 'end', name: '終了'},
],
}
const created = expect(await post('/stores/' + storeId + '/scenarios', admin, graph, idempotency()), 201)
testScenarioId = created.id
testScenarioRevision = created.revision
})

after(async () => {
if (server) await new Promise(resolve => server.close(resolve))
await Promise.allSettled([pool?.end(), owner?.end()])
if (pg) await pg.stop()
if (dir) await rm(dir, { recursive: true, force: true})
})

let sharedInterviewRaw, sharedCustomerRaw

test('作業1-1: 兼用OAの postback（interview_link）で面談リンクが発行され、引換できる', async () => {
await inbound(sharedCh, botS, [eventFor('p4-s1-follow', 'follow', userS1)])
await worker()
await inbound(sharedCh, botS, [
eventFor('p4-s1-postback', 'postback', userS1, { postback: { data: 'action=interview_link'}}),
])
await flush(2)
const tokens = await read('SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2',
[sharedCh, keyed(cfg, 'interview:' + sharedCh + ':' + userS1)])
assert.equal(tokens.rowCount, 1, '兼用OAでも面談トークンが発行されること')
const deliveries = await read("SELECT * FROM service_delivery WHERE kind='interview_link' AND channel_id=$1", [sharedCh])
assert.equal(deliveries.rowCount, 1)
const linkPush = pushesTo(userS1).find(item => item.text.includes('/reserve/'))
assert.ok(linkPush, '面談リンクのPushが届くこと')
sharedInterviewRaw = rawOf(linkPush.text)
assert.ok(sharedInterviewRaw)
assert.ok(linkPush.text.includes('/reserve/' + sharedCh + '?t=' + sharedInterviewRaw))
assert.equal(digest(sharedInterviewRaw), tokens.rows[0].token_hash)
const redeemed = await post('/interview-link/' + sharedCh + '/redeem', null, { token: sharedInterviewRaw})
expect(redeemed, 200)
assert.ok(redeemed.cookie?.startsWith('night_interview='))
const sessions = await read("SELECT audience FROM interview_session WHERE channel_id=$1 AND audience='token'", [sharedCh])
assert.equal(sessions.rowCount, 1)
})

test('作業1-1: 兼用OAの postback（customer_link）で顧客リンクが発行され、引換でき、面談と混ざらない', async () => {
await inbound(sharedCh, botS, [eventFor('p4-s2-follow', 'follow', userS2)])
await worker()
await inbound(sharedCh, botS, [
eventFor('p4-s2-postback', 'postback', userS2, { postback: { data: 'action=customer_link'}}),
])
await flush(2)
const tokens = await read('SELECT * FROM link_token WHERE channel_id=$1', [sharedCh])
assert.equal(tokens.rowCount, 1, '兼用OAでも顧客トークンが発行されること')
assert.equal(tokens.rows[0].purpose, 'customer')
const linkPush = pushesTo(userS2).find(item => item.text.includes('/account/'))
assert.ok(linkPush, '顧客リンクのPushが届くこと')
sharedCustomerRaw = rawOf(linkPush.text)
assert.ok(sharedCustomerRaw)
assert.ok(linkPush.text.includes('/account/' + sharedCh + '?t=' + sharedCustomerRaw))
assert.equal(digest(sharedCustomerRaw), tokens.rows[0].token_hash)
const redeemed = await post('/customer-link/' + sharedCh + '/redeem', null, { token: sharedCustomerRaw})
expect(redeemed, 200)
assert.ok(redeemed.cookie?.startsWith('night_customer='))
const account = expect(await request('/customer/account', { cookie: redeemed.cookie}), 200)
assert.equal(account.store, '検証店')
// 用途の取り違え: 面談トークンは顧客側で、顧客トークンは面談側で引換できない
const crossA = await post('/customer-link/' + sharedCh + '/redeem', null, { token: sharedInterviewRaw})
assert.equal(crossA.status, 401)
assert.equal(crossA.data.code, 'LINK_INVALID')
const crossB = await post('/interview-link/' + sharedCh + '/redeem', null, { token: sharedCustomerRaw})
assert.equal(crossB.status, 401)
assert.equal(crossB.data.code, 'LINK_INVALID')
})

test('作業1-1: 兼用OAでも機能フラグOFFとブロック中は発行されない', async () => {
const countInterview = async () =>
(await read('SELECT count(*)::int AS n FROM interview_link_token WHERE channel_id=$1', [sharedCh])).rows[0].n
const countCustomer = async () =>
(await read('SELECT count(*)::int AS n FROM link_token WHERE channel_id=$1', [sharedCh])).rows[0].n
await inbound(sharedCh, botS, [eventFor('p4-s3-follow', 'follow', userS3)])
await worker()
const beforeI = await countInterview()
await setFeatures({ token_interviews_enabled: false})
await inbound(sharedCh, botS, [
eventFor('p4-s3-postback-i', 'postback', userS3, { postback: { data: 'action=interview_link'}}),
])
await worker()
assert.equal(await countInterview(), beforeI, '面談フラグOFFでは発行されないこと')
await setFeatures({ token_interviews_enabled: true})
const beforeC = await countCustomer()
const t0 = Date.now()
await inbound(sharedCh, botS, [
eventFor('p4-s3-unfollow', 'unfollow', userS3, { timestamp: t0 + 1000}),
eventFor('p4-s3-postback-c', 'postback', userS3, { timestamp: t0 + 2000, postback: { data: 'action=customer_link'}}),
])
await worker()
assert.equal(await countCustomer(), beforeC, 'ブロック中は顧客リンクも発行されないこと')
})

test('作業1-2: 顧客シナリオのテスト送信で受信者ごとの専用URLが届き、引換できる', async () => {
const tester = await prepareTester(customerCh, userT1)
const job = await queueScenarioSend(testScenarioId, testScenarioRevision, tester)
await flush(2)
const sent = pushesTo(userT1)
assert.equal(sent.length, 1, 'テスト送信が1通届くこと')
const text = sent[0].text
assert.ok(text.startsWith(''), text)
assert.ok(!text.includes(dummyCustomer), 'シミュレーション用のダミーURLは送られないこと')
assert.ok(!text.includes('{{customer_link}}'), 'マーカーは送られないこと')
const raw = rawOf(text)
assert.ok(raw, '専用URLが差し込まれること: ' + text)
assert.ok(text.includes('/account/' + customerCh + '?t=' + raw))
const tokens = await read('SELECT * FROM link_token WHERE channel_id=$1', [customerCh])
assert.equal(tokens.rowCount, 1)
assert.equal(digest(raw), tokens.rows[0].token_hash)
assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'accepted')
const redeemed = await post('/customer-link/' + customerCh + '/redeem', null, { token: raw})
expect(redeemed, 200)
})

test('作業1-2: テスト送信でも機能フラグOFFでは発行されず、送信が取りやめになる', async () => {
const tester = await prepareTester(customerCh, userT2)
const before = (await read('SELECT count(*)::int AS n FROM link_token WHERE channel_id=$1', [customerCh])).rows[0].n
await setFeatures({ token_customers_enabled: false})
const job = await queueScenarioSend(testScenarioId, testScenarioRevision, tester)
await flush(2)
assert.equal(pushesTo(userT2).length, 0, 'Pushは届かないこと')
assert.equal(
(await read('SELECT count(*)::int AS n FROM link_token WHERE channel_id=$1', [customerCh])).rows[0].n,
before, 'トークンは発行されないこと')
assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'cancelled')
await setFeatures({ token_customers_enabled: true})
})

test('作業1-2: 実配信（automation）でも受信者ごとに専用URLが届き、2人目は異なるURLになる', async () => {
await publishScenario(linkScenarioGraph(customerCh, '予約確定＋リンク案内'))
const runFor = async (who, slotLabel, slotDays) => {
await inbound(customerCh, botC, [eventFor('p4-follow-' + who, 'follow', who)])
await worker()
await inbound(customerCh, botC, [
eventFor('p4-pb-' + who, 'postback', who, { postback: { data: 'action=customer_link'}}),
])
await flush(2)
const linkPush = pushesTo(who).find(item => item.text.includes('/account/'))
assert.ok(linkPush, '同意取得用の顧客リンクが届くこと')
const redeemed = await post('/customer-link/' + customerCh + '/redeem', null, { token: rawOf(linkPush.text)})
expect(redeemed, 200)
await consentWith(redeemed.cookie)
const slot = await makeSlot(slotLabel, slotDays)
await bookAndConfirm(redeemed.cookie, slot)
await flush(4)
const delivered = pushesTo(who).find(item => item.text.includes('ご予約が確定しました'))
assert.ok(delivered, '実配信のメッセージが届くこと')
assert.ok(!delivered.text.includes('link.invalid'), 'プレースホルダは送られないこと')
assert.ok(!delivered.text.includes('{{customer_link}}'), 'マーカーは送られないこと')
const raw = rawOf(delivered.text)
assert.ok(raw, '実URLが差し込まれること: ' + delivered.text)
assert.ok(delivered.text.includes('/account/' + customerCh + '?t=' + raw))
const customerId = await customerIdOf(customerCh, who)
const tokens = await read(
'SELECT * FROM link_token WHERE channel_id=$1 AND subject=$2 AND revoked_at IS NULL ORDER BY created_at DESC',
[customerCh, customerId])
assert.ok(tokens.rowCount >= 1)
assert.equal(digest(raw), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')
const sends = await read(
"SELECT status FROM automatic_send WHERE channel_id=$1 AND customer_id=$2 ORDER BY first_attempt_at DESC", [customerCh, customerId])
assert.equal(sends.rows[0].status, 'accepted')
const again = await post('/customer-link/' + customerCh + '/redeem', null, { token: raw})
expect(again, 200)
return raw
}
const rawA = await runFor(userA1, '自動配信A', 2)
const rawB = await runFor(userA2, '自動配信B', 3)
assert.notEqual(rawA, rawB, '受信者ごとに異なるURLになること')
})

test('作業1-2: 実配信でも機能フラグOFFではURLは送られず、トークンも発行されない', async () => {
await inbound(customerCh, botC, [eventFor('p4-a3-follow', 'follow', userA3)])
await worker()
const login = await post('/customer/login', null, { connection: customerCh, id_token: 'idtoken:' + userA3})
expect(login, 200)
await consentWith(login.cookie)
const slot = await makeSlot('自動配信C', 4)
await bookAndConfirm(login.cookie, slot)
await setFeatures({ token_customers_enabled: false})
await flush(4)
assert.equal(pushesTo(userA3).filter(item => item.text.includes('/account/')).length, 0,
'顧客リンクURLは送られないこと')
assert.equal(pushesTo(userA3).filter(item => item.text.includes('link.invalid')).length, 0,
'プレースホルダも送られないこと')
const customerId = await customerIdOf(customerCh, userA3)
const tokens = await read('SELECT * FROM link_token WHERE channel_id=$1 AND subject=$2', [customerCh, customerId])
assert.equal(tokens.rowCount, 0, 'トークンは発行されないこと')
const notes = await read(
"SELECT kind,detail FROM delivery_note WHERE channel_id=$1 ORDER BY id DESC LIMIT 10", [customerCh])
assert.ok(notes.rows.some(row => row.detail.includes('発行条件')),
'保留として記録されること: ' + JSON.stringify(notes.rows))
await setFeatures({ token_customers_enabled: true})
})

test('作業1-2: 兼用OAの顧客シナリオ実配信でも専用URLが届く', async () => {
await publishScenario(linkScenarioGraph(sharedCh, '兼用OAの予約確定＋リンク案内'))
await inbound(sharedCh, botS, [eventFor('p4-sh-follow', 'follow', userSH)])
await worker()
await inbound(sharedCh, botS, [
eventFor('p4-sh-pb', 'postback', userSH, { postback: { data: 'action=customer_link'}}),
])
await flush(2)
const linkPush = pushesTo(userSH).find(item => item.text.includes('/account/'))
assert.ok(linkPush)
const redeemed = await post('/customer-link/' + sharedCh + '/redeem', null, { token: rawOf(linkPush.text)})
expect(redeemed, 200)
await consentWith(redeemed.cookie)
const slot = await makeSlot('兼用OA枠', 5)
await bookAndConfirm(redeemed.cookie, slot)
await flush(4)
const delivered = pushesTo(userSH).find(item => item.text.includes('ご予約が確定しました'))
assert.ok(delivered, '兼用OAでも実配信のメッセージが届くこと')
assert.ok(!delivered.text.includes('link.invalid'))
const raw = rawOf(delivered.text)
assert.ok(raw)
assert.ok(delivered.text.includes('/account/' + sharedCh + '?t=' + raw))
const again = await post('/customer-link/' + sharedCh + '/redeem', null, { token: raw})
expect(again, 200)
})

test('作業1-2: エンジン検証と描画（顧客シナリオでのみ customer_link が使える）', () => {
const customer = starter('customer')
customer.channel = 'account'
customer.nodes.find(node => node.id === 'welcome').body = '来店予約・設定はこちら: {{customer_link}}'
assert.deepEqual(validate(customer, true), [])
const recruitment = starter('recruitment')
recruitment.channel = 'account'
recruitment.nodes.find(node => node.id === 'welcome').body = '来店予約・設定はこちら: {{customer_link}}'
const errors = validate(recruitment, true).map(item => item.message)
assert.ok(errors.some(error => error.includes('来店予約・設定 URL')), JSON.stringify(errors))
const cross = starter('customer')
cross.channel = 'account'
cross.nodes.find(node => node.id === 'welcome').body = '面談予約はこちら: {{interview_link}}'
assert.ok(validate(cross, true).some(item => item.message.includes('面談予約 URL')))
assert.equal(
renderMessage('予約・設定: {{customer_link}}', { values: { customer_link: 'https://example.test/account/x'}}).message,
'予約・設定: https://example.test/account/x')
assert.match(
renderMessage('予約・設定: {{customer_link}}', { values: { customer_link: 'http://example.test/x'}}).reason, /URL/)
assert.match(renderMessage('予約・設定: {{customer_link}}', { values: {}}).reason, /来店予約・設定 URL/)
})
