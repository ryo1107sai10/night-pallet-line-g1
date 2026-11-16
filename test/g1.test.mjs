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
import { assertAppRole, digest, poolFor, scope, tx } from '../dist/core.js'
import { bootstrap, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'
import { starter } from '../public/studio/engine.mjs'

const origin = 'https://example.test'
const cfg = { origin, master:randomBytes(32), external:true, automation:true }
const bot = 'U'+'1'.repeat(32)
const user = 'U'+'2'.repeat(32)
const user2 = 'U'+'3'.repeat(32)
const channelSecret = 'a'.repeat(32)
const accessToken = 'test-channel-token'
const pass = 'Only used in local tests!'
const ids = { messaging:'1234567890', login:'1234567891' }
const endpoint = id => '/api/v1/webhooks/line/'+id
const signup = {}
let pg, owner, pool, server, dir, base, c, path, storeId, otherStore, admin, manager, other, line
let remainingQuota=200, intendedId, pushedBody, attemptedKeys=[], remoteCalls = [], releaseRemote, remoteEntered, nextPush = 'accepted'
let managerId, fakeBusy=[], fakeGoogleError=false, googleCalls=[]
const code = (key, steps = 0) => new TOTP({ secret:Secret.fromBase32(key) })
  .generate({timestamp:Date.now()+30000*steps})
const signed = raw => createHmac('sha256',channelSecret).update(raw).digest('base64')
const send = (url, options = {}) => fetch(base + url,{redirect:'error',...options})
const idempotency = () => ({ 'Idempotency-Key':randomUUID() })

async function request(path, { method='GET', data, cookie, headers={} } = {}) {
  const response = await send('/api/v1'+path,{ method,
    headers:{ Origin:origin, ...(data===undefined?{}:{'Content-Type':'application/json'}),
      ...(cookie?{Cookie:cookie}:{}),...headers },
    body:data===undefined?undefined:JSON.stringify(data),
  })
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}
}

function expect(result, status) {
  assert.equal(result.status,status,JSON.stringify(result.data))
  return result.data
}
function post(path,cookie,data,headers) { return request(path,{method:'POST',cookie,data,headers}) }
function patch(path,cookie,data) { return request(path,{method:'PATCH',cookie,data}) }
async function activate(invite, email, tenant) {
  expect(await post('/auth/activate',null,{ invite:invite.invite_code,password:pass,code:code(invite.setup_key,-1) }),200)
  const auth = await post('/auth/login',null,{tenant,email,password:pass,code:code(invite.setup_key)})
  expect(auth,200)
  assert.ok(auth.cookie)
  return auth.cookie
}
async function web(data, signature) {
  const raw = typeof data==='string'?data:JSON.stringify(data)
  return send(endpoint(c),{method:'POST',headers:{'Content-Type':'application/json',
    ...(signature===null?{}:{'X-Line-Signature':signature??signed(raw)})},body:raw})
}
const event = (id,type,timestamp) => ({webhookEventId:id,type,timestamp,source:{type:'user',userId:user}})
const storeData = name => ({ name,address:'東京都',business_type:'接客飲食',responsible:'担当者',
  timezone:'Asia/Tokyo',cutoff:'06:00' })
const read = (sql, values) => tx(pool,async db=>{await scope(db,signup.tenant,storeId);return db.query(sql,values)})

before(async ()=>{
  const probe = createServer().listen(0,'127.0.0.1')
  await new Promise(resolve=>probe.once('listening',resolve))
  const port = probe.address().port
  await new Promise(resolve=>probe.close(resolve))
  dir = await mkdtemp(join(tmpdir(),'night-g1-'))
  pg = new EmbeddedPostgres({ databaseDir:join(dir,'db'),user:'night_owner',password:'owner-test',
    port,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--locale=C','--encoding=UTF8'],
    postgresFlags:['-h','127.0.0.1','-c','unix_socket_directories='],onLog:()=>{} })
  await pg.initialise()
  await pg.start()
  owner = poolFor(`postgresql://night_owner:owner-test@127.0.0.1:${port}/postgres`)
  await owner.query("CREATE ROLE night_app LOGIN NOBYPASSRLS PASSWORD 'app-test'")
  pool = poolFor(`postgresql://night_app:app-test@127.0.0.1:${port}/postgres`)
  await migrate(owner,'night_app')
  await migrate(owner,'night_app')
  await assertAppRole(pool)
  const fetchLine = async (url, options) => {
    const address = new URL(url)
    assert.equal(address.origin,'https://api.line.me')
    remoteCalls.push(address.pathname)
    switch (address.pathname) {
      case '/v2/oauth/verify':
        assert.equal(options.body.get('access_token'),accessToken)
        return Response.json({client_id:ids.messaging})
      case '/v2/bot/info': return Response.json({userId:bot})
      case '/v2/bot/channel/webhook/endpoint':
        return Response.json({endpoint:origin+endpoint(c),active:true})
      case '/v2/bot/channel/webhook/test':
        assert.equal((await web({destination:bot,events:[]})).status,200)
        return Response.json({success:true})
      case '/oauth2/v2.1/verify':
        assert.equal(options.body.get('client_id'),ids.login)
        return Response.json({iss:'https://access.line.me',sub:options.body.get('id_token').includes('second')?user2:user,exp:Date.now()/1000+600,
          aud:options.body.get('id_token').includes('bad')?'9999999999':ids.login})
      case '/v2/bot/message/quota': return Response.json({type:'limited',value:200})
      case '/v2/bot/message/quota/consumption': return Response.json({totalUsage:200-remainingQuota})
      case '/v2/bot/message/push': {
        assert.ok([user,user2].includes(JSON.parse(options.body).to))
        pushedBody=JSON.parse(options.body).messages[0].text
        intendedId = options.headers['X-Line-Retry-Key']
        attemptedKeys.push(intendedId)
        remoteEntered?.()
        if (releaseRemote) await releaseRemote.result
        if (nextPush==='transient') return new Response('{}',{status:503})
        if (nextPush==='duplicate') return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'line-id'}})
        return new Response('{}',{status:200,headers:{'x-line-request-id':'line-id'}})
      }
      default: throw Error('Unexpected path ' + address.pathname)
    }
  }
  line = new LineAPI(fetchLine)
  const google=new InterviewGoogle(cfg,{clientId:'calendar-client',secret:'calendar-server-secret'},async(url,options)=>{
    if(url==='https://oauth2.googleapis.com/token'){
      const grant=options.body.get('grant_type')
      assert.equal(options.body.get('client_secret'),'calendar-server-secret')
      if(grant==='authorization_code') {
        assert.match(options.body.get('code_verifier'),/^[A-Za-z0-9_-]{43}$/)
        assert.equal(options.body.get('redirect_uri'),origin+'/interview/google-return.html')
      } else assert.equal(options.body.get('refresh_token'),'calendar-refresh-secret')
      return Response.json({access_token:'calendar-access-secret',refresh_token:'calendar-refresh-secret',expires_in:3600})
    }
    assert.equal(url,'https://www.googleapis.com/calendar/v3/freeBusy')
    assert.equal(options.headers.Authorization,'Bearer calendar-access-secret')
    const query=JSON.parse(options.body)
    assert.deepEqual(query.items,[{id:'primary'}])
    googleCalls.push(query)
    return Response.json({calendars:{'example@example.test':fakeGoogleError?
      {errors:[{reason:'internalError'}]}:{busy:fakeBusy}}})
  })
  server = createApp(pool,cfg,line,google).listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  base = 'http://127.0.0.1:'+server.address().port
})

