import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import { Secret, TOTP } from 'otpauth'
import { createApp } from '../dist/app.js'
import { assertAppRole, digest, poolFor, scope, tx } from '../dist/core.js'
import { bootstrap, designateMaster, inviteSupervisor, migrate } from '../dist/setup.js'
import { LineAPI } from '../dist/line.js'
import { InterviewGoogle } from '../dist/interview-availability.js'
import { workOnce } from '../dist/jobs.js'
import { starter } from '../public/studio/engine.mjs'
import { liffAppId, lineSetupLinks } from '../public/line-setup.mjs'

const origin = 'https://example.test'
const cfg = { origin, master:randomBytes(32), external:true, automation:true }
const bot = 'U'+'1'.repeat(32)
const user = 'U'+'2'.repeat(32)
const user2 = 'U'+'3'.repeat(32)
const channelSecret = 'a'.repeat(32)
const accessToken = 'test-channel-token'
const pass = 'Only used in local tests!'
const ids = { messaging:'1234567890', login:'1234567891', redLogin:'1234567894' }
const redCalendar='red-store@example.test'
const endpoint = id => '/api/v1/webhooks/line/'+id
const signup = {}
let pg, owner, pool, server, dir, base, c, path, storeId, otherStore, admin, manager, other, line, google
let remainingQuota=200, intendedId, pushedBody, attemptedKeys=[], remoteCalls = [], releaseRemote, remoteEntered, nextPush = 'accepted'
let managerId, fakeBusy=[], fakeGoogleError=false, googleCalls=[]
const moduleConfig={id:'9012345678',secret:'d'.repeat(32),botHeader:'X-Test-Line-Bot'}
const moduleBot='U'+'e'.repeat(32), moduleUser='L'+user+'-'+moduleBot
const moduleToken='sample-stateless-token'
let exchangedCode, botInfoUnavailable=false
const moduleChallenges=new Map(), modulePushes=[]
const menus=[],pushesLog=[],remoteEvents=new Map()
const hostCalendar='host-a@example.test'
let hostBusy=[]
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

async function legacyOnlineSlot(store,connection,start,end) {
  const id=randomUUID()
  await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    await db.query(`INSERT INTO interview_slot (id,tenant_id,store_id,channel_id,starts_at,ends_at,method,instructions,published)
      VALUES ($1,$2,$3,$4,$5,$6,'online','過去の設定から残った枠',true)`,[id,signup.tenant,store,connection,start,end])
  })
  return id
}

test('公式LINEの設定ボタンは対象チャネルの画面を開き、未入力時は公式一覧を開く',()=>{
  const root='https://developers.line.biz/console/'
  const defaults=lineSetupLinks()
  assert.equal(defaults.manager,'https://manager.line.biz/')
  assert.equal(defaults.messagingSettings,root)
  const links=lineSetupLinks({provider_id:'2000000010',messaging_id:ids.messaging,login_id:ids.login,liff_id:ids.login+'-test'})
  assert.equal(links.provider,root+'provider/2000000010/settings')
  assert.equal(links.messagingBasics,root+'channel/'+ids.messaging)
  assert.equal(links.messagingSettings,root+'channel/'+ids.messaging+'/messaging-api')
  assert.equal(links.liff,root+'channel/'+ids.login+'/liff')
  assert.equal(links.liffEdit,links.liff+'/'+ids.login+'-test')
  assert.equal(liffAppId('https://liff.line.me/'+ids.login+'-test?from=copy'),ids.login+'-test')
  assert.equal(liffAppId('https://liff.line.me.example/'+ids.login+'-test'),'')
  assert.equal(lineSetupLinks({messaging_id:'../token?secret=sample'}).messagingSettings,root)
})

