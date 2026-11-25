import assert from 'node:assert/strict'
import {test} from 'node:test'
import {LineAPI} from '../dist/line.js'

test('LINE運用障害を機密情報なしで記録し、通常の拒否・リトライ受付を障害と混同しない',async t=>{
  const warnings=[]
  t.mock.method(console,'warn',m=>warnings.push(JSON.parse(m)))
  const cred={access_token:'LOCAL_ONLY_TOKEN',channel_secret:'a'.repeat(32),token_type:'console'}
  const user='U'+'1'.repeat(32)
  const body='LOCAL_ONLY_BODY'
  let status=401
  const api=new LineAPI(async()=>new Response('{}',{status,headers:status===409?{'x-line-accepted-request-id':'accepted'}:{}}))
  for(const code of [401,403,429,502]){
    status=code
    await api.push(cred,user,'retry-id',body)
  }
  status=400;await api.push(cred,user,'retry-id',body)
  status=409;assert.equal((await api.push(cred,user,'retry-id',body)).status,'accepted')
  status=200;assert.equal((await api.push(cred,user,'retry-id',body)).status,'accepted')
  const offline=new LineAPI(async()=>{throw new Error('LOCAL_ONLY_PRIVATE_ERROR')})
  await assert.rejects(offline.push(cred,user,'retry-id',body),{code:'LINE_UNAVAILABLE'})
  assert.deepEqual(warnings.map(w=>w.status??w.reason),[401,403,429,502,'network'])
  assert.ok(warnings.every(w=>w.event==='integration_failure'&&w.provider==='line'&&w.operation==='push'))
  assert.ok(!JSON.stringify(warnings).includes('LOCAL_ONLY'))
})