after(async ()=>{
  if (server) await new Promise(resolve=>server.close(resolve))
  await Promise.allSettled([pool?.end(),owner?.end()])
  if (pg) await pg.stop()
  if (dir) await rm(dir,{recursive:true,force:true})
})

test('AT03 MFA, 招待失効・再利用・CSRF拒否',async ()=>{
  const invite = await bootstrap(owner,cfg,{slug:'alpha',name:'甲法人',email:'chief@example.test'})
  const expired = await bootstrap(owner,cfg,{slug:'beta',name:'乙法人',email:'chief@example.test'})
  await owner.query('UPDATE invite SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',[digest(expired.invite_code)])
  expect(await post('/auth/activate',null,{invite:expired.invite_code,password:pass,code:code(expired.setup_key)}),400)
  expect(await post('/auth/activate',null,{invite:invite.invite_code,password:pass,code:code(invite.setup_key,-1)},
    {Origin:'https://elsewhere.test'}),403)
  admin = await activate(invite,'chief@example.test','alpha')
  expect(await post('/auth/activate',null,{invite:invite.invite_code,password:pass,code:code(invite.setup_key,1)}),400)
  expect(await post('/auth/login',null,{tenant:'alpha',email:'chief@example.test',password:pass,code:code(invite.setup_key)}),401)
  expect(await post('/auth/login',null,{tenant:'alpha',email:'chief@example.test',password:pass}),400)
  expect(await post('/auth/login',null,{tenant:'alpha',email:'chief@example.test',password:'incorrect',code:code(invite.setup_key,1)}),401)
  const state = expect(await request('/session',{cookie:admin}),200)
  signup.tenant = state.tenant.id
  assert.equal(state.tenant.legal_name,'甲法人')
  const fresh = await bootstrap(owner,cfg,{slug:'gamma',name:'丙法人',email:'chief@example.test'})
  other = await activate(fresh,'chief@example.test','gamma')
})

test('AT02 同一法人の許可店舗・別法人・DB行レベル分離、店舗作成の再試行',async ()=>{
  const a = idempotency()
  storeId = expect(await post('/stores',admin,storeData('青店'),a),201).id
  assert.equal(expect(await post('/stores',admin,storeData('青店'),a),201).id,storeId)
  expect(await post('/stores',admin,storeData('別の値'),a),409)
  otherStore = expect(await post('/stores',admin,storeData('赤店'),idempotency()),201).id
  const otherId = expect(await post('/stores',other,storeData('金店'),idempotency()),201).id
  const email = 'manager@example.test'
  const old = expect(await post('/staff/invites',admin,{email,role:'manager',stores:[otherStore]},idempotency()),201)
  const inv = expect(await post('/staff/invites',admin,{email,role:'manager',stores:[storeId]},idempotency()),201)
  assert.equal(old.id,inv.id)
  expect(await post('/auth/activate',null,{invite:old.invite_code,password:pass,code:code(old.setup_key)}),400)
  managerId = inv.id
  manager = await activate(inv,email,'alpha')
  assert.deepEqual(expect(await request('/session',{cookie:manager}),200).stores.map(s=>s.id),[storeId])
  expect(await request('/stores/'+otherStore+'/connections',{cookie:manager}),404)
  expect(await request('/stores/'+otherId+'/connections',{cookie:admin}),404)
  expect(await request('/stores/'+storeId+'/connections',{cookie:other}),404)
  expect(await post('/staff/invites',admin,{email:'across@example.test',role:'sales',stores:[otherId]},idempotency()),404)
  assert.equal((await pool.query('SELECT id FROM store')).rowCount,0)
  assert.deepEqual((await read('SELECT id FROM store')).rows,[{id:storeId}])
  await assert.rejects(assertAppRole(owner))
})

