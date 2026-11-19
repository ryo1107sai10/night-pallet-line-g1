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
import { LineAPI} from '../dist/line.js'
import { InterviewGoogle} from '../dist/interview-availability.js'
import { workOnce} from '../dist/jobs.js'
import { starter, validate} from '../public/studio/engine.mjs'

// 面談予約フェーズ2: シナリオ（ステップ配信）のテスト送信から、
// 受信者ごとの専用URLを送信直前に発行して差し込むことの結合試験。
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true}
const bot = 'U' + '1'.repeat(32)
const bot2 = 'U' + '9'.repeat(32)
const user = 'U' + '2'.repeat(32)
const user2 = 'U' + '3'.repeat(32)
const user3 = 'U' + '4'.repeat(32)
const user4 = 'U' + '5'.repeat(32)
const user5 = 'U' + '6'.repeat(32)
const channelSecret = 'a'.repeat(32)
const accessToken = 'test-channel-token'
const accessToken2 = 'test-channel-token-2'
const messagingId = '1234567890'
const messagingId2 = '1234567899'
const pass = 'Only used in local tests!'
const consoleChecks = {
ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
non_developer: true, delivery_confirmed: true,
token_verified: true, webhook_verified: true,
}
const dummyLink = 'https://example.test/reserve/sample'
let pg, owner, pool, server, dir, base, tenant, storeId, connection, shared, admin, scenarioId, scenarioRevision
const pushesLog = []
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
let line, google

const eventFor = (id, type, who, extra = {}) => ({
webhookEventId: id, type, timestamp: Date.now(), source: { type: 'user', userId: who},...extra,
})
async function inbound(conn, destination, events) {
const raw = JSON.stringify({ destination, events})
const response = await send('/api/v1/webhooks/line/' + conn, {
method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signed(raw)}, body: raw,
})
assert.equal(response.status, 200)
}

// テスターを作成→メッセージ方式で本人確認→友だち追加まで済ませ、シナリオのテスト送信先として使える状態にする。
async function prepareTester(conn, who) {
const prefix = '/stores/' + storeId + '/connections/' + conn
const invite = expect(await post(prefix + '/tests', admin, { purpose: 'recruitment'}, idempotency()), 201)
const destination = conn === connection? bot: bot2
await inbound(conn, destination, [eventFor('code-' + who, 'message', who, {
message: { type: 'text', text: '接続テスト ' + invite.code },
})])
await inbound(conn, destination, [eventFor('follow-' + who, 'follow', who)])
await worker()
await worker()
return invite.id
}

const fixture = {
start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: false, consent: true,
adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
human: false, cancelled: false, bookingLinkValid: true, tags: [],
values: { name: '応募者', store: 'リンク店', staff: '', booking: '', price: '', booking_url: '', interview_link: dummyLink},
}
async function queueScenarioSend(scenario, revision, tester) {
return expect(await post('/stores/' + storeId + '/scenarios/' + scenario + '/test-sends', admin,
{ revision, node: 'welcome', tester, fixture}, idempotency()), 202)
}
const pushesTo = who => pushesLog.filter(item => item.to === who)
const linkRawOf = text => text.match(/\?t=([A-Za-z0-9_-]{43})/)?.[1]
const tokensFor = async (conn, who) => {
const applicant = keyed(cfg, 'interview:' + conn + ':' + who)
return read('SELECT * FROM interview_link_token WHERE channel_id=$1 AND applicant_key=$2 ORDER BY created_at', [conn, applicant])
}

