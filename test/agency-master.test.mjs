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
import { assertAppRole, poolFor } from '../dist/core.js'
import { bootstrap, inviteSupervisor, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'

// 代理店マスター交代のセルフサービス化の結合試験。
// 現マスター本人が自法人分だけ招待・切り替えできること、マスターでない代理店スタッフと
// 非代理店アカウントは引き続き403であること、監督者（北村さん）経由が従来どおり動くことを検証する。
//
// RLS 前提: tenant_master の UPDATE は 019 では監督者ポリシー（night.platform_principal
// 照合）と所有者ロールに限られていたが、027 で night.agency_master 照合のセルフサービス
// ポリシーを追加し、platform.ts のゲート通過後に set_config するようになった。
// これにより現マスター本人の招待・切り替えまで本試験で検証する。

const origin = 'https://example.test'
const cfg = { origin, master: randomBytes(32), external: true, automation: true }
const bot = 'U' + '1'.repeat(32)
const messaging = '1234567890'
const pass = 'Only used in local tests!'
let pg, owner, pool, server, dir, base
let agencyInvite, master, staff, platform, plain
let alphaTenant, successorCookie

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

async function activate(invite, email, tenant, loginPath = '/auth/login') {
  expect(await post('/auth/activate', null,
    { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const auth = await post(loginPath, null, { tenant, email, password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  assert.ok(auth.cookie)
  return auth.cookie
}

const scopePath = tenant => '/platform/tenants/' + tenant + '/api/v1'
async function scoped(tenant, path, method = 'GET', data, cookie = platform) {
  const response = await send(scopePath(tenant) + path, { method, headers: { Origin: origin, Cookie: cookie,
    ...(data ? { 'Content-Type': 'application/json', ...idempotency() } : {}) },
  body: data ? JSON.stringify(data) : undefined })
  return { status: response.status, data: await response.json() }
}

before(async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(), 'night-agency-master-'))
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

  // 代理店（エール）の現マスター
  agencyInvite = await bootstrap(owner, cfg, { slug: 'alpha', name: 'エール', email: 'chief@example.test' })
  master = await activate(agencyInvite, 'chief@example.test', 'alpha')

  // マスターでない代理店スタッフ（マネージャー）。店舗作成とスタッフ招待は、
  // 代理店として紐づく前（アクセス制限が効く前）に済ませる。
  const store = expect(await post('/stores', master,
    { name: '一号店', address: '東京都', business_type: '接客飲食', responsible: '担当者',
      timezone: 'Asia/Tokyo', cutoff: '06:00' }, idempotency()), 201)
  const staffInvite = expect(await post('/staff/invites', master,
    { email: 'staff@example.test', role: 'manager', stores: [store.id] }, idempotency()), 201)
  staff = await activate(staffInvite, 'staff@example.test', 'alpha')

  // 監督者（北村さん）。この招待で alpha が代理店（agency）として紐づく
  const supervisorInvite = await inviteSupervisor(owner, cfg,
    { slug: 'lilu', name: 'リルコーポレーション', displayName: '北村さん', email: 'kitamura@example.test', agency: 'alpha' })
  expect(await post('/auth/activate', null,
    { invite: supervisorInvite.invite_code, password: pass, code: code(supervisorInvite.setup_key, -1) }), 200)
  const login = await post('/auth/platform/login', null,
    { tenant: 'lilu', email: 'kitamura@example.test', password: pass, code: code(supervisorInvite.setup_key) })
  expect(login, 200)
  platform = login.cookie

  const session = expect(await request('/session', { cookie: master }), 200)
  assert.equal(session.actor.agency, true)
  assert.equal(session.actor.platform, false)
  alphaTenant = session.tenant.id

  // 非代理店の法人の管理者（agency フラグなし）
  const plainInvite = await bootstrap(owner, cfg, { slug: 'beta', name: '乙法人', email: 'chief@example.test' })
  plain = await activate(plainInvite, 'chief@example.test', 'beta')
  assert.equal(expect(await request('/session', { cookie: plain }), 200).actor.agency, false)
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([pool?.end(), owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('マスターでない代理店スタッフと非代理店の管理者はマスター管理を使えない', async () => {
  expect(await request('/session', { cookie: staff }), 200)
  expect(await request('/agency-master', { cookie: staff }), 403)
  expect(await post('/agency-master/invite', staff, { address: 'nobody@example.test' }, idempotency()), 403)
  expect(await post('/agency-master/promote', staff, { pending: randomUUID() }), 403)
  expect(await request('/agency-master', { cookie: plain }), 403)
  expect(await post('/agency-master/invite', plain, { address: 'nobody@example.test' }, idempotency()), 403)
  expect(await post('/agency-master/promote', plain, { pending: randomUUID() }), 403)
})

test('代理店の現マスターは自法人で後任を招待し、切り替えまで完結できる', async () => {
  const before = expect(await request('/agency-master', { cookie: master }), 200)
  assert.equal(before.current_email, 'chief@example.test')
  assert.equal(before.pending_id, null)

  const invite = expect(await post('/agency-master/invite', master,
    { address: 'successor@example.test' }, idempotency()), 201)
  const pending = expect(await request('/agency-master', { cookie: master }), 200)
  assert.equal(pending.pending_id, invite.id)
  assert.equal(pending.pending_email, 'successor@example.test')
  assert.equal(pending.pending_active, false)

  // 有効化前の切り替えは従来どおり 409
  expect(await post('/agency-master/promote', master, { pending: invite.id }), 409)

  expect(await post('/auth/activate', null,
    { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const ready = expect(await request('/agency-master', { cookie: master }), 200)
  assert.equal(ready.pending_active, true)

  const promoted = expect(await post('/agency-master/promote', master, { pending: invite.id }), 200)
  assert.equal(promoted.current_email, 'successor@example.test')
  assert.equal(promoted.pending_id, null)

  // 前任者は自分のセッションもマスター資格も失う
  expect(await request('/session', { cookie: master }), 401)
  expect(await request('/agency-master', { cookie: master }), 401)
  expect(await post('/auth/login', null,
    { tenant: 'alpha', email: 'chief@example.test', password: pass, code: code(agencyInvite.setup_key, 1) }), 401)

  // 後任がマスターとしてログインし、マスター管理を開ける
  const auth = await post('/auth/master/login', null,
    { tenant: 'alpha', email: 'successor@example.test', password: pass, code: code(invite.setup_key) })
  expect(auth, 200)
  successorCookie = auth.cookie
  const state = expect(await request('/agency-master', { cookie: successorCookie }), 200)
  assert.equal(state.current_email, 'successor@example.test')
})

test('監督者（北村さん）は従来どおりスコープ経由で代理店マスターを管理できる', async () => {
  expect(await post('/platform/tenants/' + alphaTenant + '/enter', platform, {}), 200)
  // 現在のマスターが誰かには依存しない（上のセルフサービス試験の成否で変わるため）
  const state = expect(await scoped(alphaTenant, '/agency-master'), 200)
  assert.equal(typeof state.current_email, 'string')

  const invite = expect(await scoped(alphaTenant, '/agency-master/invite', 'POST',
    { address: 'final@example.test' }), 201)
  expect(await scoped(alphaTenant, '/agency-master/promote', 'POST', { pending: invite.id }), 409)
  expect(await post('/auth/activate', null,
    { invite: invite.invite_code, password: pass, code: code(invite.setup_key, -1) }), 200)
  const promoted = expect(await scoped(alphaTenant, '/agency-master/promote', 'POST',
    { pending: invite.id }), 200)
  assert.equal(promoted.current_email, 'final@example.test')
  assert.equal(promoted.pending_id, null)
  // 監督者の切り替えで前任者のセッションが終了することは g1 側でも検証している
})
