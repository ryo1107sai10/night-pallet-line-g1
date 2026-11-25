import assert from 'node:assert/strict'
import {test} from 'node:test'
import {starter,validate,simulate} from '../public/studio/engine.mjs'
import {moveStepBlock,reconnectEdge,selectOutlineRange,wizardFlow} from '../public/studio/studio-tools.mjs'
import {sanitizeStudioImage} from '../dist/studio-media.js'
import sharp from 'sharp'

test('接続変更は循環を作らず、未接続になるステップを明示する',()=>{
 const flow=starter('recruitment');flow.channel='test'
 const bad=reconnectEdge(flow,{owner:'nudge',key:'next'},'welcome');assert.equal(bad,null)
 const good=reconnectEdge(flow,{owner:'branch',key:'yes'},'nudge');assert.deepEqual(good.detached,['予約済みのため終了']);assert.equal(good.flow.nodes.find(n=>n.id==='branch').yes,'nudge');assert.equal(flow.nodes.find(n=>n.id==='branch').yes,'booked')
 assert.ok(validate(good.flow,true).length>0)
})
test('別分岐への移動は既存のステップID・到達性と元データを維持する',()=>{
 const f=starter('recruitment');f.channel='test';const result=moveStepBlock(f,['nudge'],{owner:'branch',key:'yes'});assert.ok(result)
 assert.equal(result.flow.nodes.find(n=>n.id==='branch').yes,'nudge');assert.equal(result.flow.nodes.find(n=>n.id==='branch').no,'end');assert.equal(result.flow.nodes.find(n=>n.id==='nudge').next,'booked');assert.deepEqual(validate(result.flow,true),[])
 assert.equal(f.nodes.find(n=>n.id==='branch').yes,'booked');assert.equal(moveStepBlock(f,['booked'],{owner:'branch',key:'no'}),null)
 assert.deepEqual(selectOutlineRange(f,'welcome','branch'),['welcome','wait','branch'])
})
test('返信・予約・同意撤回の時系列シミュレーションは待機後に最新状態を評価する',()=>{
 const flow=wizardFlow({name:'応募案内',purpose:'recruitment',channel:'test',trigger:'form',first:'初回',follow:'再案内',minutes:1440,skipBooked:true})
 const person={zone:'Asia/Tokyo',cutoff:'06:00',start:'2026-11-26T18:00',bookingAt:'',booked:false,consent:true,adult:true,assigned:true,dayCount:0,weekCount:0,tags:[],values:{},bookingLinkValid:true}
 assert.equal(simulate(flow,person).count,2)
 const result=simulate(flow,{...person,timeline:[{afterMinutes:180,action:'reply'},{afterMinutes:720,action:'book',bookingAt:'2026-11-28T19:00'}]})
 assert.equal(result.count,1);assert.equal(result.events.find(e=>e.id==='check').branch,'yes');assert.equal(result.events.filter(e=>e.type==='event').length,2)
 assert.equal(simulate(flow,{...person,timeline:[{afterMinutes:180,action:'consent_off'}]}).events.find(e=>e.id==='remind').state,'held')
 assert.equal(person.booked,false);assert.equal(simulate(flow,{...person,timeline:[{afterMinutes:-1,action:'reply'}]}).errors.length,1)
})
test('画像処理は許可された画像だけを再エンコードし、元の画像メタデータを残さない',async()=>{
 const png=await sharp({create:{width:32,height:24,channels:3,background:'#987ed2'}}).png().toBuffer();const image=await sanitizeStudioImage(png)
 const meta=await sharp(image.data).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,32);assert.equal(image.height,24);assert.equal(meta.exif,undefined)
 await assert.rejects(()=>sanitizeStudioImage(Buffer.from('plain text')));await assert.rejects(()=>sanitizeStudioImage(Buffer.alloc(4*1024*1024+1)))
})
