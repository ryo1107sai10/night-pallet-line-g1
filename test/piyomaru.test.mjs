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
import { bootstrap, inviteSupervisor, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'
import {askPiyomaru,redactPiyomaru} from '../dist/piyomaru.js'
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
  dir = await mkdtemp(join(tmpdir(), 'night-piyomaru-'))
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

const piyo='/platform/piyomaru'
test('ピヨ丸は監督者本人専用、他法人・エールには設定・素材・質問を公開しない',async()=>{
  for(const cookie of [null,master,staff,plain]){
    expect(await request(piyo,{cookie}),401)
    expect(await post(piyo+'/ask',cookie,{question:'面談予約',request:randomUUID()}),401)
    const page=await send('/static/piyomaru-atlas.png',{headers:cookie?{Cookie:cookie}:{}})
    assert.equal(page.status,401)
  }
  const info=expect(await request(piyo,{cookie:platform}),200)
  assert.equal(info.key_saved,false)
  assert.equal(info.connected,false)
  assert.deepEqual(info.companies.map(c=>c.id),[alphaTenant])
  assert.equal(info.jobs.length,0)
  const pic=await send('/static/piyomaru-atlas.png',{headers:{Cookie:platform}})
  assert.equal(pic.status,200);assert.match(pic.headers.get('content-type'),/image\/png/)
  const free=expect(await post(piyo+'/ask',platform,{question:'LINEの設定は？',request:randomUUID()}),200)
  assert.equal(free.kind,'guide');assert.equal(free.usage_microusd,0);assert.match(free.answer,/Messaging API/)
})

test('仮想の2店舗で代行を再開・下書きを作成・他店を拒否する',async()=>{
  const otherTenant=expect(await request('/session',{cookie:plain}),200).tenant.id
  const payload=name=>({tenant:alphaTenant,new_store:{name,address:'東京都',business_type:'接客飲食',responsible:'検証担当者'},settings:{start:1080,end:1440,faqUrl:'https://example.test/faq',mapUrl:''}})
  expect(await post(piyo+'/jobs',platform,{...payload('越境店舗'),tenant:otherTenant},idempotency()),404)
  const key=idempotency()
  const job=expect(await post(piyo+'/jobs',platform,payload('ピヨ丸 検証店A'),key),201)
  assert.equal(job.features_ready,true);assert.equal(job.steps[0].done,true);assert.equal(job.publish_ready,false)
  assert.equal(job.hours.start,1080);assert.equal(job.hours.end,1440)
  assert.equal(expect(await post(piyo+'/jobs',platform,payload('ピヨ丸 検証店A'),key),201).id,job.id)
  const view=expect(await request(piyo+'/jobs/'+job.id,{cookie:platform}),200)
  assert.equal(view.id,job.id);assert.equal(view.selected_channel,null)
  expect(await post(piyo+'/jobs/'+job.id+'/action',platform,{action:'draft',confirm:true}),409)
  const store=new URL(job.links.store,origin).searchParams.get('store')
  const con=expect(await scoped(alphaTenant,'/stores/'+store+'/connections','POST',{
    label:'ピヨ丸 採用LINE',purpose:'recruitment',owner_name:'検証店舗',provider_id:'2000000010',
    messaging_id:messaging,account_type:'unverified',management_authority:'検証のみ',
    access_token:'local-test-token-for-piyo',channel_secret:'a'.repeat(32),token_type:'console',
  }),201)
  const refreshed=expect(await post(piyo+'/jobs/'+job.id+'/refresh',platform,{}),200)
  assert.equal(refreshed.selected_channel,con.id);assert.equal(refreshed.steps.find(s=>s.topic==='line').done,false)
  assert.match(refreshed.steps.find(s=>s.topic==='line').description,/接続情報は登録済み/)
  const draft=expect(await post(piyo+'/jobs/'+job.id+'/action',platform,{action:'draft',channel:con.id,confirm:true}),200)
  assert.equal(draft.steps.find(s=>s.topic==='draft').done,true)
  const intake=expect(await scoped(alphaTenant,'/stores/'+store+'/recruitment-intake/'+con.id),200)
  assert.equal(intake.active,false);assert.equal(intake.draft.faqUrl,'https://example.test/faq')
  // Editing the draft outside the assistant must never be overwritten by a retry.
  const edited=expect(await scoped(alphaTenant,'/stores/'+store+'/recruitment-intake','PUT',{channel:con.id,revision:intake.revision,settings:{...intake.draft,name:'名前をお願いします（編集済）'}}),200)
  expect(await post(piyo+'/jobs/'+job.id+'/action',platform,{action:'draft',channel:con.id,confirm:true}),200)
  assert.equal(expect(await scoped(alphaTenant,'/stores/'+store+'/recruitment-intake/'+con.id),200).revision,edited.revision)
  assert.equal(expect(await scoped(alphaTenant,'/stores/'+store+'/recruitment-intake/'+con.id),200).draft.name,'名前をお願いします（編集済）')
  expect(await post(piyo+'/jobs/'+job.id+'/action',platform,{action:'publish',channel:con.id,revision:edited.revision,confirm:true}),409)
  expect(await post(piyo+'/jobs/'+job.id+'/action',platform,{action:'confirm_test',confirm:true}),409)
  const second=expect(await post(piyo+'/jobs',platform,payload('ピヨ丸 検証店B'),idempotency()),201)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'select_channel',channel:con.id,confirm:true}),409)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'cancel',confirm:true}),200)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'prepare',confirm:true}),409)
  const end=expect(await request(piyo,{cookie:platform}),200)
  assert.equal(end.knowledge.find(x=>x.topic==='draft').verified_count,1)
  assert.equal(end.knowledge.find(x=>x.topic==='store').verified_count,2)
  assert.equal(end.jobs.length,2)
})