test('共有カレンダーの空き時間照合は店舗を限定し、短期のサーバー権限を使う',async()=>{
  const store=randomUUID(),calendar='shared@example.test',account='calendar-reader@project.iam.gserviceaccount.com'
  const range={starts_at:new Date('2030-04-05T09:00:00Z'),ends_at:new Date('2030-04-05T10:00:00Z')}
  const calls=[]
  let aclError=false
  const shared=new InterviewGoogle(cfg,undefined,async(url,options)=>{
    const {hostname,pathname}=new URL(url)
    calls.push(hostname)
    if(hostname==='metadata.google.internal'){
      assert.equal(options.headers['Metadata-Flavor'],'Google')
      return Response.json({access_token:'runtime'})
    }
    if(hostname==='iamcredentials.googleapis.com'){
      assert.equal(decodeURIComponent(pathname).split('/').at(-1),account+':generateAccessToken')
      assert.equal(options.headers.Authorization,'Bearer runtime')
      assert.deepEqual(JSON.parse(options.body),{scope:['https://www.googleapis.com/auth/calendar.events.freebusy'],lifetime:'900s'})
      return Response.json({accessToken:'short-lived',expireTime:new Date(Date.now()+900000).toISOString()})
    }
    assert.equal(hostname,'www.googleapis.com')
    assert.equal(options.headers.Authorization,'Bearer short-lived')
    assert.deepEqual(JSON.parse(options.body).items,[{id:calendar}])
    return Response.json({calendars:{[calendar]:aclError?{errors:[{reason:'notFound'}]}:{busy:[{
      start:range.starts_at.toISOString(),end:range.ends_at.toISOString(),
    }]}}})
  },{store,calendar,account})
  assert.equal(shared.sharedCalendar(store),calendar)
  await assert.rejects(shared.sharedBusy(randomUUID(),range,calendar),{code:'GOOGLE_UNAVAILABLE'})
  assert.deepEqual(await shared.sharedBusy(store,range,calendar),[range])
  aclError=true
  await assert.rejects(shared.sharedBusy(store,range,calendar),{code:'GOOGLE_UNAVAILABLE'})
  assert.deepEqual(calls,['metadata.google.internal','iamcredentials.googleapis.com','www.googleapis.com','www.googleapis.com'])
})

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
    if (address.href==='https://manager.line.biz/module/auth/v1/token') {
      const fields=options.body
      assert.equal(fields.get('client_id'),moduleConfig.id)
      assert.equal(fields.get('client_secret'),moduleConfig.secret)
      assert.equal(fields.get('grant_type'),'authorization_code')
      assert.equal(fields.get('redirect_uri'),origin+'/line-module/return')
      assert.equal(fields.get('region'),'JP')
      assert.equal(fields.get('scope'),'message:send message:receive')
      const code=fields.get('code')
      assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'),moduleChallenges.get(code))
      exchangedCode=code
      return Response.json({bot_id:moduleBot,scope:'message:send message:receive'})
    }
    assert.equal(address.origin,'https://api.line.me')
    remoteCalls.push(address.pathname)
    if(address.pathname.startsWith('/v2/bot/richmenu/')){
      return address.pathname.endsWith('0'.repeat(32))?new Response(null,{status:404}):Response.json({richMenuId:address.pathname.split('/').at(-1)})
    }
    if(/^\/v2\/bot\/user\/U[0-9a-f]{32}\/richmenu/.test(address.pathname)){
      menus.push({pathname:address.pathname,method:options.method})
      return new Response(null,{status:200})
    }
    switch (address.pathname) {
      case '/v2/oauth/verify':
        assert.equal(options.body.get('access_token'),accessToken)
        return Response.json({client_id:ids.messaging})
      case '/oauth2/v3/token':
        assert.equal(options.body.get('grant_type'),'client_credentials')
        assert.equal(options.body.get('client_id'),moduleConfig.id)
        assert.equal(options.body.get('client_secret'),moduleConfig.secret)
        return Response.json({access_token:moduleToken,expires_in:900})
      case '/v2/bot/info': {
        if (!options.headers[moduleConfig.botHeader]) return Response.json({userId:bot})
        assert.equal(options.headers.Authorization,'Bearer '+moduleToken)
        assert.equal(options.headers[moduleConfig.botHeader],moduleBot)
        if (botInfoUnavailable) return new Response(null,{status:503})
        return Response.json({userId:moduleBot,basicId:'@testshop',displayName:'かんたん連携テスト'})
      }
      case '/v2/bot/channel/webhook/endpoint':
        return Response.json({endpoint:origin+endpoint(c),active:true})
      case '/v2/bot/channel/webhook/test':
        assert.equal((await web({destination:bot,events:[]})).status,200)
        return Response.json({success:true})
      case '/oauth2/v2.1/verify': {
        assert.ok([ids.login,ids.redLogin].includes(options.body.get('client_id')))
        const proof=options.body.get('id_token')
        return Response.json({iss:'https://access.line.me',sub:proof.includes('second')?user2:user,exp:Date.now()/1000+600,
          aud:proof.includes('bad')?'9999999999':proof.includes('red-store')?ids.redLogin:ids.login})
      }
      case '/v2/bot/message/quota': return Response.json({type:'limited',value:200})
      case '/v2/bot/message/quota/consumption': return Response.json({totalUsage:200-remainingQuota})
      case '/v2/bot/message/push': {
        if (options.headers[moduleConfig.botHeader]) {
          assert.equal(options.headers[moduleConfig.botHeader],moduleBot)
          assert.equal(options.headers.Authorization,'Bearer '+moduleToken)
          const message=JSON.parse(options.body)
          assert.equal(message.to,moduleUser)
          modulePushes.push(message)
          return new Response('{}',{status:200,headers:{'x-line-request-id':'module-test-line-id'}})
        }
        assert.ok([user,user2].includes(JSON.parse(options.body).to))
        pushedBody=JSON.parse(options.body).messages[0].text
        pushesLog.push(JSON.parse(options.body))
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
  google=new InterviewGoogle(cfg,{clientId:'calendar-client',secret:'calendar-server-secret'},async(url,options)=>{
    if(url==='https://oauth2.googleapis.com/token'){
      const grant=options.body.get('grant_type')
      const red=options.body.get('code')==='test-red-oauth-code'||options.body.get('refresh_token')==='red-refresh-secret'
      assert.equal(options.body.get('client_secret'),'calendar-server-secret')
      if(grant==='authorization_code') {
        assert.match(options.body.get('code_verifier'),/^[A-Za-z0-9_-]{43}$/)
        assert.equal(options.body.get('redirect_uri'),origin+'/interview/google-return.html')
      } else assert.equal(options.body.get('refresh_token'),red?'red-refresh-secret':'calendar-refresh-secret')
      const scope=options.body.get('code')==='test-write-oauth-code'?
        'https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events':undefined
      return Response.json({access_token:red?'red-access-secret':'calendar-access-secret',
        refresh_token:red?'red-refresh-secret':'calendar-refresh-secret',expires_in:3600,scope})
    }
    if(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/')){
      const address=new URL(url)
      assert.equal(address.searchParams.get('sendUpdates'),'none')
      assert.equal(options.headers.Authorization,'Bearer calendar-access-secret')
      const [, , , ,calendar,,id]=address.pathname.split('/')
      const key=decodeURIComponent(calendar)+'/'+id
      if(options.method==='DELETE')return new Response(null,{status:remoteEvents.delete(key)?204:404})
      const data=JSON.parse(options.body)
      assert.equal(data.visibility,'private')
      assert.equal(data.summary,'Night PRO LINE 面談')
      if(options.method==='POST'){
        remoteEvents.set(decodeURIComponent(calendar)+'/'+data.id,data)
        return Response.json(data)
      }
      if(!remoteEvents.has(key))return new Response(null,{status:404})
      remoteEvents.set(key,data)
      return Response.json(data)
    }
    assert.equal(url,'https://www.googleapis.com/calendar/v3/freeBusy')
    const query=JSON.parse(options.body)
    googleCalls.push(query)
    if (query.items[0].id===redCalendar) {
      assert.equal(options.headers.Authorization,'Bearer red-access-secret')
      return Response.json({calendars:{[redCalendar]:{busy:[]}}})
    }
    if(query.items[0].id===hostCalendar){
      assert.equal(options.headers.Authorization,'Bearer calendar-access-secret')
      return Response.json({calendars:{[hostCalendar]:{busy:hostBusy}}})
    }
    assert.equal(options.headers.Authorization,'Bearer calendar-access-secret')
    assert.deepEqual(query.items,[{id:'primary'}])
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
    messaging_id:ids.messaging,login_id:ids.login,liff_id:ids.login+'-test',
    account_type:'unverified',management_authority:'管理者確認',channel_secret:channelSecret,
    access_token:accessToken,token_type:'console'}
  const prefix = '/stores/'+storeId+'/connections'
  const wrong = expect(await post(prefix,manager,{...data,messaging_id:'1234567899'},idempotency()),422)
  assert.equal(wrong.code,'LINE_CHANNEL_TOKEN')
  c = expect(await post(prefix,manager,data,idempotency()),201).id
  path = prefix+'/'+c
  expect(await post('/stores/'+otherStore+'/connections',admin,data,idempotency()),409)
  const result = expect(await request(prefix,{cookie:manager}),200)[0]
  assert.equal(result.bot_user_id,bot)
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

async function publish(flow,store=storeId) {
  const root='/stores/'+store+'/scenarios'
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
    ...(method==='online'?{method}:{}),instructions:'確定者専用の参加方法',published,
  },idempotency())
  expect(await create(new Date(tomorrow+17.5*3600000),true),422)
  expect(await create(new Date(tomorrow+18.25*3600000),true),422)
  const midnight=expect(await create(new Date(tomorrow+23.5*3600000),true),201)
  const one=expect(await create(first,true),201)
  expect(await create(first,true),409)
  const nextStart=new Date(+first+3600000)
  expect(await create(nextStart,true,'online'),400)
  const online=await legacyOnlineSlot(storeId,c,nextStart,new Date(+nextStart+1800000))
  expect(await patch(root+'/slots/'+online,recruiter,{revision:1,published:true}),422)
  const next=expect(await create(nextStart,true),201)
  const hidden=expect(await create(new Date(+first+2*3600000),false),201)
  const published=expect(await request('/interview/calendar',{cookie:a.cookie}),200)
  assert.deepEqual(published.slots.map(slot=>slot.id),[one.id,next.id,midnight.id])
  assert.ok(published.slots.every(slot=>slot.method==='onsite'))
  assert.doesNotMatch(JSON.stringify(published),/確定者専用/)
  expect(await request('/interview/calendar?start=2026-02-30',{cookie:a.cookie}),422)
  expect(await post('/interview/bookings',a.cookie,{slot:hidden.id,name:'応募者A'}),409)
  expect(await post('/interview/bookings',a.cookie,{slot:online,name:'応募者A'}),409)
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
  assert.equal(changed.method,'onsite')
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
  expect(await patch('/interview/bookings/'+first.id,applicant.cookie,{action:'cancel',revision:1}),200)
})

