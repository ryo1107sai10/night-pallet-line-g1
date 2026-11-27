import { previousCode } from './helpers/totp.mjs'
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
import { bootstrap, inviteSupervisor, migrate, renameAgencyLoginId } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'
import {prepareMasterPasswordReset} from '../dist/master-password-reset.js'
import {verifyPassword} from '../dist/auth.js'
import {scope,tx} from '../dist/core.js'

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
    { invite: invite.invite_code, password: pass, code: await previousCode(invite.setup_key) }), 200)
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
    { invite: supervisorInvite.invite_code, password: pass, code: await previousCode(supervisorInvite.setup_key) }), 200)
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

test('現マスターのパスワード回復は登録メールへの一回限りリンクと既存MFAを必要とし、セッションだけを失効する',async()=>{
  const tenant='recovery-test',address='recovery@example.test',nextPassword='New password only for local test!'
  const invite=await bootstrap(owner,cfg,{slug:tenant,name:'回復検証用法人',email:address})
  const existing=await activate(invite,address,tenant)
  const {tenant:{id}}=expect(await request('/session',{cookie:existing}),200)
  // 実運用データに触れず、管理会社の検証用テナントを設定する。
  await tx(owner,async db=>{await scope(db,id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[id])})
  const target={tenant,address}
  await assert.rejects(prepareMasterPasswordReset(owner,cfg,{...target,address:'other@example.test'}))
  await assert.rejects(prepareMasterPasswordReset(pool,cfg,target),{code:'42501'})
  const issued=await prepareMasterPasswordReset(owner,cfg,target)
  assert.equal(issued.email,address)
  const recovery=new URL(issued.url).hash.slice(1)
  expect(await request('/session',{cookie:existing}),200)
  const badCode=String((Number(code(invite.setup_key))+1)%1000000).padStart(6,'0')
  expect(await post('/auth/master/recovery',null,{recovery,password:nextPassword,code:badCode}),400)
  expect(await request('/session',{cookie:existing}),200)
  const proof=code(invite.setup_key,1)
  expect(await post('/auth/master/recovery',null,{recovery,password:nextPassword,code:proof}),200)
  expect(await request('/session',{cookie:existing}),401)
  expect(await post('/auth/master/recovery',null,{recovery,password:nextPassword,code:proof}),400)
  const hashes=await tx(owner,async db=>{await scope(db,id,undefined,true);return (await db.query('SELECT password_hash FROM staff WHERE email=$1',[address])).rows[0]})
  assert.equal(await verifyPassword(nextPassword,hashes.password_hash),true)
  assert.equal(await verifyPassword(pass,hashes.password_hash),false)
  expect(await request('/session',{cookie:master}),200)
  expect(await request('/platform/session',{cookie:platform}),200)
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
    { invite: invite.invite_code, password: pass, code: await previousCode(invite.setup_key) }), 200)
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
    { invite: invite.invite_code, password: pass, code: await previousCode(invite.setup_key) }), 200)
  const promoted = expect(await scoped(alphaTenant, '/agency-master/promote', 'POST',
    { pending: invite.id }), 200)
  assert.equal(promoted.current_email, 'final@example.test')
  assert.equal(promoted.pending_id, null)
  // 監督者の切り替えで前任者のセッションが終了することは g1 側でも検証している
})

