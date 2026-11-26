import { previousCode } from './helpers/totp.mjs'
import assert from 'node:assert/strict'
import { createHmac,createHash,randomBytes, randomUUID } from 'node:crypto'
import { mkdir,mkdtemp, rm,writeFile } from 'node:fs/promises'
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
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'
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
let alphaTenant, successorCookie,healthStore,healthChannel,line,google,expectedWebhook='',mockGoogleFailure=false,mockLineFailure=false,pushCount=0

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
  const fixture=join(dir,'materials')
  await mkdir(fixture)
  await writeFile(join(fixture,'chapter-03.mp4'),Buffer.from('virtual-video-data'))
  await writeFile(join(fixture,'supervisor-guide.pdf'),Buffer.from('%PDF-1.4\nvirtual-pdf'))
  await writeFile(join(fixture,'supervisor-guide-p1.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]))
  const archive=Buffer.from('%PDF-1.4\noriginal-compiled-guide')
  await writeFile(join(fixture,'combined-guide-20261126.pdf'),archive)
  await writeFile(join(fixture,'combined-guide-20261126-p19.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]))
  const release=join(dir,'release-guide');await mkdir(release)
  const manual=Buffer.from('%PDF-1.4\nrelease-synced-manual')
  await writeFile(join(release,'operation-manual.pdf'),manual)
  await writeFile(join(release,'manifest.json'),JSON.stringify({version:'aabbccddeeff',updated_at:'2026-11-26T04:30:00Z',pages:2,sha256:createHash('sha256').update(manual).digest('hex')}))
  for(const i of [1,2])await writeFile(join(release,'operation-manual-p'+i+'.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]))
  process.env.PIYOMARU_RELEASE_DIRECTORY=release
  process.env.NPL_REQUIRE_RELEASE_MANUAL='1'
  process.env.PIYOMARU_MEDIA_DIRECTORY=fixture
  const fetchLine = async url => {
    const address = new URL(url)
    if (address.pathname === '/v2/oauth/verify') return Response.json({ client_id: messaging })
    if (address.pathname === '/v2/bot/info') return Response.json({ userId: bot })
    if(address.pathname==='/v2/bot/channel/webhook/endpoint')return Response.json({endpoint:expectedWebhook,active:!mockLineFailure})
    if(address.pathname==='/v2/bot/channel/webhook/test')return Response.json({success:true})
    if(address.pathname==='/v2/bot/message/push'){pushCount++;return Response.json({})}
    if(address.pathname==='/v2/bot/message/quota')return Response.json({type:'limited',value:1000})
    if(address.pathname==='/v2/bot/message/quota/consumption')return Response.json({totalUsage:0})
    throw new Error('Unexpected path ' + address.pathname)
  }
  line=new LineAPI(fetchLine)
  google=new InterviewGoogle(cfg,undefined,async(url,options)=>{
    if(url.includes('metadata.google.internal'))return Response.json({access_token:'mock-runtime'})
    if(url.includes('iamcredentials.googleapis.com'))return Response.json({accessToken:'mock-google',expireTime:new Date(Date.now()+900000).toISOString()})
    if(url.includes('/freeBusy')){
      if(mockGoogleFailure)return new Response('{}',{status:403})
      const {items}=JSON.parse(options.body)
      return Response.json({calendars:Object.fromEntries(items.map(({id})=>[id,{busy:[]}]))})
    }
    throw Error('Unexpected Google request')
  },[],'qa-calendar@example-test.iam.gserviceaccount.com')
  server = createApp(pool, cfg, line,google).listen(0, '127.0.0.1')
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
  delete process.env.PIYOMARU_RELEASE_DIRECTORY
  delete process.env.NPL_REQUIRE_RELEASE_MANUAL
  delete process.env.PIYOMARU_MEDIA_DIRECTORY
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
  assert.ok(free.related_materials.includes('chapter-03'))
})

test('動画・PDFは監督者だけ閲覧可能。シーク用の部分取得と不明な教材の拒否',async()=>{
  const info=expect(await request(piyo,{cookie:platform}),200)
  assert.equal(info.materials.length,16)
  const chapter=info.materials.find(m=>m.id==='chapter-03')
  const manual=info.materials.find(m=>m.id==='supervisor-guide')
  assert.equal(chapter.type,'video');assert.equal(manual.type,'pdf')
  for(const cookie of [null,master,staff,plain]){
    const headers=cookie?{Cookie:cookie}:{}
    assert.equal((await send(chapter.url,{headers:{...headers,Range:'bytes=0-3'}})).status,401)
    assert.equal((await send(manual.url,{headers})).status,401)
    assert.equal((await send(manual.url+'/page/1',{headers})).status,401)
    assert.equal((await send(chapter.url,{method:'HEAD',headers})).status,401)
  }
  const clip=await send(chapter.url,{headers:{Cookie:platform,Range:'bytes=0-6'}})
  assert.equal(clip.status,206);assert.equal(clip.headers.get('content-type'),'video/mp4')
  assert.match(clip.headers.get('content-range'),/^bytes 0-6\//)
  assert.match(clip.headers.get('cache-control'),/no-store/)
  assert.equal(await clip.text(),'virtual')
  const pdf=await send(manual.url,{headers:{Cookie:platform}})
  assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf')
  assert.match(await pdf.text(),/^%PDF-/)
  const image=await send(manual.url+'/page/1',{headers:{Cookie:platform}})
  assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from([0xff,0xd8,0xff,0xd9]))
  const download=await send(manual.url+'?download=1',{headers:{Cookie:platform}})
  assert.match(download.headers.get('content-disposition'),/^attachment;/)
  assert.equal((await send(manual.url+'/page/6',{headers:{Cookie:platform}})).status,404)
  assert.equal((await send('/platform/piyomaru/material/not-listed',{headers:{Cookie:platform}})).status,404)
  assert.equal((await send(chapter.url,{headers:{Cookie:platform,Range:'bytes=0-1,3-4'}})).status,416)
})

test('公開版と同期する総合マニュアルと原本保存版は監督者のみ・手動編集で古い版にならない',async()=>{
  const info=expect(await request(piyo,{cookie:platform}),200)
  const latest=info.materials[0],archive=info.materials.find(m=>m.id==='combined-guide-20261126')
  assert.equal(latest.id,'operation-manual');assert.equal(latest.managed,'release');assert.equal(latest.pages,2);assert.equal(latest.version,'aabbccddeeff')
  assert.equal(archive.managed,'archive');assert.equal(archive.pages,19)
  for(const cookie of [null,master,staff,plain])for(const m of [latest,archive]){
    const headers=cookie?{Cookie:cookie}:{}
    assert.equal((await send(m.url,{headers})).status,401)
    assert.equal((await send(m.url+'/page/1',{headers})).status,401)
  }
  const headers={Cookie:platform}
  const pdf=await send(latest.url+'?download=1',{headers});assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-disposition'),/^attachment;/);assert.match(await pdf.text(),/release-synced-manual/)
  const page=await send(latest.url+'/page/2',{headers});assert.equal(page.status,200);assert.equal(page.headers.get('content-type'),'image/jpeg')
  assert.equal((await send(latest.url+'/page/3',{headers})).status,404)
  const saved=await send(archive.url,{headers});assert.equal(saved.status,200);assert.match(await saved.text(),/original-compiled-guide/)
  assert.equal((await send(archive.url+'/page/19',{headers})).status,200)
  for(const m of [latest,archive]){
    expect(await post(piyo+'/library/draft',platform,{material:m.id,title:'旧版への差し替え',description:'テスト',instructions:''}),409)
    expect(await post(piyo+'/library/publish',platform,{material:m.id,revision:null,confirmed:true}),409)
    assert.deepEqual(expect(await request(piyo+'/library/'+m.id,{cookie:platform}),200),[])
    assert.equal((await send(m.url+'?revision='+randomUUID(),{headers})).status,404)
  }
  const answer=expect(await post(piyo+'/ask',platform,{question:'操作マニュアルはどこ？',mode:'guide',request:randomUUID()}),200)
  assert.ok(answer.related_materials.includes('operation-manual'))
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
  healthStore=store;healthChannel=con.id;expectedWebhook=origin+'/api/v1/webhooks/line/'+con.id
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
  const compact=payload('ピヨ丸 検証店B');compact.settings={...compact.settings,tone:'compact',reminder3h:false}
  const second=expect(await post(piyo+'/jobs',platform,compact,idempotency()),201)
  assert.equal(second.proposal.tone,'compact');assert.equal(second.proposal.settings.reminder3h,false);assert.match(second.proposal.settings.greeting,/採用窓口/)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'select_channel',channel:con.id,confirm:true}),409)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'cancel',confirm:true}),200)
  expect(await post(piyo+'/jobs/'+second.id+'/action',platform,{action:'prepare',confirm:true}),409)
  const end=expect(await request(piyo,{cookie:platform}),200)
  assert.equal(end.knowledge.find(x=>x.topic==='draft').verified_count,1)
  assert.equal(end.knowledge.find(x=>x.topic==='store').verified_count,2)
  assert.equal(end.jobs.length,2)
})