test('同一法人の店舗ごとにOA・Google予定・タグ・機能設定を分離する',async()=>{
  const blue='/stores/'+storeId
  const red='/stores/'+otherStore
  const email='blue-manager@example.test'
  const invite=expect(await post('/staff/invites',admin,{email,role:'manager',stores:[storeId]},idempotency()),201)
  const blueManager=await activate(invite,email,'alpha')
  const registered=expect(await post(red+'/connections',admin,{
    label:'赤店の公式LINE',purpose:'shared',owner_name:'甲法人',provider_id:'provider',
    messaging_id:'1234567893',login_id:ids.redLogin,liff_id:ids.redLogin+'-red',bot_user_id:'U'+'4'.repeat(32),
    account_type:'unverified',management_authority:'テスト用',channel_secret:channelSecret,
    access_token:accessToken,token_type:'console',
  },idempotency()),201)
  expect(await patch(red+'/connections/'+registered.id+'/console',admin,{...consoleChecks,revision:1,reason:'検証用'}),200)
  assert.ok(expect(await request(blue+'/connections',{cookie:admin}),200).some(item=>item.id===c))
  assert.deepEqual(expect(await request(red+'/connections',{cookie:admin}),200).map(item=>item.id),[registered.id])
  expect(await request(red+'/connections',{cookie:blueManager}),404)
  const blueProof='signed-token-from-blue-store'
  const redProof='signed-token-from-red-store'
  const login=(connection,id_token)=>post('/interview/login',null,{connection,id_token})
  const a=await login(c,blueProof),b=await login(registered.id,redProof)
  expect(a,200);expect(b,200)
  expect(await login(registered.id,blueProof),401)
  expect(await login(c,redProof),401)
  assert.equal(expect(await request('/liff/'+registered.id),200).liff_id,ids.redLogin+'-red')

  const settings=store=>store+'/interviews/availability'
  const startLink=async(store,calendar_id)=>{
    const {url}=expect(await post(settings(store)+'/google',admin,{calendar_id}),200)
    return new URL(url).searchParams.get('state').split('.')[1]
  }
  const finishLink=(store,state,code)=>post(settings(store)+'/google/complete',admin,{state,code})
  const redState=await startLink(red,redCalendar)
  expect(await finishLink(blue,redState,'test-red-oauth-code'),409)
  expect(await finishLink(red,redState,'test-red-oauth-code'),200)
  expect(await finishLink(blue,await startLink(blue,'primary'),'test-oauth-code'),200)
  assert.equal(expect(await request(settings(blue),{cookie:admin}),200).google.calendar_id,'primary')
  assert.equal(expect(await request(settings(red),{cookie:admin}),200).google.calendar_id,redCalendar)

  const calendar=async cookie=>expect(await request('/interview/calendar',{cookie}),200)
  const day=Date.parse((await calendar(a.cookie)).today+'T00:00:00+09:00')+4*86400000
  const at=hour=>new Date(day+hour*3600000).toISOString()
  const offer=(store,channel)=>post(store+'/interviews/slots',admin,{
    channel,starts_at:at(18),ends_at:at(18.5),instructions:'対面会場の案内',published:true,
  },idempotency())
  const one=expect(await offer(blue,c),201)
  const two=expect(await offer(red,registered.id),201)
  fakeBusy=[{start:at(18.25),end:at(19)}]
  const blueView=await calendar(a.cookie)
  assert.equal(blueView.slots.find(slot=>slot.id===one.id).available,false)
  assert.ok(!blueView.slots.some(slot=>slot.id===two.id))
  assert.deepEqual((await calendar(b.cookie)).slots.map(slot=>[slot.id,slot.available]),[[two.id,true]])
  const book=(cookie,slot)=>post('/interview/bookings',cookie,{slot,name:'面談テスト'})
  assert.equal(expect(await book(a.cookie,one.id),409).code,'INTERVIEW_SLOT_BLOCKED')
  expect(await book(a.cookie,two.id),409)
  const interview=expect(await book(b.cookie,two.id),201)
  assert.equal(interview.method,'onsite')
  assert.equal(interview.instructions,'対面会場の案内')
  const overview=expect(await request(red+'/interviews',{cookie:admin}),200)
  assert.equal(overview.slots.find(slot=>slot.id===two.id).booking_id,interview.id)

  const rule=(store,name,trigger)=>request(store+'/tags',{method:'PUT',cookie:admin,data:{name,trigger}})
  expect(await rule(red,'来店予約済み','booking_created'),200)
  expect(await rule(red,'常連',null),200)
  const customer=await post('/customer/login',null,{connection:registered.id,id_token:redProof})
  expect(customer,200)
  const customerList=store=>request(store+'/customers',{cookie:admin})
  const record=expect(await customerList(red),200)[0]
  assert.deepEqual(record.tags,[])
  const visit=expect(await post(red+'/slots',admin,{label:'来店用',starts_at:at(20),ends_at:at(20.5),capacity:5,published:true},idempotency()),201)
  expect(await post(red+'/bookings',admin,{customer:record.id,slot:visit.id,party:1,confirm:true},idempotency()),201)
  const secondVisit=expect(await post(red+'/slots',admin,{label:'別の来店枠',starts_at:at(21),ends_at:at(21.5),capacity:5,published:true},idempotency()),201)
  const tagged=expect(await customerList(red),200)[0]
  assert.deepEqual(tagged.tags,['来店予約済み'])
  assert.ok(!expect(await request(blue+'/tags',{cookie:admin}),200).some(tag=>tag.name==='来店予約済み'))
  expect(await patch(red+'/customers/'+record.id+'/tags',admin,{revision:record.revision,tags:[]}),409)
  const manual=expect(await patch(red+'/customers/'+record.id+'/tags',admin,{revision:tagged.revision,tags:['来店予約済み','常連']}),200)
  assert.equal(manual.tags.length,2)
  const filter=async (tags,match)=>{
    const query=new URLSearchParams({match})
    for(const tag of tags)query.append('tag',tag)
    return expect(await request(red+'/customers?'+query,{cookie:admin}),200)
  }
  assert.deepEqual((await filter(['来店予約済み','常連'],'all')).map(item=>item.id),[record.id])
  assert.deepEqual(await filter(['常連','初回'],'all'),[])
  assert.deepEqual((await filter(['常連','初回'],'any')).map(item=>item.id),[record.id])
  const segment={name:'次回のご案内候補',tags:['来店予約済み','常連'],match:'all'}
  expect(await request(red+'/tag-filters',{method:'PUT',cookie:blueManager,data:segment}),404)
  expect(await request(red+'/tag-filters',{method:'PUT',cookie:admin,data:segment}),200)
  assert.deepEqual(expect(await request(red+'/tag-filters',{cookie:admin}),200),[segment])
  assert.deepEqual(expect(await request(blue+'/tag-filters',{cookie:admin}),200),[])
  expect(await patch(blue+'/customers/'+record.id+'/tags',admin,{revision:manual.revision,tags:[]}),404)

  const storeFlags=async(store,cookie=admin)=>expect(await request(store+'/features',{cookie}),200)
  const blueWithoutGoogle=expect(await patch(blue+'/features',admin,{
    ...await storeFlags(blue),google_calendar_enabled:false,
  }),200)
  const googleQueries=googleCalls.length
  assert.equal((await calendar(a.cookie)).slots.find(slot=>slot.id===one.id).available,true)
  assert.equal(googleCalls.length,googleQueries)
  expect(await patch(blue+'/features',admin,{...blueWithoutGoogle,google_calendar_enabled:true}),200)
  const flags=await storeFlags(red)
  const next={...flags,tags_enabled:false,visits_enabled:false,interviews_enabled:false,google_calendar_enabled:false}
  expect(await patch(red+'/features',blueManager,next),404)
  expect(await patch(blue+'/features',blueManager,{...await storeFlags(blue,blueManager),tags_enabled:false}),403)
  expect(await patch(red+'/features',admin,next),200)
  expect(await patch(red+'/features',admin,next),409)
  expect(await request(red+'/tags',{cookie:admin}),409)
  expect(await request(red+'/tag-filters',{cookie:admin}),409)
  expect(await patch(red+'/customers/'+record.id+'/tags',admin,{revision:manual.revision,tags:[]}),409)
  expect(await post(red+'/interviews/availability/google',admin,{calendar_id:redCalendar}),409)
  assert.equal(expect(await post('/customer/bookings',customer.cookie,{slot:secondVisit.id,party:2}),409).code,'STORE_FEATURE_DISABLED')
  const redView=await calendar(b.cookie)
  assert.deepEqual(redView.slots,[])
  assert.equal(redView.bookings.find(item=>item.id===interview.id).status,'confirmed')
  expect(await patch('/interview/bookings/'+interview.id,b.cookie,{action:'cancel',revision:interview.revision}),200)
  assert.equal((await storeFlags(blue)).interviews_enabled,true)
  assert.equal((await calendar(a.cookie)).slots.find(slot=>slot.id===one.id).available,false)
  assert.equal(expect(await request(settings(red),{cookie:admin}),200).google.calendar_id,redCalendar)
  fakeBusy=[]
})