test('兼任マスターは2名が個別認証で全店舗を運用し、片方だけを引き継げる',async()=>{
  const tenant='joint-masters',firstEmail='first@example.test',secondEmail='second@example.test',nextEmail='next@example.test'
  const firstInvite=await bootstrap(owner,cfg,{slug:tenant,name:'兼任マスター検証',email:firstEmail})
  const first=await activate(firstInvite,firstEmail,tenant)
  const {tenant:{id}}=expect(await request('/session',{cookie:first}),200)
  await tx(owner,async db=>{await scope(db,id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[id])})
  const storeData=name=>({name,address:'東京都',business_type:'検証',responsible:'検証担当',timezone:'Asia/Tokyo',cutoff:'06:00'})
  const firstStore=expect(await post('/stores',first,storeData('一号店'),idempotency()),201).id
  const original=expect(await request('/agency-master',{cookie:first}),200)
  assert.deepEqual(original.masters.map(m=>m.email),[firstEmail])
  assert.equal(original.master_limit,2)
  const pending=expect(await post('/agency-master/invite',first,{address:secondEmail,mode:'add'},idempotency()),201)
  assert.equal(expect(await request('/agency-master',{cookie:first}),200).pending_mode,'add')
  expect(await post('/agency-master/promote',first,{pending:pending.id}),409)
  const loginInput={tenant,email:secondEmail,password:pass,code:code(pending.setup_key)}
  expect(await post('/auth/activate',null,{invite:pending.invite_code,password:pass,code:await previousCode(pending.setup_key)}),200)
  expect(await post('/auth/master/login',null,loginInput),401)
  expect(await post('/agency-master/promote',first,{pending:pending.id}),409)
  expect(await post('/agency-master/promote',first,{pending:pending.id,mode:'replace',replace_id:original.current_id}),409)
  const joint=expect(await post('/agency-master/promote',first,{pending:pending.id,mode:'add'}),200)
  assert.deepEqual(joint.masters.map(m=>m.email),[firstEmail,secondEmail])
  expect(await request('/session',{cookie:first}),200)
  const secondLogin=await post('/auth/master/login',null,{...loginInput,code:code(pending.setup_key)})
  expect(secondLogin,200)
  const second=secondLogin.cookie
  assert.notEqual(first,second)
  assert.equal(expect(await request('/session',{cookie:second}),200).actor.role,'admin')
  const secondStore=expect(await post('/stores',second,storeData('二号店'),idempotency()),201).id
  assert.deepEqual(new Set(expect(await request('/session',{cookie:first}),200).stores.map(s=>s.id)),new Set([firstStore,secondStore]))
  assert.deepEqual(new Set(expect(await request('/session',{cookie:second}),200).stores.map(s=>s.id)),new Set([firstStore,secondStore]))
  assert.deepEqual(new Set(expect(await request('/store-health',{cookie:first}),200).map(s=>s.id)),new Set([firstStore,secondStore]))
  assert.deepEqual(new Set(expect(await request('/store-health',{cookie:second}),200).map(s=>s.id)),new Set([firstStore,secondStore]))
  expect(await request('/stores/'+firstStore+'/connections',{cookie:second}),200)
  expect(await request('/stores/'+secondStore+'/connections',{cookie:first}),200)
  const linked=expect(await post('/stores/'+secondStore+'/connections',second,{
    label:'兼任マスターの採用LINE',purpose:'recruitment',owner_name:'検証店舗',provider_id:'2000000010',
    messaging_id:messaging,account_type:'unverified',management_authority:'検証のみ',
    access_token:'local-test-token-for-co-master',channel_secret:'a'.repeat(32),token_type:'console',
  },idempotency()),201)
  assert.equal(expect(await request('/stores/'+secondStore+'/connections',{cookie:first}),200)[0].id,linked.id)
  expect(await request('/stores/'+firstStore+'/connections',{cookie:plain}),404)
  expect(await request('/platform/session',{cookie:second}),401)
  expect(await post('/agency-master/invite',second,{address:'third@example.test',mode:'add'},idempotency()),409)
  expect(await post('/agency-master/invite',second,{address:firstEmail,mode:'replace',replace_id:pending.id},idempotency()),409)
  // Both members can recover their own password, not other tenants' credentials.
  assert.equal((await prepareMasterPasswordReset(owner,cfg,{tenant,address:secondEmail})).email,secondEmail)
  const replacement=expect(await post('/agency-master/invite',second,{address:nextEmail,mode:'replace',replace_id:original.current_id},idempotency()),201)
  const ready=expect(await request('/agency-master',{cookie:second}),200)
  assert.equal(ready.pending_replace_email,firstEmail)
  expect(await post('/agency-master/promote',second,{pending:replacement.id}),409)
  expect(await request('/session',{cookie:first}),200)
  expect(await post('/auth/activate',null,{invite:replacement.invite_code,password:pass,code:await previousCode(replacement.setup_key)}),200)
  expect(await post('/agency-master/promote',second,{pending:replacement.id,mode:'replace',replace_id:pending.id}),409)
  expect(await post('/agency-master/promote',second,{pending:replacement.id,mode:'add'}),409)
  const handed=expect(await post('/agency-master/promote',second,{pending:replacement.id,mode:'replace',replace_id:original.current_id}),200)
  assert.deepEqual(handed.masters.map(m=>m.email),[nextEmail,secondEmail])
  expect(await request('/session',{cookie:first}),401)
  expect(await request('/session',{cookie:second}),200)
  const nextLogin=await post('/auth/master/login',null,{tenant,email:nextEmail,password:pass,code:code(replacement.setup_key)})
  expect(nextLogin,200)
  assert.equal(expect(await request('/agency-master',{cookie:nextLogin.cookie}),200).masters.length,2)
  // The continuing master can also hand over their own seat, or revoke it.
  const removed=expect(await post('/agency-master/remove',nextLogin.cookie,{target:pending.id}),200)
  assert.deepEqual(removed.masters.map(m=>m.email),[nextEmail])
  expect(await request('/session',{cookie:second}),401)
  expect(await post('/agency-master/remove',nextLogin.cookie,{target:replacement.id}),409)
  await assert.rejects(prepareMasterPasswordReset(owner,cfg,{tenant,address:secondEmail}))
  // DB membership remains tenant-scoped and non-authorized application requests cannot change it.
  await tx(pool,async db=>{await scope(db,id);assert.equal((await db.query('UPDATE tenant_master SET co_staff_id=$1 WHERE tenant_id=$2',[pending.id,id])).rowCount,0)})
})