test('AT01/04 接続台帳とWebhookの署名・destination・再送',async ()=>{
  const data = {label:'接続検証',purpose:'shared',owner_name:'甲法人',provider_id:'provider',
    messaging_id:ids.messaging,login_id:ids.login,liff_id:ids.login+'-test',bot_user_id:bot,
    account_type:'unverified',management_authority:'管理者確認',channel_secret:channelSecret,
    access_token:accessToken,token_type:'console'}
  const prefix = '/stores/'+storeId+'/connections'
  c = expect(await post(prefix,manager,data,idempotency()),201).id
  path = prefix+'/'+c
  expect(await post('/stores/'+otherStore+'/connections',admin,data,idempotency()),409)
  const result = expect(await request(prefix,{cookie:manager}),200)[0]
  assert.equal(result.status,'pending')
  assert.doesNotMatch(JSON.stringify(result),new RegExp(channelSecret+'|'+accessToken+'|credentials'))
  assert.notEqual((await read('SELECT credentials FROM channel')).rows[0].credentials,channelSecret)
  const valid = {destination:bot,events:[]}
  const original = JSON.stringify(valid)
  assert.equal((await web(valid,null)).status,401)
  assert.equal((await web(original+' ',signed(original))).status,401)
  assert.equal((await web({destination:user,events:[]})).status,401)
  assert.equal((await web(valid)).status,200)
  const now = Date.now()
  const payload = {destination:bot,events:[event('block','unfollow',now),event('old','follow',now-100)]}
  assert.equal((await web(payload)).status,200)
  assert.equal((await web(payload)).status,200)
  await workOnce(pool,cfg,line)
  assert.deepEqual((await read('SELECT following FROM channel_relationship')).rows,[{following:false}])
  assert.equal((await read('SELECT event_id FROM webhook_event')).rowCount,2)
  assert.equal((await read('SELECT id FROM customer')).rowCount,0,'兼用OAの友だち追加で顧客に用途を推定しない')
  expect(await request('/stores/'+otherStore+'/connections/'+c+'/tests',{cookie:admin}),404)
})

const consoleChecks = {
  ownership_verified:true,provider_verified:true,redelivery_enabled:true,auto_reply_checked:true,
  login_published:true,non_developer:true,delivery_confirmed:false,
}
const getChannel = async () => expect(await request(path.slice(0,path.lastIndexOf('/')),{cookie:admin}),200)[0]
async function prepareTester(usage='recruitment') {
  const invite = expect(await post(path+'/tests',admin,{purpose:usage},idempotency()),201)
  const proof = {connection:c,purpose:usage,code:invite.code,id_token:'signed-token-from-line-platform',allow_test_message:true}
  expect(await post('/auth/line/verify',null,{...proof,purpose:usage==='customer'?'recruitment':'customer'}),401)
  expect(await post('/auth/line/verify',null,{...proof,id_token:'signed-token-with-bad-audience'}),401)
  expect(await post('/auth/line/verify',null,proof),200)
  expect(await post('/auth/line/verify',null,proof),401)
  assert.equal((await web({destination:bot,events:[event(randomUUID(),'follow',Date.now())]})).status,200)
  await workOnce(pool,cfg,line)
  return invite
}

test('AT01/05/06 LIFF用途の固定、兼用OAの隔離、受付と実機確認の区別',async ()=>{
  expect(await patch(path+'/console',admin,{...consoleChecks,reason:'公式管理画面で照合',revision:(await getChannel()).revision}),200)
  expect(await post(path+'/check-token',admin,{revision:(await getChannel()).revision}),200)
  expect(await post(path+'/check-webhook',admin,{revision:(await getChannel()).revision}),200)
  const salesEmail = 'sales@example.test'
  const salesInvite = expect(await post('/staff/invites',admin,{email:salesEmail,role:'sales',stores:[storeId]},idempotency()),201)
  const sales = await activate(salesInvite,salesEmail,'alpha')
  expect(await request(path+'/tests',{cookie:sales}),403)
  expect(await request('/stores/'+storeId+'/audit',{cookie:sales}),403)
  const tester = await prepareTester()
  assert.equal((await read("SELECT purpose FROM webhook_event WHERE kind='follow' LIMIT 1")).rows[0].purpose,'unclassified')
  const sendPath = path+'/tests/'+tester.id+'/send'
  const job = expect(await post(sendPath,admin,{},idempotency()),202)
  assert.equal(expect(await post(sendPath,admin,{},idempotency()),202).id,job.id)
  nextPush = 'transient'
  await workOnce(pool,cfg,line)
  assert.equal(intendedId,job.id)
  assert.equal((await read('SELECT status FROM test_send WHERE id=$1',[job.id])).rows[0].status,'unknown')
  await read('UPDATE test_send SET next_at=now() WHERE id=$1',[job.id])
  nextPush = 'duplicate'
  await workOnce(pool,cfg,line)
  assert.equal(intendedId,job.id)
  assert.equal((await getChannel()).status,'pending')
  assert.equal((await getChannel()).checks.send_accepted,true)
  const confirmation = expect(await patch(path+'/console',admin,{...consoleChecks,delivery_confirmed:true,
    reason:'検証端末に受信を確認',revision:(await getChannel()).revision}),200)
  assert.equal(confirmation.status,'connected')
})

