import {previousCode} from './helpers/totp.mjs'
import assert from 'node:assert/strict'
import {createHmac,randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {before,after,test} from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import {Secret,TOTP} from 'otpauth'
import {createApp} from '../dist/app.js'
import {keyed,poolFor,scope,tx,unseal} from '../dist/core.js'
import {bootstrap,migrate} from '../dist/setup.js'
import {LineAPI} from '../dist/line.js'
import {workOnce} from '../dist/jobs.js'
import {intakeTemplate,normalizeAnswer,unblockSettings} from '../public/studio/interview-intake-template.mjs'

const origin='https://example.test',cfg={origin,master:randomBytes(32),external:true,automation:true}
const bot='U'+'1'.repeat(32),user='U'+'2'.repeat(32),other='U'+'3'.repeat(32)
const lineSecret='a'.repeat(32),password='Synthetic-local-password-2026!'
const consoleChecks={ownership_verified:true,provider_verified:true,redelivery_enabled:true,auto_reply_checked:true,non_developer:true,delivery_confirmed:true,token_verified:true,webhook_verified:true}
const pushes=[]
const line=new LineAPI(async(url,opts)=>{
  switch(new URL(url).pathname){
    case '/v2/oauth/verify':return Response.json({client_id:'1234567890'})
    case '/v2/bot/info':return Response.json({userId:bot})
    case '/v2/bot/message/quota':return Response.json({type:'limited',value:1000})
    case '/v2/bot/message/quota/consumption':return Response.json({totalUsage:0})
    case '/v2/bot/message/push':pushes.push(JSON.parse(opts.body));return Response.json({})
    default:throw new Error('Unexpected LINE request')
  }
})
let pg,owner,pool,dir,server,base,admin,tenant,store,connection,url
const wait=()=>new Promise(resolve=>setTimeout(resolve,8))
const call=async(path,{method='GET',data,cookie=admin}={})=>{
  const response=await fetch(base+'/api/v1'+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()})},body:data===undefined?undefined:JSON.stringify(data)})
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}
}
const expect=(res,status)=>{assert.equal(res.status,status,JSON.stringify(res.data));return res.data}
const read=(sql,args=[])=>tx(pool,async db=>{await scope(db,tenant,store);return db.query(sql,args)})
const worker=()=>workOnce(pool,cfg,line)
const sent=who=>pushes.filter(p=>p.to===who).map(p=>p.messages[0])
const latest=who=>sent(who).at(-1)
async function inbound(who,type,text,eventId=randomUUID(),follow){
  await wait()
  const raw=JSON.stringify({destination:bot,events:[{webhookEventId:eventId,type,timestamp:Date.now(),source:{type:'user',userId:who},...(follow?{follow}:{}),...(text!==undefined?{message:{id:randomUUID(),type:'text',text}}:{})}]})
  const response=await fetch(base+'/api/v1/webhooks/line/'+connection,{method:'POST',headers:{'Content-Type':'application/json','X-Line-Signature':createHmac('sha256',lineSecret).update(raw).digest('base64')},body:raw})
  assert.equal(response.status,200)
  await worker()
}
before(async()=>{
  const probe=createServer().listen(0,'127.0.0.1')
  await new Promise(resolve=>probe.once('listening',resolve));const port=probe.address().port
  await new Promise(resolve=>probe.close(resolve))
  dir=await mkdtemp(join(tmpdir(),'npl-intake-'))
  pg=new EmbeddedPostgres({databaseDir:join(dir,'db'),user:'night_owner',password:'owner-test',port,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--locale=C','--encoding=UTF8'],postgresFlags:['-h','127.0.0.1','-c','unix_socket_directories='],onLog:()=>{}})
  await pg.initialise();await pg.start()
  owner=poolFor('postgresql://night_owner:owner-test@127.0.0.1:'+port+'/postgres')
  await owner.query("CREATE ROLE night_app LOGIN NOBYPASSRLS PASSWORD 'app-test'")
  pool=poolFor('postgresql://night_app:app-test@127.0.0.1:'+port+'/postgres');await migrate(owner,'night_app')
  server=createApp(pool,cfg,line).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port
  const invitation=await bootstrap(owner,cfg,{slug:'intake',name:'架空法人',email:'operator@example.test'})
  expect(await call('/auth/activate',{cookie:null,method:'POST',data:{invite:invitation.invite_code,password,code:await previousCode(invitation.setup_key)}}),200)
  const auth=await call('/auth/login',{cookie:null,method:'POST',data:{tenant:'intake',email:'operator@example.test',password,code:new TOTP({secret:Secret.fromBase32(invitation.setup_key)}).generate()}})
  expect(auth,200);admin=auth.cookie
  tenant=expect(await call('/session'),200).tenant.id
  store=expect(await call('/stores',{method:'POST',data:{name:'サンプル事業所',address:'東京都',business_type:'接客飲食',responsible:'担当者',timezone:'Asia/Tokyo',cutoff:'06:00'}}),201).id
  connection=expect(await call('/stores/'+store+'/connections',{method:'POST',data:{owner_name:'架空法人',provider_id:'provider',account_type:'unverified',management_authority:'検証用',channel_secret:lineSecret,token_type:'console',label:'採用OA',purpose:'recruitment',messaging_id:'1234567890',access_token:'test-channel-token'}}),201).id
  await read('UPDATE channel SET checks=$2,bot_user_id=$3 WHERE id=$1',[connection,consoleChecks,bot])
  await read("UPDATE store SET eligible_at=now(),contract_active=true,auto_enabled=true,auto_enabled_at=now(),monthly_limit=1000,forms_enabled=true,recruitment_enabled=true,interviews_enabled=true,token_interviews_enabled=true,reminders_enabled=true WHERE id=$1",[store])
  url='/stores/'+store+'/recruitment-intake'
})
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await Promise.allSettled([pool?.end(),owner?.end()]);if(pg)await pg.stop();if(dir)await rm(dir,{recursive:true,force:true})})

