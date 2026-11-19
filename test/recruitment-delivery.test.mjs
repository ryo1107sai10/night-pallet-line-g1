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
import { validate} from '../public/studio/engine.mjs'

// 採用シナリオ実配信（026）の結合試験。
// ・採用OAの友だち追加で連絡先が登録され、同意済み応募者が follow シナリオに登録・配信される
// ・{{interview_link}} は送信直前に受信者ごと発行され、Push のURLが発行記録と一致し引換できる
// ・同意なしでは登録されず、発行条件を満たさない場合は保留され、ブロック/全配信停止でランが終了する
// ・面談予約（interview_booked）でもシナリオが開始される
// ・採用OAへの受信メッセージが受信箱（purpose='recruitment'）に残る
// 実PostgreSQL（embedded）＋ HTTP経由、LINE APIは模擬fetchで受ける。
const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true}
const channelSecret = 'a'.repeat(32)
const pass = 'Only used in local tests!'
const botR = 'U' + '1'.repeat(32)
const userA = 'U' + '2'.repeat(32)
const userB = 'U' + '3'.repeat(32)
const userC = 'U' + '4'.repeat(32)
const userD = 'U' + '5'.repeat(32)
const userE = 'U' + '6'.repeat(32)
const userF = 'U' + '7'.repeat(32)
const userG = 'U' + '8'.repeat(32)
const userH = 'U' + '9'.repeat(32)
const bots = { 'access-token-recruit': botR}
const clients = { 'access-token-recruit': '1234567893'}
const consoleChecks = {
  ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
  non_developer: true, delivery_confirmed: true,
  token_verified: true, webhook_verified: true,
}
let pg, owner, pool, server, dir, base, tenant, storeId, admin, line, google
let recruitCh
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
const applicantKeyOf = who => keyed(cfg, 'interview:' + recruitCh + ':' + who)

const pubFixture = {
  start: '2026-11-14T12:00', bookingAt: '', dayCount: 0, weekCount: 0, booked: true, consent: true,
  adult: true, responded: false, assigned: true, stopped: false, marketingStopped: false, blocked: false,
  human: false, cancelled: false, bookingLinkValid: true, tags: [],
  values: {
    name: 'テスト応募者', store: '検証店', staff: '', booking: '11月18日 18:00', price: '',
    booking_url: 'https://example.test/booking', interview_link: 'https://example.test/reserve/sample',
  },
}
async function publishScenario(graph) {
  const root = '/stores/' + storeId + '/scenarios'
  const start = expect(await post(root, admin, graph, idempotency()), 201)
  const url = root + '/' + start.id + '/transition'
  const next = expect(await post(url, admin, { revision: start.revision, action: 'test', fixture: pubFixture}), 200)
  const approved = expect(await post(url, admin, { revision: next.revision, action: 'approve'}), 200)
  return expect(await post(url, admin, { revision: approved.revision, action: 'publish'}), 200)
}

const followLinkGraph = {
  name: '友だち追加・面談案内', purpose: 'recruitment', trigger: 'follow', channel: null,
  windowStart: '00:00', windowEnd: '23:59', daily: 5, weekly: 10, cooldownDays: 30, rejoin: false,
  missingAssignee: 'manager', holidays: [], entry: 'welcome',
  nodes: [
    { id: 'welcome', type: 'message', name: '面談のご案内', category: 'service',
      body: '{{store}}へのご応募ありがとうございます。面談予約はこちら: {{interview_link}}', next: 'end'},
    { id: 'end', type: 'end', name: '完了'},
  ],
}
const bookedGraph = {
  name: '面談予約・確定のお知らせ', purpose: 'recruitment', trigger: 'interview_booked', channel: null,
  windowStart: '00:00', windowEnd: '23:59', daily: 5, weekly: 10, cooldownDays: 30, rejoin: false,
  missingAssignee: 'manager', holidays: [], entry: 'notice',
  nodes: [
    { id: 'notice', type: 'message', name: '確定のお知らせ', category: 'service',
      body: '{{name}}さん、面談予約が確定しました。日時: {{booking}}', next: 'end'},
    { id: 'end', type: 'end', name: '完了'},
  ],
}
const stopGraph = {
  name: '停止確認用', purpose: 'recruitment', trigger: 'follow', channel: null,
  windowStart: '00:00', windowEnd: '23:59', daily: 5, weekly: 10, cooldownDays: 30, rejoin: false,
  missingAssignee: 'manager', holidays: [], entry: 'welcome',
  nodes: [
    { id: 'welcome', type: 'message', name: '歓迎', category: 'service', body: 'ご応募ありがとうございます。', next: 'wait'},
    { id: 'wait', type: 'wait', name: '60分待機', mode: 'delay', minutes: 60, next: 'second'},
    { id: 'second', type: 'message', name: '2通目', category: 'service', body: '面談の日程調整をお願いします。', next: 'end'},
    { id: 'end', type: 'end', name: '完了'},
  ],
}

