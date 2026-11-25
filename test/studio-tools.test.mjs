import assert from 'node:assert/strict'
import {test} from 'node:test'
import {starter,validate} from '../public/studio/engine.mjs'
import {insertStep,incomingEdges,outgoingEdges,formatMinutes,timeUnit,copyFlow,bodyReplacement,compareFlows,simulationCases,tagKeys} from '../public/studio/studio-tools.mjs'

test('途中・分岐・終了の手前へ挿入しても既存接続を維持する',()=>{
  const flow=starter('recruitment');flow.channel='test'
  const edge=outgoingEdges(flow,'booked')[0]
  assert.deepEqual(edge,{owner:'branch',key:'yes'})
  const draft=insertStep(flow,edge,'wait','inserted')
  const n=draft.nodes.find(n=>n.id==='inserted')
  assert.equal(n.next,'booked')
  assert.equal(draft.nodes.find(n=>n.id==='branch').yes,'inserted')
  assert.equal(draft.nodes.find(n=>n.id==='branch').no,'nudge')
  assert.deepEqual(validate(draft,true),[])
  const branch=insertStep(draft,{owner:null,key:'entry'},'branch','front')
  assert.equal(branch.entry,'front')
  assert.equal(branch.nodes.find(n=>n.id==='front').yes,flow.entry)
  assert.equal(branch.nodes.find(n=>n.id==='front').no,flow.entry)
  assert.deepEqual(validate(branch,true),[])
  assert.equal(insertStep(branch,{owner:'front',key:'no'},'end','bad'),null)
  assert.equal(flow.entry,'welcome')
})
test('待機単位を正しい分数・読みやすい表記で維持する',()=>{
  assert.deepEqual(timeUnit(1440),{value:1,unit:1440})
  assert.deepEqual(timeUnit(120),{value:2,unit:60})
  assert.equal(formatMinutes(2880),'2日')
  assert.equal(formatMinutes(90),'90分')
})
test('店舗複製でLINE・タグ・店舗名・本システム予約URLだけ対応付ける',()=>{
  const source=starter('recruitment')
  source.trigger='tag_added';source.triggerTag='first';source.channel='old'
  const m=source.nodes.find(n=>n.type==='message')
  m.body='旧店舗 へ応募 https://app.example/reserve/opaque https://other.example/page'
  m.tagGuard={tag:'first',exclude:['stop'],booked:false}
  const b=source.nodes.find(n=>n.type==='branch');b.condition='tag';b.tag='first'
  assert.deepEqual(tagKeys(source),['first','stop'])
  const result=copyFlow(source,{name:'  複製  ',channel:'new',sourceName:'旧店舗',targetName:'新店舗',tagMap:{first:'next',stop:'halt'},origin:'https://app.example'})
  assert.equal(result.name,'複製');assert.equal(result.channel,'new')
  assert.equal(result.triggerTag,'next')
  assert.equal(result.nodes[0].body,'{{store}} へ応募 {{interview_link}} https://other.example/page')
  assert.deepEqual(result.nodes[0].tagGuard,{tag:'next',exclude:['halt'],booked:false})
  assert.equal(result.nodes.find(n=>n.type==='branch').tag,'next')
  assert.equal(source.channel,'old')
})
test('メッセージ一括編集は下書きだけを変え、版差分を識別する',()=>{
  const flow=starter('recruitment')
  flow.nodes[0].body='面談 面談';flow.nodes.find(n=>n.id==='nudge').body='面談'
  const edited=bodyReplacement(flow,'面談','対面面談')
  assert.equal(edited.count,3);assert.equal(edited.steps,2)
  assert.equal(flow.nodes[0].body,'面談 面談')
  const changes=compareFlows(flow,edited.flow)
  assert.equal(changes.changed.length,2);assert.deepEqual(changes.added,[])
})
test('複数条件の模擬テストは同意・有人対応・停止などを表示する',()=>{
  const flow=starter('recruitment');flow.channel='test'
  const sample={start:'2026-11-26T18:00',bookingAt:'',zone:'Asia/Tokyo',cutoff:'06:00',adult:true,consent:true,
    assigned:true,booked:false,dayCount:0,weekCount:0,tags:[],values:{name:'テスト',store:'店',booking:'明日',staff:'担当'}}
  const cases=simulationCases(flow,sample)
  assert.equal(cases.length,6)
  assert.ok(cases.find(c=>c.label==='未予約・同意あり').result.count>0)
  for(const label of ['通知同意なし','店長対応中','LINEブロック中','全配信停止中'])
    assert.equal(cases.find(c=>c.label===label).result.count,0)
})