test('匿名テンプレートの下書き・公開、LINEで一問ずつ回答、予約と3時間前カード・OKまで',async()=>{
  const initial=expect(await call(url+'/'+connection),200)
  assert.equal(initial.revision,0);assert.equal(initial.active,false)
  assert.deepEqual(expect(await call(url),200),[],'未保存のテンプレートは一覧に出さない')
  expect(await call(url,{cookie:null}),401)
  const draft=expect(await call(url,{method:'PUT',data:{channel:connection,revision:0,settings:{...intakeTemplate,faqUrl:'https://example.test/faq',mapUrl:'https://example.test/map'}}}),200)
  assert.equal(draft.active,false);assert.equal(pushes.length,0)
  const savedList=expect(await call(url),200);assert.equal(savedList.length,1);assert.equal(savedList[0].channel_id,connection);assert.equal(savedList[0].revision,draft.revision);assert.equal(savedList[0].active,false);assert.equal(savedList[0].stopped,false);assert.ok(!Object.hasOwn(savedList[0],'draft'));assert.ok(!Object.hasOwn(savedList[0],'credentials'))
  const otherStore=expect(await call('/stores',{method:'POST',data:{name:'別のサンプル事業所',address:'東京都',business_type:'接客飲食',responsible:'担当者',timezone:'Asia/Tokyo',cutoff:'06:00'}}),201).id
  assert.deepEqual(expect(await call('/stores/'+otherStore+'/recruitment-intake'),200),[],'同一法人の他店の下書きを表示しない')
  assert.deepEqual(expect(await call('/stores/'+store+'/scenarios?summary=1'),200),[],'トーク型の下書きは通常シナリオと二重登録しない')
  const stale=await call(url+'/action',{method:'POST',data:{channel:connection,revision:99,action:'publish'}})
  assert.equal(stale.status,409)
  const live=expect(await call(url+'/action',{method:'POST',data:{channel:connection,revision:draft.revision,action:'publish'}}),200)
  assert.equal(live.active,true)
  const publishedList=expect(await call(url),200);assert.equal(publishedList.length,1);assert.equal(publishedList[0].active,true);assert.equal(publishedList[0].live_revision,live.live_revision)
  const forms=expect(await call('/stores/'+store+'/workflows/recruitment/forms'),200)
  assert.equal(forms.forms.length,0,'チャット専用フォームが通常フォームに混入しない')
  await inbound(user,'follow')
  assert.match(latest(user).text,/サンプル事業所/);assert.equal(latest(user).quickReply.items[0].action.text,'応募する')
  await inbound(user,'message','応募する')
  assert.match(latest(user).text,/氏名・最寄駅・年齢/)
  await inbound(user,'message','通知ありで応募')
  assert.match(latest(user).text,/お名前/)
  const nameEvent=randomUUID()
  await inbound(user,'message','架空応募者', nameEvent)
  assert.match(latest(user).text,/最寄駅/)
  const count=sent(user).length
  await inbound(user,'message','架空応募者',nameEvent)
  assert.equal(sent(user).length,count,'同じWebhookを二度処理しない')
  await inbound(user,'message','架空駅')
  assert.match(latest(user).text,/ご年齢/)
  await inbound(user,'message','二十五歳')
  assert.match(latest(user).text,/数字のみ/)
  await inbound(user,'message','２５')
  assert.match(latest(user).text,/架空応募者さま/)
  const token=latest(user).text.match(/\?t=([A-Za-z0-9_-]{43})/)?.[1]
  assert.ok(token)
  const rows=(await read("SELECT id,answers_box FROM workflow_response")).rows
  assert.equal(rows.length,1)
  const answers=JSON.parse(unseal(cfg,'form-response:'+rows[0].id,rows[0].answers_box)).answers
  assert.deepEqual(answers.map(x=>x.value),['架空応募者','架空駅','25'])
  assert.equal((await read('SELECT count(*)::int AS n FROM webhook_event WHERE intake_phrase_box IS NOT NULL')).rows[0].n,0)
  assert.equal((await read('SELECT answers_box FROM recruitment_intake_run WHERE channel_id=$1',[connection])).rows[0].answers_box,null)
  const future=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+3*86400000))
  const slot=expect(await call('/stores/'+store+'/interviews/slots',{method:'POST',data:{channel:connection,starts_at:future+'T19:00:00+09:00',ends_at:future+'T19:30:00+09:00',instructions:'検証会場',published:true}}),201)
  const redeemed=await call('/interview-link/'+connection+'/redeem',{cookie:null,method:'POST',data:{token}})
  expect(redeemed,200)
  assert.equal(expect(await call('/interview/form',{cookie:redeemed.cookie}),200),null)
  const booking=expect(await call('/interview/bookings',{cookie:redeemed.cookie,method:'POST',data:{slot:slot.id,name:'架空応募者'}}),201)
  await worker()
  assert.equal(latest(user).type,'flex')
  assert.deepEqual(latest(user).contents.footer.contents.map(b=>b.action.label),['予約の変更・キャンセル','よくある質問','お店の地図'])
  const reminder=(await read("SELECT id,next_at FROM service_delivery WHERE object_id=$1 AND kind='interview_reminder_3h'",[booking.id])).rows[0]
  assert.equal(+reminder.next_at,Date.parse(future+'T19:00:00+09:00')-3*3600000)
  // Advance only this isolated fake appointment to the scheduled send time.
  await read("UPDATE interview_slot SET starts_at=now()+interval '179 minutes',ends_at=now()+interval '209 minutes' WHERE id=$1",[slot.id])
  await read("UPDATE service_delivery SET next_at=now(),expires_at=now()+interval '20 minutes' WHERE id=$1",[reminder.id])
  await worker()
  assert.match(latest(user).contents.body.contents[0].text,/3時間前/)
  assert.equal(latest(user).quickReply.items[0].action.label,'OK')
  await inbound(user,'message','面談確認OK')
  const proof=(await read('SELECT arrival_confirmed_revision,revision FROM interview_booking WHERE id=$1',[booking.id])).rows[0]
  assert.equal(proof.arrival_confirmed_revision,proof.revision)
  await inbound(other,'message','面談確認OK')
  const countBefore=sent(other).length
  await inbound(other,'message','応募する');assert.equal(sent(other).length,countBefore+1)
  await inbound(other,'message','通知なしで応募');assert.match(latest(other).text,/お名前/)
  await inbound(other,'message','別人')
  await inbound(other,'message','応募取消')
  assert.equal((await read('SELECT stage,answers_box FROM recruitment_intake_run WHERE channel_id=$1 AND applicant_key=$2',[connection,keyed(cfg,'interview:'+connection+':'+other)])).rows[0].stage,'cancelled')
  const afterCancel=sent(other).length
  await inbound(other,'message','架空駅')
  assert.equal(sent(other).length,afterCancel)
  const current=expect(await call(url+'/'+connection),200)
  const stopped=expect(await call(url+'/action',{method:'POST',data:{channel:connection,revision:current.revision,action:'stop'}}),200)
  assert.equal(stopped.active,false)
  const stoppedList=expect(await call(url),200);assert.equal(stoppedList.length,1);assert.equal(stoppedList[0].stopped,true);assert.equal(stoppedList[0].active,false)
  await inbound(other,'message','応募する')
  assert.equal(sent(other).length,afterCancel)
})

