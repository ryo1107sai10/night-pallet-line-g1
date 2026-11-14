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
import { workOnce } from '../dist/jobs.js'
import { starter } from '../public/studio/engine.mjs'

const origin = 'https://example.test'
const cfg = { origin, master:randomBytes(32), external:true }
const bot = 'U'+'1'.repeat(32)
const user = 'U'+'2'.repeat(32)
const channelSecret = 'a'.repeat(32)
const accessToken = 'test-channel-token'
const pass = 'Only used in local tests!'
const ids = { messaging:'1234567890', login:'1234567891' }
const endpoint = id => '/api/v1/webhooks/line/'+id
const signup = {}
let pg, owner, pool, server, dir, base, c, path, storeId, otherStore, admin, manager, other, line
let intendedId, pushedBody, remoteCalls = [], releaseRemote, remoteEntered, nextPush = 'accepted'
let managerId
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
        return Response.json({iss:'https://access.line.me',sub:user,exp:Date.now()/1000+600,
          aud:options.body.get('id_token').includes('bad')?'9999999999':ids.login})
      case '/v2/bot/message/push': {
        assert.equal(JSON.parse(options.body).to,user)
        pushedBody=JSON.parse(options.body).messages[0].text
        intendedId = options.headers['X-Line-Retry-Key']
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
  server = createApp(pool,cfg,line).listen(0,'127.0.0.1')
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