test('健康診断は監督者・現マスターのみ。現実の疎通を照合し、実機確認記録が設定変更で失効する',async()=>{
  const rows=expect(await request('/platform/store-health',{cookie:platform}),200)
  assert.ok(rows.some(r=>r.id===healthStore))
  assert.deepEqual(expect(await request('/store-health',{cookie:master}),200).map(r=>r.id),rows.map(r=>r.id))
  expect(await request('/store-health',{cookie:staff}),403)
  expect(await request('/store-health',{cookie:plain}),403)
  expect(await request('/platform/store-health',{cookie:master}),401)
  const other=expect(await request('/session',{cookie:plain}),200).tenant.id
  expect(await post('/platform/store-health/'+other+'/'+healthStore+'/probe',platform,{}),404)
  const prefix='/stores/'+healthStore+'/connections/'+healthChannel
  const summary=async()=>expect(await request('/stores/'+healthStore+'/connections',{cookie:master}),200).find(c=>c.id===healthChannel)
  expect(await post(prefix+'/check-token',master,{revision:(await summary()).revision}),200)
  expect(await post(prefix+'/check-webhook',master,{revision:(await summary()).revision}),200)
  const checks={ownership_verified:true,provider_verified:true,redelivery_enabled:true,auto_reply_checked:true,non_developer:true,delivery_confirmed:false,reason:'模擬LINE試験'}
  expect(await request(prefix+'/console',{cookie:master,method:'PATCH',data:{...checks,revision:(await summary()).revision}}),200)
  const tester=expect(await post(prefix+'/tests',master,{purpose:'recruitment'},idempotency()),201)
  const person='U'+'9'.repeat(32)
  async function inbound(type,message){
    const raw=JSON.stringify({destination:bot,events:[{webhookEventId:randomUUID(),type,timestamp:Date.now(),source:{type:'user',userId:person},...(message?{message:{id:randomUUID(),type:'text',text:message}}:{})}]})
    const r=await send('/api/v1/webhooks/line/'+healthChannel,{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':createHmac('sha256','a'.repeat(32)).update(raw).digest('base64')},body:raw})
    assert.equal(r.status,200)
  }
  await inbound('message','接続テスト '+tester.code);await inbound('follow')
  await workOnce(pool,cfg,line,google);await workOnce(pool,cfg,line,google)
  expect(await post(prefix+'/tests/'+tester.id+'/send',master,{},idempotency()),202)
  await workOnce(pool,cfg,line,google);await workOnce(pool,cfg,line,google)
  assert.equal(expect(await request(prefix+'/tests',{cookie:master}),200).find(t=>t.id===tester.id).send_status,'accepted')
  expect(await request(prefix+'/console',{cookie:master,method:'PATCH',data:{...checks,delivery_confirmed:true,revision:(await summary()).revision}}),200)
  const staffId=expect(await request('/session',{cookie:master}),200).actor.id
  // Synthetic configuration only; important fields use store-specific RLS rather than an all-store bypass.
  await tx(pool,async db=>{
    await scope(db,alphaTenant,healthStore)
    await db.query("UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,auto_enabled_at=now(),monthly_limit=1000 WHERE id=$1",[healthStore])
    await db.query("INSERT INTO interview_shared_calendar(store_id,tenant_id,calendar_id,linked_by) VALUES($1,$2,$3,$4)",[healthStore,alphaTenant,'virtualqa@group.calendar.google.com',staffId])
    await db.query("INSERT INTO interview_slot(id,tenant_id,store_id,channel_id,starts_at,ends_at,method,instructions,published) VALUES($1,$2,$3,$4,now()+interval '3 days',now()+interval '3 days 30 minutes','onsite','検証',true)",[randomUUID(),alphaTenant,healthStore,healthChannel])
  })
  const intake=expect(await scoped(alphaTenant,'/stores/'+healthStore+'/recruitment-intake/'+healthChannel),200)
  expect(await scoped(alphaTenant,'/stores/'+healthStore+'/recruitment-intake/action','POST',{channel:healthChannel,revision:intake.revision,action:'publish'}),200)
  const before=pushCount
  let health=expect(await post('/stores/'+healthStore+'/health/probe',master,{}),200)
  assert.equal(pushCount,before,'診断だけではLINEを送らない')
  for(const id of ['line','calendar','forms','steps','slots','automation'])assert.equal(health.checks.find(c=>c.id===id).state,'ready',JSON.stringify(health.checks))
  assert.equal(health.acceptance_ready,true);assert.equal(health.ready,false)
  const acceptance={fingerprint:health.fingerprint,received:true,application:true,booking:true,overlap:true,notification:true}
  health=expect(await post('/stores/'+healthStore+'/health/acceptance',master,acceptance),200)
  assert.equal(health.ready,true)
  mockGoogleFailure=true
  health=expect(await post('/stores/'+healthStore+'/health/probe',master,{}),200)
  assert.equal(health.checks.find(c=>c.id==='calendar').state,'action')
  assert.equal(health.ready,false);mockGoogleFailure=false
  await tx(pool,async db=>{await scope(db,alphaTenant,healthStore);await db.query('UPDATE store SET revision=revision+1 WHERE id=$1',[healthStore])})
  expect(await post('/stores/'+healthStore+'/health/acceptance',master,acceptance),409)
})

test('教材更新は下書き・部分アップロード・公開と旧版復帰を分離し、エールからは操作できない',async()=>{
  const metadata={material:'chapter-03',title:'更新した連携手順',description:'検証向け説明',instructions:'Webhook設定のあとに確認ボタンを押す。'}
  for(const cookie of [master,staff,plain,null]){
    expect(await post(piyo+'/library/draft',cookie,metadata),401)
    expect(await request(piyo+'/library/chapter-03',{cookie}),401)
  }
  const draft=expect(await post(piyo+'/library/draft',platform,metadata),201)
  assert.equal(draft.usable,true)
  assert.notEqual(expect(await request(piyo,{cookie:platform}),200).materials.find(m=>m.id==='chapter-03').title,metadata.title)
  expect(await post(piyo+'/library/publish',platform,{material:'chapter-03',revision:draft.id,confirmed:true}),200)
  assert.equal(expect(await request(piyo,{cookie:platform}),200).materials.find(m=>m.id==='chapter-03').title,metadata.title)
  const guide=expect(await post(piyo+'/ask',platform,{question:'LINE連携の手順は？',mode:'guide',request:randomUUID()}),200)
  assert.match(guide.answer,/確認ボタンを押す/)
  const bytes=Buffer.concat([Buffer.from([0,0,0,16]),Buffer.from('ftyp'),Buffer.from('virtual video only')])
  const uploaded=expect(await post(piyo+'/library/draft',platform,{...metadata,title:'新しい録画',file:{bytes:bytes.length,type:'video/mp4'}}),201)
  assert.equal(uploaded.usable,false)
  expect(await post(piyo+'/library/publish',platform,{material:'chapter-03',revision:uploaded.id,confirmed:true}),409)
  const upload=await send('/api/v1'+piyo+'/library/upload/'+uploaded.id+'?offset=0',{method:'PUT',headers:{Origin:origin,Cookie:platform,'Content-Type':'application/octet-stream'},body:bytes})
  assert.equal(upload.status,200);assert.equal((await upload.json()).usable,true)
  expect(await post(piyo+'/library/publish',platform,{material:'chapter-03',revision:uploaded.id,confirmed:true}),200)
  const media=await send('/platform/piyomaru/material/chapter-03',{headers:{Cookie:platform,Range:'bytes=4-7'}})
  assert.equal(media.status,206);assert.equal(await media.text(),'ftyp')
  assert.equal((await send('/platform/piyomaru/material/chapter-03?revision='+uploaded.id,{headers:{Cookie:master}})).status,401)
  expect(await post(piyo+'/library/publish',platform,{material:'chapter-03',revision:draft.id,confirmed:true}),200)
  expect(await post(piyo+'/library/publish',platform,{material:'chapter-03',revision:null,confirmed:true}),200)
  assert.equal(await (await send('/platform/piyomaru/material/chapter-03',{headers:{Cookie:platform}})).text(),'virtual-video-data')
  const bad=expect(await post(piyo+'/library/draft',platform,{...metadata,file:{bytes:16,type:'video/mp4'}}),201)
  assert.equal((await send('/api/v1'+piyo+'/library/upload/'+bad.id+'?offset=0',{method:'PUT',headers:{Origin:origin,Cookie:master,'Content-Type':'application/octet-stream'},body:Buffer.alloc(16)})).status,401)
  const wrong=await send('/api/v1'+piyo+'/library/upload/'+bad.id+'?offset=0',{method:'PUT',headers:{Origin:origin,Cookie:platform,'Content-Type':'application/octet-stream'},body:Buffer.alloc(16)})
  assert.equal(wrong.status,422)
})

test('60店舗追加・4並行の健康診断で店舗分離と一覧応答を検証する',async()=>{
  const other=expect(await request('/session',{cookie:plain}),200).tenant.id
  const before=expect(await request('/store-health',{cookie:master}),200).length
  await tx(owner,async db=>{
    await scope(db,alphaTenant,undefined,true)
    await db.query(`INSERT INTO store(id,tenant_id,name,address,business_type,responsible,timezone,cutoff)
      SELECT gen_random_uuid(),$1,'負荷検証店 '||n,'東京都','検証','担当者','Asia/Tokyo','06:00' FROM generate_series(1,60) n`,[alphaTenant])
    await scope(db,other,undefined,true)
    await db.query("INSERT INTO store(id,tenant_id,name,address,business_type,responsible,timezone,cutoff) VALUES($1,$2,'他法人のみ','東京都','検証','担当者','Asia/Tokyo','06:00')",[randomUUID(),other])
  })
  const measured=await Promise.all(Array.from({length:4},async(_,i)=>{
    const start=performance.now()
    const rows=expect(await request(i%2===0?'/store-health':'/platform/store-health',{cookie:i%2===0?master:platform}),200)
    assert.equal(rows.length,before+60);assert.ok(rows.every(r=>r.tenant===alphaTenant&&r.name!=='他法人のみ'))
    return performance.now()-start
  }))
  console.log('HEALTH_LOAD stores='+String(before+60)+' concurrent=4 ms='+measured.map(Math.round).join(','))
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