before(async () => {
const probe = createServer().listen(0, '127.0.0.1')
await new Promise(resolve => probe.once('listening', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
dir = await mkdtemp(join(tmpdir(), 'night-scenario-link-'))
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
case '/v2/oauth/verify': {
const at = options.body.get('access_token')
return Response.json({ client_id: at === accessToken2? messagingId2: messagingId})
}
case '/v2/bot/info':
return Response.json({ userId: options.headers.Authorization === 'Bearer ' + accessToken2? bot2: bot})
case '/v2/bot/message/quota': return Response.json({ type: 'limited', value: 200})
case '/v2/bot/message/quota/consumption': return Response.json({ totalUsage: 0})
case '/v2/bot/message/push': {
pushesLog.push(JSON.parse(options.body))
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

const invite = await bootstrap(owner, cfg, { slug: 'slink', name: 'シナリオ法人', email: 'chief@example.test'})
expect(await post('/auth/activate', null, { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1)}), 200)
const auth = await post('/auth/login', null, { tenant: 'slink', email: 'chief@example.test', password: pass, code: code(invite.setup_key)})
expect(auth, 200)
admin = auth.cookie
tenant = expect(await request('/session', { cookie: admin}), 200).tenant.id
storeId = expect(await post('/stores', admin, {
name: 'リンク店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
timezone: 'Asia/Tokyo', cutoff: '06:00',
}, idempotency()), 201).id
const connectionInput = {
owner_name: 'シナリオ法人', provider_id: 'provider', account_type: 'unverified',
management_authority: '検証用', channel_secret: channelSecret, token_type: 'console',
}
connection = expect(await post('/stores/' + storeId + '/connections', admin, {
...connectionInput, label: '採用OA', purpose: 'recruitment',
messaging_id: messagingId, access_token: accessToken,
}, idempotency()), 201).id
shared = expect(await post('/stores/' + storeId + '/connections', admin, {
...connectionInput, label: '兼用OA', purpose: 'shared',
messaging_id: messagingId2, access_token: accessToken2,
}, idempotency()), 201).id
await tx(pool, async db => {
await scope(db, tenant, storeId)
await db.query('UPDATE channel SET checks=$2 WHERE id=ANY($1)', [[connection, shared], consoleChecks])
await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`, [storeId])
})
const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin}), 200)
expect(await patch('/stores/' + storeId + '/features', admin, {
...settings, reminders_enabled: true, rich_menus_enabled: true, token_interviews_enabled: true,
recruitment_enabled: true,
}), 200)

const graph = {
name: '面談フォロー', purpose: 'recruitment', trigger: 'form', channel: connection,
windowStart: '00:00', windowEnd: '23:59', daily: 1, weekly: 3, cooldownDays: 30, rejoin: false,
missingAssignee: 'manager', holidays: [], entry: 'welcome',
nodes: [
{ id: 'welcome', type: 'message', name: '面談のご案内', category: 'service',
body: '{{name}}さん、面談のご案内です。\n面談予約はこちら: {{interview_link}}', next: 'end'},
{ id: 'end', type: 'end', name: '終了'},
],
}
const created = expect(await post('/stores/' + storeId + '/scenarios', admin, graph, idempotency()), 201)
scenarioId = created.id
scenarioRevision = created.revision
})

after(async () => {
if (server) await new Promise(resolve => server.close(resolve))
await Promise.allSettled([pool?.end(), owner?.end()])
if (pg) await pg.stop()
if (dir) await rm(dir, { recursive: true, force: true})
})

const jstDate = days => {
const at = new Date(Date.now() + days * 86400000)
return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(at)
}
let rawA

test('シナリオのテスト送信で受信者ごとの専用URLが届き、予約が本人に紐づく', async () => {
const tester = await prepareTester(connection, user)
const job = await queueScenarioSend(scenarioId, scenarioRevision, tester)
await worker()
await worker()
const sent = pushesTo(user)
assert.equal(sent.length, 1, 'テスト送信が1通届くこと')
const text = sent[0].messages[0].text
assert.ok(text.startsWith('【接続テスト】'), text)
assert.ok(text.includes('応募者さん、面談のご案内です。'), text)
assert.ok(!text.includes(dummyLink), 'シミュレーション用のダミーURLは送られないこと')
assert.ok(!text.includes('{{interview_link}}'), 'マーカーは送られないこと')
rawA = linkRawOf(text)
assert.ok(rawA, '専用URLが差し込まれること: ' + text)
assert.ok(text.includes('/reserve/' + connection + '?t=' + rawA))
const tokens = await tokensFor(connection, user)
assert.equal(tokens.rowCount, 1)
assert.equal(digest(rawA), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')
assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'accepted')

// 届いたURLから予約すると、その受信者（応募者）の予約として紐づく
const slotDate = jstDate(4)
const slotId = expect(await post('/stores/' + storeId + '/interviews/slots', admin, {
channel: connection, starts_at: slotDate + 'T18:00:00+09:00', ends_at: slotDate + 'T18:30:00+09:00',
instructions: '会場案内', published: true,
}, idempotency()), 201).id
const redeemed = await post('/interview-link/' + connection + '/redeem', null, { token: rawA})
expect(redeemed, 200)
const booking = expect(await post('/interview/bookings', redeemed.cookie, { slot: slotId, name: '応募者A'}), 201)
const after = await tokensFor(connection, user)
assert.ok(after.rows.find(row => row.token_hash === digest(rawA)).used_at, '予約確定でトークンが消費されること')
const cases = await read('SELECT * FROM recruitment_case')
assert.equal(cases.rowCount, 1, '採用ケースが作成されること')
assert.ok(booking.id)
})

test('別の受信者には異なるURLが届き、再発行で旧リンクが失効する', async () => {
const tester = await prepareTester(connection, user2)
await queueScenarioSend(scenarioId, scenarioRevision, tester)
await worker()
await worker()
const sent = pushesTo(user2).filter(item => item.messages[0].text.includes('/reserve/'))
assert.equal(sent.length, 1)
const rawB = linkRawOf(sent[0].messages[0].text)
assert.ok(rawB)
assert.notEqual(rawB, rawA, '受信者ごとに異なるURLになること')
const tokens = await tokensFor(connection, user2)
assert.equal(tokens.rowCount, 1)
assert.equal(digest(rawB), tokens.rows[0].token_hash)

// 同じ応募者がリッチメニューを再タップすると、シナリオ経由の未使用リンクは失効し新しい1本だけが有効になる
await inbound(connection, bot, [eventFor('pb-user2', 'postback', user2, { postback: { data: 'action=interview_link'}})])
await worker()
await worker()
const after = await tokensFor(connection, user2)
const live = after.rows.filter(row =>!row.used_at &&!row.revoked_at)
assert.equal(live.length, 1, '有効な未使用リンクは常に1本だけ')
assert.ok(after.rows.find(row => row.token_hash === digest(rawB)).revoked_at, 'シナリオ経由の旧リンクが失効すること')
const stale = await post('/interview-link/' + connection + '/redeem', null, { token: rawB})
assert.equal(stale.status, 401)
assert.equal(stale.data.code, 'LINK_INVALID')
})

test('機能フラグOFFでは発行されず、URLも送られない', async () => {
const tester = await prepareTester(connection, user3)
const settings = expect(await request('/stores/' + storeId + '/features', { cookie: admin}), 200)
expect(await patch('/stores/' + storeId + '/features', admin, {...settings, token_interviews_enabled: false}), 200)
const job = await queueScenarioSend(scenarioId, scenarioRevision, tester)
await worker()
await worker()
assert.equal(pushesTo(user3).length, 0, 'Pushは届かないこと')
assert.equal((await tokensFor(connection, user3)).rowCount, 0, 'トークンは発行されないこと')
assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'cancelled')
const restored = expect(await request('/stores/' + storeId + '/features', { cookie: admin}), 200)
expect(await patch('/stores/' + storeId + '/features', admin, {...restored, token_interviews_enabled: true}), 200)
})

test('ブロック中は発行されず、URLも送られない', async () => {
const tester = await prepareTester(connection, user4)
const t0 = Date.now()
await inbound(connection, bot, [
eventFor('unfollow-user4', 'unfollow', user4, { timestamp: t0 + 60000}),
])
await worker()
const job = await queueScenarioSend(scenarioId, scenarioRevision, tester)
await worker()
await worker()
assert.equal(pushesTo(user4).length, 0, 'Pushは届かないこと')
assert.equal((await tokensFor(connection, user4)).rowCount, 0, 'トークンは発行されないこと')
assert.notEqual((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'accepted')
})

test('兼用OA（shared）でも発行され、専用URLが届く', async () => {
const tester = await prepareTester(shared, user5)
const graph = {
name: '兼用OAの面談案内', purpose: 'recruitment', trigger: 'form', channel: shared,
windowStart: '00:00', windowEnd: '23:59', daily: 1, weekly: 3, cooldownDays: 30, rejoin: false,
missingAssignee: 'manager', holidays: [], entry: 'welcome',
nodes: [
{ id: 'welcome', type: 'message', name: '面談のご案内', category: 'service',
body: '{{name}}さん、面談予約はこちら: {{interview_link}}', next: 'end'},
{ id: 'end', type: 'end', name: '終了'},
],
}
const created = expect(await post('/stores/' + storeId + '/scenarios', admin, graph, idempotency()), 201)
const job = await queueScenarioSend(created.id, created.revision, tester)
await worker()
await worker()
const sent = pushesTo(user5)
assert.equal(sent.length, 1, '兼用OAでもテスト送信が1通届くこと')
const text = sent[0].messages[0].text
const raw = linkRawOf(text)
assert.ok(raw, '専用URLが差し込まれること: ' + text)
assert.ok(text.includes('/reserve/' + shared + '?t=' + raw))
const tokens = await tokensFor(shared, user5)
assert.equal(tokens.rowCount, 1, 'トークンが発行されること')
assert.equal(digest(raw), tokens.rows[0].token_hash, 'DBにはハッシュのみが保存されること')
assert.equal((await read('SELECT status FROM test_send WHERE id=$1', [job.id])).rows[0].status, 'accepted')
})

test('面談予約URLの差し込みは採用シナリオでのみ検証を通る', () => {
const customer = starter('customer')
customer.channel = 'account'
customer.nodes.find(node => node.id === 'welcome').body = '面談予約はこちら: {{interview_link}}'
const errors = validate(customer, true).map(item => item.message)
assert.ok(errors.some(error => error.includes('面談予約 URL')), JSON.stringify(errors))
const recruitment = starter('recruitment')
recruitment.channel = 'account'
recruitment.nodes.find(node => node.id === 'welcome').body = '面談予約はこちら: {{interview_link}}'
assert.deepEqual(validate(recruitment, true), [])
})
