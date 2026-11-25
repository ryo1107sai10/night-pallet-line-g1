import {test} from 'node:test'
import assert from 'node:assert/strict'
import {starter,validate,simulate} from '../public/studio/engine.mjs'
import {reorderGroups,reorderStep,adjacentMove} from '../public/studio/step-order.mjs'

const byId=(flow,id)=>flow.nodes.find(step=>step.id===id)
const graph=()=>({...starter('customer'),channel:'account'})
const message=(id,next)=>({id,type:'message',name:id,category:'service',body:id,next})
const wait=(id,next)=>({id,type:'wait',name:id,mode:'delay',minutes:60,next})
const end=id=>({id,type:'end',name:id})

test('開始ステップをドラッグで入れ替えると開始位置と実配信順が変わり、元の版を変更しない',()=>{
  const initial=graph(),snapshot=structuredClone(initial)
  const result=reorderStep(initial,'wait','welcome','before')
  assert.equal(result.entry,'wait')
  assert.equal(byId(result,'wait').next,'welcome')
  assert.equal(byId(result,'welcome').next,'branch')
  assert.deepEqual(byId(result,'branch'),byId(initial,'branch'))
  assert.deepEqual(validate(result,true),[])
  assert.deepEqual(initial,snapshot)
  assert.deepEqual(result.nodes.slice(0,2).map(step=>step.id),['wait','welcome'])
  const person={start:'2026-11-25T18:00',zone:'Asia/Tokyo',cutoff:'06:00',adult:true,consent:true,booked:true,
    assigned:true,dayCount:0,weekCount:0,tags:[],values:{name:'テスト',store:'テスト店'}}
  const preview=simulate(result,person)
  assert.deepEqual(preview.errors,[])
  assert.deepEqual(preview.events.slice(0,2).map(event=>event.id),['wait','welcome'])
  assert.equal(preview.events[1].at,'2026-11-26T09:00:00.000Z')
  assert.deepEqual(adjacentMove(result,'wait',1),initial)
})

test('分岐内の複数ステップを端から端へ移動しても他方の条件経路は変わらない',()=>{
  const initial={...graph(),entry:'split',nodes:[
    {id:'split',type:'branch',name:'分岐',condition:'booked',yes:'a',no:'x'},
    message('a','b'),wait('b','c'),{id:'c',type:'tag',name:'タグ',tag:'応募',action:'add',next:'done'},
    message('x','y'),{id:'y',type:'task',name:'担当タスク',note:'連絡',next:'done'},end('done'),
  ]}
  const result=reorderStep(initial,'a','c','after')
  assert.equal(byId(result,'split').yes,'b')
  assert.equal(byId(result,'split').no,'x')
  assert.equal(byId(result,'b').next,'c')
  assert.equal(byId(result,'c').next,'a')
  assert.equal(byId(result,'a').next,'done')
  assert.deepEqual(byId(result,'x'),byId(initial,'x'))
  assert.deepEqual(byId(result,'y'),byId(initial,'y'))
  assert.deepEqual(validate(result,true),[])
  assert.equal(reorderStep(initial,'a','x','before'),null)
  assert.equal(reorderStep(initial,'split','a','after'),null)
  assert.equal(reorderStep(initial,'a','done','after'),null)
})

test('合流後の共通ステップを移動すると両方の接続先が一緒に更新される',()=>{
  const initial={...graph(),entry:'split',nodes:[
    {id:'split',type:'branch',name:'分岐',condition:'booked',yes:'left',no:'right'},
    message('left','shared1'),message('right','shared1'),message('shared1','shared2'),wait('shared2','done'),end('done'),
  ]}
  assert.deepEqual(reorderGroups(initial).get('shared1'),['shared1','shared2'])
  assert.equal(reorderStep(initial,'left','shared1','after'),null)
  const result=reorderStep(initial,'shared2','shared1','before')
  assert.equal(byId(result,'left').next,'shared2')
  assert.equal(byId(result,'right').next,'shared2')
  assert.equal(byId(result,'shared2').next,'shared1')
  assert.equal(byId(result,'shared1').next,'done')
  assert.deepEqual(validate(result,true),[])
})

test('未接続や循環した経路、移動先が同じ場合は下書きを破損しない',()=>{
  const initial=graph()
  initial.nodes.push(message('unconnected','end'))
  assert.equal(reorderStep(initial,'unconnected','welcome','before'),null)
  assert.equal(reorderStep(initial,'welcome','wait','before'),null)
  assert.equal(adjacentMove(initial,'welcome',-1),null)
  assert.equal(reorderStep(initial,'welcome','wait','invalid'),null)
  byId(initial,'wait').next='welcome'
  assert.equal(reorderGroups(initial).size,0)
  assert.equal(reorderStep(initial,'wait','welcome','before'),null)
})