test('既に有効な店舗担当者の兼任昇格は最終確定までは権限を変えない',async()=>{
  const tenant='existing-co-master',address='master@example.test',staffAddress='operator@example.test'
  const primaryInvite=await bootstrap(owner,cfg,{slug:tenant,name:'既存担当者検証',email:address})
  const primary=await activate(primaryInvite,address,tenant)
  const store=expect(await post('/stores',primary,{name:'担当店舗',address:'東京都',business_type:'検証',responsible:'担当',timezone:'Asia/Tokyo',cutoff:'06:00'},idempotency()),201)
  const existingInvite=expect(await post('/staff/invites',primary,{email:staffAddress,role:'manager',stores:[store.id]},idempotency()),201)
  const existing=await activate(existingInvite,staffAddress,tenant)
  const {tenant:{id}}=expect(await request('/session',{cookie:primary}),200)
  await tx(owner,async db=>{await scope(db,id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[id])})
  const proposal=expect(await post('/agency-master/invite',primary,{address:staffAddress,mode:'add'},idempotency()),201)
  assert.equal(proposal.existing_active,true)
  assert.equal(proposal.invite_code,undefined)
  assert.equal(expect(await request('/session',{cookie:existing}),200).actor.role,'manager')
  expect(await request('/agency-master',{cookie:existing}),403)
  expect(await post('/agency-master/promote',primary,{pending:proposal.id,mode:'add'}),200)
  expect(await request('/session',{cookie:existing}),401)
  const promoted=await post('/auth/master/login',null,{tenant,email:staffAddress,password:pass,code:code(existingInvite.setup_key,1)})
  expect(promoted,200)
  assert.equal(expect(await request('/session',{cookie:promoted.cookie}),200).actor.role,'admin')
  expect(await request('/session',{cookie:primary}),200)
})