const put=(path,cookie,data)=>request(path,{method:'PUT',cookie,data,headers:idempotency()})
async function workflowStore(label,purpose,index,features){
  const store=expect(await post('/stores',admin,storeData(label),idempotency()),201).id
  const root='/stores/'+store
  const destination='U'+index.repeat(32)
  const connection=expect(await post(root+'/connections',admin,{
    label,purpose,owner_name:'甲法人',provider_id:'provider',messaging_id:'130000000'+index,
    login_id:ids.login,liff_id:ids.login+'-'+index,bot_user_id:destination,
    account_type:'unverified',management_authority:'検証用',channel_secret:channelSecret,access_token:accessToken,token_type:'console',
  },idempotency()),201).id
  await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    await db.query('UPDATE channel SET checks=$2 WHERE id=$1',[connection,{
      ...consoleChecks,delivery_confirmed:true,token_verified:true,webhook_verified:true,
    }])
    await db.query(`UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,
      auto_enabled_at=now(),monthly_limit=100 WHERE id=$1`,[store])
  })
  const settings=expect(await request(root+'/features',{cookie:admin}),200)
  expect(await patch(root+'/features',admin,{...settings,...features}),200)
  const inbound=async events=>{
    const raw=JSON.stringify({destination,events})
    return send(endpoint(connection),{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':signed(raw)},body:raw})
  }
  return {store,root,connection,inbound}
}
const worker=()=>workOnce(pool,cfg,line,google)
const confirmation=(cookie,slot,name='応募者')=>post('/interview/bookings',cookie,{slot,name})

test('採用と顧客の回答フォーム・版・流入QRを分離し、店舗の面談・体入・入店実績に集計する',async()=>{
  const {root,connection}=await workflowStore('フォーム検証','shared','5',{
    forms_enabled:true,recruitment_enabled:true,sources_enabled:true,
  })
  const candidate=root+'/workflows/recruitment'
  const guest=root+'/workflows/customer'
  const entry=expect(await post(candidate+'/sources',admin,{channel:connection,label:'求人媒体Ａ'}),201)
  const competing=expect(await post(candidate+'/sources',admin,{channel:connection,label:'求人媒体Ｂ'}),201)
  const channelOnly=expect(await post(guest+'/sources',admin,{channel:connection,label:'来店用'}),201)
  const fixture={channel:connection,revision:0,title:'面談事前フォーム',description:'回答をご入力ください',published:true,
    fields:[{key:'name',label:'お名前',kind:'text',required:true,applicant_name:true},
      {key:'shift',label:'希望',kind:'choice',required:true,options:['平日','週末']}]}
  const form=expect(await put(candidate+'/forms',admin,fixture),200)
  const second=expect(await put(candidate+'/forms',admin,{...fixture,title:'追加質問'}),200)
  expect(await put(guest+'/forms',admin,{...fixture,title:'来店アンケート'}),200)
  const person=await post('/interview/login',null,{connection,id_token:'signed-token-first-user',source:entry.id})
  expect(person,200)
  expect(await post('/interview/login',null,{connection,id_token:'signed-token-first-user',source:competing.id}),200)
  const guestUser=await post('/customer/login',null,{connection,id_token:'signed-token-first-user',source:entry.id})
  expect(guestUser,200)
  assert.equal(expect(await request('/customer/form?form='+form.id,{cookie:guestUser.cookie}),200),null)
  assert.equal(expect(await request('/interview/form',{cookie:person.cookie}),200).id,form.id)
  assert.equal(expect(await request('/interview/form?form='+second.id,{cookie:person.cookie}),200).id,second.id)
  expect(await post('/interview/form',person.cookie,{form:form.id,revision:1,answers:{name:'面談テスト',shift:'不正'}}),422)
  const answers={form:form.id,revision:1,answers:{name:'面談テスト',shift:'週末'}}
  expect(await post('/interview/form',person.cookie,answers),201)
  expect(await post('/interview/form',person.cookie,answers),201)
  expect(await put(candidate+'/forms',admin,{...fixture,id:form.id,revision:1,title:'更新後の題名'}),200)
  expect(await post('/interview/form',person.cookie,answers),409)
  const response=expect(await request(candidate+'/responses',{cookie:admin}),200)
  assert.equal(response.length,1)
  assert.equal(response[0].title,fixture.title)
  assert.deepEqual(response[0].answers,[{label:'お名前',value:'面談テスト'},{label:'希望',value:'週末'}])
  assert.doesNotMatch(JSON.stringify(response),/answers_box|applicant_key/)
  assert.deepEqual(expect(await request(guest+'/responses',{cookie:admin}),200),[])
  expect(await request(candidate+'/responses',{cookie:other}),404)
  expect(await request(guest+'/sources/'+entry.id+'/qr',{cookie:admin}),404)
  assert.match(expect(await request(candidate+'/sources/'+entry.id+'/qr',{cookie:admin}),200).image,/^data:image\/png;base64,/)
  let [record]=expect(await request(root+'/recruitment',{cookie:admin}),200)
  assert.equal(record.applicant_name,'面談テスト')
  assert.equal(record.source,'求人媒体Ａ')
  expect(await patch(root+'/recruitment/'+record.id,admin,{stage:'hired',trial_at:null,revision:record.revision}),409)
  for(const stage of ['interviewed','trial_scheduled','trial_done','hired']){
    record=expect(await patch(root+'/recruitment/'+record.id,admin,{stage,revision:record.revision,
      trial_at:stage==='trial_scheduled'?new Date(Date.now()+86400000).toISOString():null}),200)
  }
  const report=expect(await request(candidate+'/sources',{cookie:admin}),200)
  assert.match(report.entries.find(source=>source.id===entry.id).url,/source=/)
  assert.deepEqual(report.entries.map(source=>[source.opened,source.forms,source.interviewed,source.trials,source.hired]),[[1,1,1,1,1],[0,0,0,0,0]])
  assert.equal(expect(await request(guest+'/sources',{cookie:admin}),200).entries.find(source=>source.id===channelOnly.id).opened,0)
})

test('担当者別の空き枠・Googleへの登録と取消・LINEメニュー・面談通知・キャンセル待ち',async()=>{
  const {root,connection,inbound}=await workflowStore('面談フロー検証','recruitment','6',{
    reminders_enabled:true,waitlist_enabled:true,rich_menus_enabled:true,interviewers_enabled:true,google_write_enabled:true,
  })
  const path=root+'/interviews'
  const menusPath=root+'/workflows/recruitment/rich-menus'
  const normal='richmenu-'+'1'.repeat(32), booked='richmenu-'+'2'.repeat(32)
  expect(await put(menusPath,admin,{channel:connection,revision:0,base_menu:normal,booked_menu:'richmenu-'+'0'.repeat(32)}),422)
  expect(await put(menusPath,admin,{channel:connection,revision:0,base_menu:normal,booked_menu:booked}),200)
  const first=await post('/interview/login',null,{connection,id_token:'signed-token-first-user'})
  const second=await post('/interview/login',null,{connection,id_token:'signed-token-second-user'})
  expect(first,200);expect(second,200)
  assert.equal((await inbound([event('host-follow-a','follow',Date.now()),{
    ...event('host-follow-b','follow',Date.now()),source:{type:'user',userId:user2},
  }])).status,200)
  const oauth=expect(await post(path+'/availability/google',admin,{calendar_id:'primary'}),200)
  const url=new URL(oauth.url)
  assert.match(url.searchParams.get('scope'),/calendar\.events$/)
  const state=url.searchParams.get('state').split('.')[1]
  expect(await post(path+'/availability/google/complete',admin,{state,code:'test-write-oauth-code'}),200)
  const availability=expect(await request(path+'/availability',{cookie:admin}),200)
  assert.equal(availability.google_write_granted,true)
  const host=expect(await put(path+'/hosts',admin,{name:'面談担当Ａ',calendar_id:hostCalendar,active:true}),200)
  const alternative=expect(await put(path+'/hosts',admin,{name:'面談担当Ｂ',calendar_id:null,active:true}),200)
  const day=Date.parse(expect(await request('/interview/calendar',{cookie:first.cookie}),200).today+'T00:00:00+09:00')+4*86400000
  const at=hour=>new Date(day+hour*3600000).toISOString()
  const offer=(host_id,hour)=>post(path+'/slots',admin,{channel:connection,host_id,starts_at:at(hour),ends_at:at(hour+.5),
    instructions:'会場案内のテスト',published:true},idempotency())
  const personal=expect(await offer(host.id,18),201)
  const parallel=expect(await offer(alternative.id,18),201)
  const later=expect(await offer(host.id,19),201)
  expect(await offer(host.id,18),409)
  hostBusy=[{start:at(18),end:at(18.5)}]
  const candidates=expect(await request('/interview/calendar',{cookie:first.cookie}),200)
  assert.equal(candidates.slots.find(slot=>slot.id===personal.id).available,false)
  assert.equal(candidates.slots.find(slot=>slot.id===parallel.id).available,true)
  assert.doesNotMatch(JSON.stringify(candidates),/host-a@example/)
  expect(await confirmation(first.cookie,personal.id),409)
  expect(await put('/interview/waitlist',second.cookie,{method:'onsite',days:7}),409)
  expect(await put('/interview/notices',first.cookie,{enabled:true}),200)
  expect(await put('/interview/notices',second.cookie,{enabled:true}),200)
  const appointment=expect(await confirmation(first.cookie,later.id),201)
  expect(await put('/interview/waitlist',second.cookie,{method:'onsite',days:7}),200)
  assert.equal(appointment.method,'onsite')
  await worker()
  await worker()
  const calendarKey=hostCalendar+'/night'+appointment.id.replaceAll('-','')
  assert.equal(remoteEvents.get(calendarKey)?.start.dateTime,at(19))
  assert.ok(menus.some(item=>item.method==='POST'&&item.pathname.endsWith('/'+booked)&&item.pathname.includes(user)))
  assert.ok(pushesLog.some(item=>item.to===user&&item.messages[0].text.includes('面談予約が確定しました。')))
  const notices=expect(await request(root+'/workflows/recruitment/delivery',{cookie:admin}),200)
  assert.ok(notices.some(item=>item.kind==='interview_reminder'&&item.status==='queued'))
  expect(await patch('/interview/bookings/'+appointment.id,first.cookie,{action:'cancel',revision:1}),200)
  await worker()
  assert.equal(remoteEvents.has(calendarKey),false)
  assert.ok(pushesLog.some(item=>item.to===user2&&item.messages[0].text.includes('面談の受付枠に変更')))
  const final=expect(await request(root+'/workflows/recruitment/delivery',{cookie:admin}),200)
  assert.ok(final.some(item=>item.kind==='interview_reminder'&&item.status==='cancelled'))
  hostBusy=[]
})

test('一斉配信は承認・送信直前の同意確認を守り、兼用LINEの受信は振り分け前に漏れない',async()=>{
  const {root,connection,inbound}=await workflowStore('配信・受信箱検証','shared','7',{campaigns_enabled:true,inbox_enabled:true})
  const customers=root+'/workflows/customer'
  const intake=root+'/intake'
  const one=await post('/customer/login',null,{connection,id_token:'signed-token-first-user'})
  const two=await post('/customer/login',null,{connection,id_token:'signed-token-second-user'})
  for(const [person,name] of [[one,'試験ひとり目'],[two,'試験ふたり目']]){
    expect(person,200)
    const account=expect(await request('/customer/account',{cookie:person.cookie}),200)
    expect(await patch('/customer/preferences',person.cookie,{revision:account.revision,version:account.policy_version,
      preferences:{service_consent:true,marketing_consent:true,all_stop:false}}),200)
    const rows=expect(await request(root+'/customers',{cookie:admin}),200)
    const record=rows.find(row=>row.display_name===null&&!row.tags.length)
    expect(await patch(root+'/customers/'+record.id,admin,{revision:record.revision,display_name:name,memo:'',
      assigned_to:null,verified20:true,active_chat:false,tags:['検証配信'],reason:'試験用の本人確認'}),200)
  }
  assert.equal((await inbound([event('campaign-follow-a','follow',Date.now()),{
    ...event('campaign-follow-b','follow',Date.now()),source:{type:'user',userId:user2},
  }])).status,200)
  await worker()
  const nowHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(new Date()))
  const clock=hour=>String((hour+24)%24).padStart(2,'0')+':00'
  const draft=expect(await post(root+'/campaigns',admin,{channel:connection,title:'配信承認テスト',body:'配信リハーサル',
    scheduled_at:new Date().toISOString(),criteria:{tags:['検証配信'],match:'all',last_visit_days:null,assigned_to:null,
      windowStart:clock(nowHour-1),windowEnd:clock(nowHour+2)}},idempotency()),201)
  assert.equal(draft.eligible,2)
  await worker()
  assert.equal(pushesLog.filter(item=>item.messages[0].text==='配信リハーサル').length,0)
  expect(await post(root+'/campaigns/'+draft.id+'/approve',admin,{recipients:1,approved:true}),409)
  expect(await post(root+'/campaigns/'+draft.id+'/approve',admin,{recipients:2,approved:true}),200)
  const beforeStop=expect(await request('/customer/account',{cookie:two.cookie}),200)
  expect(await patch('/customer/preferences',two.cookie,{revision:beforeStop.revision,version:beforeStop.policy_version,
    preferences:{service_consent:false,marketing_consent:false,all_stop:true}}),200)
  await worker()
  await worker()
  assert.deepEqual(pushesLog.filter(item=>item.messages[0].text==='配信リハーサル').map(item=>item.to),[user])
  const [sent]=expect(await request(root+'/campaigns',{cookie:admin}),200).entries
  assert.deepEqual(sent.counts,{accepted:1,cancelled:1})

  const chat={...event('inbox-message','message',Date.now()),message:{id:'760001',type:'text',text:'面談の日程を確認したいです'}}
  assert.equal((await inbound([chat,chat])).status,200)
  assert.deepEqual(expect(await request(customers+'/inbox',{cookie:admin}),200).threads,[])
  assert.deepEqual(expect(await request(root+'/workflows/recruitment/inbox',{cookie:admin}),200).threads,[])
  const [thread]=expect(await request(intake,{cookie:admin}),200).threads
  assert.equal(expect(await request(intake+'/'+thread.id,{cookie:admin}),200).length,1)
  expect(await request(intake+'/'+thread.id,{cookie:other}),404)
  expect(await patch(intake+'/'+thread.id,admin,{revision:thread.revision,purpose:'recruitment',reason:'応募者から面談日程の確認'}),200)
  const route=root+'/workflows/recruitment/inbox'
  const [classified]=expect(await request(route,{cookie:admin}),200).threads
  const actor=expect(await request('/session',{cookie:admin}),200).actor
  const handling=expect(await patch(route+'/'+classified.id,admin,{revision:classified.revision,state:'handling',assigned_to:actor.id}),200)
  const key=idempotency()
  const reply={revision:handling.revision,body:'公式LINEの面談窓口です。',internal:false}
  const queued=expect(await post(route+'/'+classified.id,admin,reply,key),201)
  assert.equal(expect(await post(route+'/'+classified.id,admin,reply,key),201).id,queued.id)
  expect(await post(route+'/'+classified.id,admin,reply,idempotency()),409)
  await worker()
  assert.equal(pushesLog.filter(item=>item.messages[0].text===reply.body).length,1)
  const unsend={...event('inbox-unsend','unsend',Date.now()),unsend:{messageId:chat.message.id}}
  assert.equal((await inbound([unsend])).status,200)
  const messages=expect(await request(route+'/'+classified.id,{cookie:admin}),200)
  assert.ok(messages.some(item=>item.withdrawn&&item.body===null))
  assert.ok(messages.some(item=>item.status==='accepted'))
})