test('Muse API接続・使用量・重複課金防止・機密情報の除外・手順メモの蓄積',async()=>{
  const note='Webhook検証後は接続画面の確認状態を再読み込みする。'
  expect(await post(piyo+'/knowledge',platform,{topic:'line',note,confirmed:true}),201)
  expect(await post(piyo+'/knowledge',platform,{topic:'line',note:'連絡先 example@example.test',confirmed:true}),422)
  const key='LLM_1234567890123456_SYNTHETIC_TEST_KEY_ONLY'
  const setting=expect(await request(piyo+'/settings',{cookie:platform,method:'PUT',data:{key,budget_microusd:100000}}),200)
  assert.equal(setting.key_saved,true);assert.equal(setting.connected,false);assert.ok(!JSON.stringify(setting).includes(key))
  let calls=0
  const mock=async(url,options)=>{
    calls++
    assert.equal(url,'https://api.meta.ai/v1/chat/completions')
    assert.equal(options.headers.Authorization,'Bearer '+key)
    const body=JSON.parse(options.body)
    assert.equal(body.model,'muse-ember-1.0');assert.equal(body.store,false)
    assert.match(body.messages[0].content,/公式LINE連携・ステップ構築を進める/)
    assert.ok(JSON.stringify(body.messages).includes(note))
    assert.ok(!JSON.stringify(body).includes('sensitive@example.test'))
    assert.ok(!JSON.stringify(body).includes('987654'))
    assert.ok(!JSON.stringify(body).includes(key))
    return Response.json({choices:[{message:{content:'ピヨ丸だよ。LINE設定を確認してね。'}}],usage:{prompt_tokens:1000,completion_tokens:100}})
  }
  const credential=platform.split('=')[1]
  const question={question:'Webhook LINEの設定・sensitive@example.test・987654',mode:'normal',history:[],request:randomUUID()}
  const answer=await askPiyomaru(pool,cfg,credential,question,mock)
  assert.equal(answer.kind,'muse');assert.equal(answer.usage_microusd,150);assert.equal(answer.spent_microusd,150);assert.equal(calls,1)
  await assert.rejects(askPiyomaru(pool,cfg,credential,question,mock),e=>e.code==='PIYO_REQUEST_USED')
  assert.equal(calls,1)
  const info=expect(await request(piyo,{cookie:platform}),200)
  assert.equal(info.connected,true);assert.equal(info.spent_microusd,150);assert.ok(!JSON.stringify(info).includes(key))
  // Explicit free guide always works, including when an API key is saved.
  const guide=await askPiyomaru(pool,cfg,credential,{...question,mode:'guide',request:randomUUID()},mock)
  assert.equal(guide.kind,'guide');assert.equal(calls,1);assert.match(guide.answer,/再読み込み/)
  expect(await request(piyo+'/knowledge/'+info.notes[0].id,{cookie:platform,method:'DELETE',data:{}}),200)
  assert.equal(expect(await request(piyo,{cookie:platform}),200).notes.length,0)
  await assert.rejects(askPiyomaru(pool,cfg,credential,{...question,request:randomUUID()},async()=>new Response('{}',{status:401})),e=>e.code==='PIYO_MUSE_UNAVAILABLE')
  expect(await request(piyo+'/settings',{cookie:platform,method:'PUT',data:{budget_microusd:100000,remove:true}}),200)
  assert.equal(expect(await request(piyo,{cookie:platform}),200).key_saved,false)
  assert.ok(!redactPiyomaru(key).includes(key))
})
