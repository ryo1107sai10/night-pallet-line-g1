import test from 'node:test'
import assert from 'node:assert/strict'
import {basicFeatures,recommendedFeatures,guideStages,nextGuideStep} from '../public/agency-guide.mjs'
const info={features:{sources_enabled:true,rich_menus_enabled:false},contract_active:false,auto_enabled:false}
const journey={connected:false,channels:[],counts:{drafts:0,published:0,active_tags:0},health:{checks:[]}}
test('初心者モードは保存された状態を表示し、未設定を完了扱いにしない',()=>{
  assert.equal(nextGuideStep(info,journey),1)
  assert.deepEqual(guideStages(info,journey).map(s=>s.ready),[false,false,false,false,false])
  const details={...journey,connected:true,counts:{drafts:1,published:0,active_tags:22}}
  const settings={...info,eligible_at:'2026-11-27',features:recommendedFeatures(info.features)}
  assert.deepEqual(guideStages(settings,details).map(s=>s.ready),[true,true,false,true,false])
  assert.equal(nextGuideStep(settings,details),3)
  const checks=['calendar','slots','automation','test'].map(id=>({id,state:'ready'}))
  assert.deepEqual(guideStages({...settings,contract_active:true,auto_enabled:true},{...details,counts:{...details.counts,published:1},health:{checks}}).map(s=>s.ready),[true,true,true,true,true])
  assert.equal(guideStages({...settings,contract_active:true,auto_enabled:true},{...details,health:{checks}})[4].ready,false)
})
test('おすすめ機能は既存の詳細設定を保持する',()=>{
  const settings=recommendedFeatures(info.features)
  assert.equal(settings.sources_enabled,true);assert.equal(settings.rich_menus_enabled,false)
  assert.ok(basicFeatures.every(k=>settings[k]===true))
  assert.equal(info.features.google_calendar_enabled,undefined)
})
