import assert from 'node:assert/strict'
import {test} from 'node:test'
import {tagStepTemplates,recommendedTagTemplate,buildTagTemplate} from '../public/studio/tag-templates.mjs'
import {validate,simulate} from '../public/studio/engine.mjs'

const keys=['new_friend','new_application','unanswered','in_progress','interview_pending','interview_booked','interview_done','interview_cancelled','trial_scheduled','trial_done','hired','joined','withdrawn','waiting_reply','handoff','follow_up','job_site','instagram','x','referral','beginner','experienced']
const channel='00000000-0000-4000-8000-000000000001'
const sample={start:'2026-11-25T18:00',zone:'Asia/Tokyo',cutoff:'06:00',consent:true,booked:false,dayCount:0,weekCount:0,values:{store:'検証店舗',interview_link:'https://example.test/reserve/sample'}}
const tag=key=>({tag_key:key,label:tagStepTemplates[key]?.label??'任意タグ',active:true})

test('標準22種類すべてに専用テンプレートがあり、実配信対応の編集可能な下書きを作成できる',()=>{
  assert.deepEqual(Object.keys(tagStepTemplates).filter(key=>key!=='generic').sort(),[...keys].sort())
  for(const key of keys)for(const mode of ['tag_added','tag_campaign']){
    const flow=buildTagTemplate({tag:tag(key),channel,mode,activeKeys:keys})
    assert.deepEqual(validate(flow,true),[],key+' '+mode)
    assert.equal(flow.purpose,'recruitment');assert.equal(flow.channel,channel);assert.equal(flow.trigger,mode)
    if(mode==='tag_added')assert.equal(flow.triggerTag,key);else assert.equal(flow.triggerTag,undefined)
    const result=simulate(flow,{...sample,tags:[key],booked:tagStepTemplates[key].booked??false})
    assert.deepEqual(result.errors,[],key)
    assert.equal(result.count,tagStepTemplates[key].silent?0:1,key)
  }
})

test('任意タグにおすすめ文面、別の文面、URLなしを適用しても対象タグ・店舗は変わらない',()=>{
  const custom=tag('custom-template-tag')
  assert.equal(recommendedTagTemplate(custom.tag_key),'generic')
  const a=buildTagTemplate({tag:custom,channel,pattern:'interview_pending',activeKeys:keys})
  const b=buildTagTemplate({tag:custom,channel,pattern:'interview_pending',activeKeys:keys,withLink:false})
  assert.equal(a.triggerTag,custom.tag_key);assert.equal(b.triggerTag,custom.tag_key)
  assert.match(a.nodes.find(n=>n.type==='message').body,/\{\{interview_link\}\}/)
  assert.doesNotMatch(b.nodes.find(n=>n.type==='message').body,/interview_link|こちらから.*空き枠/)
  assert.match(b.nodes.find(n=>n.type==='message').body,/トーク/)
  a.nodes.find(n=>n.type==='message').body='編集済み'
  assert.notEqual(buildTagTemplate({tag:custom,channel,pattern:'interview_pending'}).nodes.find(n=>n.type==='message').body,'編集済み')
  assert.throws(()=>buildTagTemplate({tag:{...custom,active:false},channel}))
})

test('テンプレートは対象タグなし・辞退・引継ぎ・同意なし・予約済の再案内を送信しない',()=>{
  const flow=buildTagTemplate({tag:tag('interview_pending'),channel,activeKeys:keys})
  for(const fixture of [{tags:[]},{tags:['interview_pending','withdrawn']},{tags:['interview_pending','handoff']},{tags:['interview_pending'],consent:false},{tags:['interview_pending'],booked:true}])assert.equal(simulate(flow,{...sample,...fixture}).count,0)
  const booked=buildTagTemplate({tag:tag('interview_booked'),channel,activeKeys:keys})
  assert.equal(simulate(booked,{...sample,tags:['interview_booked'],booked:false}).count,0)
  const manual=buildTagTemplate({tag:tag('handoff'),channel,activeKeys:keys})
  assert.equal(manual.nodes.some(n=>n.type==='message'),false)
})

test('分岐済みのテンプレート文面でも送信直前のタグと予約条件を再確認する',()=>{
  const flow=buildTagTemplate({tag:tag('interview_pending'),channel,activeKeys:keys})
  // Model a graph which has reached the message after a previous condition was checked.
  flow.nodes=flow.nodes.filter(n=>['message','end'].includes(n.id));flow.entry='message'
  assert.equal(simulate(flow,{...sample,tags:[]}).count,0)
  assert.equal(simulate(flow,{...sample,tags:['interview_pending'],booked:true}).count,0)
  assert.equal(simulate(flow,{...sample,tags:['interview_pending']}).count,1)
})