test('AT07 停止時は未開始を取消、提出中を記録し、再開後も旧ジョブを送らない',async ()=>{
  const one = await prepareTester('customer')
  const two = await prepareTester('customer')
  const first = expect(await post(path+'/tests/'+one.id+'/send',admin,{},idempotency()),202).id
  const second = expect(await post(path+'/tests/'+two.id+'/send',admin,{},idempotency()),202).id
  const entered = new Promise(resolve=>{remoteEntered=resolve})
  let release
  releaseRemote = {result:new Promise(resolve=>{release=resolve})}
  nextPush = 'accepted'
  const running = workOnce(pool,cfg,line)
  try {
    await Promise.race([entered, running.then(()=>assert.fail('submission did not start'))])
    assert.equal(intendedId,first)
    const stopped = expect(await patch('/tenant/stop',admin,{revision:1,stopped:true,reason:'停止試験'}),200)
    assert.equal(stopped.in_flight,1)
    assert.equal(stopped.cancelled,1)
    expect(await post(path+'/tests/'+two.id+'/send',admin,{},idempotency()),409)
    assert.equal((await read('SELECT status FROM test_send WHERE id=$1',[second])).rows[0].status,'cancelled')
    expect(await patch('/tenant/stop',admin,{revision:stopped.revision,stopped:false,reason:'再開試験'}),200)
  } finally { release(); await running; releaseRemote = undefined; remoteEntered = undefined }
  const count = remoteCalls.filter(path=>path.endsWith('/push')).length
  await workOnce(pool,cfg,line)
  assert.equal(remoteCalls.filter(path=>path.endsWith('/push')).length,count)
})

test('AT03 退職後の既存セッション失効',async ()=>{
  expect(await request('/session',{cookie:manager}),200)
  expect(await post('/staff/'+managerId+'/disable',admin,{reason:'退職確認'}),200)
  expect(await request('/session',{cookie:manager}),401)
  assert.equal((await read('SELECT 1 FROM staff_session WHERE staff_id=$1',[managerId])).rowCount,0)
})


test('AT02/27/28 シナリオの公開版は不変で、店舗外と古い版を拒否する',async ()=>{
  const base='/stores/'+storeId+'/scenarios'
  const graph=starter()
  graph.channel=c
  expect(await post('/stores/'+otherStore+'/scenarios',admin,graph,idempotency()),404)
  const key=idempotency()
  const first=expect(await post(base,admin,graph,key),201)
  assert.equal(expect(await post(base,admin,graph,key),201).id,first.id)
  const url=base+'/'+first.id
  expect(await request(url,{cookie:other}),404)
  expect(await request('/stores/'+otherStore+'/scenarios/'+first.id,{cookie:admin}),404)
  expect(await post(url+'/transition',admin,{action:'test',revision:first.revision},undefined),422)
  const fixture={start:'2026-11-14T12:00',bookingAt:'',dayCount:0,weekCount:0,booked:false,consent:true,adult:true,
    responded:false,assigned:true,stopped:false,marketingStopped:false,blocked:false,human:false,cancelled:false,
    bookingLinkValid:true,tags:[],values:{name:'検証',store:'青店',staff:'',booking:'',price:'',booking_url:''}}
  const tested=expect(await post(url+'/transition',admin,{action:'test',revision:first.revision,fixture}),200)
  const approved=expect(await post(url+'/transition',admin,{action:'approve',revision:tested.revision}),200)
  const published=expect(await post(url+'/transition',admin,{action:'publish',revision:approved.revision}),200)
  expect(await patch(url,admin,{revision:approved.revision,graph}),409)
  const draft=expect(await patch(url,admin,{revision:published.revision,graph:{...graph,name:'新しい下書き'}}),200)
  assert.equal(draft.state,'draft')
  assert.equal(draft.published_version,1)
  const version=expect(await request(url+'/versions/1',{cookie:admin}),200)
  assert.equal(version.graph.name,graph.name)
})


test('AT34 適合するテスト利用者にだけ差し込み済み本文を1通送る',async ()=>{
  const base='/stores/'+storeId+'/scenarios'
  const graph=starter()
  graph.channel=c
  const scenario=expect(await post(base,admin,graph,idempotency()),201)
  const path=base+'/'+scenario.id
  const wrongPurpose=await prepareTester('recruitment')
  const verified=await prepareTester('customer')
  const candidates=expect(await request(path+'/testers',{cookie:admin}),200)
  assert.ok(!candidates.some(item=>item.id===wrongPurpose.id))
  assert.ok(candidates.some(item=>item.id===verified.id))
  const fixture={start:'2026-11-14T12:00',bookingAt:'',dayCount:0,weekCount:0,booked:false,consent:true,adult:true,
    responded:false,assigned:true,stopped:false,marketingStopped:false,blocked:false,human:false,cancelled:false,
    bookingLinkValid:true,tags:[],values:{name:'テスト利用者',store:'青店',staff:'',booking:'',price:'',booking_url:''}}
  const input={revision:scenario.revision,node:'welcome',tester:verified.id,fixture}
  expect(await post(path+'/test-sends',admin,{...input,tester:wrongPurpose.id},idempotency()),404)
  expect(await post(path+'/test-sends',admin,{...input,fixture:{...fixture,stopped:true}},idempotency()),422)
  const key=idempotency()
  const accepted=expect(await post(path+'/test-sends',admin,input,key),202)
  assert.equal(expect(await post(path+'/test-sends',admin,input,key),202).id,accepted.id)
  expect(await post(path+'/test-sends',admin,input,idempotency()),404)
  await workOnce(pool,cfg,line)
  assert.equal(intendedId,accepted.id)
  assert.match(pushedBody,/^【接続テスト】\nテスト利用者さん/)
  assert.equal(expect(await request(path+'/test-sends',{cookie:admin}),200)[0].status,'accepted')
})