test('法人IDの大文字小文字を区別せず、法人IDの変更後も既存の法人・店舗・マスターを保持する',async()=>{
  const address='rename-master@example.test',old='old-rename-agency',next='YEEELL'
  const invite=await bootstrap(owner,cfg,{slug:old,name:'法人ID変更検証',email:address})
  const oldCookie=await activate(invite,address,old.toUpperCase(),'/auth/master/login')
  const prior=expect(await request('/session',{cookie:oldCookie}),200)
  const store=expect(await post('/stores',oldCookie,{name:'維持する店舗',address:'東京都',business_type:'検証',responsible:'担当',timezone:'Asia/Tokyo',cutoff:'06:00'},idempotency()),201)
  await tx(owner,async db=>{await scope(db,prior.tenant.id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[prior.tenant.id])})
  await assert.rejects(renameAgencyLoginId(owner,old,'BETA'))
  assert.equal((await renameAgencyLoginId(owner,old,next)).login_id,next)
  const current=expect(await request('/session',{cookie:oldCookie}),200)
  assert.equal(current.tenant.id,prior.tenant.id);assert.equal(current.tenant.slug,next)
  assert.ok(current.stores.some(s=>s.id===store.id))
  assert.equal(current.actor.id,prior.actor.id)
  expect(await post('/auth/master/login',null,{tenant:old,email:address,password:pass,code:code(invite.setup_key,1)}),401)
  const login=expect(await post('/auth/master/login',null,{tenant:next.toLowerCase(),email:address,password:pass,code:code(invite.setup_key,1)}),200)
  assert.ok(login)
  await assert.rejects(bootstrap(owner,cfg,{slug:'yeeell',name:'別法人',email:'other@example.test'}))
})


test('2名の個別招待リンクは独立し、両名が本人登録するまで旧マスター権限を維持する',async()=>{
  const tenant='pair-agency',address='pair-old@example.test',firstEmail='pair-first@example.test',secondEmail='pair-second@example.test'
  const invite=await bootstrap(owner,cfg,{slug:tenant,name:'2名引き継ぎ検証',email:address})
  const oldCookie=await activate(invite,address,tenant,'/auth/master/login')
  const prior=expect(await request('/session',{cookie:oldCookie}),200)
  const store=expect(await post('/stores',oldCookie,{name:'引継ぎ対象店舗',address:'東京都',business_type:'検証',responsible:'担当',timezone:'Asia/Tokyo',cutoff:'06:00'},idempotency()),201)
  await tx(owner,async db=>{await scope(db,prior.tenant.id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[prior.tenant.id])})
  expect(await post('/agency-master/pair/invite',staff,{addresses:[firstEmail,secondEmail]},idempotency()),403)
  expect(await post('/agency-master/pair/invite',oldCookie,{addresses:[firstEmail,firstEmail]},idempotency()),400)
  const pair=expect(await post('/agency-master/pair/invite',oldCookie,{addresses:[firstEmail,secondEmail]},idempotency()),201)
  assert.equal(pair.candidates.length,2);assert.notEqual(pair.candidates[0].url,pair.candidates[1].url)
  const [a,b]=pair.candidates.map(c=>new URL(c.url).hash.slice(1))
  const infoA=expect(await post('/auth/master/enrollment',null,{invite:a}),200)
  const infoB=expect(await post('/auth/master/enrollment',null,{invite:b}),200)
  assert.equal(infoA.email,firstEmail);assert.equal(infoB.email,secondEmail);assert.notEqual(infoA.setup_key,infoB.setup_key);assert.ok(infoA.qr.startsWith('data:image/png;base64,'))
  assert.equal(infoA.login_id,tenant)
  const enrollmentPage=await send('/master/enrollment/');assert.equal(enrollmentPage.status,200);assert.match(await enrollmentPage.text(),/エールのマスター登録/)
  expect(await post('/agency-master/pair/confirm',oldCookie,{id:pair.id}),409)
  expect(await post('/agency-master/invite',oldCookie,{address:'conflict@example.test',mode:'add'},idempotency()),409)
  expect(await post('/auth/activate',null,{invite:a,password:pass,code:await previousCode(infoA.setup_key)}),200)
  expect(await post('/auth/master/enrollment',null,{invite:a}),400)
  expect(await post('/auth/master/login',null,{tenant,email:firstEmail,password:pass,code:code(infoA.setup_key)}),401)
  expect(await request('/session',{cookie:oldCookie}),200)
  expect(await post('/agency-master/pair/confirm',oldCookie,{id:pair.id}),409)
  const renewed=expect(await post('/agency-master/pair/invite',oldCookie,{addresses:[firstEmail,secondEmail]},idempotency()),201)
  assert.equal(renewed.candidates[0].active,true);assert.equal(renewed.candidates[0].url,undefined);assert.notEqual(renewed.candidates[1].url,pair.candidates[1].url)
  expect(await post('/auth/master/enrollment',null,{invite:b}),400)
  const b2=new URL(renewed.candidates[1].url).hash.slice(1),updatedB=expect(await post('/auth/master/enrollment',null,{invite:b2}),200)
  expect(await post('/auth/activate',null,{invite:b2,password:pass,code:await previousCode(updatedB.setup_key)}),200)
  assert.equal(expect(await request('/agency-master',{cookie:oldCookie}),200).pair.candidates.every(c=>c.active),true)
  expect(await post('/agency-master/pair/confirm',oldCookie,{id:pair.id}),200)
  expect(await request('/session',{cookie:oldCookie}),401)
  for(const [email,key] of [[firstEmail,infoA.setup_key],[secondEmail,updatedB.setup_key]]){
    const auth=await post('/auth/master/login',null,{tenant:tenant.toUpperCase(),email,password:pass,code:code(key)})
    expect(auth,200)
    const current=expect(await request('/session',{cookie:auth.cookie}),200);assert.equal(current.tenant.id,prior.tenant.id);assert.ok(current.stores.some(s=>s.id===store.id));assert.equal(current.actor.platform,false)
    assert.equal(expect(await request('/agency-master',{cookie:auth.cookie}),200).masters.length,2)
  }
})