test('ログイン不要の面談は対面のみ、予約時もGoogleの重複を拒否して連絡先を店舗に限定する',async()=>{
  const {store,root,connection}=await workflowStore('公開面談検証','recruitment','8',{guest_interviews_enabled:true})
  const api='/guest-interview/'+connection
  const session=await post(api+'/session',null,{})
  expect(session,201)
  assert.match(session.cookie,/^night_guest_interview=/)
  const calendar=async()=>expect(await request(api+'/calendar',{cookie:session.cookie}),200)
  expect(await request('/interview/calendar',{cookie:session.cookie}),401)
  const {today}=await calendar()
  const start=Date.parse(today+'T00:00:00+09:00')+2*86400000
  const at=time=>new Date(start+time*3600000).toISOString()
  const slot=async hour=>expect(await post(root+'/interviews/slots',admin,{
    channel:connection,starts_at:at(hour),ends_at:at(hour+0.5),published:true,instructions:'店舗受付',
  },idempotency()),201).id
  const busy=await slot(18)
  const free=await slot(19)
  const online=await legacyOnlineSlot(store,connection,at(20),at(20.5))
  const book=id=>post(api+'/bookings',session.cookie,{slot:id,name:'公開予約テスト',email:'booking@example.test'})
  assert.equal((await calendar()).availability_warning,true)
  assert.equal(expect(await book(free),503).code,'GOOGLE_UNAVAILABLE')
  const googlePath=root+'/interviews/availability/google'
  const auth=expect(await post(googlePath,admin,{calendar_id:'primary'}),200)
  const [,state]=new URL(auth.url).searchParams.get('state').split('.')
  expect(await post(googlePath+'/complete',admin,{state,code:'test-oauth-code'}),200)
  fakeBusy=[{start:at(18.25),end:at(18.75)}]
  try{
    const before=await calendar()
    assert.equal(before.slots.find(slot=>slot.id===busy).available,false)
    assert.equal(before.slots.find(slot=>slot.id===free).available,true)
    assert.ok(before.slots.every(slot=>slot.id!==online))
    assert.equal(expect(await book(busy),409).code,'INTERVIEW_SLOT_BLOCKED')
    expect(await book(online),409)
    fakeBusy.push({start:at(19),end:at(19.5)})
    assert.equal(expect(await book(free),409).code,'INTERVIEW_SLOT_BLOCKED')
    fakeBusy.pop()
    const booking=expect(await book(free),201)
    assert.equal(booking.status,'confirmed')
    assert.equal(booking.method,'onsite')
    assert.doesNotMatch(JSON.stringify(await calendar()),/booking@example\.test/)
    const staff=expect(await request(root+'/interviews',{cookie:admin}),200)
    assert.equal(staff.slots.find(slot=>slot.id===free).guest_email,'booking@example.test')
    const stranger=await post(api+'/session',null,{})
    assert.deepEqual(expect(await request(api+'/calendar',{cookie:stranger.cookie}),200).bookings,[])
    expect(await patch(api+'/bookings/'+booking.id,stranger.cookie,{action:'cancel',revision:1}),404)
    expect(await patch(api+'/bookings/'+booking.id,session.cookie,{action:'cancel',revision:1}),200)
  }finally{fakeBusy=[]}
})