async function publish(flow) {
  const root='/stores/'+storeId+'/scenarios'
  const start=expect(await post(root,admin,flow,idempotency()),201)
  const url=root+'/'+start.id+'/transition'
  const fixture={start:'2026-11-14T12:00',bookingAt:'',dayCount:0,weekCount:0,booked:true,consent:true,adult:true,
    responded:false,assigned:true,stopped:false,marketingStopped:false,blocked:false,human:false,cancelled:false,
    bookingLinkValid:true,tags:[],values:{name:'テスト利用者',store:'青店',staff:'',booking:'11月18日 22:00',
      price:'',booking_url:'https://example.test/booking'}}
  const next=expect(await post(url,admin,{revision:start.revision,action:'test',fixture}),200)
  const approved=expect(await post(url,admin,{revision:next.revision,action:'approve'}),200)
  return expect(await post(url,admin,{revision:approved.revision,action:'publish'}),200)
}
async function terminal(cookie,consent=true) {
  const account=expect(await request('/customer/account',{cookie}),200)
  expect(await patch('/customer/preferences',cookie,{revision:account.revision,version:account.policy_version,
    preferences:{service_consent:consent,marketing_consent:false,all_stop:!consent}}),200)
}
const flushWorker=async (iterations=3)=>{
  for(let i=0;i<iterations;i++) await workOnce(pool,cfg,line)
}

test('CRM-01/BOOK-02–05 署名付きLINE・本人同意・予約競合とLINE自動送信を通しで確認',async ()=>{
  const root='/stores/'+storeId
  const flow=starter()
  Object.assign(flow,{name:'予約確定通知',channel:c,trigger:'booking_created',entry:'update',nodes:[
    {id:'update',type:'message',name:'確定のお知らせ',category:'service',body:'{{store}}で{{booking}}のご予約が確定しました。',next:'wait'},
    {id:'wait',type:'wait',name:'予約1時間前まで待機',mode:'booking',minutes:60,next:'remind'},
    {id:'remind',type:'message',name:'来店リマインド',category:'service',body:'ご来店のご案内 {{booking}}',next:'end'},
    {id:'end',type:'end',name:'完了'},
  ]})
  const confirmed=await publish(flow)
  const current=expect(await request('/session',{cookie:admin}),200).stores[0]
  expect(await patch(root+'/automation',admin,{revision:current.revision,enabled:true,contract:true,monthly_limit:25,reason:'検証承認'}),409)
  const eligible=expect(await patch(root+'/eligibility',admin,{revision:current.revision,verified:true,reference:'検証済み'}),200)
  expect(await patch(root+'/automation',admin,{revision:eligible.revision,enabled:true,contract:true,monthly_limit:25,reason:'検証承認'}),200)
  const original=await post('/customer/login',null,{connection:c,id_token:'signed-token-first-user'})
  const second=await post('/customer/login',null,{connection:c,id_token:'signed-token-second-user'})
  expect(original,200);expect(second,200)
  const created=await request(root+'/customers',{cookie:admin})
  const people=expect(created,200)
  assert.equal(people.length,2)
  assert.ok(people.every(person=>!person.service_consent&&!person.marketing_consent))
  assert.doesNotMatch(JSON.stringify(people),/line_address|user_key/)
  expect(await request(root+'/customers',{cookie:other}),404)
  const now=Date.now()
  assert.equal((await web({destination:bot,events:[{...event('friend-second','follow',now),
    source:{type:'user',userId:user2}}]})).status,200)
  await flushWorker()
  const tomorrow=now+2*86400000
  const makeSlot=(name,at)=>({label:name,starts_at:new Date(at).toISOString(),ends_at:new Date(at+3600000).toISOString(),capacity:2,published:true})
  const a=expect(await post(root+'/slots',admin,makeSlot('夜の部',tomorrow),idempotency()),201).id
  expect(await post(root+'/slots',admin,makeSlot('重複',tomorrow+900000),idempotency()),409)
  const b=expect(await post(root+'/slots',admin,makeSlot('翌日',tomorrow+86400000),idempotency()),201).id
  await terminal(original.cookie);await terminal(second.cookie)
  const first=expect(await post('/customer/bookings',original.cookie,{slot:a,party:2}),201)
  const rival=expect(await post('/customer/bookings',second.cookie,{slot:a,party:2}),201)
  assert.equal(first.status,'pending')
  expect(await patch('/customer/bookings/'+first.id,second.cookie,{revision:1,slot:a,party:2,status:'cancelled'}),404)
  const pushes=()=>remoteCalls.filter(path=>path.endsWith('/push')).length
  const before=pushes()
  await flushWorker()
  assert.equal(pushes(),before)
  const confirmedChange={revision:1,slot:a,party:2,status:'confirmed',reason:'店舗が確認'}
  const race=await Promise.all([
    patch(root+'/bookings/'+first.id,admin,confirmedChange),patch(root+'/bookings/'+rival.id,admin,confirmedChange),
  ])
  assert.deepEqual(race.map(result=>result.status).sort(),[200,409])
  const winner=race[0].status===200?first:rival
  const winnerCookie=race[0].status===200?original.cookie:second.cookie
  nextPush='accepted'
  await flushWorker()
  assert.equal(pushes(),before+1)
  assert.match(pushedBody,/青店で.*のご予約が確定しました。/)
  const schedule=(await read('SELECT booking_id,wait_node,due_at,version FROM enrollment WHERE scenario_id=$1',[confirmed.id])).rows
  assert.deepEqual(schedule.map(value=>[value.booking_id,value.wait_node,+value.due_at,value.version]),
    [[winner.id,'wait',tomorrow-3600000,1]])
  const requestChange=expect(await patch('/customer/bookings/'+winner.id,winnerCookie,{revision:2,slot:b,party:2,status:'pending'}),200)
  expect(await patch(root+'/bookings/'+winner.id,admin,confirmedChange),409)
  const changed=expect(await patch(root+'/bookings/'+winner.id,admin,{revision:requestChange.revision,slot:b,party:2,
    status:'confirmed',reason:'日時変更を確認'}),200)
  assert.equal(changed.revision,4)
  const eventLog=(await read('SELECT kind FROM delivery_event WHERE booking_id=$1 ORDER BY booking_revision',[winner.id])).rows
  assert.deepEqual(eventLog.map(row=>row.kind),['booking_created','booking_changed'])
  assert.match((await read('SELECT end_reason FROM enrollment WHERE scenario_id=$1',[confirmed.id])).rows[0].end_reason,/旧版/)
  assert.equal(pushes(),before+1)
  const history=expect(await request(root+'/automation',{cookie:admin}),200)
  assert.ok(history.jobs.some(job=>job.status==='accepted'&&job.line_request_id==='line-id'))
  expect(await patch('/customer/bookings/'+winner.id,winnerCookie,{revision:changed.revision,slot:b,party:2,status:'cancelled'}),200)
  assert.equal(expect(await request(root+'/slots',{cookie:admin}),200).find(slot=>slot.id===b).remaining,2)
})