// 友だち追加→メニューの postback でリンクを受け取り→引換→通知ONまで済ませた応募者を用意する。
// この時点では通知がOFFのため follow シナリオには登録されない（同意が登録の前提）。
async function optInApplicant(who, tag) {
  await inbound(recruitCh, botR, [eventFor(tag + '-follow', 'follow', who)])
  await worker()
  await inbound(recruitCh, botR, [
    eventFor(tag + '-postback', 'postback', who, { postback: { data: 'action=interview_link'}}),
  ])
  await flush(2)
  const linkPush = pushesTo(who).find(item => item.text.includes('/reserve/'))
  assert.ok(linkPush, '面談リンクのPushが届くこと')
  const redeemed = await post('/interview-link/' + recruitCh + '/redeem', null,
    { token: rawOf(linkPush.text)})
  expect(redeemed, 200)
  expect(await request('/interview/notices', { method: 'PUT', cookie: redeemed.cookie, data: { enabled: true}}), 200)
  return redeemed.cookie
}
const followAgain = async (who, tag) => {
  await inbound(recruitCh, botR, [eventFor(tag, 'follow', who)])
  await flush(3)
}

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-rd-'))
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

  const invite = await bootstrap(owner, cfg, { slug: 'rd', name: '検証法人', email: 'chief@example.test'})
  expect(await post('/auth/activate', null, { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1)}), 200)
  const auth = await post('/auth/login', null, { tenant: 'rd', email: 'chief@example.test', password: pass, code: code(invite.setup_key)})
  expect(auth, 200)
  admin = auth.cookie
  tenant = expect(await request('/session', { cookie: admin}), 200).tenant.id
  storeId = expect(await post('/stores', admin, {
    name: '検証店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
    timezone: 'Asia/Tokyo', cutoff: '06:00',
  }, idempotency()), 201).id
  recruitCh = expect(await post('/stores/' + storeId + '/connections', admin, {
    label: '採用OA', purpose: 'recruitment', owner_name: '検証法人', provider_id: 'provider',
    messaging_id: '1234567893',
    account_type: 'unverified', management_authority: '検証用', channel_secret: channelSecret,
    access_token: 'access-token-recruit', token_type: 'console',
  }, idempotency()), 201).id
  followLinkGraph.channel = recruitCh
  bookedGraph.channel = recruitCh
  stopGraph.channel = recruitCh
  await tx(pool, async db => {
    await scope(db, tenant, storeId)
    await db.query('UPDATE channel SET checks=$2 WHERE id=$1', [recruitCh, consoleChecks])
    await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
      auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`, [storeId])
  })
  await setFeatures({
    visits_enabled: true, interviews_enabled: true, recruitment_enabled: true,
    reminders_enabled: true, rich_menus_enabled: true, inbox_enabled: true,
    token_interviews_enabled: true, token_customers_enabled: true,
  })
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true})
})

test('採用: 友だち追加で登録され、面談URLが受信者ごとに発行されて届き、引換できる', async () => {
  await publishScenario(followLinkGraph)
  await optInApplicant(userA, 't1-a')
  await followAgain(userA, 't1-a-follow2')

  const enrollment = await read('SELECT * FROM applicant_enrollment WHERE channel_id=$1 AND applicant_key=$2',
    [recruitCh, applicantKeyOf(userA)])
  assert.equal(enrollment.rowCount, 1, '同意済み応募者が follow シナリオに登録されること')
  const sends = await read("SELECT * FROM applicant_send WHERE applicant_key=$1 AND status='accepted'",
    [applicantKeyOf(userA)])
  assert.equal(sends.rowCount, 1, '実配信ジョブがLINEに受付されること')

  const delivered = pushesTo(userA).filter(item => item.text.includes('面談予約はこちら'))
  assert.equal(delivered.length, 1)
  assert.ok(delivered[0].text.includes('検証店へのご応募ありがとうございます'))
  assert.ok(!delivered[0].text.includes('link.invalid'), 'プレースホルダのまま送らないこと')
  const raw = rawOf(delivered[0].text)
  assert.ok(raw, '実URLが含まれること')
  const tokenRow = (await read('SELECT * FROM interview_link_token WHERE token_hash=$1', [digest(raw)])).rows[0]
  assert.ok(tokenRow, 'PushのURLのハッシュが発行記録と一致すること')
  assert.equal(tokenRow.applicant_key, applicantKeyOf(userA))
  const auditRow = await read("SELECT * FROM audit WHERE operation='interview_link.issue' AND object_id=$1", [tokenRow.id])
  assert.equal(auditRow.rowCount, 1)
  assert.equal(auditRow.rows[0].details.source, 'scenario_auto')

  const redeemed = await post('/interview-link/' + recruitCh + '/redeem', null, { token: raw })
  expect(redeemed, 200)
  assert.ok(redeemed.cookie?.startsWith('night_interview='), '配信されたURLがそのまま引換できること')

  // 別の応募者には別のURLが発行される（受信者ごとの発行）。
  await optInApplicant(userB, 't1-b')
  await followAgain(userB, 't1-b-follow2')
  const deliveredB = pushesTo(userB).filter(item => item.text.includes('面談予約はこちら'))
  assert.equal(deliveredB.length, 1)
  const rawB = rawOf(deliveredB[0].text)
  assert.ok(rawB && rawB !== raw, '応募者ごとに異なるURLが発行されること')
  const tokenRowB = (await read('SELECT * FROM interview_link_token WHERE token_hash=$1', [digest(rawB)])).rows[0]
  assert.equal(tokenRowB.applicant_key, applicantKeyOf(userB))
})

test('採用: 通知の同意がない応募者は follow シナリオに登録されない', async () => {
  await inbound(recruitCh, botR, [eventFor('t2-follow', 'follow', userC)])
  await flush(3)
  const contact = await read(`SELECT * FROM workflow_contact WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2`,
    [recruitCh, applicantKeyOf(userC)])
  assert.equal(contact.rowCount, 1, '友だち追加で連絡先自体は登録されること')
  assert.equal(contact.rows[0].notices, false)
  const enrollment = await read('SELECT * FROM applicant_enrollment WHERE applicant_key=$1', [applicantKeyOf(userC)])
  assert.equal(enrollment.rowCount, 0, '同意がないため登録されないこと')
  const event = await read('SELECT handled_at FROM applicant_event WHERE channel_id=$1 AND applicant_key=$2',
    [recruitCh, applicantKeyOf(userC)])
  assert.equal(event.rowCount, 1)
  assert.ok(event.rows[0].handled_at, 'イベントは処理済みになること')
  assert.equal(pushesTo(userC).filter(item => item.text.includes('面談予約はこちら')).length, 0)
})

test('採用: 面談URLの発行条件を満たさない場合は保留され、URLは送られない', async () => {
  await optInApplicant(userD, 't3')
  const tokensBefore = (await read('SELECT count(*)::int AS n FROM interview_link_token WHERE applicant_key=$1',
    [applicantKeyOf(userD)])).rows[0].n
  await setFeatures({ token_interviews_enabled: false })
  try {
    await followAgain(userD, 't3-follow2')
  } finally {
    await setFeatures({ token_interviews_enabled: true })
  }
  const held = await read(`SELECT n.* FROM applicant_note n JOIN applicant_enrollment e ON e.id=n.enrollment_id
    WHERE e.applicant_key=$1 AND n.kind='held'`, [applicantKeyOf(userD)])
  assert.equal(held.rowCount, 1, '発行条件を満たさないメッセージは保留として記録されること')
  assert.ok(held.rows[0].detail.includes('面談予約URLの発行条件'))
  const tokensAfter = (await read('SELECT count(*)::int AS n FROM interview_link_token WHERE applicant_key=$1',
    [applicantKeyOf(userD)])).rows[0].n
  assert.equal(tokensAfter, tokensBefore, '新しいトークンは発行されないこと')
  assert.equal(pushesTo(userD).filter(item => item.text.includes('面談予約はこちら')).length, 0)
  assert.equal(pushesTo(userD).filter(item => item.text.includes('link.invalid')).length, 0)
})

test('採用: 面談予約（interview_booked）でシナリオが開始され、確定内容が届く', async () => {
  await publishScenario(bookedGraph)
  const cookie = await optInApplicant(userE, 't4')
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + 3 * 86400000))
  const slotId = expect(await post('/stores/' + storeId + '/interviews/slots', admin, {
    channel: recruitCh, starts_at: date + 'T18:00:00+09:00', ends_at: date + 'T18:30:00+09:00',
    instructions: '会場案内', published: true,
  }, idempotency()), 201).id
  const booking = expect(await post('/interview/bookings', cookie, { slot: slotId, name: '応募者E' }), 201)
  await flush(3)
  const event = await read(`SELECT * FROM applicant_event WHERE channel_id=$1 AND applicant_key=$2 AND kind='interview_booked'`,
    [recruitCh, applicantKeyOf(userE)])
  assert.equal(event.rowCount, 1, '面談予約イベントが発行されること')
  assert.equal(event.rows[0].booking_id, booking.id)
  const enrollment = await read('SELECT * FROM applicant_enrollment WHERE applicant_key=$1 AND event_id=$2',
    [applicantKeyOf(userE), event.rows[0].id])
  assert.equal(enrollment.rowCount, 1, '予約イベントでシナリオに登録されること')
  const sends = await read("SELECT * FROM applicant_send WHERE applicant_key=$1 AND status='accepted'",
    [applicantKeyOf(userE)])
  assert.equal(sends.rowCount, 1)
  const notice = pushesTo(userE).filter(item => item.text.startsWith('応募者Eさん、面談予約が確定しました'))
  assert.equal(notice.length, 1, 'シナリオの確定メッセージが届くこと（業務通知とは別に）')
  assert.ok(notice[0].text.includes('応募者Eさん'))
  assert.ok(notice[0].text.includes('18:00'), '予約日時が差し込まれること')
})

test('採用: 全配信停止とブロックで進行中のランが終了し、続きは届かない', async () => {
  await publishScenario(stopGraph)
  // 全配信停止
  await optInApplicant(userF, 't5-f')
  await followAgain(userF, 't5-f-follow2')
  const runF = (await read(`SELECT * FROM applicant_enrollment WHERE applicant_key=$1 AND ended_at IS NULL AND node_id='wait'`,
    [applicantKeyOf(userF)])).rows[0]
  assert.ok(runF, '待機中のランがあること')
  assert.equal(pushesTo(userF).filter(item => item.text === 'ご応募ありがとうございます。').length, 1)
  await inbound(recruitCh, botR, [eventFor('t5-f-stop', 'message', userF, {
    message: { type: 'text', text: '全配信停止' },
  })])
  await worker()
  const stoppedF = (await read('SELECT * FROM applicant_enrollment WHERE id=$1', [runF.id])).rows[0]
  assert.ok(stoppedF.ended_at, '全配信停止でランが終了すること')
  assert.equal(stoppedF.end_reason, 'LINEから配信停止')
  const contactF = (await read(`SELECT notices FROM workflow_contact WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2`,
    [recruitCh, applicantKeyOf(userF)])).rows[0]
  assert.equal(contactF.notices, false, '通知の同意も取り消されること')
  await read('UPDATE applicant_enrollment SET due_at=now() WHERE id=$1', [runF.id])
  await flush(2)
  assert.equal(pushesTo(userF).filter(item => item.text.includes('面談の日程調整')).length, 0, '2通目は届かないこと')

  // ブロック
  await optInApplicant(userG, 't5-g')
  await followAgain(userG, 't5-g-follow2')
  const runG = (await read(`SELECT * FROM applicant_enrollment WHERE applicant_key=$1 AND ended_at IS NULL AND node_id='wait'`,
    [applicantKeyOf(userG)])).rows[0]
  assert.ok(runG)
  await inbound(recruitCh, botR, [eventFor('t5-g-unfollow', 'unfollow', userG)])
  await worker()
  const stoppedG = (await read('SELECT * FROM applicant_enrollment WHERE id=$1', [runG.id])).rows[0]
  assert.ok(stoppedG.ended_at, 'ブロックでランが終了すること')
  assert.equal(stoppedG.end_reason, 'LINEブロック')
  await read('UPDATE applicant_enrollment SET due_at=now() WHERE id=$1', [runG.id])
  await flush(2)
  assert.equal(pushesTo(userG).filter(item => item.text.includes('面談の日程調整')).length, 0)
})

test('採用: 受信メッセージが受信箱に残り、友だち追加で宛先が封緘される', async () => {
  await inbound(recruitCh, botR, [eventFor('t6-follow', 'follow', userH)])
  const stored = (await read('SELECT recipient_box FROM webhook_event WHERE channel_id=$1 AND event_id=$2',
    [recruitCh, 't6-follow'])).rows[0]
  assert.ok(stored.recipient_box, '採用OAの友だち追加でも宛先が封緘されること（026の受信側修正）')
  await worker()
  const contact = await read(`SELECT * FROM workflow_contact WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2`,
    [recruitCh, applicantKeyOf(userH)])
  assert.equal(contact.rowCount, 1, '友だち追加で応募者の連絡先が登録されること')
  await inbound(recruitCh, botR, [eventFor('t6-message', 'message', userH, {
    message: { id: 't6-msg-1', type: 'text', text: '面談の日程について質問です' },
  })])
  await worker()
  const thread = await read(`SELECT * FROM inbox_thread WHERE channel_id=$1 AND purpose='recruitment' AND user_key=$2`,
    [recruitCh, userKey(cfg, { id: recruitCh }, userH)])
  assert.equal(thread.rowCount, 1, '採用OAへのメッセージが採用の受信箱スレッドに残ること')
  const messages = await read('SELECT * FROM inbox_message WHERE thread_id=$1', [thread.rows[0].id])
  assert.equal(messages.rowCount, 1)
})

test('採用: 実配信に対応しない開始イベントは公開できず、用途違いの開始イベントは検証で拒否される', async () => {
  const root = '/stores/' + storeId + '/scenarios'
  // 採用 × form（下書き・テスト送信のみ）は公開不可
  const formGraph = { ...followLinkGraph, name: 'フォーム開始', trigger: 'form' }
  const created = expect(await post(root, admin, formGraph, idempotency()), 201)
  const url = root + '/' + created.id + '/transition'
  const tested = expect(await post(url, admin, { revision: created.revision, action: 'test', fixture: pubFixture }), 200)
  const approved = expect(await post(url, admin, { revision: tested.revision, action: 'approve' }), 200)
  const published = await post(url, admin, { revision: approved.revision, action: 'publish' })
  assert.equal(published.status, 422)
  assert.equal(published.data.code, 'TRIGGER_UNAVAILABLE')
  // 用途違いの開始イベントはグラフ検証で拒否され、正しい組み合わせは通る
  assert.ok(validate({ ...bookedGraph, purpose: 'customer' }, true).length > 0,
    '顧客 × interview_booked は検証で拒否されること')
  assert.ok(validate({ ...followLinkGraph, trigger: 'booking_created' }, true).length > 0,
    '採用 × booking_created は検証で拒否されること')
  assert.equal(validate(bookedGraph, true).length, 0, '採用 × interview_booked は検証を通ること')
  assert.equal(validate(followLinkGraph, true).length, 0, '採用 × follow は検証を通ること')
})
