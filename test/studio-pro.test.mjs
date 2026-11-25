import assert from 'node:assert/strict'
import {test} from 'node:test'
import {starter,validate,evaluateBranch,simulate} from '../public/studio/engine.mjs'
import {stepBlock,pasteBlock,stepOutline,wizardFlow,tagKeys,copyFlow} from '../public/studio/studio-tools.mjs'
import {lineMessage,richErrors} from '../public/studio/message-format.mjs'
import {LineAPI} from '../dist/line.js'

test('複数条件はAND・OR・否定とタグの照合を同じ評価器で処理する',()=>{
  const b={condition:'all',rules:[{condition:'booked',negated:true},{condition:'tag',tag:'applicant'}]}
  assert.equal(evaluateBranch(b,{booked:false},['applicant']),true)
  assert.equal(evaluateBranch(b,{booked:true},['applicant']),false)
  assert.equal(evaluateBranch(b,{booked:false},[]),false)
  assert.equal(evaluateBranch({...b,condition:'any'},{booked:true},['applicant']),true)
  const flow=starter('recruitment');flow.channel='test';Object.assign(flow.nodes.find(n=>n.id==='branch'),b)
  assert.equal(validate(flow,true).length,0);assert.ok(tagKeys(flow).includes('applicant'))
  const copied=copyFlow(flow,{name:'new',channel:'other',sourceName:'old',targetName:'new',tagMap:{applicant:'other-tag'}})
  assert.equal(copied.nodes.find(n=>n.id==='branch').rules[1].tag,'other-tag')
  flow.nodes.find(n=>n.id==='branch').rules=[];assert.ok(validate(flow,true).some(e=>e.nodeId==='branch'))
})
test('選択したブロックを複製して既存の開始点・接続を壊さない',()=>{
  const flow=starter('recruitment');flow.channel='test'
  assert.equal(stepBlock(flow,['welcome','nudge']),null)
  const block=stepBlock(flow,['welcome','wait','branch']);assert.equal(block.entry,'welcome')
  let i=0;const pasted=pasteBlock(flow,{owner:'branch',key:'no'},block,()=>`copy-${++i}`)
  assert.equal(pasted.flow.nodes.length,9);assert.equal(pasted.flow.nodes.find(n=>n.id==='branch').no,pasted.entry)
  assert.deepEqual(validate(pasted.flow,true),[]);assert.equal(flow.nodes.length,6)
  assert.ok(stepOutline(pasted.flow).find(n=>n.id===pasted.entry).path.includes('branch:no'))
  assert.equal(pasteBlock(flow,{owner:'welcome',key:'next'},stepBlock(flow,['end']),()=> 'endcopy'),null)
})
test('作成ウィザードは面談済みの再案内を止める有効な下書きを生成する',()=>{
 const flow=wizardFlow({name:'応募案内',channel:'test',trigger:'form',first:'最初',follow:'再案内',minutes:60,skipBooked:true})
 assert.deepEqual(validate(flow,true),[])
 const person={zone:'Asia/Tokyo',cutoff:'06:00',start:'2026-11-26T18:00',bookingAt:'',consent:true,adult:true,assigned:true,dayCount:0,weekCount:0,tags:[],values:{},bookingLinkValid:true}
 assert.equal(simulate(flow,{...person,booked:true}).count,1)
 assert.equal(simulate(flow,{...person,booked:false}).count,2)
})
test('LINE画像カード・リンクボタンは実際のMessaging API形式、1メッセージで送信される',async()=>{
  const rich={kind:'card',title:'対面面談',imageUrl:'https://images.example.test/photo.jpg',buttons:[{label:'詳細',url:'https://example.test/detail'}]}
  assert.deepEqual(richErrors(rich,'案内'),[])
  const m=lineMessage('ご案内',rich);assert.equal(m.type,'flex');assert.equal(m.contents.hero.url,rich.imageUrl);assert.equal(m.contents.footer.contents[0].action.uri,rich.buttons[0].url)
  let request
  const line=new LineAPI(async(url,options)=>{request=JSON.parse(options.body);return new Response('{}',{status:200})})
  const response=await line.push({access_token:'local-test'},'U'+'1'.repeat(32),'local-attempt','ご案内',rich)
  assert.equal(response.status,'accepted');assert.deepEqual(request.messages,[m])
  assert.ok(richErrors({...rich,buttons:[{label:'詳細',url:'javascript:alert(1)'}]}).length)
  assert.ok(richErrors({...rich,kind:'image',imageUrl:''}).length)
  assert.deepEqual(lineMessage('テキスト'),{type:'text',text:'テキスト'})
})