test('AT25/29/48 自動配信の同一開始防止、即時撤回、LINE枠不足、同一キーでの再試行',async ()=>{
  const root='/stores/'+storeId
  const graph=starter()
  Object.assign(graph,{name:'手動案内',channel:c,trigger:'manual',entry:'single',rejoin:true,
    nodes:[{id:'single',type:'message',name:'案内',category:'service',body:'{{store}}からの案内です。',next:'end'},
      {id:'end',type:'end',name:'完了'}]})
  const flow=await publish(graph)
  const first=await post('/customer/login',null,{connection:c,id_token:'signed-token-first-user'})
  const second=await post('/customer/login',null,{connection:c,id_token:'signed-token-second-user'})
  await terminal(first.cookie);await terminal(second.cookie)
  // One person withdraws after a signed LINE stop message, independent of delivery-event processing order.
  const stopPayload={destination:bot,events:[{...event('stop-automatic','message',Date.now()),message:{type:'text',text:'全配信停止'}}]}
  for(let i=0;i<2;i++) assert.equal((await web(stopPayload)).status,200)
  const previousPushes=remoteCalls.filter(path=>path.endsWith('/push')).length
  await flushWorker()
  const stopped=expect(await request('/customer/account',{cookie:first.cookie}),200)
  assert.equal(stopped.all_stop,true)
  const key=idempotency()
  const {rows:[withdrawn]}=await read('SELECT id FROM customer WHERE all_stop')
  const {rows:[active]}=await read('SELECT id FROM customer WHERE service_consent AND NOT all_stop')
  for(let i=0;i<2;i++)expect(await post(root+'/customers/'+withdrawn.id+'/enroll',admin,{reason:'登録試験'},key),202)
  assert.equal((await read("SELECT count(*)::int AS count FROM delivery_event WHERE kind='manual'")).rows[0].count,1)
  expect(await post(root+'/customers/'+active.id+'/enroll',admin,{reason:'配信上限の確認'},idempotency()),202)
  remainingQuota=0
  await flushWorker()
  const calls=()=>remoteCalls.filter(path=>path.endsWith('/push')).length
  assert.equal(calls(),previousPushes)
  assert.match((await read(`SELECT reason FROM automatic_send WHERE status='cancelled' ORDER BY first_attempt_at DESC LIMIT 1`)).rows[0].reason,/LINEの月間通数/)
  const otherScenario=await publish({...graph,name:'再送試験'})
  expect(await post(root+'/customers/'+active.id+'/enroll',admin,{reason:'再送確認'},idempotency()),202)
  remainingQuota=200
  nextPush='transient'
  await flushWorker(1)
  const {rows:[ambiguous]}=await read(`SELECT s.id,s.status FROM automatic_send s
    JOIN enrollment e ON e.id=s.enrollment_id WHERE e.scenario_id=$1 AND s.status='unknown'`,[otherScenario.id])
  assert.ok(ambiguous)
  const retryKey=ambiguous.id
  await read('UPDATE automatic_send SET next_at=now() WHERE id=$1',[ambiguous.id])
  nextPush='duplicate'
  await flushWorker()
  assert.equal(attemptedKeys.filter(key=>key===retryKey).length,2)
  assert.equal((await read('SELECT status FROM automatic_send WHERE id=$1',[ambiguous.id])).rows[0].status,'accepted')
  assert.ok(flow.id)
})