test('LINEモジュールの許可を開始した店舗に戻し、署名付き受信から端末へのテスト送信まで行える',async()=>{
  const store=expect(await post('/stores',admin,storeData('かんたん連携店舗'),idempotency()),201).id
  const basePath='/stores/'+store
  const start=basePath+'/line-module'
  const remoteWebhook='/api/v1/webhooks/line-module'
  const moduleWeb=(destination,events,secret=moduleConfig.secret)=>{
    const raw=JSON.stringify({destination,events})
    return send(remoteWebhook,{method:'POST',headers:{'Content-Type':'application/json',
      'X-Line-Signature':createHmac('sha256',secret).update(raw).digest('base64')},body:raw})
  }
  const message=(content,mode='active')=>({
    webhookEventId:randomUUID(),type:'message',mode,timestamp:Date.now(),
    source:{type:'user',userId:moduleUser},message:{id:randomUUID(),type:'text',text:content},
  })
  assert.equal(expect(await request(start,{cookie:admin}),200).configured,false)
  expect(await post(start,admin,{purpose:'recruitment'}),409)
  cfg.lineModule=moduleConfig
  try {
    assert.equal(expect(await request(start,{cookie:admin}),200).configured,true)
    expect(await post(start,null,{purpose:'recruitment'}),401)
    const result=expect(await post(start,admin,{purpose:'recruitment'}),200)
    const authURL=new URL(result.url)
    assert.equal(authURL.origin+authURL.pathname,'https://manager.line.biz/module/auth/v1/authorize')
    const params=authURL.searchParams
    assert.equal(params.get('client_id'),moduleConfig.id)
    assert.equal(params.get('redirect_uri'),origin+'/line-module/return')
    assert.equal(params.get('scope'),'message:send message:receive')
    assert.equal(params.get('code_challenge_method'),'S256')
    assert.ok(!result.url.includes(moduleConfig.secret))
    const data={state:params.get('state'),code:'module-test-code'}
    moduleChallenges.set(data.code,params.get('code_challenge'))
    expect(await post(start+'/complete',null,data),401)
    expect(await post('/stores/'+storeId+'/line-module/complete',admin,data),409)
    expect(await post(start+'/complete',admin,{...data,state:data.state.slice(0,32)+'e'.repeat(64)}),409)
    assert.equal(exchangedCode,undefined)
    const landing=await send('/line-module/return')
    assert.equal(landing.status,200)
    assert.match(await landing.text(),/公式LINEの連携/)

    botInfoUnavailable=true
    expect(await post(start+'/complete',admin,data),502)
    assert.equal(exchangedCode,data.code)
    assert.deepEqual(expect(await request(basePath+'/connections',{cookie:admin}),200),[])
    botInfoUnavailable=false
    const done=expect(await post(start+'/complete',admin,{...data,code:'exchange-must-not-repeat'}),200)
    assert.equal(exchangedCode,data.code)
    assert.deepEqual(expect(await post(start+'/complete',admin,data),200),done)
    const path=basePath+'/connections/'+done.id
    const summary=async()=>expect(await request(basePath+'/connections',{cookie:admin}),200)[0]
    const linked=await summary()
    assert.equal(linked.module_status,'attached')
    assert.equal(linked.label,'かんたん連携テスト')
    assert.equal(linked.basic_id,'@testshop')
    assert.equal(linked.liff_url,null)
    assert.equal(linked.status,'pending')
    assert.ok(!JSON.stringify(linked).includes(moduleConfig.secret))
    assert.ok(!JSON.stringify(linked).includes(moduleToken))
    assert.ok(!expect(await request('/stores/'+storeId+'/connections',{cookie:admin}),200).find(c=>c.id===done.id))
    expect(await request('/liff/'+done.id),409)
    assert.equal((await moduleWeb(moduleBot,[])).status,200)
    assert.equal((await moduleWeb(moduleBot,[message('偽の受信')],channelSecret)).status,401)
    assert.equal((await moduleWeb(bot,[message('別のチャネル')])).status,200)
    assert.equal((await summary()).module_status,'attached')
    assert.equal((await moduleWeb(moduleBot,[message('待機中','standby')])).status,200)
    assert.equal((await summary()).module_status,'standby')

    const tester=expect(await post(path+'/tests',admin,{purpose:'recruitment'},idempotency()),201)
    const verify=message('接続テスト '+tester.code)
    assert.equal((await moduleWeb(moduleBot,[verify])).status,200)
    assert.equal((await moduleWeb(moduleBot,[verify])).status,200)
    assert.equal((await moduleWeb(moduleBot,[message('動作確認')])).status,200)
    const ready=await summary()
    assert.equal(ready.module_status,'active')
    assert.equal(ready.checks.receive_verified,true)
    expect(await post(path+'/module-delivery',admin,{revision:ready.revision}),409)
    expect(await post(path+'/tests/'+tester.id+'/send',admin,{},idempotency()),202)
    await workOnce(pool,cfg,line,google)
    const sent=await summary()
    assert.equal(sent.checks.send_accepted,true)
    assert.equal(modulePushes.length,1)
    const confirmed=expect(await post(path+'/module-delivery',admin,{revision:sent.revision}),200)
    assert.equal(confirmed.status,'connected')
    const overview=async()=>expect(await request('/line-onboarding',{cookie:admin}),200).find(item=>item.id===store)
    assert.equal((await overview()).stage,'verified')
    const setup=basePath+'/line-onboarding'
    const ask=expect(await patch(setup,admin,{action:'set-mode',mode:'invite',revision:0}),200)
    const guide=expect(await patch(setup,admin,{action:'issue-guide',revision:ask.revision}),200)
    const guideToken=new URL(guide.guide.url).hash.slice(1)
    expect(await patch(setup,admin,{action:'confirm-access',connection:done.id,revision:guide.revision}),200)
    const guideStatus=async()=>expect(await post('/line-onboarding/guide',null,{token:guideToken}),200).status
    assert.equal(await guideStatus(),'verified')
    assert.equal((await moduleWeb(moduleBot,[{
      webhookEventId:randomUUID(),type:'module',mode:'active',timestamp:Date.now(),
      module:{type:'detached',botId:moduleBot},
    }])).status,200)
    assert.equal((await summary()).module_status,'detached')
    assert.equal((await summary()).checks.delivery_confirmed,undefined)
    assert.equal((await overview()).stage,'setting')
    assert.equal(await guideStatus(),'setting')
  } finally {
    delete cfg.lineModule
    botInfoUnavailable=false
  }
})

test('法人マスターだけが店舗別のLINE初期設定を管理し、店舗は案内リンクでLINEの招待を渡せる',async()=>{
  const name='LINE初期設定テスト店'
  const store=expect(await post('/stores',admin,storeData(name),idempotency()),201).id
  const endpoint='/stores/'+store+'/line-onboarding'
  const list=async()=>expect(await request('/line-onboarding',{cookie:admin}),200).find(item=>item.id===store)
  const lookup=async token=>post('/line-onboarding/guide',null,{token})
  const invite=(token,invitation,headers)=>post('/line-onboarding/guide/submit',null,{token,invitation},headers)
  const guideToken=detail=>new URL(detail.guide.url).hash.slice(1)
  const authURL='https://manager.line.biz/invitation/testTenantExampleInvite'
  const option=(mode,revision)=>({action:'set-mode',mode,revision})
  assert.equal((await list()).stage,'unknown')
  expect(await request('/line-onboarding'),401)
  expect(await request(endpoint,{cookie:other}),404)
  assert.ok(!expect(await request('/line-onboarding',{cookie:other}),200).some(item=>item.id===store))
  const memberEmail='onboarding-manager@example.test'
  const memberInvite=expect(await post('/staff/invites',admin,{email:memberEmail,role:'manager',stores:[store]},idempotency()),201)
  const member=await activate(memberInvite,memberEmail,'alpha')
  expect(await request('/line-onboarding',{cookie:member}),403)
  expect(await request(endpoint,{cookie:member}),403)
  expect(await patch(endpoint,member,option('invite',0)),403)
  const creating=expect(await patch(endpoint,admin,option('create',0)),200)
  assert.equal((await list()).stage,'uncreated')
  const waiting=expect(await patch(endpoint,admin,option('invite',creating.revision)),200)
  const issued=expect(await patch(endpoint,admin,{action:'issue-guide',revision:waiting.revision}),200)
  const raw=guideToken(issued)
  assert.equal(new URL(issued.guide.url).pathname,'/line-setup/invite')
  expect(await patch(endpoint,admin,{action:'issue-guide',revision:waiting.revision}),409)
  const landing=await send('/line-setup/invite')
  assert.equal(landing.status,200)
  assert.equal(landing.headers.get('x-robots-tag'),'noindex, nofollow')
  assert.match(await landing.text(),/公式LINEの管理者招待/)
  assert.deepEqual(expect(await lookup(raw),200),{store:name,company:'甲法人',status:'waiting'})
  expect(await lookup(randomBytes(32).toString('base64url')),404)
  expect(await invite(raw,authURL,{Origin:'https://other-origin.test'}),403)
  expect(await invite(raw,'https://manager.line.biz.example/invitation/testTenantExampleInvite'),400)
  expect(await invite(raw,'https://manager.line.biz/not-an-invitation'),400)
  assert.deepEqual(expect(await invite(raw,authURL),200),{store:name,company:'甲法人',status:'received'})
  expect(await invite(raw,'https://manager.line.biz/invitation/differentValidToken'),200)
  const receipt=expect(await request(endpoint,{cookie:admin}),200)
  assert.equal(receipt.invitation,authURL)
  assert.equal((await list()).stage,'received')
  assert.ok(!JSON.stringify(await list()).includes(authURL))
  const persisted=await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    return (await db.query('SELECT guide_box,invitation_box FROM line_onboarding WHERE store_id=$1',[store])).rows[0]
  })
  assert.notEqual(persisted.guide_box,raw)
  assert.notEqual(persisted.invitation_box,authURL)
  const renewed=expect(await patch(endpoint,admin,{action:'issue-guide',revision:receipt.revision}),200)
  expect(await lookup(raw),404)
  const active=guideToken(renewed)
  expect(await invite(active,authURL),200)
  const updated=expect(await request(endpoint,{cookie:admin}),200)
  expect(await patch(endpoint,admin,{action:'confirm-access',connection:c,revision:updated.revision}),404)
  const managed=expect(await patch(endpoint,admin,{action:'confirm-access',connection:null,revision:updated.revision}),200)
  assert.equal(managed.invitation,null)
  assert.equal((await list()).stage,'setting')
  assert.equal(expect(await lookup(active),200).status,'setting')
  await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    await db.query("UPDATE line_onboarding SET guide_expires_at=now()-interval '1 minute' WHERE store_id=$1",[store])
  })
  expect(await lookup(active),404)
})

