import {test} from 'node:test'
import assert from 'node:assert/strict'
import {starter,recruitmentTemplates,recruitmentTemplate,liveTriggers,validate,simulate,localInstant,renderMessage} from '../public/studio/engine.mjs'

const person = {start:'2026-11-14T22:00',zone:'Asia/Tokyo',cutoff:'06:00',adult:true,consent:true,
  assigned:true,booked:false,dayCount:0,weekCount:0,values:{name:'山田',store:'検証店'}}

test('面談ステップのテンプレートは実配信対応の採用開始条件と編集可能な文面を持つ',()=>{
  assert.equal(recruitmentTemplates.length,4)
  for(const template of recruitmentTemplates){
    const flow=recruitmentTemplate(template.id,'account')
    assert.ok(Object.hasOwn(liveTriggers.recruitment,flow.trigger))
    assert.deepEqual(validate(flow,true),[])
    assert.notEqual(recruitmentTemplate(template.id,'other').channel,flow.channel)
  }
})

test('新しい採用シナリオは実配信できる面談予約を起点にし、用途別の開始項目を使う',()=>{
  const graph=starter('recruitment')
  graph.channel='account'
  assert.equal(graph.trigger,'interview_booked')
  assert.ok(Object.hasOwn(liveTriggers.recruitment,graph.trigger))
  assert.ok(!Object.hasOwn(liveTriggers.recruitment,'form'))
  assert.ok(!Object.hasOwn(liveTriggers.customer,'interview_booked'))
  assert.deepEqual(validate(graph,true),[])
  const result=simulate(graph,{...person,booked:true,bookingAt:'2026-11-20T19:00',values:{...person.values,booking:'11月20日19:00'}})
  assert.ok(result.events.some(item=>item.message?.includes('11月20日19:00')))
})

test('AT24/27 循環・孤立・未接続・目的外の販促は公開検証で拒否する', () => {
  const graph=starter()
  graph.channel='account'
  assert.deepEqual(validate(graph,true),[])
  graph.nodes.find(node=>node.id==='branch').yes='welcome'
  graph.nodes.find(node=>node.id==='nudge').next='nonexistent'
  graph.purpose='recruitment'
  const errors=validate(graph,true).map(item=>item.message)
  for (const key of ['循環','到達','つないで','採用シナリオ']) assert.ok(errors.some(error=>error.includes(key)))
})

test('AT26 許可時間・休業曜日・深夜の営業日と予約基準を計算できる', () => {
  const graph=starter()
  graph.holidays=[1]
  const first=simulate(graph,person)
  assert.equal(first.events.find(item=>item.id==='nudge').at,'2026-11-17T03:00:00.000Z')
  Object.assign(graph.nodes[1],{mode:'business',days:1,time:'02:00'})
  const overnight=simulate(graph,{...person,start:'2026-11-15T01:30'})
  assert.equal(overnight.events.find(item=>item.id==='wait').at,'2026-11-15T17:00:00.000Z')
  Object.assign(graph.nodes[1],{mode:'booking',minutes:60})
  const late=simulate(graph,{...person,bookingAt:'2026-11-14T22:30'})
  assert.equal(late.events.find(item=>item.id==='wait').state,'held')
  assert.equal(localInstant('2026-02-30T14:00','Asia/Tokyo'),null)
  assert.equal(localInstant('2026-11-01T01:30','America/New_York'),null)
})

test('AT29/30/32 予約済み分岐、停止、年齢、頻度、差し込みを反映する', () => {
  const graph=starter()
  assert.equal(simulate(graph,{...person,booked:true}).count,1)
  assert.equal(simulate(graph,{...person,stopped:true}).count,0)
  assert.match(simulate(graph,{...person,adult:false}).events.find(item=>item.id==='nudge').detail,/20歳/)
  assert.equal(simulate(graph,{...person,budgetAvailable:false}).count,0)
  assert.equal(simulate(graph,{...person,eligible:false}).count,0)
  assert.match(simulate(graph,{...person,dayCount:1,weekCount:1}).events.find(item=>item.id==='nudge').detail,/上限/)
  assert.match(renderMessage('{{name}}',{values:{}}).reason,/お名前/)
  assert.match(renderMessage('{{ booking_url }}',{values:{booking_url:'http://example.test'},bookingLinkValid:true}).reason,/URL/)
})