test('面談カレンダー: 採用権限、枠の取り合い、本人の日程変更と取消', async ()=>{
  const root='/stores/'+storeId+'/interviews'
  const login=(token,cookie)=>post('/interview/login',cookie,{connection:c,id_token:token})
  expect(await request('/interview/calendar'),401)
  expect(await request(root,{cookie:other}),404)
  const invitation=expect(await post('/staff/invites',admin,{email:'recruiter@example.test',role:'recruiter',stores:[storeId]},idempotency()),201)
  const recruiter=await activate(invitation,'recruiter@example.test','alpha')
  expect(await request('/stores/'+otherStore+'/interviews',{cookie:recruiter}),404)
  const a=await login('signed-token-first-user')
  const b=await login('signed-token-second-user')
  expect(a,200);expect(b,200)
  const empty=expect(await request('/interview/calendar',{cookie:a.cookie}),200)
  assert.deepEqual(empty.hours,{start:1080,end:1440,revision:1})
  const tomorrow=Date.parse(empty.today+'T00:00:00+09:00')+86400000
  const first=new Date(tomorrow+21*3600000)
  const create=(start,published,method='onsite')=>post(root+'/slots',recruiter,{
    channel:c,starts_at:start.toISOString(),ends_at:new Date(+start+30*60000).toISOString(),
    method,instructions:'確定者専用の参加方法',published,
  },idempotency())
  expect(await create(new Date(tomorrow+17.5*3600000),true),422)
  expect(await create(new Date(tomorrow+18.25*3600000),true),422)
  const midnight=expect(await create(new Date(tomorrow+23.5*3600000),true),201)
  const one=expect(await create(first,true),201)
  expect(await create(first,true),409)
  const next=expect(await create(new Date(+first+3600000),true,'online'),201)
  const hidden=expect(await create(new Date(+first+2*3600000),false),201)
  const published=expect(await request('/interview/calendar',{cookie:a.cookie}),200)
  assert.deepEqual(published.slots.map(slot=>slot.id),[one.id,next.id,midnight.id])
  assert.doesNotMatch(JSON.stringify(published),/確定者専用/)
  expect(await request('/interview/calendar?start=2026-02-30',{cookie:a.cookie}),422)
  expect(await post('/interview/bookings',a.cookie,{slot:hidden.id,name:'応募者A'}),409)
  const races=await Promise.all([
    post('/interview/bookings',a.cookie,{slot:one.id,name:'応募者A'}),
    post('/interview/bookings',b.cookie,{slot:one.id,name:'応募者B'}),
  ])
  assert.deepEqual(races.map(result=>result.status).sort(),[201,409])
  const winner=races[0].status===201?a.cookie:b.cookie
  const loser=races[0].status===201?b.cookie:a.cookie
  const booking=races.find(result=>result.status===201).data
  assert.equal(booking.instructions,'確定者専用の参加方法')
  assert.equal(expect(await request('/interview/calendar',{cookie:loser}),200).slots[0].available,false)
  expect(await patch('/interview/bookings/'+booking.id,loser,{action:'cancel',revision:1}),404)
  assert.equal(expect(await post('/interview/bookings',winner,{slot:one.id,name:booking.applicant_name}),201).id,booking.id)
  const changed=expect(await patch('/interview/bookings/'+booking.id,winner,{action:'reschedule',revision:1,slot:next.id}),200)
  assert.equal(changed.method,'online')
  const calendar=expect(await request('/interview/calendar',{cookie:loser}),200)
  assert.deepEqual(calendar.slots.map(slot=>slot.available),[true,false,true])
  assert.deepEqual(calendar.bookings,[])
  expect(await patch('/interview/bookings/'+booking.id,winner,{action:'cancel',revision:1}),409)
  const done=expect(await patch('/interview/bookings/'+booking.id,winner,{action:'cancel',revision:2}),200)
  assert.equal(done.status,'cancelled')
  assert.equal(done.instructions,null)
  assert.ok(expect(await request('/interview/calendar',{cookie:loser}),200).slots.every(slot=>slot.available))
  expect(await patch(root+'/slots/'+next.id,recruiter,{revision:1,published:false}),200)
  assert.deepEqual(expect(await request('/interview/calendar',{cookie:loser}),200).slots.map(slot=>slot.id),[one.id,midnight.id])
  const final=expect(await post('/interview/bookings',loser,{slot:midnight.id,name:'深夜の面談'}),201)
  assert.equal(final.ends_at,new Date(tomorrow+86400000).toISOString())
  expect(await patch(root+'/hours',other,{start:960,end:1260,revision:1}),404)
  expect(await patch(root+'/hours',recruiter,{start:975,end:1260,revision:1}),400)
  expect(await patch(root+'/hours',recruiter,{start:1260,end:1260,revision:1}),400)
  const changedHours=expect(await patch(root+'/hours',recruiter,{start:960,end:1260,revision:1}),200)
  assert.deepEqual(changedHours,{start:960,end:1260,revision:2})
  expect(await patch(root+'/hours',recruiter,{start:1080,end:1440,revision:1}),409)
  const revised=expect(await request('/interview/calendar',{cookie:loser}),200)
  assert.equal(revised.slots.length,0)
  assert.ok(revised.bookings.some(booking=>booking.id===final.id&&booking.status==='confirmed'))
  expect(await post('/interview/bookings',winner,{slot:one.id,name:'受付時間外の申込'}),409)
  const earlier=expect(await create(new Date(tomorrow+16*3600000),true),201)
  const view=expect(await request('/interview/calendar',{cookie:winner}),200)
  assert.deepEqual(view.slots.map(slot=>slot.id),[earlier.id])
  expect(await patch('/interview/bookings/'+final.id,loser,{action:'cancel',revision:final.revision}),200)
})