test('エールの新2名だけはパスワード認証で登録でき、北村さんと既存マスターのMFAは維持される',async()=>{
  const tenant='password-agency',email='previous@example.test',first='new-one@example.test',second='new-two@example.test'
  const old=await bootstrap(owner,cfg,{slug:tenant,name:'パスワード引継ぎ検証',email})
  const oldCookie=await activate(old,email,tenant,'/auth/master/login')
  const prior=expect(await request('/session',{cookie:oldCookie}),200)
  await tx(owner,async db=>{await scope(db,prior.tenant.id,undefined,true);await db.query('UPDATE tenant SET agency_operations_only=true WHERE id=$1',[prior.tenant.id])})
  assert.equal(expect(await post('/auth/master/login',null,{tenant,email,password:pass}),400).code,'MFA_REQUIRED')
  assert.equal(expect(await post('/auth/platform/login',null,{tenant:'lilu',email:'kitamura@example.test',password:pass}),400).code,'MFA_REQUIRED')
  const pair=expect(await post('/agency-master/pair/invite',oldCookie,{addresses:[first,second],mfa_required:false},idempotency()),201)
  assert.equal(pair.mfa_required,false)
  expect(await post('/agency-master/pair/invite',oldCookie,{addresses:[first,second],mfa_required:true},idempotency()),409)
  for(const c of pair.candidates){const token=new URL(c.url).hash.slice(1),info=expect(await post('/auth/master/enrollment',null,{invite:token}),200);assert.equal(info.mfa_required,false);assert.equal(info.setup_key,undefined);assert.equal(info.qr,undefined);assert.equal(info.email,c.email);expect(await post('/auth/activate',null,{invite:token,password:pass}),200);expect(await post('/auth/activate',null,{invite:token,password:pass}),400);expect(await post('/auth/master/login',null,{tenant,email:c.email,password:pass}),401)}
  expect(await request('/session',{cookie:oldCookie}),200)
  expect(await post('/agency-master/pair/confirm',oldCookie,{id:pair.id}),200)
  expect(await request('/session',{cookie:oldCookie}),401)
  for(const recipient of [first,second]){const auth=await post('/auth/master/login',null,{tenant:tenant.toUpperCase(),email:recipient,password:pass});expect(auth,200);const session=expect(await request('/session',{cookie:auth.cookie}),200);assert.equal(session.tenant.id,prior.tenant.id);assert.equal(session.actor.platform,false);assert.equal(expect(await request('/agency-master',{cookie:auth.cookie}),200).masters.length,2);expect(await post('/auth/platform/login',null,{tenant,email:recipient,password:pass}),401)}
  const reset=await prepareMasterPasswordReset(owner,cfg,{tenant,address:first}),recovery=new URL(reset.url).hash.slice(1)
  const password2='New-Demo-Password-123456';expect(await post('/auth/master/recovery',null,{recovery,password:password2}),200)
  expect(await post('/auth/master/login',null,{tenant,email:first,password:pass}),401)
  expect(await post('/auth/master/login',null,{tenant,email:first,password:password2}),200)
})