test('公開入口からマスターを分離し、指定した法人管理者の二段階認証と割り当てを毎回確認する',async()=>{
  const tenant='master-guard'
  const email='master@example.test'
  const first=await bootstrap(owner,cfg,{slug:tenant,name:'マスター試験法人',email})
  const open=async (path,cookie)=>send(path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}})
  const guest=await open('/')
  const homepage=await guest.text()
  assert.equal(guest.status,200)
  assert.match(homepage,/応募・面談予約/)
  assert.doesNotMatch(homepage,/マスター|管理画面|admin\.mjs/)
  cfg.publicBookingConnection=c
  try {
    assert.equal((await open('/')).headers.get('location'),'/book/'+c)
    assert.equal((await open('/book/'+c)).status,200)
  } finally {
    delete cfg.publicBookingConnection
  }
  const signIn=await open('/master/')
  assert.equal(signIn.status,200)
  assert.equal(signIn.headers.get('x-robots-tag'),'noindex, nofollow')
  const form=await signIn.text()
  assert.match(form,/認証アプリ/)
  assert.doesNotMatch(form,/id="workspace"/)
  assert.equal((await open('/static/index.html')).status,404)
  assert.equal((await open('/interview/staff.html')).status,302)
  assert.equal((await open('/studio/')).status,302)
  expect(await request('/line-onboarding'),401)
  expect(await request('/staff'),401)

  expect(await post('/auth/activate',null,{invite:first.invite_code,password:pass,code:code(first.setup_key,-1)}),200)
  expect(await post('/auth/master/login',null,{tenant,email,password:pass}),400)
  const master=await post('/auth/master/login',null,{tenant,email,password:pass,code:code(first.setup_key)})
  expect(master,200)
  const workspace=await open('/master/',master.cookie)
  assert.equal(workspace.status,200)
  assert.match(await workspace.text(),/id="workspace"/)
  expect(await request('/line-onboarding',{cookie:master.cookie}),200)
  assert.equal((await open('/studio/',master.cookie)).status,200)
  assert.equal((await open('/interview/staff.html',master.cookie)).status,200)
  assert.equal((await open('/staff/?store='+storeId,master.cookie)).headers.get('location'),'/master/?store='+storeId)
  expect(await post('/staff/invites',master.cookie,{email:'extra@example.test',role:'admin',stores:[]},idempotency()),400)

  const store=expect(await post('/stores',master.cookie,storeData('権限試験店'),idempotency()),201).id
  const alternateEmail='alternate@example.test'
  const invite=expect(await post('/staff/invites',master.cookie,{email:alternateEmail,role:'manager',stores:[store]},idempotency()),201)
  expect(await post('/auth/activate',null,{invite:invite.invite_code,password:pass,code:code(invite.setup_key,-1)}),200)
  const alternateLogin={tenant,email:alternateEmail,password:pass,code:code(invite.setup_key)}
  expect(await post('/auth/master/login',null,alternateLogin),401)
  const staff=await post('/auth/login',null,alternateLogin)
  expect(staff,200)
  assert.equal((await open('/master/',staff.cookie)).headers.get('location'),'/')
  expect(await request('/line-onboarding',{cookie:staff.cookie}),403)
  expect(await request('/stores/'+store+'/connections',{cookie:staff.cookie}),200)

  const {tenant:identity}=expect(await request('/session',{cookie:master.cookie}),200)
  await tx(owner,async db=>{
    await scope(db,identity.id,undefined,true)
    await db.query("UPDATE staff SET role='admin' WHERE id=$1",[invite.id])
  })
  const nextCode={...alternateLogin,code:code(invite.setup_key,1)}
  expect(await post('/auth/login',null,nextCode),401)
  expect(await post('/auth/master/login',null,nextCode),401)
  expect(await request('/session',{cookie:staff.cookie}),401)
  expect(await request('/line-onboarding',{cookie:staff.cookie}),401)
  assert.doesNotMatch(await (await open('/master/',staff.cookie)).text(),/id="workspace"/)
  await assert.rejects(designateMaster(pool,tenant,alternateEmail),{code:'42501'})

  await designateMaster(owner,tenant,alternateEmail)
  expect(await request('/session',{cookie:master.cookie}),401)
  expect(await request('/line-onboarding',{cookie:master.cookie}),401)
  assert.doesNotMatch(await (await open('/master/',master.cookie)).text(),/id="workspace"/)
  const newMaster=await post('/auth/master/login',null,nextCode)
  expect(newMaster,200)
  expect(await request('/line-onboarding',{cookie:newMaster.cookie}),200)
})

test('北村さんはエールだけを管理し、エールの担当者のみ担当店舗で操作できる',async()=>{
  const creator='lilu'
  const email='kitamura@example.test'
  const input={slug:creator,name:'リルコーポレーション',displayName:'北村さん',email,agency:'alpha'}
  await assert.rejects(inviteSupervisor(pool,cfg,input),{code:'42501'})
  const invite=await inviteSupervisor(owner,cfg,input)
  await assert.rejects(inviteSupervisor(owner,cfg,{...input,slug:'another-supervisor'}),/既に登録/)
  expect(await post('/auth/activate',null,{invite:invite.invite_code,password:pass,code:code(invite.setup_key,-1)}),200)
  const loginData={tenant:creator,email,password:pass,code:code(invite.setup_key)}
  expect(await post('/auth/master/login',null,loginData),401)
  expect(await post('/auth/login',null,loginData),401)
  expect(await request('/platform/tenants',{cookie:admin}),401)
  const platform=await post('/auth/platform/login',null,loginData)
  expect(platform,200)
  assert.match(platform.cookie,/^night_platform=/)
  const {actor:supervisor}=expect(await request('/platform/session',{cookie:platform.cookie}),200)
  assert.equal(supervisor.display_name,'北村さん')
  assert.equal(supervisor.organization,'リルコーポレーション')
  expect(await request('/session',{cookie:platform.cookie}),401)
  expect(await request('/session',{cookie:platform.cookie.replace('night_platform=','night_session=')}),401)

  const alpha=expect(await request('/session',{cookie:admin}),200)
  const gamma=expect(await request('/session',{cookie:other}),200)
  const legal=expect(await request('/platform/tenants',{cookie:platform.cookie}),200)
  assert.deepEqual(legal.map(t=>t.id),[alpha.tenant.id])
  const open=async path=>send(path,{headers:{Cookie:platform.cookie},redirect:'manual'})
  assert.match(await (await open('/platform/')).text(),/管理会社の監督/)
  const scopePath=tenant=>'/platform/tenants/'+tenant+'/api/v1'
  async function scoped(tenant,path,method='GET',data,cookie=platform.cookie){
    const response=await send(scopePath(tenant)+path,{method,headers:{Origin:origin,Cookie:cookie,
      ...(data?{'Content-Type':'application/json',...idempotency()}:{}),
    },body:data?JSON.stringify(data):undefined})
    return {status:response.status,data:await response.json()}
  }
  const enter=tenant=>post('/platform/tenants/'+tenant+'/enter',platform.cookie,{})
  expect(await post('/platform/tenants/'+alpha.tenant.id+'/enter',admin,{}),401)
  const workA=expect(await enter(alpha.tenant.id),200)
  assert.equal(new URL(workA.url,origin).pathname,'/platform/tenants/'+alpha.tenant.id+'/master/')
  assert.match(await (await open(workA.url)).text(),/id="workspace"/)
  expect(await enter(gamma.tenant.id),404)
  expect(await scoped(gamma.tenant.id,'/session'),404)
  expect(await scoped(alpha.tenant.id,'/session','GET',undefined,admin),401)
  const one=expect(await scoped(alpha.tenant.id,'/session'),200)
  assert.equal(one.actor.platform,true)
  assert.deepEqual(one.stores.map(s=>s.id),alpha.stores.map(s=>s.id))
  const created=expect(await scoped(alpha.tenant.id,'/stores','POST',storeData('北村さんが登録した検証店')),201).id
  assert.ok(expect(await request('/session',{cookie:admin}),200).stores.some(s=>s.id===created))
  assert.ok(!expect(await request('/session',{cookie:other}),200).stores.some(s=>s.id===created))
  const trace=expect(await scoped(alpha.tenant.id,'/stores/'+created+'/audit'),200).find(entry=>entry.operation==='store.create')
  assert.equal(trace.actor,'全体管理者')
  assert.equal(trace.details.platform_staff_id,supervisor.id)
  const tenantTrace=expect(await request('/stores/'+created+'/audit',{cookie:admin}),200).find(entry=>entry.operation==='store.create')
  assert.equal(tenantTrace.details.platform_staff_id,undefined)

  const managerEmail='step-manager@example.test'
  const next=expect(await post('/staff/invites',admin,{email:managerEmail,role:'manager',stores:[storeId]},idempotency()),201)
  const manager=await activate(next,managerEmail,'alpha')
  assert.deepEqual(expect(await request('/session',{cookie:manager}),200).stores.map(item=>item.id),[storeId])
  const graph={...starter(),channel:c,name:'店舗別のステップ'}
  const path='/stores/'+storeId+'/scenarios'
  const step=expect(await post(path,manager,graph,idempotency()),201)
  const saved=expect(await patch(path+'/'+step.id,manager,{revision:step.revision,graph:{...graph,name:'担当店舗のステップ更新'}}),200)
  assert.equal(saved.graph.name,'担当店舗のステップ更新')
  expect(await request('/stores/'+otherStore+'/scenarios',{cookie:manager}),404)
  expect(await post('/stores/'+otherStore+'/scenarios',manager,graph,idempotency()),404)
  expect(await request('/line-onboarding',{cookie:manager}),403)
  expect(await request('/platform/tenants',{cookie:manager}),401)
  expect(await post('/platform/logout',platform.cookie,{}),200)
  expect(await scoped(alpha.tenant.id,'/session'),401)
  expect(await scoped(gamma.tenant.id,'/session'),401)
  await tx(owner,async db=>{
    await scope(db,alpha.tenant.id)
    await db.query('UPDATE staff SET agency_staff=false WHERE id=$1',[next.id])
  })
  expect(await request('/session',{cookie:manager}),401)
  expect(await post('/auth/login',null,{tenant:'alpha',email:managerEmail,password:pass,code:code(next.setup_key,1)}),401)
})