test('ブロック解除は共通の型で再開し、専用文面・OFF・明示停止・既存応募・重複再送を安全に扱う',async()=>{
  const newUser='U'+'4'.repeat(32),customUser='U'+'5'.repeat(32),stoppedUser='U'+'6'.repeat(32),offUser='U'+'7'.repeat(32)
  const release=(who,id=randomUUID(),flag=true)=>inbound(who,'follow',undefined,id,{isUnblocked:flag})
  const saveAndPublish=async settings=>{const old=expect(await call(url+'/'+connection),200);const saved=expect(await call(url,{method:'PUT',data:{channel:connection,revision:old.revision,settings}}),200);return expect(await call(url+'/action',{method:'POST',data:{channel:connection,revision:saved.revision,action:'publish'}}),200)}
  const original=expect(await call(url+'/'+connection),200).draft
  assert.equal(unblockSettings(original).mode,'same')
  await saveAndPublish(original)
  await inbound(newUser,'follow');const greeting=latest(newUser).text,initial=sent(newUser).length
  await inbound(newUser,'unfollow');assert.equal(sent(newUser).length,initial)
  const releaseId=randomUUID();await release(newUser,releaseId);assert.equal(latest(newUser).text,greeting);assert.equal(sent(newUser).length,initial+1)
  await release(newUser,releaseId);assert.equal(sent(newUser).length,initial+1,'同じ解除イベントで重複送信しない')
  await inbound(newUser,'message','応募する');assert.match(latest(newUser).text,/応募に必要な情報/)
  await inbound(newUser,'message','通知なしで応募');assert.equal(latest(newUser).text,original.name)
  const count=(await read('SELECT count(*)::int AS n FROM workflow_response')).rows[0].n
  await inbound(user,'unfollow');await release(user);await inbound(user,'message','応募する');await inbound(user,'message','通知なしで応募');assert.match(latest(user).text,/回答済み/);assert.equal((await read('SELECT count(*)::int AS n FROM workflow_response')).rows[0].n,count,'以前の回答を重複作成しない')
  const customized={...original,unblock:{...unblockSettings(original),mode:'custom',greeting:'再開のご案内：{{store}}',name:'再開時のお名前を入力',station:'再開時の駅名を入力',age:'再開時の年齢を入力',thanks:'{{name}}さん、再開用の予約はこちらです。'}}
  await saveAndPublish(customized);assert.equal(expect(await call(url),200)[0].unblock_mode,'custom')
  await inbound(customUser,'follow');assert.equal(latest(customUser).text,greeting,'新規友だちは共通の文面のまま')
  await inbound(customUser,'unfollow');await release(customUser,randomUUID(),false);assert.match(latest(customUser).text,/再開のご案内/,'フラグが不正確でも直前のブロック履歴で解除を識別する')
  await inbound(customUser,'message','応募する');await inbound(customUser,'message','通知なしで応募');assert.equal(latest(customUser).text,customized.unblock.name)
  await inbound(customUser,'message','架空応募者復帰');assert.equal(latest(customUser).text,customized.unblock.station)
  await inbound(customUser,'message','架空駅');assert.equal(latest(customUser).text,customized.unblock.age)
  await inbound(customUser,'message','25');assert.match(latest(customUser).text,/再開用の予約/);assert.equal((await read('SELECT count(*)::int AS n FROM workflow_response')).rows[0].n,count+1)
  await inbound(stoppedUser,'follow');await inbound(stoppedUser,'message','全配信停止');const stoppedCount=sent(stoppedUser).length
  await inbound(stoppedUser,'unfollow');await release(stoppedUser);assert.equal(sent(stoppedUser).length,stoppedCount,'明示的な全配信停止を解除だけで変更しない')
  await saveAndPublish({...customized,unblock:{...customized.unblock,mode:'off'}})
  await inbound(offUser,'follow');const offCount=sent(offUser).length;await inbound(offUser,'unfollow');await release(offUser);assert.equal(sent(offUser).length,offCount)
  await inbound(offUser,'message','応募する');assert.match(latest(offUser).text,/応募に必要な情報/,'OFFでも本人からの応募は妨げない')
})

test('年齢は数値形式だけ検証し、回答者の氏名・最寄駅は原文のまま扱う',()=>{
  assert.equal(normalizeAnswer('age','２５'),'25')
  assert.equal(normalizeAnswer('age','25歳'),null)
  assert.equal(normalizeAnswer('age','121'),null)
  assert.equal(normalizeAnswer('name','髙橋'),'髙橋')
  assert.equal(normalizeAnswer('station',''),null)
})
