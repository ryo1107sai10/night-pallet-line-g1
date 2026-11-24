import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import { Secret, TOTP } from 'otpauth'
import { createApp } from '../dist/app.js'
import { assertAppRole, digest, poolFor, scope, tx } from '../dist/core.js'
import { bootstrap, inviteSupervisor, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'

// 登録フロー再設計（設計書 §12）の結合試験。
// 北村さんのウィザード一括作成と進捗一覧、CLI --master の画面化、
// エール側セットアップウィザードのステップ確定・再確定・完了条件を検証する。

const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true }
const bot = 'U' + '1'.repeat(32)
const messaging = '1234567890'
const pass = 'Only used in local tests!'
let pg, owner, pool, server, dir, base
let platform, agencyAdmin, master, manager
let created, storeId

const code = (key, steps = 0) => new TOTP({ secret: Secret.fromBase32(key) })
  .generate({ timestamp: Date.now() + 30000 * steps })
const send = (url, options = {}) => fetch(base + url, { redirect: 'error', ...options })
const idempotency = () => ({ 'Idempotency-Key': randomUUID() })

async function request(path, { method = 'GET', data, cookie, headers = {} } = {}) {
  const response = await send('/api/v1' + path, { method,
    headers: { Origin: origin, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data) })
  const setCookie = response.headers.get('set-cookie')
  return { status: response.status, data: await response.json(), cookie: setCookie?.split(';')[0], setCookie }
}
function expect(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.data))
  return result.data
}
const post = (path, cookie, data, headers) => request(path, { method: 'POST', cookie, data, headers })
const patch = (path, cookie, data) => request(path, { method: 'PATCH', cookie, data })