test('面談の受付停止時間とGoogle予定: 境界、再確認、障害時停止、既存予約の維持',async()=>{
  const root='/stores/'+storeId+'/interviews'
  const settings=root+'/availability'
  const applicant=await post('/interview/login',null,{connection:c,id_token:'signed-token-first-user'})
  const alternate=await post('/interview/login',null,{connection:c,id_token:'signed-token-second-user'})
  expect(applicant,200);expect(alternate,200)
  const calendar=async()=>expect(await request('/interview/calendar',{cookie:applicant.cookie}),200)
  const day=Date.parse((await calendar()).today+'T00:00:00+09:00')+2*86400000
  const at=hour=>new Date(day+hour*3600000).toISOString()
  const create=async hour=>expect(await post(root+'/slots',admin,{channel:c,starts_at:at(hour),ends_at:at(hour+0.5),
    method:'onsite',instructions:'会場の案内',published:true},idempotency()),201).id
  const booked=await create(17)
  const blocked=await create(17.5)
  const googleSlot=await create(18)
  const edge=await create(18.5)
  const book=slot=>post('/interview/bookings',applicant.cookie,{slot,name:'テスト利用者'})
  const first=expect(await book(booked),201)
  const change=(revision,slot)=>patch('/interview/bookings/'+first.id,applicant.cookie,{action:'reschedule',revision,slot})
  const blockedRange={starts_at:at(17.25),ends_at:at(17.75),note:'非公開の管理メモ'}
  const key=idempotency()
  const block=expect(await post(settings+'/blocks',admin,blockedRange,key),201)
  assert.equal(block.confirmed,1)
  assert.equal(expect(await post(settings+'/blocks',admin,blockedRange,key),201).id,block.id)
  expect(await post(settings+'/blocks',other,blockedRange,idempotency()),404)
  const atFirst=await calendar()
  assert.doesNotMatch(JSON.stringify(atFirst),/非公開の管理メモ/)
  assert.equal(atFirst.slots.find(slot=>slot.id===blocked).available,false)
  assert.equal(expect(await change(1,blocked),409).code,'INTERVIEW_SLOT_BLOCKED')

  const auth=expect(await post(settings+'/google',admin,{calendar_id:'primary'}),200)
  const href=new URL(auth.url)
  assert.equal(href.origin,'https://accounts.google.com')
  assert.match(href.searchParams.get('scope'),/calendar\.events\.freebusy$/)
  assert.equal(href.searchParams.get('code_challenge_method'),'S256')
  const [,state]=href.searchParams.get('state').split('.')
  const complete={state,code:'test-oauth-code'}
  expect(await post(settings+'/google/complete',admin,{...complete,state:'x'.repeat(43)}),409)
  expect(await post(settings+'/google/complete',other,complete),404)
  expect(await post(settings+'/google/complete',admin,complete),200)
  expect(await post(settings+'/google/complete',admin,complete),409)
  const overview=expect(await request(settings,{cookie:admin}),200)
  assert.deepEqual(overview.google,{configured:true,connected:true,calendar_id:'primary'})
  assert.doesNotMatch(JSON.stringify(overview),/calendar-refresh-secret|calendar-access-secret/)

  fakeBusy=[{start:at(18.25),end:at(18.5)}]
  const checked=await calendar()
  assert.equal(checked.slots.find(slot=>slot.id===googleSlot).available,false)
  assert.equal(checked.slots.find(slot=>slot.id===edge).available,true)
  const another=await post('/interview/bookings',alternate.cookie,{slot:googleSlot,name:'別の応募者'})
  assert.equal(expect(another,409).code,'INTERVIEW_SLOT_BLOCKED')
  // Force Calendar to change after the availability list was loaded.
  fakeBusy=[{start:at(18.5),end:at(19)}]
  assert.equal(expect(await change(1,edge),409).code,'INTERVIEW_SLOT_BLOCKED')
  assert.equal(googleCalls.at(-1).timeMin,at(18.5))
  assert.equal((await calendar()).bookings.find(item=>item.id===first.id).slot_id,booked)
  fakeGoogleError=true
  const degraded=await calendar()
  assert.equal(degraded.availability_warning,true)
  assert.ok(degraded.slots.every(slot=>!slot.available))
  assert.equal(expect(await change(1,edge),503).code,'GOOGLE_UNAVAILABLE')
  assert.equal(degraded.bookings.find(item=>item.id===first.id).status,'confirmed')
  fakeGoogleError=false
  fakeBusy=[]
  expect(await request(settings+'/blocks/'+block.id,{method:'DELETE',cookie:other,data:{}}),404)
  expect(await request(settings+'/blocks/'+block.id,{method:'DELETE',cookie:admin,data:{}}),200)
  assert.equal((await calendar()).slots.find(slot=>slot.id===blocked).available,true)
  expect(await request(settings+'/google',{method:'DELETE',cookie:admin,data:{}}),200)
  assert.equal(expect(await request(settings,{cookie:admin}),200).google.connected,false)
})