test('店長引き継ぎは会話単位でステップ配信と管理会社の返信を停止し、終了後は新しい配信を再開する',async()=>{
  const {store,root,connection,inbound}=await workflowStore('店長返信検証','customer','9',{inbox_enabled:true,campaigns_enabled:true})
  const path=root+'/workflows/customer/inbox'
  const draft=starter()
  const body='店長対応の自動配信テスト'
  await publish({...draft,name:'店長対応の検証',channel:connection,trigger:'manual',rejoin:true,cooldownDays:1,
    entry:'message',nodes:[{id:'message',type:'message',name:'案内',category:'service',body,next:'end'},
      {id:'end',type:'end',name:'完了'}]},store)
  const customer=await post('/customer/login',null,{connection,id_token:'signed-token-first-user'})
  const second=await post('/customer/login',null,{connection,id_token:'signed-token-second-user'})
  for(const person of [customer,second]){
    const account=expect(await request('/customer/account',{cookie:person.cookie}),200)
    expect(await patch('/customer/preferences',person.cookie,{revision:account.revision,version:account.policy_version,
      preferences:{service_consent:true,marketing_consent:true,all_stop:false}}),200)
  }
  for(const item of expect(await request(root+'/customers',{cookie:admin}),200)){
    expect(await patch(root+'/customers/'+item.id,admin,{revision:item.revision,display_name:'店長対応の検証',memo:'',
      assigned_to:null,verified20:true,active_chat:false,reason:'検証用の本人確認'}),200)
  }
  await inbound([event('handoff-follow-first','follow',Date.now()),
    {...event('handoff-follow-second','follow',Date.now()),source:{type:'user',userId:user2}},
    {...event('handoff-message-first','message',Date.now()),message:{id:'91001',type:'text',text:'店長へ質問'}}])
  await worker()
  const nowHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(new Date()))
  const clock=hour=>String((hour+24)%24).padStart(2,'0')+':00'
  const broadcast='店長対応の絞り込み配信テスト'
  const campaign=expect(await post(root+'/campaigns',admin,{channel:connection,title:broadcast,body:broadcast,
    scheduled_at:new Date().toISOString(),criteria:{tags:[],match:'all',last_visit_days:null,assigned_to:null,
      windowStart:clock(nowHour-1),windowEnd:clock(nowHour+2)}},idempotency()),201)
  assert.equal(campaign.eligible,2)
  expect(await post(root+'/campaigns/'+campaign.id+'/approve',admin,{recipients:2,approved:true}),200)
  const getThread=async()=>(expect(await request(path,{cookie:admin}),200).threads)[0]
  const thread=await getThread()
  const url=path+'/'+thread.id
  const {actor}=expect(await request('/session',{cookie:admin}),200)
  const {revision}=expect(await patch(url,admin,{revision:thread.revision,assigned_to:actor.id,state:'handling'}),200)
  const reply='引き継ぎ前に準備した返信'
  expect(await post(url,admin,{revision,body:reply,internal:false},idempotency()),201)
  const ready=await getThread()
  expect(await patch(url+'/handoff',other,{revision:ready.revision,minutes:30}),404)
  expect(await patch(url+'/handoff',admin,{revision:ready.revision,minutes:1}),400)
  const hold=expect(await patch(url+'/handoff',admin,{revision:ready.revision,minutes:30}),200)
  assert.ok(Date.parse(hold.handoff_until)>Date.now()+28*60000)
  const held=await getThread()
  assert.equal(held.handoff_until,hold.handoff_until)
  assert.equal(held.state,'open')
  expect(await patch(url+'/handoff',admin,{revision:ready.revision,minutes:null}),409)
  expect(await patch(url,admin,{revision:held.revision,state:'handling',assigned_to:actor.id}),409)
  const people=await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    return (await db.query(`SELECT c.id,t.id IS NOT NULL AS held FROM customer c LEFT JOIN inbox_thread t
      ON c.channel_id=t.channel_id AND c.user_key=t.user_key ORDER BY held DESC`)).rows
  })
  const start=id=>post(root+'/customers/'+id+'/enroll',admin,{reason:'店長対応を検証'},idempotency())
  for(const person of people)expect(await start(person.id),202)
  for(let i=0;i<4;i++)await worker()
  assert.deepEqual(pushesLog.filter(item=>item.messages[0].text===body).map(item=>item.to),[user2])
  assert.deepEqual(pushesLog.filter(item=>item.messages[0].text===broadcast).map(item=>item.to),[user2])
  assert.ok(!pushesLog.some(item=>item.messages[0].text===reply))
  const messages=expect(await request(url,{cookie:admin}),200)
  assert.equal(messages.find(item=>item.body===reply).status,'cancelled')

  await tx(pool,async db=>{
    await scope(db,signup.tenant,store)
    await db.query("UPDATE line_handoff SET until_at=now()-interval '1 second' WHERE channel_id=$1",[connection])
    await db.query("UPDATE enrollment SET ended_at=now()-interval '2 days' WHERE customer_id=$1 AND ended_at IS NOT NULL",[people[0].id])
  })
  const expired=await getThread()
  assert.equal(expired.handoff_until,null)
  expect(await start(people[0].id),202)
  for(let i=0;i<4;i++)await worker()
  assert.deepEqual(pushesLog.filter(item=>item.messages[0].text===body).map(item=>item.to),[user2,user])
  expect(await patch(url+'/handoff',admin,{revision:expired.revision,minutes:15}),200)
  expect(await patch(url+'/handoff',admin,{revision:(await getThread()).revision,minutes:null}),200)
  assert.equal((await getThread()).handoff_until,null)
})

test('採用専用LINEでは店長対応中の面談通知を見送り、終了後の新しい通知を送る', async()=>{
  const {root,connection,inbound}=await workflowStore('採用の店長引き継ぎ','recruitment','0',{inbox_enabled:true,reminders_enabled:true})
  const person=await post('/interview/login',null,{connection,id_token:'signed-token-first-user'})
  expect(person,200)
  const at=Date.now()
  assert.equal((await inbound([
    event('recruitment-handoff-follow','follow',at),
    {...event('recruitment-handoff-chat','message',at),message:{id:'41701',type:'text',text:'採用引き継ぎ確認'}},
  ])).status,200)
  await worker()
  expect(await put('/interview/notices',person.cookie,{enabled:true}),200)
  const day=Date.parse(expect(await request('/interview/calendar',{cookie:person.cookie}),200).today+'T00:00:00+09:00')+3*86400000
  const offer=async(hour,label)=>expect(await post(root+'/interviews/slots',admin,{channel:connection,
    starts_at:new Date(day+hour*3600000).toISOString(),ends_at:new Date(day+(hour+.5)*3600000).toISOString(),
    instructions:label,published:true},idempotency()),201).id
  const before=await offer(18,'引き継ぎ前の試験')
  const during=await offer(19,'引き継ぎ中の試験')
  const after=await offer(20,'引き継ぎ終了後の試験')
  const delivered=phrase=>pushesLog.filter(p=>p.to===user&&p.messages.some(m=>m.text.includes(phrase))).length
  const book=async slot=>expect(await confirmation(person.cookie,slot,'引き継ぎ 検証'),201)
  const cancel=async item=>expect(await patch('/interview/bookings/'+item.id,person.cookie,{action:'cancel',revision:item.revision}),200)
  const inbox=root+'/workflows/recruitment/inbox'
  const current=async()=>(expect(await request(inbox,{cookie:admin}),200).threads)[0]

  const baseline=await book(before)
  await worker()
  assert.equal(delivered('引き継ぎ前の試験'),1)
  await cancel(baseline)

  const thread=await current()
  const endpoint=inbox+'/'+thread.id+'/handoff'
  expect(await patch(endpoint,admin,{revision:thread.revision,minutes:15}),200)
  const held=await book(during)
  await worker()
  assert.equal(delivered('引き継ぎ中の試験'),0)
  const logs=expect(await request(root+'/workflows/recruitment/delivery',{cookie:admin}),200)
  assert.ok(logs.some(r=>r.kind==='interview_confirm'&&r.status==='cancelled'&&r.reason==='店長対応中'))

  await cancel(held)
  expect(await patch(endpoint,admin,{revision:(await current()).revision,minutes:null}),200)
  await book(after)
  await worker()
  assert.equal(delivered('引き継ぎ終了後の試験'),1)
  assert.equal(delivered('引き継ぎ中の試験'),0)
})