async function activate(invite, email, tenant, loginPath = '/auth/login') {
  expect(await post('/auth/activate', null,
    { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const auth = await post(loginPath, null, { tenant, email, password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  assert.ok(auth.cookie)
  return auth.cookie
}

const featureBody = (revision, overrides = {}) => ({ revision,
  tags_enabled: true, visits_enabled: true, interviews_enabled: true, google_calendar_enabled: true,
  forms_enabled: false, recruitment_enabled: true, sources_enabled: false, campaigns_enabled: false,
  rich_menus_enabled: false, reminders_enabled: true, waitlist_enabled: false, inbox_enabled: true,
  interviewers_enabled: false, google_write_enabled: false, guest_interviews_enabled: false,
  token_interviews_enabled: true, token_customers_enabled: false, ...overrides })

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-registration-'))
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), user: 'night_owner', password: 'owner-test',
    port, persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--locale=C', '--encoding=UTF8'],
    postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='], onLog: () => {} })
  await pg.initialise()
  await pg.start()
  owner = poolFor(`postgresql://night_owner:owner-test@127.0.0.1:${port}/postgres`)
  await owner.query("CREATE ROLE night_app LOGIN NOBYPASSRLS PASSWORD 'app-test'")
  pool = poolFor(`postgresql://night_app:app-test@127.0.0.1:${port}/postgres`)
  await migrate(owner, 'night_app')
  await migrate(owner, 'night_app')
  await assertAppRole(pool)
  const fetchLine = async url => {
    const address = new URL(url)
    if (address.pathname === '/v2/oauth/verify') return Response.json({ client_id: messaging })
    if (address.pathname === '/v2/bot/info') return Response.json({ userId: bot })
    throw new Error('Unexpected path ' + address.pathname)
  }
  server = createApp(pool, cfg, new LineAPI(fetchLine)).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = 'http://127.0.0.1:' + server.address().port

  const agencyInvite = await bootstrap(owner, cfg, { slug: 'alpha', name: 'エール', email: 'chief@example.test' })
  agencyAdmin = await activate(agencyInvite, 'chief@example.test', 'alpha')
  const supervisorInvite = await inviteSupervisor(owner, cfg,
    { slug: 'lilu', name: 'リルコーポレーション', displayName: '北村さん', email: 'kitamura@example.test', agency: 'alpha' })
  expect(await post('/auth/activate', null,
    { invite: supervisorInvite.invite_code, password: pass, code: code(supervisorInvite.setup_key, -1) }), 200)
  const login = await post('/auth/platform/login', null,
    { tenant: 'lilu', email: 'kitamura@example.test', password: pass, code: code(supervisorInvite.setup_key) })
  expect(login, 200)
  platform = login.cookie
  assert.match(platform, /^night_platform=/)
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('北村さんのウィザードで法人・店舗・招待が一括作成され、テンプレートが適用される', async () => {
  const input = { legal_name: '新規法人', store_name: '一号店', email: 'ops@example.test' }
  expect(await post('/platform/registrations', agencyAdmin, input, idempotency()), 401)
  expect(await post('/platform/registrations', null, input, idempotency()), 401)
  const key = idempotency()
  created = expect(await post('/platform/registrations', platform, input, key), 201)
  assert.match(created.tenant.slug, /^corp-[0-9a-f]{16}$/)
  assert.equal(created.store.name, '一号店')
  assert.ok(created.invite.invite_code && created.invite.setup_key && created.invite.expires_at)
  assert.equal(created.urls.master, origin + '/master/')
  const replay = expect(await post('/platform/registrations', platform, input, key), 201)
  assert.equal(replay.tenant.id, created.tenant.id)
  storeId = created.store.id

  await tx(owner, async db => {
    await scope(db, created.tenant.id, undefined, true)
    const { rows: [store] } = await db.query(`SELECT name,address,timezone,to_char(cutoff,'HH24:MI') AS cutoff,
      interview_open_minute,interview_close_minute,tags_enabled,visits_enabled,interviews_enabled,
      google_calendar_enabled,forms_enabled,token_interviews_enabled FROM store WHERE id=$1`, [storeId])
    assert.equal(store.name, '一号店')
    assert.equal(store.address, '未設定')
    assert.equal(store.timezone, 'Asia/Tokyo')
    assert.equal(store.cutoff, '06:00')
    assert.equal(store.interview_open_minute, 1080)
    assert.equal(store.interview_close_minute, 1440)
    assert.deepEqual([store.tags_enabled, store.visits_enabled, store.interviews_enabled,
      store.google_calendar_enabled], [true, true, true, true])
    assert.equal(store.forms_enabled, false)
    assert.equal(store.token_interviews_enabled, false)
    const { rows: [binding] } = await db.query(
      'SELECT staff_id FROM tenant_master WHERE tenant_id=$1', [created.tenant.id])
    assert.equal(binding.staff_id, created.invite.id)
    const { rows: [registration] } = await db.query(
      'SELECT store_id FROM platform_registration WHERE tenant_id=$1', [created.tenant.id])
    assert.equal(registration.store_id, storeId)
  })

  expect(await request('/platform/registrations/progress', { cookie: agencyAdmin }), 401)
  const progress = expect(await request('/platform/registrations/progress', { cookie: platform }), 200)
  assert.equal(progress.length, 2)
  const entry = progress.find(item => item.tenant.id === created.tenant.id)
  assert.equal(entry.stage, 'master_pending')
  assert.equal(entry.master.email, 'ops@example.test')
  assert.equal(entry.master.activated, false)
  assert.equal(entry.stores[0].line_stage, 'unknown')
  assert.equal(entry.stores[0].setup.confirmed, 0)
  assert.ok(progress.some(item => item.tenant.slug === 'alpha'))
})

test('エール担当者が有効化すると進捗が進み、マスターとして操作できる', async () => {
  master = await activate(created.invite, 'ops@example.test', created.tenant.slug)
  const session = expect(await request('/session', { cookie: master }), 200)
  assert.equal(session.tenant.legal_name, '新規法人')
  assert.deepEqual(session.stores.map(store => store.id), [storeId])
  const progress = expect(await request('/platform/registrations/progress', { cookie: platform }), 200)
  const entry = progress.find(item => item.tenant.id === created.tenant.id)
  assert.equal(entry.master.activated, true)
  assert.equal(entry.stage, 'registered')
})

test('マスター指定の画面化は、対象法人の有効な管理者だけを指定できる', async () => {
  const path = '/platform/registrations/' + created.tenant.id + '/master'
  expect(await post(path, master, { address: 'ops@example.test' }), 401)
  expect(await post(path, platform, { address: 'nobody@example.test' }), 404)
  const same = expect(await post(path, platform, { address: 'ops@example.test' }), 200)
  assert.equal(same.designated, true)
  assert.equal(same.changed, false)
  await bootstrap(owner, cfg, { slug: 'gamma', name: '丙法人', email: 'chief@example.test' })
  const { rows: [gamma] } = await owner.query('SELECT id FROM tenant WHERE slug=$1', ['gamma'])
  expect(await post('/platform/registrations/' + gamma.id + '/master', platform,
    { address: 'chief@example.test' }), 404)
})

test('監督者は登録した法人を開いてマスターを管理でき、未登録法人と代理店には権限を広げない', async () => {
  const tenants = expect(await request('/platform/tenants', { cookie: platform }), 200)
  assert.equal(tenants.length, 2)
  assert.ok(tenants.some(item => item.id === created.tenant.id && item.stores === 1))
  const entry = expect(await post('/platform/tenants/' + created.tenant.id + '/enter', platform, {}), 200)
  assert.equal(entry.url, '/platform/tenants/' + created.tenant.id + '/master/')
  const workspace = '/platform/tenants/' + created.tenant.id + '/api/v1'
  const call = async (path, cookie, data) => {
    const result = await send(workspace + path, { method: data ? 'POST' : 'GET',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...idempotency() },
      body: data ? JSON.stringify(data) : undefined })
    return { status: result.status, data: await result.json() }
  }
  assert.deepEqual(expect(await call('/session', platform), 200).stores.map(item => item.id), [storeId])
  assert.equal(expect(await call('/agency-master', platform), 200).current_email, 'ops@example.test')
  const invite = expect(await call('/agency-master/invite', platform, { address: 'successor@example.test' }), 201)
  assert.equal(expect(await call('/agency-master', platform), 200).pending_id, invite.id)
  expect(await call('/session', agencyAdmin), 401)
  const { rows: [gamma] } = await owner.query('SELECT id FROM tenant WHERE slug=$1', ['gamma'])
  expect(await post('/platform/tenants/' + gamma.id + '/enter', platform, {}), 404)
  assert.ok(!tenants.some(item => item.id === gamma.id))
})

test('エール側セットアップはステップ確定制で、設定を変えると再確定が要る', async () => {
  const base = '/stores/' + storeId
  const setup = () => request(base + '/setup', { cookie: master })
  let state = expect(await setup(), 200)
  assert.deepEqual(state.steps, { profile: false, features: false, hours: false, line: false })
  assert.equal(state.profile.complete, false)
  assert.deepEqual([state.hours.start, state.hours.end], [1080, 1440])
  assert.equal(state.revision, 1)
  assert.equal(state.completed_at, null)

  // 店舗情報が未設定のままでは確定できない
  expect(await post(base + '/setup/confirm', master,
    { step: 'profile', revision: 1 }), 409)
  const updated = expect(await patch(base, master,
    { name: '一号店', address: '東京都新宿区', business_type: '接客飲食', responsible: '店長',
      timezone: 'Asia/Tokyo', cutoff: '06:00', revision: 1 }), 200)
  expect(await post(base + '/setup/confirm', master,
    { step: 'profile', revision: 1 }), 200)
  state = expect(await setup(), 200)
  assert.equal(state.steps.profile, true)
  assert.equal(state.revision, 2)

  // 機能を選んで確定する
  const features = expect(await patch(base + '/features', master, featureBody(updated.revision)), 200)
  expect(await post(base + '/setup/confirm', master,
    { step: 'features', revision: 2 }), 200)
  state = expect(await setup(), 200)
  assert.equal(state.steps.features, true)
  assert.equal(state.features.token_interviews_enabled, true)

  // 機能を変えると確定が外れ、再確定が要る
  expect(await patch(base + '/features', master,
    featureBody(features.revision, { token_interviews_enabled: false })), 200)
  state = expect(await setup(), 200)
  assert.equal(state.steps.features, false)
  expect(await post(base + '/setup/confirm', master,
    { step: 'features', revision: state.revision }), 200)
  state = expect(await setup(), 200)
  assert.equal(state.steps.features, true)
  // 関係ないステップ（店舗情報）の確定は、機能を変えても外れない
  assert.equal(state.steps.profile, true)

  // 面談の受付時間を決めて確定する
  expect(await patch(base + '/interviews/hours', master,
    { start: 1140, end: 1380, revision: 1 }), 200)
  state = expect(await setup(), 200)
  expect(await post(base + '/setup/confirm', master,
    { step: 'hours', revision: state.revision }), 200)
  state = expect(await setup(), 200)
  assert.equal(state.steps.hours, true)
  assert.deepEqual([state.hours.start, state.hours.end], [1140, 1380])

  // LINE未接続の間は完了できない
  const incomplete = await post(base + '/setup/complete', master, { revision: state.revision })
  expect(incomplete, 409)
  assert.equal(incomplete.data.code, 'SETUP_INCOMPLETE')
})

test('LINE接続が確認できるとセットアップを完了でき、再編集もできる', async () => {
  const base = '/stores/' + storeId
  const connection = expect(await post(base + '/connections', master, {
    label: '採用LINE', purpose: 'recruitment', owner_name: '新規法人', provider_id: 'provider-1',
    messaging_id: messaging, account_type: 'verified', management_authority: '管理権限を確認済み',
    token_type: 'console', access_token: 'test-channel-token', channel_secret: 'a'.repeat(32),
  }, idempotency()), 201)
  let state = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.equal(state.line.connections.length, 1)
  assert.equal(state.line.connections[0].status, 'pending')
  assert.equal(state.steps.line, false)
  expect(await post(base + '/setup/complete', master, { revision: state.revision }), 409)

  // 検収済みの状態をDBで再現する（自動判定の証跡＋手動確認項目）
  await tx(owner, async db => {
    await scope(db, created.tenant.id, storeId)
    const { rows: [channel] } = await db.query('SELECT generation FROM channel WHERE id=$1', [connection.id])
    await db.query(`UPDATE channel SET checks=checks || $2::jsonb WHERE id=$1`, [connection.id, JSON.stringify({
      ownership_verified: true, provider_verified: true, redelivery_enabled: true, auto_reply_checked: true,
      non_developer: true, token_verified: true, webhook_verified: true, delivery_confirmed: true })])
    const testerId = randomUUID()
    await db.query(`INSERT INTO tester(id,tenant_id,store_id,channel_id,generation,purpose,code_hash,
      expires_at,verified_at,user_key) VALUES($1,$2,$3,$4,$5,'recruitment',$6,now()+interval '2 hours',now(),$7)`,
      [testerId, created.tenant.id, storeId, connection.id, channel.generation,
        digest('registration-test-code'), 'test-user-key'])
    await db.query(`INSERT INTO webhook_event(tenant_id,store_id,channel_id,event_id,generation,
      occurred_at,received_at,kind,purpose,user_key) VALUES($1,$2,$3,'evt-registration',$4,now(),now(),
      'follow','recruitment','test-user-key')`,
      [created.tenant.id, storeId, connection.id, channel.generation])
    const { rows: [me] } = await db.query('SELECT id FROM staff WHERE tenant_id=$1 AND email=$2',
      [created.tenant.id, 'ops@example.test'])
    await db.query(`INSERT INTO test_send(id,tenant_id,store_id,channel_id,tester_id,actor_id,
      operation_key,generation,status) VALUES($1,$2,$3,$4,$5,$6,'registration-test',$7,'accepted')`,
      [randomUUID(), created.tenant.id, storeId, connection.id, testerId, me.id, channel.generation])
  })

  state = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.equal(state.line.connections[0].status, 'connected')
  assert.deepEqual(Object.values(state.line.connections[0].auto), [true, true, true, true, true])
  assert.equal(state.steps.line, true)
  expect(await post(base + '/setup/complete', master, { revision: state.revision }), 200)
  state = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.ok(state.completed_at)
  const progress = expect(await request('/platform/registrations/progress', { cookie: platform }), 200)
  const entry = progress.find(item => item.tenant.id === created.tenant.id)
  assert.equal(entry.stores[0].setup.completed, true)
  assert.equal(entry.stores[0].setup.confirmed, 4)
  assert.equal(entry.stage, 'verified')

  expect(await post(base + '/setup/reopen', master, { revision: state.revision }), 200)
  state = expect(await request(base + '/setup', { cookie: master }), 200)
  assert.equal(state.completed_at, null)
})

test('管理者以外はセットアップを確定できず、他法人の店舗は見えない', async () => {
  const base = '/stores/' + storeId
  const invite = expect(await post('/staff/invites', master,
    { email: 'manager@example.test', role: 'manager', stores: [storeId] }, idempotency()), 201)
  manager = await activate(invite, 'manager@example.test', created.tenant.slug)
  const state = expect(await request(base + '/setup', { cookie: manager }), 200)
  expect(await post(base + '/setup/confirm', manager,
    { step: 'profile', revision: state.revision }), 403)
  expect(await post(base + '/setup/complete', manager, { revision: state.revision }), 403)
  // 管理会社（agency）アカウントは、既存のアクセス制限どおりワークスペース外の店舗では拒否される
  expect(await request(base + '/setup', { cookie: agencyAdmin }), 403)
  expect(await post('/platform/registrations', master,
    { legal_name: '不正法人', store_name: '不正店', email: 'x@example.test' }, idempotency()), 401)
})
