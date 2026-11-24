import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Secret,TOTP} from 'otpauth'
import {previousCode} from './helpers/totp.mjs'
const key='JBSWY3DPEHPK3PXP'
const totp=()=>new TOTP({secret:Secret.fromBase32(key)})

test('認証の試験は時刻の切り替わりをまたいでも有効な前区間のコードを使う',async()=>{
  let time=59990
  const expired=totp().generate({timestamp:time-30000})
  assert.equal(totp().validate({token:expired,timestamp:time+200,window:1}),null)
  const code=await previousCode(key,{now:()=>time,pause:async duration=>{time+=duration}})
  assert.equal(time,60050)
  assert.equal(totp().validate({token:code,timestamp:time+200,window:1}),-1)
})

test('認証の試験は区間の前半なら待機せず、現区間をログイン用に残す',async()=>{
  const time=64500
  const code=await previousCode(key,{now:()=>time,pause:()=>{throw new Error('Unnecessary wait')}})
  assert.equal(totp().validate({token:code,timestamp:time,window:1}),-1)
  assert.notEqual(code,totp().generate({timestamp:time}))
})
