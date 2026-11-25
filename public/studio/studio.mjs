import {workspacePath,scopeWorkspaceLinks} from '/static/workspace-path.mjs'
import {starter,recruitmentTemplates,recruitmentTemplate,kinds,conditions,triggers,liveTriggers,variables,validate,simulate,renderMessage,links,branchRules} from './engine.mjs'
import {reorderGroups,reorderStep,adjacentMove} from './step-order.mjs'
import {installStepDrag} from './step-drag.mjs'
import {edgeTarget,incomingEdges,outgoingEdges,insertStep,formatMinutes,timeUnit,tagKeys,copyFlow,bodyReplacement,compareFlows,simulationCases,routeSteps,stepBlock,pasteBlock,stepOutline,wizardFlow} from './studio-tools.mjs'
import {publicHttps} from './message-format.mjs'
import {tagStepTemplates,recommendedTagTemplate,buildTagTemplate} from './tag-templates.mjs'

scopeWorkspaceLinks()

const demo=document.documentElement.dataset.mode==='demo'
const controlled=document.documentElement.dataset.settings
const draftKey='night-pallet-studio-v1'
const $=selector=>document.querySelector(selector)
const icons={message:'✉',wait:'◷',branch:'⑂',tag:'◇',task:'✓',end:'■'}
const purposes={customer:'顧客',recruitment:'採用'}
const waitTypes={delay:'相対時間',fixed:'実日付',business:'営業日・店舗締め',booking:'予約時刻の前'}
const steps={draft:'下書き',tested:'テスト済み',approved:'承認済み'}
const defaults={zone:'Asia/Tokyo',cutoff:'06:00',start:'',bookingAt:'',booked:false,consent:true,adult:true,responded:false,
  assigned:true,stopped:false,marketingStopped:false,blocked:false,human:false,cancelled:false,
  dayCount:0,weekCount:0,tags:[],bookingLinkValid:true,eligible:true,contractActive:true,budgetAvailable:true,bookingCurrent:true}
let person={...defaults,values:{name:'水城あおい',store:'銀座店（サンプル）',staff:'橘',booking:'11月16日 23:00',
  price:'60分 8,000円（税込）',booking_url:'https://example.test/reservations/sample',interview_link:'https://example.test/reserve/sample',customer_link:'https://example.test/account/sample'}}
let applicantCatalog={enabled:false,definitions:[]}
let scenario,graph,selection,scenarioList=[],stores=[],channels=[],store,original='',dirty=false,tab='edit',part='workspace',simulation
let busy=false, ready=false, preset='unbooked', localCreateKey
let currentSession, viewMode='basic', zoom=1, autosave=true, saveTimer, savePromise=null, saveIssue='', historyKey='', historyTime=0
let undoStack=[],redoStack=[],searchText='',folderFilter='',libraryKind='all',matrix=null,branchOpen=new Map(),pendingMeta={folder:'',is_template:false},recoveryAvailable=true
let hideLibrary=false,hideInspector=false,focusMode=false,minimapOpen=false,stepClipboard=null,metrics=null,metricsBusy=false,presenceInfo=null,presenceSequence=0
const editorClient=crypto.randomUUID()
const recoveryKey=()=>store&&currentSession?'npl-studio-recovery-v2:'+currentSession.actor.id+':'+store.id:null
function recoverRead(){try{const k=recoveryKey();return k?JSON.parse(localStorage.getItem(k)):null}catch{return null}}
function recoverWrite(){
  const k=recoveryKey()
  if(!k||demo)return
  try{
    if(dirty&&graph)localStorage.setItem(k,JSON.stringify({id:scenario?.id??null,key:localCreateKey??null,revision:scenario?.revision??null,graph,meta:pendingMeta,at:Date.now()}))
    else{const existing=recoverRead();if(!existing||existing.id===(scenario?.id??null)||localCreateKey&&existing.key===localCreateKey)localStorage.removeItem(k)}
    recoveryAvailable=true
  }catch{recoveryAvailable=false}
}
function clearRecovery(){try{const k=recoveryKey();if(k)localStorage.removeItem(k)}catch{}}
function recordHistory(key=''){
  if(!graph)return
  const now=Date.now()
  const pushed=!key||key!==historyKey||now-historyTime>800
  if(pushed){undoStack.push({graph:structuredClone(graph),selection});if(undoStack.length>60)undoStack.shift()}
  historyKey=key;historyTime=now;redoStack=[];return pushed
}
function historyMove(direction){
  if(!graph||busy)return
  const from=direction==='undo'?undoStack:redoStack,to=direction==='undo'?redoStack:undoStack
  if(!from.length)return
  to.push({graph:structuredClone(graph),selection})
  const next=from.pop();graph=next.graph;selection=next.selection&&graph.nodes.some(n=>n.id===next.selection)?next.selection:graph.entry
  historyKey='';dirty=JSON.stringify(graph)!==original;simulation=null;matrix=null;saveIssue=''
  show();scheduleSave();recoverWrite()
}
function resetEditorState(){metrics=null;metricsBusy=false;presenceInfo=null;presenceSequence++;minimapOpen=false;clearTimeout(saveTimer);undoStack=[];redoStack=[];historyKey='';historyTime=0;matrix=null;saveIssue='';branchOpen=new Map();const canvas=$('#workspace .canvas-scroll');if(canvas){canvas.scrollTop=0;canvas.scrollLeft=0}$('#inspector').scrollTop=0}
function scheduleSave(){
  clearTimeout(saveTimer)
  recoverWrite()
  if(!autosave||!dirty||!graph||!graph.channel||!graph.name.trim()||busy)return
  saveTimer=setTimeout(()=>{save(true).catch(()=>{})},1400)
}
function updateSaveIndicator(){
  const status=$('#save-state')
  if(status){status.textContent=savePromise?'保存中…':saveIssue?'保存失敗：'+saveIssue:dirty?(autosave?'下書き・自動保存待ち':(recoveryAvailable?'未保存（端末保護）':'未保存（端末保護不可）')):'下書き保存済み';status.dataset.state=saveIssue?'error':dirty?'dirty':'saved'}
  for(const el of document.querySelectorAll('[data-save-action]')){el.disabled=!graph||!!savePromise||busy||(!dirty&&!!scenario);el.textContent=savePromise?'保存中…':'下書き保存'}
  const u=$('#undo-work'),r=$('#redo-work')
  if(u)u.disabled=!undoStack.length||busy
  if(r)r.disabled=!redoStack.length||busy
  updateValidation();renderPresence()
}
function workbar(){
  const root=$('#workbar')
  if(!root)return
  const context=node('div',null,'work-context')
  context.append(node('strong',graph?.name||'シナリオを選択'),node('small',store?store.name+' · '+(graph?channels.find(c=>c.id===graph.channel)?.label??'LINE未選択':'シナリオ一覧'):''))
  const ops=node('div',null,'work-actions')
  const status=node('span','','save-state');status.id='save-state'
  const undo=button('↶ 戻す',()=>historyMove('undo'));undo.id='undo-work';undo.title='取り消し（Ctrl/⌘+Z）'
  const redo=button('↷ やり直す',()=>historyMove('redo'));redo.id='redo-work';redo.title='やり直し（Ctrl/⌘+Shift+Z）'
  const saveBtn=button('下書き保存',()=>save(),'primary');saveBtn.dataset.saveAction='true'
  const auto=button(autosave?'自動保存 ON':'自動保存 OFF',()=>{autosave=!autosave;try{localStorage.setItem('npl-studio-auto-v2:'+currentSession.actor.id,String(autosave))}catch{}workbar();scheduleSave()});auto.setAttribute('aria-pressed',String(autosave))
  const view=button(viewMode==='basic'?'詳細フロー':'簡単編集',()=>{viewMode=viewMode==='basic'?'graph':'basic';show();choosePiece('workspace')});view.setAttribute('aria-pressed',String(viewMode==='graph'))
  const guide=button('テスト',()=>{tab='test';show();choosePiece('inspector')})
  const publish=button('公開管理',()=>{tab='publish';show();choosePiece('inspector')},'primary')
  const utility=button('その他 ▾',openUtilities)
  const focus=button(focusMode?'集中モード終了':'集中モード',()=>{focusMode=!focusMode;hideLibrary=focusMode;hideInspector=focusMode;applyPanelMode();show()});focus.setAttribute('aria-pressed',String(focusMode));focus.classList.add('desktop-focus')
  if(graph)ops.append(status,undo,redo,auto,view,focus,utility,saveBtn,guide,publish)
  const state=node('span','','presence-state');state.id='presence-state';context.append(state);root.replaceChildren(context,ops);root.hidden=!graph;updateSaveIndicator()
}
async function finishBeforeLeave(){
  clearTimeout(saveTimer)
  if(busy)return false
  if(savePromise)await savePromise.catch(()=>{})
  if(!dirty)return true
  if(autosave&&!saveIssue&&graph?.channel&&graph.name.trim()){try{await save(true)}catch{}if(!dirty)return true}
  const ok=await ask('未保存の下書きがあります。別の画面へ移動しますか？','保存せずに移動すると、現在の編集内容は破棄されます。')
  if(ok){clearTimeout(saveTimer);clearRecovery()}else scheduleSave()
  return ok
}

const sessionDemo={
  actor:{id:'demo',role:'admin',agency:false,platform:false},
  stores:[
    {id:'ginza',name:'銀座店（サンプル）',timezone:'Asia/Tokyo',cutoff:'06:00'},
    {id:'yokohama',name:'横浜店（サンプル）',timezone:'Asia/Tokyo',cutoff:'06:00'},
  ],
}
const channelDemo = location => [
  {id:location+'-customer',label:'顧客向け公式LINE',purpose:'customer'},
  {id:location+'-recruitment',label:'採用向け公式LINE',purpose:'recruitment'},
]
const stamp=()=>new Date().toISOString()
function fixtures() {
  const welcome=starter()
  welcome.channel='ginza-customer'
  const recruit=starter('recruitment')
  recruit.channel='ginza-recruitment'
  const visit=starter()
  visit.name='来店後のお礼'
  visit.trigger='visit'
  visit.channel='ginza-customer'
  visit.nodes=[{id:'welcome',type:'message',name:'来店のお礼',category:'marketing',
    body:'{{name}}さん、{{store}}へお越しいただきありがとうございました。',next:'end'},{id:'end',type:'end',name:'終了'}]
  return {
    ginza:[welcome,visit,recruit].map((flow,index)=>({
      id:'sample-'+index,graph:flow,revision:1,state:'draft',stopped:false,updated_at:stamp(),
      published_version:index===1?1:null,versions:index===1?[{version:1,graph:structuredClone(flow),published_at:stamp()}]:[],
    })),
    yokohama:[],
  }
}
let local
function demoRecords() {
  if (!local) {
    try { local=JSON.parse(localStorage.getItem(draftKey)) } catch { local=null }
    if (!local || !Array.isArray(local.ginza) || !Array.isArray(local.yokohama)) local=fixtures()
  }
  return local[store.id]
}

function saveLocal() {
  try { localStorage.setItem(draftKey,JSON.stringify(local)) } catch { /* The demo remains available in this tab. */ }
}

async function api(path,method='GET',body,key) {
  const response=await fetch(workspacePath('/api/v1'+path),{method,headers:{...(body?{'content-type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined})
  const payload=await response.json()
  if (!response.ok) throw Object.assign(new Error(payload.message??'処理できませんでした。'),{status:response.status})
  return payload
}
const base=()=>'/stores/'+store.id+'/scenarios'

function node(tag,txt,cls) {
  const el=document.createElement(tag)
  if (txt!=null) el.textContent=txt
  if (cls) el.className=cls
  return el
}
function panelHead(title,desc) {
  const box=node('div',null,'panelhead')
  box.append(node('h2',title))
  if (desc) box.append(node('p',desc))
  return box
}
function button(title,fn,cls='quiet') {
  const btn=node('button',title,cls)
  btn.type='button'
  btn.addEventListener('click',async()=>{
    if (!fn) return
    try { await fn() } catch(error) { announce(error.message,true) }
  })
  return btn
}
function pill(text,cls='') { return node('span',text,'pill '+cls) }
function announce(text,error=false) {
  const el=$('#message')
  el.textContent=text
  el.hidden=!text
  el.classList.toggle('error',error)
}
function choosePiece(value) {
  if(value==='inspector'&&hideInspector){hideInspector=false;applyPanelMode()}
  part=value
  $('#layout').dataset.part=part
  for (const btn of document.querySelectorAll('.mobile button')) {
    if(btn.dataset.part===part) btn.setAttribute('aria-current','true')
    else btn.removeAttribute('aria-current')
  }
}
function applicantTagOptions(value){
  const fields={'':'タグを選択'}
  for(const t of applicantCatalog.definitions.filter(t=>t.active))fields[t.tag_key]=t.label
  if(value&&!Object.hasOwn(fields,value))fields[value]=value+'（登録済みタグを確認）'
  return fields
}
function tagField(label,value,change){
  return graph.purpose==='recruitment'?field(label,value,change,{items:applicantTagOptions(value)}):field(label,value,change,{event:'input',attributes:{maxlength:'80'}})
}
function field(label,value,change,options={}) {
  const wrap=node('label',null,options.type==='checkbox'?'check':'field')
  const input=node(options.items?'select':options.type==='textarea'?'textarea':'input')
  wrap.append(node('span',label))
  if (options.items) for(const [key,text] of Object.entries(options.items)) input.add(new Option(text,key))
  else if (options.type!=='textarea') input.type=options.type??'text'
  if (options.type==='checkbox') input.checked=!!value
  else input.value=value??''
  for (const [k,v] of Object.entries(options.attributes??{})) input.setAttribute(k,v)
  if (options.type==='checkbox') wrap.prepend(input)
  else wrap.append(input)
  input.addEventListener(options.event??'change',()=>{
    const next=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value
    try { change(next,input) } catch(error) { announce(error.message,true) }
  })
  return wrap
}
function dialog(title,text,content) {
  const box=$('#dialog')
  box.classList.remove('template-dialog')
  const heading=node('h2',title);heading.tabIndex=-1
  box.replaceChildren(heading,node('p',text),content,button('閉じる',()=>box.close()))
  box.showModal();heading.focus({preventScroll:true});box.scrollTop=0
}
function ask(question,description='現在の画面で保存していない内容は破棄されます。') {
  return new Promise(resolve=>{
    const actions=node('div',null,'controls')
    const finish=ok=>{ resolve(ok); $('#dialog').close() }
    actions.append(button('続ける',()=>finish(true),'primary'))
    dialog(question,description,actions)
    $('#dialog').addEventListener('close',()=>resolve(false),{once:true})
  })
}
function update(change,rerender=true,key='') {
  if (busy) return
  const pushed=recordHistory(key)
  const before=JSON.stringify(graph)
  change()
  if(JSON.stringify(graph)===before){if(pushed)undoStack.pop();return}
  dirty=JSON.stringify(graph)!==original
  simulation=null;matrix=null;saveIssue=''
  if (rerender) show()
  else {
    const title=$('#workspace .editor-head h2')
    if (title) title.textContent=graph.name||'名称未設定'
    const selected=$('#workspace .node.selected .node-content strong')
    if(selected && currentNode()) selected.textContent=currentNode().name||kinds[currentNode().type]
    const excerpt=$('#workspace .node.selected .excerpt')
    if(excerpt && currentNode()?.type==='message') excerpt.textContent=currentNode().body.replace(/\s+/g,' ')
    const caption=$('#workspace .node.selected .node-content small');const step=currentNode();if(caption&&step?.type==='wait'&&['delay','booking'].includes(step.mode))caption.textContent='待機 · '+(step.mode==='booking'?'予約の':'')+formatMinutes(step.minutes)+(step.mode==='booking'?'前':'')
    const context=$('#workbar .work-context strong');if(context)context.textContent=graph.name||'名称未設定'
    updateSaveIndicator()
  }
  scheduleSave();updateSaveIndicator()
}
function limits() { return validate(graph,true) }
const currentNode=()=>graph?.nodes.find(item=>item.id===selection)
function syncScenarioURL(){if(!store)return;const url=new URL(location.href);url.searchParams.set('store',store.id);if(scenario?.id)url.searchParams.set('scenario',scenario.id);else url.searchParams.delete('scenario');history.replaceState(null,'',url)}
function setupFlow(data) {
  resetEditorState()
  scenario=data??null
  localCreateKey=null
  pendingMeta={folder:scenario?.folder??'',is_template:scenario?.is_template??false}
  graph=data?structuredClone(data.graph):null
  original=graph?JSON.stringify(graph):''
  dirty=false
  simulation=null
  selection=graph?.entry
  tab='edit'
  syncScenarioURL();show();pollPresence()
}

async function refreshStore(next) {
  store=next
  person={...person,zone:store.timezone,cutoff:store.cutoff,values:{...person.values,store:store.name}}
  channels=demo?channelDemo(store.id):await api('/stores/'+store.id+'/connections')
  applicantCatalog=demo?{enabled:true,definitions:Object.entries(tagStepTemplates).filter(([key])=>key!=='generic').map(([tag_key,t])=>({tag_key,label:t.label,active:true}))}:await api('/stores/'+store.id+'/workflows/recruitment/tags/catalog').catch(()=>({enabled:false,definitions:[]}))
  scenarioList=demo?structuredClone(demoRecords()):await api(base())
  const requested=new URLSearchParams(location.search).get('scenario')
  const first=scenarioList.find(s=>s.id===requested)??scenarioList.find(s=>!s.is_template)??scenarioList[0]
  setupFlow(first&&!demo?await api(base()+'/'+first.id):first)
  const recovery=recoverRead()
  if(recovery?.graph&&Date.now()-recovery.at<7*86400000){
    const saved=scenarioList.find(s=>s.id===recovery.id)
    if(recovery.id&&saved&&JSON.stringify(saved.graph)===JSON.stringify(recovery.graph)){clearRecovery();return}
    const row=node('div')
    const conflict=!!recovery.id&&(!saved||saved.revision!==recovery.revision)
    row.append(node('p',conflict?'サーバー上の版が変わっています。復元する場合は別の新規下書きとして開きます。':'前回の未保存編集を復元できます。'))
    row.append(button('下書きを復元',async()=>{
      let latest
      if(!conflict&&saved)latest=demo?saved:await api(base()+'/'+saved.id)
      $('#dialog').close()
      if(latest&&latest.revision===recovery.revision){
        setupFlow(latest);graph=structuredClone(recovery.graph);dirty=true;selection=graph.entry;show();scheduleSave()
      }else{
        draftScenario(recovery.graph,null,recovery.meta,!recovery.id&&!conflict&&recovery.key?recovery.key:undefined)
        if(recovery.id)announce('サーバー版を保護するため、復元内容は別の新規下書きとして開きました。')
      }
    },'primary'),button('復元しない',()=>{clearRecovery();$('#dialog').close()}))
    dialog('未保存の下書きを復元',new Date(recovery.at).toLocaleString('ja-JP'),row)
  }
}

async function openScenario(id) {
  if (scenario?.id===id) return choosePiece('workspace')
  if (!await finishBeforeLeave()) return
  setupFlow(demo?structuredClone(demoRecords().find(item=>item.id===id)):await api(base()+'/'+id))
  choosePiece('workspace')
  announce('')
}

function draftScenario(flow,templateInfo,meta={folder:'',is_template:false},createKey){
  resetEditorState()
  scenario=null
  pendingMeta=meta
  localCreateKey=createKey??crypto.randomUUID()
  graph=flow
  original=''
  selection=graph.entry
  dirty=true
  simulation=null
  tab='settings'
  if(templateInfo){
    const booked=templateInfo.booked===true
    preset=booked?'booked':'unbooked'
    person={...person,tags:[templateInfo.tag],booked,consent:true,blocked:false,stopped:false,human:false,cancelled:false,
      values:{...person.values,interview_link:'https://example.test/reserve/sample'}}
  }
  syncScenarioURL();show()
  choosePiece('workspace')
  recoverWrite();scheduleSave()
  announce(templateInfo?'タグ別テンプレートを下書きに読み込みました。文面・待機・分岐を自由に編集できます。':'下書きを作成しました。名称と公式アカウントを確認してください。')
}
function newScenario(purpose='customer',template) {
  const preferred=channels.find(item=>item.purpose===purpose)??(!template?.dedicated&&channels.find(item=>item.purpose==='shared'))
  const flow=template?recruitmentTemplate(template.id,preferred?.id??''):starter(purpose)
  flow.channel=preferred?.id??''
  draftScenario(flow)
}
function openTagTemplates(initialTag){
  const content=node('div',null,'tag-template-picker')
  const tags=applicantCatalog.enabled?applicantCatalog.definitions.filter(t=>t.active):[]
  if(!tags.length){
    content.append(node('p','この店舗で有効な採用タグがありません。採用タグ管理で機能を有効にし、タグを登録してください。'))
    const link=node('a','採用タグ管理を開く','studio-link');link.href=workspacePath('/workflows/?store='+encodeURIComponent(store.id)+'&use=recruitment&tab=tags');content.append(link)
    dialog('採用タグ別テンプレート','店舗ごとのタグに対応するテンプレートです。',content);return
  }
  const compatible=channels.filter(c=>c.purpose==='recruitment'||c.purpose==='shared')
  let tag=tags.find(t=>t.tag_key===initialTag)??tags.find(t=>t.tag_key==='applied')??tags.find(t=>t.label==='新規応募')??tags[0]
  let pattern=recommendedTagTemplate(tag.tag_key),mode='tag_added',channel=compatible.find(c=>c.purpose==='recruitment')?.id??compatible[0]?.id??'',withLink=true
  const prefix=node('div',null,'template-pills');prefix.append(pill('店舗：'+store.name),pill(tags.length+'種類のタグ'))
  content.append(prefix)
  const tagPicker=field('対象の採用タグ',tag.tag_key,value=>{tag=tags.find(t=>t.tag_key===value)??tags[0];pattern=recommendedTagTemplate(tag.tag_key);patternPicker.querySelector('select').value=pattern;withLink=true;renderPreview()},{items:Object.fromEntries(tags.map(t=>[t.tag_key,t.label]))})
  const patternPicker=field('テンプレート文面・フロー',pattern,value=>{pattern=value;withLink=true;renderPreview()},{items:Object.fromEntries(Object.entries(tagStepTemplates).map(([key,t])=>[key,t.label+' · '+t.title]))})
  const modePicker=field('配信の開始方法',mode,value=>{mode=value;renderPreview()},{items:{tag_added:'タグが付いたとき（自動）',tag_campaign:'既にタグが付いた人へ絞り込み配信（手動）'}})
  const channelPicker=field('配信先の公式LINE',channel,value=>{channel=value;renderPreview()},{items:Object.fromEntries(compatible.length?compatible.map(c=>[c.id,c.label]):[['','採用用・兼用LINEを登録してください']])})
  content.append(tagPicker,patternPicker,modePicker,channelPicker)
  const preview=node('section',null,'template-preview')
  content.append(preview)
  function renderPreview(){
    const t=tagStepTemplates[pattern]
    const flow=buildTagTemplate({tag,pattern,channel,mode,withLink,activeKeys:tags.map(t=>t.tag_key)})
    const message=flow.nodes.find(n=>n.type==='message')
    const list=node('div',null,'template-path')
    preview.replaceChildren(node('h3',t.title),node('p',t.description,'field-hint'))
    if(t.link)preview.append(field('面談予約の専用URLを文面に含める',withLink,value=>{withLink=value;renderPreview()},{type:'checkbox'}))
    if(t.link&&withLink)preview.append(node('p','予約URLは送信時に応募者ごとに発行されます。発行できない場合はメッセージを保留します。','field-hint'))
    preview.append(node('p',mode==='tag_added'?'今後、通知に同意した応募者にタグが新しく付いたときに開始します。既に付いている人には自動で送り直しません。':'公開後、採用タグ管理で対象タグを指定し、人数を確認して配信開始します。','field-hint'))
    const stages=[]
    if(!t.silent){stages.push('対象タグを確認');if(t.wait)stages.push(t.wait===1440?'24時間待機':t.wait+'分待機','タグを再確認');if(typeof t.booked==='boolean')stages.push(t.booked?'面談予約ありを確認':'面談未予約を確認');stages.push('送信直前の条件確認','LINEメッセージ1通','終了')}
    else stages.push('自動メッセージを送信せず終了')
    for(const label of stages)list.append(node('span',label,'template-path-step'))
    preview.append(list)
    if(message){preview.append(node('h4','メッセージ文面（編集できます）'),node('p',message.body,'template-message'))}
    if(t.manual){preview.append(node('h4','手動返信用の参考文面'),node('p',t.manual,'template-message'),button('参考文面をコピー',async()=>{try{await navigator.clipboard.writeText(t.manual);noticeText.textContent='文面をコピーしました。'}catch{noticeText.textContent='上の文面を選択してコピーしてください。'}}))}
    const noticeText=node('p','', 'field-hint');noticeText.setAttribute('role','status');preview.append(noticeText)
    if(!channel)preview.append(node('p','先にこの店舗の採用用または兼用の公式LINEを登録してください。','field-hint'))
    preview.append(node('p','下書きを作成しても送信されません。内容の編集・テスト・承認・公開を行ってから利用してください。一度に複数の似たテンプレートを公開すると案内が重複することがあるため、用途に合うものを選んでください。','field-hint'))
    const use=button('このテンプレートで下書きを作成',()=>{$('#dialog').close();draftScenario(flow,{tag:tag.tag_key,booked:t.booked})},'primary template-use');use.disabled=!channel;preview.append(use)
  }
  renderPreview()
  dialog('採用タグ別ステップテンプレート','対象タグと文面を選び、用意されたステップを下書きに読み込みます。',content)
  $('#dialog').classList.add('template-dialog')
}

async function readStoreResources(target){
  if(demo)return {channels:channelDemo(target.id),catalog:{enabled:true,definitions:Object.entries(tagStepTemplates).filter(([k])=>k!=='generic').map(([tag_key,t])=>({tag_key,label:t.label,active:true}))}}
  const [list,catalog]=await Promise.all([
    api('/stores/'+target.id+'/connections'),
    api('/stores/'+target.id+'/workflows/recruitment/tags/catalog').catch(()=>({enabled:false,definitions:[]})),
  ])
  return {channels:list,catalog}
}
async function openCopy(source,sourceStore,asTemplate=false,folder=''){
  const initial=structuredClone(source)
  const box=node('div',null,'copy-dialog')
  let target=asTemplate?sourceStore:store,name=(source.name+(asTemplate?'・テンプレート':'（コピー）')).slice(0,100),destinationFolder=asTemplate?'共通テンプレート':folder,request=0
  const key=crypto.randomUUID()
  const selector=field('複製先の店舗',target.id,value=>{target=stores.find(s=>s.id===value);loadDestination().catch(e=>announce(e.message,true))},{items:Object.fromEntries((asTemplate?[sourceStore]:stores).map(s=>[s.id,s.name]))})
  const dest=node('div',null,'copy-mappings')
  const title=field(asTemplate?'テンプレート名':'新しいシナリオ名',name,v=>{name=v},{event:'input',attributes:{maxlength:'100'}})
  const group=field('フォルダ（任意）',destinationFolder,v=>{destinationFolder=v},{event:'input',attributes:{maxlength:'50'}})
  box.append(selector,title,group,node('p','公開中の配信は変更しません。配信先のLINE、タグ、固定URLを確認したうえで新規下書きにします。','field-hint'),dest)
  async function loadDestination(){
    const serial=++request,current=target
    dest.replaceChildren(node('p','複製先の設定を読み込み中…','field-hint'))
    const info=await readStoreResources(current)
    if(serial!==request)return
    const targets=info.channels.filter(c=>c.purpose===initial.purpose||c.purpose==='shared')
    let channel=sourceStore.id===current.id&&targets.some(c=>c.id===initial.channel)?initial.channel:''
    const tagMap={}
    const sourceCatalog=sourceStore.id===store.id?applicantCatalog:(await readStoreResources(sourceStore)).catalog
    if(serial!==request)return
    dest.replaceChildren()
    const channelField=field('配信先の公式LINE（必須）',channel,value=>{channel=value;validateCopy()},{items:{'':'選択してください',...Object.fromEntries(targets.map(c=>[c.id,c.label]))}})
    dest.append(channelField)
    if(!targets.length)dest.append(node('p','複製先に対象用途のLINEを登録してください。','field-hint'))
    const keys=initial.purpose==='recruitment'?tagKeys(initial):[]
    const definitions=info.catalog.enabled?info.catalog.definitions.filter(t=>t.active):[]
    if(keys.length)dest.append(node('h3','タグを複製先に対応付ける'))
    for(const tag of keys){
      const label=sourceCatalog.definitions.find(t=>t.tag_key===tag)?.label??tag
      const match=definitions.find(t=>t.tag_key===tag)??definitions.find(t=>t.label===label)
      tagMap[tag]=match?.tag_key??''
      dest.append(field(label,tagMap[tag],value=>{tagMap[tag]=value;validateCopy()},{items:{'':'複製先タグを選択',...Object.fromEntries(definitions.map(t=>[t.tag_key,t.label]))}}))
    }
    const anyFixed=initial.nodes.some(n=>n.type==='message'&&(/https?:\/\//.test(n.body)||n.rich?.imageUrl||n.rich?.buttons.length))
    if(anyFixed)dest.append(node('p','固定URLを含む文面があります。このアプリの既知の予約URLは差し込みに変更されます。外部リンクは自動変換しません。店舗別予約リンクがボタンに設定されている場合は空欄にして、再設定を求めます。','copy-warning'))
    const confirm=button(asTemplate?'テンプレートを保存（配信しない）':'新規下書きへコピー',async()=>{
      if(!name.trim()||!channel||keys.some(k=>!tagMap[k])||new Set(keys.map(k=>tagMap[k])).size!==keys.length)throw new Error('名称・LINE・タグの対応付けを確認してください。')
      confirm.disabled=true
      try{
        if(savePromise)await savePromise
        const output=copyFlow(initial,{name,channel,sourceName:sourceStore.name,targetName:current.name,tagMap,origin:location.origin})
        const meta={folder:destinationFolder.trim(),is_template:asTemplate}
        let created
        if(demo){
          created={id:crypto.randomUUID(),graph:output,state:'draft',revision:1,stopped:false,published_version:null,versions:[],updated_at:stamp(),...meta};local[current.id].unshift(created);saveLocal()
        }else created=await api('/stores/'+current.id+'/scenarios','POST',{graph:output,...meta},key)
        $('#dialog').close()
        if(!dirty){
          $('#store').value=current.id
          if(current.id!==store.id)await refreshStore(current);else scenarioList=[created,...scenarioList.filter(s=>s.id!==created.id)]
          setupFlow(created);choosePiece('workspace')
        }else if(current.id===store.id){scenarioList=[created,...scenarioList.filter(s=>s.id!==created.id)];library()}
        announce(asTemplate?'自社テンプレートを保存しました。配信は行われません。':'「'+current.name+'」に新規下書きを作成しました。配信にはテスト・承認・公開が必要です。')
      }finally{confirm.disabled=false}
    },'primary template-use')
    function validateCopy(){confirm.disabled=!channel||keys.some(k=>!tagMap[k])||new Set(keys.map(k=>tagMap[k])).size!==keys.length}
    dest.append(confirm);validateCopy()
  }
  dialog(asTemplate?'自社テンプレートとして保存':'シナリオを複製',source.name,box)
  $('#dialog').classList.add('template-dialog')
  await loadDestination()
}
async function openSavedTemplates(){
  if(!ready||!store)return
  const box=node('div',null,'copy-dialog')
  box.append(node('p','アクセス可能な店舗の自社テンプレートを読み込んでいます。','field-hint'))
  dialog('自社テンプレートライブラリ','他店舗でもそのまま利用できます。複製先でLINEとタグを選び直してください。',box)
  $('#dialog').classList.add('template-dialog')
  let records=[]
  if(demo)records=stores.flatMap(s=>(local?.[s.id]??[]).filter(r=>r.is_template).map(r=>({item:r,source:s})))
  else{
    const result=await Promise.allSettled(stores.map(async source=>(await api('/stores/'+source.id+'/scenarios')).filter(r=>r.is_template).map(item=>({source,item}))))
    records=result.flatMap(r=>r.status==='fulfilled'?r.value:[])
  }
  if(!$('#dialog').open||!box.isConnected)return
  box.replaceChildren()
  const list=node('div',null,'template-cards')
  const filter=value=>{
    list.replaceChildren()
    for(const {item,source} of records.filter(r=>(r.item.graph.name+' '+r.source.name+' '+(r.item.folder??'')).toLowerCase().includes(value.toLowerCase()))){
      const b=button('',()=>{$('#dialog').close();openCopy(item.graph,source,false,item.folder??'').catch(e=>announce(e.message,true))},'template-card')
      b.append(node('strong',item.graph.name),node('small',source.name+' · '+(item.folder||'未分類')+' · '+item.graph.nodes.length+'ステップ'))
      list.append(b)
    }
    if(!list.children.length)list.append(node('p','該当する自社テンプレートがありません。「その他」から登録できます。','empty'))
  }
  box.append(field('テンプレート検索','',filter,{event:'input',attributes:{placeholder:'名称・店舗・フォルダ'}}),list);filter('')
}
function openUtilities(){
  if(!graph)return
  const menu=node('div',null,'insert-picker')
  const action=(label,fn)=>button(label,()=>{$('#dialog').close();return fn()})
  menu.append(action('シナリオを複製・他店舗へコピー',()=>openCopy(graph,store,false,scenario?.folder??'')),
    action('複数店舗へ一括コピー',()=>openBatchCopy(graph)),
    action('ステップを選択してコピー',()=>openStepCopy()),
    action('自社テンプレートとして保存',()=>openCopy(graph,store,true)),
    action('メッセージ文面の一括置換',openBatchReplace))
  if(scenario)menu.append(action('フォルダを設定',openFolder))
  if(saveIssue)menu.append(action('競合した下書きを新規として保存',()=>openCopy(graph,store,false,pendingMeta.folder??'')))
  dialog('便利な編集機能','公開中のシナリオを直接変更せず、下書きで作業できます。',menu)
}
function openBatchReplace(){
  let find='',replacement=''
  const box=node('div',null,'stack'),preview=node('p','検索文字を入力してください。','field-hint')
  const apply=button('下書きの文面を一括置換',()=>{
    const result=bodyReplacement(graph,find,replacement)
    if(!result.count)return
    if(result.flow.nodes.some(n=>n.type==='message'&&n.body.length>5000))throw new Error('5000文字を超えるメッセージがあります。置換内容を調整してください。')
    $('#dialog').close();update(()=>{graph=result.flow});announce(result.steps+'件・'+result.count+'箇所を書き換えました。取り消し可能です。')
  },'primary')
  apply.disabled=true
  const check=()=>{const result=bodyReplacement(graph,find,replacement);const overflow=result.flow.nodes.some(n=>n.type==='message'&&n.body.length>5000);preview.textContent=result.steps+'メッセージ・'+result.count+'箇所が対象'+(overflow?' · 5000文字を超える文面があります':'');apply.disabled=!result.count||overflow}
  box.append(field('検索する文字','',v=>{find=v;check()},{event:'input'}),field('置換後の文字','',v=>{replacement=v;check()},{event:'input',type:'textarea'}),preview,apply)
  dialog('メッセージ文面を一括置換','公開版ではなく現在の下書きだけを変更します。',box)
}
function openFolder(){
  let value=scenario.folder??''
  const box=node('div')
  box.append(field('フォルダ名（空欄で未分類）',value,v=>{value=v},{event:'input',attributes:{maxlength:'50'}}),button('フォルダを保存',async()=>{
    if(savePromise)await savePromise
    clearTimeout(saveTimer)
    try{
      let updated
      if(demo){const item=demoRecords().find(s=>s.id===scenario.id);item.folder=value.trim();item.revision++;saveLocal();updated=structuredClone(item)}
      else updated=await api(base()+'/'+scenario.id+'/folder','PATCH',{revision:scenario.revision,folder:value.trim()})
      scenario={...scenario,...updated};pendingMeta.folder=scenario.folder;scenarioList=[{...updated},...scenarioList.filter(s=>s.id!==scenario.id)]
      $('#dialog').close();show();announce('フォルダを保存しました。')
    }finally{scheduleSave()}
  },'primary'))
  dialog('フォルダを設定','シナリオ一覧を店舗内で分類します。配信内容は変更されません。',box)
}

async function save(automatic=false) {
  if (busy||!graph) return
  clearTimeout(saveTimer)
  if(savePromise){await savePromise;if(dirty&&!automatic)return save(false);return}
  if(!dirty&&scenario)return
  if(!graph.channel||!graph.name.trim()){
    if(automatic)return
    throw new Error('シナリオ名と公式アカウントを入力してください。')
  }
  const snapshot=structuredClone(graph),id=scenario?.id,key=localCreateKey??crypto.randomUUID(),revision=scenario?.revision
  const meta={...pendingMeta},storeId=store.id
  saveIssue=''
  savePromise=(async()=>{
    try{
      let created
      if(demo){
        const records=demoRecords(),existing=records.find(item=>item.id===id)
        created={...existing,id:existing?.id??crypto.randomUUID(),revision:(existing?.revision??0)+1,graph:snapshot,state:'draft',stopped:existing?.stopped??false,updated_at:stamp(),
          published_version:existing?.published_version??null,versions:existing?.versions??[],...meta}
        if(existing)Object.assign(existing,created);else records.unshift(created)
        saveLocal();scenarioList=structuredClone(records)
      }else{
        created=await api('/stores/'+storeId+'/scenarios'+(id?'/'+id:''),id?'PATCH':'POST',
          id?{graph:snapshot,revision}:{graph:snapshot,...meta},id?null:key)
        scenarioList=[created,...scenarioList.filter(s=>s.id!==created.id)]
      }
      scenario={versions:scenario?.versions??[],...created}
      syncScenarioURL();if(!id)pollPresence()
      original=JSON.stringify(snapshot)
      dirty=JSON.stringify(graph)!==original
      recoverWrite()
      library()
      if(!automatic||tab==='publish'||tab==='test')show();else flowView()
      if(!automatic)announce('下書きを保存しました。公開中の配信には反映されません。')
    }catch(error){
      saveIssue=error.status===409?'他の変更があります。端末の下書きを保持しています。':error.message
      recoverWrite()
      if(!automatic)throw error
    }
  })()
  updateSaveIndicator()
  try{await savePromise}finally{savePromise=null;updateSaveIndicator();if(dirty&&!saveIssue)scheduleSave()}
}
async function transition(action,reason) {
  if(savePromise)await savePromise
  if (!scenario || busy || dirty) throw new Error('先に下書きを保存してください。')
  if (['test','publish'].includes(action) && limits().length) throw new Error(limits()[0].message)
  busy=true
  try {
    if (demo) {
      const record=demoRecords().find(item=>item.id===scenario.id)
      if (action==='test') record.state='tested'
      if (action==='approve') record.state='approved'
      if (action==='publish') {
        record.published_version=(record.published_version??0)+1
        record.versions.unshift({version:record.published_version,graph:structuredClone(graph),published_at:stamp()})
        record.state='draft'
      }
      if (action==='stop' || action==='resume') record.stopped=action==='stop'
      record.revision++
      record.updated_at=stamp()
      scenario=structuredClone(record)
      scenarioList=structuredClone(demoRecords())
      saveLocal()
    } else {
      const {zone,cutoff,...fixture}=person
      scenario=await api(base()+'/'+scenario.id+'/transition','POST',{
        action,reason,revision:scenario.revision,...(action==='test'?{fixture}:{}),
      })
      scenarioList=await api(base())
    }
    const labels={test:'テスト結果を記録しました。',approve:'下書きを承認しました。',publish:'公開版を保存しました。',
      stop:'シナリオを停止しました。',resume:'シナリオを再開しました。'}
    announce(labels[action])
    if(action==='test'||action==='approve')tab='publish'
    show()
  } finally {busy=false;updateSaveIndicator()}
}

function library() {
  const target=$('#library')
  const box=node('div',null,'panelbody')
  const rows=node('div',null,'library-list')
  const search=field('検索',searchText,value=>{searchText=value;filter()},{event:'input',attributes:{placeholder:'シナリオ名・フォルダ',type:'search'}})
  const folders=[...new Set(scenarioList.map(s=>s.folder??'').filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja'))
  if(folderFilter&&!folders.includes(folderFilter.slice(7))&&folderFilter!=='__none')folderFilter=''
  const picker=field('フォルダ',folderFilter,value=>{folderFilter=value;filter()},{items:{'':'すべて','__none':'未分類',...Object.fromEntries(folders.map(f=>['folder:'+f,f]))}})
  const kind=field('表示',libraryKind,value=>{libraryKind=value;filter()},{items:{all:'すべて',live:'公開中',draft:'下書き',stopped:'停止中',template:'テンプレート'}})
  function filter(){
    const shown=scenarioList.filter(item=>{
      const text=((item.graph.name??'')+' '+(item.folder??'')).toLocaleLowerCase()
      const folderMatch=!folderFilter||(folderFilter==='__none'?!item.folder:item.folder===folderFilter.slice(7))
      const kindMatch=libraryKind==='all'||libraryKind==='template'&&item.is_template||libraryKind==='live'&&item.published_version&&!item.stopped||libraryKind==='draft'&&!item.published_version&&!item.is_template||libraryKind==='stopped'&&item.stopped
      return text.includes(searchText.toLocaleLowerCase())&&folderMatch&&kindMatch
    })
    rows.replaceChildren()
    let prior
    for(const item of shown.sort((a,b)=>(a.folder??'').localeCompare(b.folder??'','ja'))){
      if(prior!==(item.folder??'')){rows.append(node('h3',item.folder||'未分類','folder-heading'));prior=item.folder??''}
      const selected=item.id===scenario?.id
      const entry=button('',()=>openScenario(item.id),'scenario-card'+(selected?' selected':''))
      entry.setAttribute('aria-pressed',String(selected))
      const badges=node('div',null,'labels')
      badges.append(pill(purposes[item.graph.purpose]),pill(item.is_template?'テンプレート':item.stopped?'停止中':item.published_version?'公開 v'+item.published_version:steps[item.state],
        item.stopped?'warn':item.published_version?'good':''))
      if(item.published_version&&selected&&dirty)badges.append(pill('編集中','warn'))
      entry.append(node('strong',item.graph.name),badges)
      rows.append(entry)
    }
    if(!shown.length)rows.append(node('p','一致するシナリオがありません。','empty'))
  }
  filter();box.append(search,picker,kind,rows)
  target.replaceChildren(panelHead('シナリオ一覧',scenarioList.length+'件'),box)
}

const selectStep = id=>{
  for(const key of stepOutline(graph).find(n=>n.id===id)?.path??[])branchOpen.set(key,true)
  if(hideInspector){hideInspector=false;applyPanelMode()}
  selection=id
  tab='edit'
  show()
  choosePiece(matchMedia('(max-width:950px)').matches?'inspector':'workspace')
  $('#inspector').scrollTop=0
  requestAnimationFrame(()=>{const card=[...$('#workspace').querySelectorAll('[data-step-id]')].find(c=>c.dataset.stepId===id);if(card&&matchMedia('(min-width:951px)').matches)card.scrollIntoView({block:'nearest',inline:'nearest'})})
}
const nameOf = id=>graph.nodes.find(item=>item.id===id)?.name??'接続なし'

function applyStepOrder(next,id,focus=false) {
  if (!next || busy) return false
  update(()=>{graph=next;selection=id;tab='edit'})
  choosePiece('workspace')
  announce('「'+nameOf(id)+'」の順番を変更しました。変更を保存すると下書きに反映されます。')
  if(focus) requestAnimationFrame(()=>{
    const card=[...$('#workspace').querySelectorAll('[data-step-id]')].find(item=>item.dataset.stepId===id)
    card?.focus({preventScroll:true})
    card?.scrollIntoView({block:'nearest'})
  })
  return true
}

function edgeDescription(edge){
  if(edge.owner===null)return '開始条件の直後'
  const parent=graph.nodes.find(n=>n.id===edge.owner)
  return (parent?.name??'ステップ')+(edge.key==='yes'?' → はい':edge.key==='no'?' → いいえ':' の直後')
}
function addStep(edge){
  if(graph.nodes.length>=100)return announce('ステップ数は100件までです。',true)
  if(!edge){
    const edges=outgoingEdges(graph,selection)
    if(!edges.length)return announce('追加したい経路の「＋」を選んでください。',true)
    if(edges.length>1){
      const options=node('div',null,'insert-picker')
      for(const ref of edges)options.append(button(edgeDescription(ref),()=>{$('#dialog').close();addStep(ref)}))
      dialog('追加する経路を選択','既存の分岐のどちらに追加するかを選択します。',options);return
    }
    edge=edges[0]
  }
  const target=edgeTarget(graph,edge)
  const menu=node('div',null,'insert-picker')
  if(stepClipboard?.store===store.id&&stepClipboard.purpose===graph.purpose){const paste=button('コピーしたステップを挿入（'+stepClipboard.block.nodes.length+'件）',()=>{const result=pasteBlock(graph,edge,stepClipboard.block,newStepId);if(!result)throw new Error('この位置にはコピーできません。終了ステップを除いた範囲を選んでください。');$('#dialog').close();update(()=>{graph=result.flow;selection=result.entry;tab='edit'});selectStep(result.entry)},'primary');menu.append(paste)}
  const descriptions={message:'LINEの本文を送る',wait:'時間や日付まで待つ',branch:'条件に応じて経路を分ける',tag:'タグを追加・解除する',task:'担当者への作業を作る',end:'この経路を終了する'}
  for(const [type,label] of Object.entries(kinds)){
    const item=button('',()=>{
      const id=newStepId(),next=insertStep(graph,edge,type,id)
      if(!next)throw new Error('追加箇所が変更されました。もう一度選んでください。')
      $('#dialog').close()
      update(()=>{graph=next;selection=id;tab='edit'})
      choosePiece(matchMedia('(max-width:950px)').matches?'inspector':'workspace')
    },'insert-option')
    item.append(node('strong',icons[type]+' '+label),node('small',descriptions[type]))
    if(type==='end'&&target)item.disabled=true
    menu.append(item)
  }
  dialog('ステップを挿入',edgeDescription(edge)+(target?' · '+nameOf(target)+' の前':' · 新しい経路'),menu)
}
function edgeButton(edge,label='ステップを挿入'){
  const b=button('＋',()=>addStep(edge),'edge-add')
  b.setAttribute('aria-label',label+'：'+edgeDescription(edge));b.title=label+'：'+edgeDescription(edge)
  return b
}
function removeStep(item) {
  update(()=>{
    graph.nodes=graph.nodes.filter(step=>step.id!==item.id)
    const fallback=item.type!=='branch' && item.next!==item.id?item.next??'':''
    if (graph.entry===item.id) graph.entry=fallback||graph.nodes[0]?.id||''
    for (const candidate of graph.nodes) for (const property of ['next','yes','no']) {
      if (candidate[property]===item.id) candidate[property]=fallback===candidate.id?'':fallback
    }
    selection=graph.entry
  })
}

function flowView() {
  const root=$('#workspace')
  if(!graph){root.replaceChildren(panelHead('配信フロー'),node('p','「新規シナリオ」またはテンプレートを選択してください。','empty'));return}
  const priorScroll=root.querySelector('.canvas-scroll')
  const oldTop=priorScroll?.scrollTop??0,oldLeft=priorScroll?.scrollLeft??0
  const title=node('div',null,'panelhead editor-head')
  title.append(panelHead(graph.name||'名称未設定',purposes[graph.purpose]+'  ·  '+(channels.find(item=>item.id===graph.channel)?.label??'公式LINE未選択')))
  const badges=node('div',null,'labels')
  if(scenario?.is_template||pendingMeta.is_template)badges.append(pill('テンプレート（配信なし）'))
  else if(scenario?.published_version)badges.append(pill(scenario.stopped?'公開停止中':'公開版 v'+scenario.published_version,scenario.stopped?'warn':'good'))
  badges.append(pill(dirty?'未保存の下書き':steps[scenario?.state??'draft'],dirty?'warn':''))
  title.append(badges)
  const bar=node('div',null,'toolbar')
  bar.append(button('＋ ステップ追加',()=>addStep()),button('ステップ検索',openStepSearch),button('コピー',openStepCopy),button(minimapOpen?'マップを閉じる':'ミニマップ',()=>{minimapOpen=!minimapOpen;show()}),button('実績',()=>{tab='metrics';show();choosePiece('inspector');loadMetrics()}),node('span',graph.nodes.length+'ステップ','field-hint'),node('span',null,'spacer'))
  const left=button(hideLibrary?'一覧を表示':'一覧を隠す',()=>{hideLibrary=!hideLibrary;applyPanelMode();show()});left.classList.add('desktop-panel-toggle');bar.append(left)
  const right=button(hideInspector?'設定を表示':'設定を隠す',()=>{hideInspector=!hideInspector;applyPanelMode();show()});right.classList.add('desktop-panel-toggle');bar.append(right)
  if(viewMode==='graph'){
    const setZoom=value=>{zoom=Math.max(.35,Math.min(1.5,value));show()}
    const zoomOut=button('－',()=>setZoom(zoom-.1));zoomOut.setAttribute('aria-label','縮小')
    const zoomIn=button('＋',()=>setZoom(zoom+.1));zoomIn.setAttribute('aria-label','拡大')
    bar.append(zoomOut,button(Math.round(zoom*100)+'%',()=>setZoom(1)),zoomIn,button('全体表示',()=>{
      const list=root.querySelector('.node-list'),scroll=root.querySelector('.canvas-scroll')
      if(list&&scroll)setZoom(Math.min(1,zoom*(scroll.clientWidth-32)/Math.max(list.getBoundingClientRect().width,1)))
    }))
  }else {
    bar.append(button('全分岐を開く',()=>{for(const n of graph.nodes.filter(n=>n.type==='branch'))for(const k of ['yes','no'])branchOpen.set(n.id+':'+k,true);show()}),button('折りたたむ',()=>{for(const n of graph.nodes.filter(n=>n.type==='branch'))for(const k of ['yes','no'])branchOpen.set(n.id+':'+k,false);show()}))
  }
  const scroll=node('div',null,'canvas-scroll '+(viewMode==='graph'?'graph-scroll':'basic-scroll'))
  const board=node('div',null,'canvas '+(viewMode==='graph'?'graph-view':'basic-view'))
  if(viewMode==='graph')board.style.zoom=String(zoom)
  const help=node('p','＋で途中に挿入。カードを選んで編集、長押し・ドラッグで同じ経路内の順番を変更できます。','reorder-help')
  help.id='reorder-help'
  const trigger=button('',()=>{tab='settings';show();choosePiece('inspector')},'trigger')
  const triggerText=node('span')
  const tag=graph.trigger==='tag_added'?applicantTagOptions(graph.triggerTag)[graph.triggerTag]:''
  triggerText.append(node('small','開始条件 · クリックして変更'),node('strong',(triggers[graph.trigger]??'未設定')+(tag?'：'+tag:'')))
  trigger.append(node('span','↳','icon'),triggerText)
  const list=node('div',null,'node-list')
  const map=new Map(graph.nodes.map(item=>[item.id,item]))
  const groups=reorderGroups(graph),seen=new Set()
  const connect=(edge,parent)=>{
    const connector=node('div',null,'connector insert-edge')
    connector.append(edgeButton(edge));parent.append(connector)
  }
  function drawPath(id,parent,depth=0) {
    const item=map.get(id)
    if(!item){parent.append(node('p','接続なし · ＋ から追加','path-ref'));return}
    if(seen.has(id)||depth>100){parent.append(button('↪ '+nameOf(id),()=>selectStep(id),'path-ref'));return}
    seen.add(id)
    const card=button('',()=>selectStep(item.id),'node'+(item.id===selection?' selected':''))
    card.setAttribute('aria-pressed',String(item.id===selection));card.dataset.stepId=item.id
    const copy=node('span',null,'node-content')
    let detail=kinds[item.type]
    if(item.type==='wait')detail+=' · '+(item.mode==='delay'?formatMinutes(item.minutes):item.mode==='booking'?'予約の'+formatMinutes(item.minutes)+'前':waitTypes[item.mode])
    if(item.type==='branch')detail+=' · '+(conditions[item.condition]??(item.condition==='all'?'すべての条件':item.condition==='any'?'いずれかの条件':'条件未設定'))+(item.condition==='tag'?'：'+(applicantTagOptions(item.tag)[item.tag]??item.tag):'')
    if(item.type==='branch'&&['all','any'].includes(item.condition))detail+='（'+branchRules(item).length+'件）'
    if(item.type==='message')detail+=' · '+(item.rich?({image:'画像付き',buttons:'ボタン付き',card:'カード'}[item.rich.kind])+' · ':'')+(item.category==='marketing'?'販促':graph.purpose==='recruitment'?'採用連絡':'業務案内')
    copy.append(node('strong',item.name||kinds[item.type]),node('small',detail+(item.id===graph.entry?' · 開始':'')))
    if(item.type==='message')copy.append(node('small',item.body.replace(/\s+/g,' '),'excerpt'))
    card.append(node('span',icons[item.type],'icon '+item.type),copy)
    copy.append(node('small','','step-error'))
    const observed=metrics&&metrics.version===scenario?.published_version?metrics.nodes.find(n=>n.node_id===item.id):null
    if(observed)copy.append(node('small','実績 v'+metrics.version+'：通過 '+observed.reached+'件'+(item.type==='message'?' ／ LINE受付 '+observed.accepted+'件':''),'step-stat'))
    if((groups.get(item.id)?.length??0)>1){
      card.dataset.reorderable='true';card.setAttribute('aria-describedby','reorder-help');card.setAttribute('aria-keyshortcuts','Alt+ArrowUp Alt+ArrowDown')
      const grip=node('span','⠿','step-grip');grip.setAttribute('aria-hidden','true');grip.title='長押しして並べ替え';card.append(grip)
      card.addEventListener('keydown',event=>{if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();applyStepOrder(adjacentMove(graph,item.id,event.key==='ArrowUp'?-1:1),item.id,true)}})
    }
    parent.append(card)
    if(item.type==='branch'){
      const lanes=node('div',null,'branch-lanes')
      for(const key of ['yes','no']){
        const next=item[key],label=key==='yes'?'はい':'いいえ',edge={owner:item.id,key}
        if(viewMode==='basic'){
          const lane=node('details',null,'branch-route branch-'+key)
          lane.open=branchOpen.get(item.id+':'+key)??true
          lane.addEventListener('toggle',()=>{if(lane.isConnected)branchOpen.set(item.id+':'+key,lane.open)})
          const summary=node('summary',label+' → '+nameOf(next)+'（'+routeSteps(graph,next)+'ステップ）','branch-summary')
          const body=node('div',null,'branch-body');lane.append(summary,body);connect(edge,body);drawPath(next,body,depth+1);lanes.append(lane)
        }else{
          const lane=node('div',null,'branch-lane branch-'+key)
          lane.append(node('span',label,'branch-label'));connect(edge,lane);drawPath(next,lane,depth+1);lanes.append(lane)
        }
      }
      parent.append(lanes)
    }else if(item.type!=='end'){connect({owner:item.id,key:'next'},parent);drawPath(item.next,parent,depth+1)}
  }
  connect({owner:null,key:'entry'},list);if(graph.entry)drawPath(graph.entry,list)
  const disconnected=graph.nodes.filter(item=>!seen.has(item.id))
  if(disconnected.length){
    const extra=node('div',null,'disconnected');extra.append(node('p','未接続のステップ（公開前に修正）','field-hint'))
    for(const item of disconnected)extra.append(button(item.name||kinds[item.type],()=>selectStep(item.id),'path-ref'));list.append(extra)
  }
  board.append(help,trigger,list);scroll.append(board)
  installStepDrag(board,{groups,canMove:()=>!busy&&board.isConnected,onMove:(source,target,position)=>applyStepOrder(reorderStep(graph,source,target,position),source)})
  const overview=minimapOpen?makeMinimap():null
  root.replaceChildren(title,bar,...(overview?[overview]:[]),scroll)
  updateValidation()
  scroll.scrollTop=oldTop;scroll.scrollLeft=oldLeft
}

function editStep() {
  const item=currentNode()
  if (!item) return node('p','フロー上のステップを選んで編集できます。','empty')
  const wrap=node('div')
  const set=(key,full=true)=>value=>update(()=>{item[key]=value},full,item.id+':'+key)
  const destinations=Object.fromEntries([['','接続なし'],...graph.nodes.filter(choice=>choice.id!==item.id).map(choice=>[choice.id,choice.name])])
  wrap.append(field('ステップ名',item.name,set('name',false),{event:'input',attributes:{maxlength:'100'}}))
  const group=reorderGroups(graph).get(item.id)
  if(group&&group.length>1){
    const position=group.indexOf(item.id)
    const controls=node('div',null,'step-move-controls')
    controls.append(node('span',`${position+1} / ${group.length} · この経路内の順番`,'field-hint'))
    const up=button('↑ 上へ',()=>applyStepOrder(adjacentMove(graph,item.id,-1),item.id))
    const down=button('↓ 下へ',()=>applyStepOrder(adjacentMove(graph,item.id,1),item.id))
    up.disabled=position===0
    down.disabled=position===group.length-1
    controls.append(up,down)
    wrap.append(controls)
  }
  if (item.type==='message') {
    if(graph.purpose==='customer')wrap.append(field('連絡の用途',item.category,set('category'),{items:{service:'業務案内',marketing:'顧客向け販促'}}))
    wrap.append(field('メッセージ形式',item.rich?.kind??'text',value=>update(()=>{if(value==='text')delete item.rich;else item.rich={kind:value,title:value==='card'?(item.rich?.title||'ご案内'):item.rich?.title??'',imageUrl:item.rich?.imageUrl??'',buttons:item.rich?.buttons?.length?item.rich.buttons:value==='buttons'?[{label:'詳細を見る',url:''}]:[]}}),{items:{text:'テキスト',image:'画像付きメッセージ',buttons:'リンクボタン付き',card:'カード'}}))
    if(item.rich)wrap.append(richEditor(item))
    const preview=node('div',null,'preview')
    const bubble=node('div',null,'rich-preview')
    preview.append(node('h3','LINEプレビュー（模擬）'),bubble)
    function updatePreview() {
      const result=renderMessage(item.body,person)
      bubble.replaceChildren(messagePreview(result.reason??(result.message||'メッセージを入力してください。'),item.rich))
    }
    const body=field('メッセージ本文',item.body,value=>{set('body',false)(value);updatePreview()},
      {type:'textarea',event:'input',attributes:{maxlength:item.rich?'1000':'5000'}})
    const vars=node('div',null,'controls')
    const relevant=graph.purpose==='recruitment'?['name','store','staff','booking','interview_link']:['name','store','staff','booking','price','booking_url','customer_link']
    for (const [key,label] of Object.entries(variables).filter(([key])=>relevant.includes(key))) vars.append(button(label,()=>{
      const input=body.querySelector('textarea')
      input.setRangeText('{{'+key+'}}',input.selectionStart,input.selectionEnd,'end')
      set('body',false)(input.value)
      count.textContent=input.value.length+'/'+(item.rich?1000:5000)+'文字'
      updatePreview()
      input.focus()
    },'chip'))
    updatePreview()
    const count=node('p',item.body.length+'/'+(item.rich?1000:5000)+'文字','field-hint')
    body.querySelector('textarea').addEventListener('input',()=>{count.textContent=body.querySelector('textarea').value.length+'/'+(item.rich?1000:5000)+'文字'})
    wrap.append(body,count,vars,preview,node('div',null,'separ'))
    if(graph.purpose==='recruitment'&&!item.tagGuard&&applicantCatalog.enabled&&viewMode==='graph'){
      wrap.append(button('送信直前条件を追加',()=>update(()=>{item.tagGuard={tag:graph.triggerTag||applicantCatalog.definitions.find(t=>t.active)?.tag_key||'',exclude:[]}})))
    }
    if(item.tagGuard){
      const guard=node('details',null,'template-guard');guard.open=true
      guard.append(node('summary','送信直前の条件（テンプレート）'),node('p','対象タグや面談予約が変わった場合、送信を保留します。','field-hint'),
        tagField('必要なタグ',item.tagGuard.tag,value=>update(()=>{item.tagGuard.tag=value;item.tagGuard.exclude=item.tagGuard.exclude.filter(k=>k!==value)})),
        field('面談予約条件',item.tagGuard.booked===undefined?'any':item.tagGuard.booked?'booked':'unbooked',value=>update(()=>{if(value==='any')delete item.tagGuard.booked;else item.tagGuard.booked=value==='booked'}),{items:{any:'指定しない',booked:'予約済みのみ',unbooked:'未予約のみ'}}))
      for(const t of applicantCatalog.definitions.filter(t=>t.active&&t.tag_key!==item.tagGuard.tag))guard.append(field('除外：'+t.label,item.tagGuard.exclude.includes(t.tag_key),value=>update(()=>{item.tagGuard.exclude=value?[...new Set([...item.tagGuard.exclude,t.tag_key])]:item.tagGuard.exclude.filter(k=>k!==t.tag_key)},false),{type:'checkbox'}))
      guard.append(button('送信直前条件を外す',()=>update(()=>{delete item.tagGuard})))
      wrap.append(guard)
    }
  }
  if (item.type==='wait') {
    wrap.append(field('待機方法',item.mode,value=>update(()=>{
      item.mode=value
      delete item.minutes;delete item.time;delete item.days
      if(value==='delay') item.minutes=60
      if(value==='booking') item.minutes=60
      if(value==='fixed') item.time=''
      if(value==='business') {item.days=1;item.time='18:00'}
    }),{items:waitTypes}))
    if(item.mode==='delay'||item.mode==='booking'){
      let {value,unit}=timeUnit(item.minutes)
      const row=node('div',null,'row'),label=item.mode==='delay'?'待機時間':'予約時刻の前'
      const amount=field(label,value,v=>{value=v;update(()=>{item.minutes=v*unit},false,item.id+':minutes');description.textContent=formatMinutes(item.minutes)},{type:'number',attributes:{min:item.mode==='delay'?'1':'0',step:'1',max:'525600'}})
      const units=field('単位',String(unit),v=>{unit=Number(v);update(()=>{item.minutes=value*unit},false,item.id+':minutes');description.textContent=formatMinutes(item.minutes)},{items:{'1':'分','60':'時間','1440':'日'}})
      const description=node('p',formatMinutes(item.minutes),'field-hint')
      row.append(amount,units);wrap.append(row,description)
    }
    if (item.mode==='fixed') wrap.append(field('実日付と時刻',item.time,set('time'),{type:'datetime-local'}))
    if (item.mode==='business') wrap.append(field('何営業日後',item.days,set('days'),{type:'number',attributes:{min:'0'}}),field('営業日内の時刻',item.time,set('time'),{type:'time'}))
  }
  if (item.type==='branch') {
    wrap.append(field('分岐する条件',item.condition,value=>update(()=>{const prev=branchRules(item);item.condition=value;if(['all','any'].includes(value)){item.rules=prev;delete item.tag}else{delete item.rules;if(value==='tag')item.tag=prev.find(r=>r.condition==='tag')?.tag??'';else delete item.tag}}),{items:{...conditions,all:'すべて満たす（AND）',any:'いずれか満たす（OR）'}}))
    if (item.condition==='tag') wrap.append(tagField('タグ名',item.tag,set('tag',false)))
    if(['all','any'].includes(item.condition)){
      const rules=item.rules??[];const ruleBox=node('div',null,'rules-box')
      ruleBox.append(node('p',item.condition==='all'?'すべての条件を満たす場合「はい」へ':'1つ以上の条件を満たす場合「はい」へ','field-hint'))
      rules.forEach((rule,i)=>{const row=node('section',null,'rule-row');row.append(node('strong','条件 '+(i+1)),field('条件の内容',rule.condition,v=>update(()=>{rule.condition=v;if(v!=='tag')delete rule.tag}),{items:conditions}));if(rule.condition==='tag')row.append(tagField('タグ',rule.tag??'',v=>update(()=>{rule.tag=v},false,item.id+':rule:'+i)));row.append(field('この条件を満たさない',!!rule.negated,v=>update(()=>{rule.negated=v}),{type:'checkbox'}));const remove=button('条件を削除',()=>update(()=>{item.rules.splice(i,1)}));remove.disabled=rules.length<=1;row.append(remove);ruleBox.append(row)})
      const add=button('＋ 条件を追加',()=>update(()=>{item.rules??=[];item.rules.push({condition:'booked',negated:false})}));add.disabled=rules.length>=8;ruleBox.append(add);wrap.append(ruleBox)
    }
    if(viewMode==='graph')wrap.append(field('条件を満たす場合',item.yes,set('yes'),{items:destinations}),field('条件を満たさない場合',item.no,set('no'),{items:destinations}))
    else for(const key of ['yes','no'])wrap.append(node('p',(key==='yes'?'はい':'いいえ')+' → '+nameOf(item[key]),'field-hint'),button((key==='yes'?'はい':'いいえ')+' に挿入',()=>addStep({owner:item.id,key})))
  } else if(item.type!=='end'){const next=field('次のステップ',item.next,set('next'),{items:destinations});if(viewMode==='graph')wrap.append(next);else wrap.append(node('p','次：'+nameOf(item.next),'field-hint'),button('次の位置に挿入',()=>addStep({owner:item.id,key:'next'})))}
  if (item.type==='tag') wrap.append(
    field('タグ操作',item.action??'add',set('action'),{items:{add:'付ける',remove:'外す'}}),
    tagField('タグ名',item.tag,set('tag',false)))
  if (item.type==='task') wrap.append(field('担当者へ渡す内容',item.note,set('note',false),{type:'textarea',event:'input',attributes:{maxlength:'400'}}))
  wrap.append(button('このステップをコピー',()=>copySelected([item.id])),button('ステップを削除',()=>{
    const ok=button('削除を確定',()=>{$('#dialog').close();removeStep(item)},'danger')
    dialog('「'+item.name+'」を削除しますか？','接続先を変更した後、公開前にフローを検証してください。',ok)
  },'danger'))
  return wrap
}

function settings() {
  const wrap=node('div')
  const set=(key,draw=true)=>value=>update(()=>{graph[key]=value},draw)
  const opts=Object.fromEntries([['','選択してください'],...channels
    .filter(c=>c.purpose===graph.purpose||c.purpose==='shared').map(c=>[c.id,c.label])])
  wrap.append(field('シナリオ名',graph.name,set('name',false),{event:'input',attributes:{maxlength:'100'}}),
    field('シナリオの用途',graph.purpose,value=>update(()=>{
      graph.purpose=value
      graph.channel=channels.find(c=>c.purpose===value||c.purpose==='shared')?.id??''
    }),{items:Object.fromEntries(Object.entries(purposes).filter(([key])=>key===graph.purpose||channels.some(c=>c.purpose===key||c.purpose==='shared')))}),
    field('配信先の公式アカウント',graph.channel,set('channel'),{items:opts}))
  if (Object.keys(opts).length<2) wrap.append(node('p','対象店舗に対応する公式アカウントを登録してください。','field-hint'))
  const available={...liveTriggers[graph.purpose]}
  if(graph.purpose==='recruitment'&&!applicantCatalog.enabled){delete available.tag_added;delete available.tag_campaign}
  if(!Object.hasOwn(available,graph.trigger)){
    available[graph.trigger]=(triggers[graph.trigger]??graph.trigger)+'（下書き・テスト専用）'
    wrap.append(node('p','現在の開始イベントは実配信に対応していません。公開するには、開始イベントを対応する項目へ変更してください。','field-hint'))
  }
  wrap.append(field('開始イベント',graph.trigger,set('trigger'),{items:available}))
  if(viewMode==='graph')wrap.append(field('開始ステップ',graph.entry,set('entry'),{items:Object.fromEntries(graph.nodes.map(item=>[item.id,item.name]))}))
  if(graph.trigger==='tag_added')wrap.append(tagField('開始条件のタグ',graph.triggerTag??'',set('triggerTag')))
  if(graph.trigger==='tag_campaign')wrap.append(node('p','公開後、「採用タグ・絞り込み配信」で対象タグを選び、人数を確認して配信を開始します。','field-hint'))
  if(graph.purpose==='recruitment'&&!applicantCatalog.enabled)wrap.append(node('p','採用タグを使うには店舗運用の採用タグ機能を有効にしてください。','field-hint'))
  const window=node('div',null,'row')
  window.append(field('販促を開始できる時刻',graph.windowStart,set('windowStart'),{type:'time'}),
    field('販促を終了する時刻',graph.windowEnd,set('windowEnd'),{type:'time'}))
  const freq=node('div',null,'row')
  freq.append(field('1日あたりの上限',graph.daily,set('daily'),{type:'number',attributes:{min:'1',max:'50'}}),
    field('7日間の上限',graph.weekly,set('weekly'),{type:'number',attributes:{min:'1',max:'50'}}))
  const advanced=node('details',null,'advanced-options');advanced.open=viewMode==='graph';advanced.append(node('summary','詳細な配信制限と担当者設定'))
  if(graph.purpose==='customer')advanced.append(window,freq)
  const holidays=node('details')
  holidays.append(node('summary','販促の休業曜日'))
  for (const [index,label] of ['日','月','火','水','木','金','土'].entries()) holidays.append(field(label+'曜日を休業',graph.holidays.includes(index),checked=>update(()=>{
    graph.holidays=checked?[...new Set([...graph.holidays,index])]:graph.holidays.filter(day=>day!==index)
  },false),{type:'checkbox'}))
  if(graph.purpose==='customer')advanced.append(holidays)
  advanced.append(field('再参加を許可する',graph.rejoin,set('rejoin',false),{type:'checkbox'}),
    field('再参加の間隔（日）',graph.cooldownDays,set('cooldownDays',false),{type:'number',attributes:{min:'1',max:'365'}}))
  advanced.append(field('担当者が不在の場合',graph.missingAssignee,set('missingAssignee'),
    {items:{manager:'店舗責任者へ回す',hold:'保留'}}));wrap.append(advanced)
  return wrap
}

function nowInZone(zone) {
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
  const p=Object.fromEntries(format.formatToParts(new Date()).map(item=>[item.type,item.value]))
  return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute
}

async function testDelivery() {
  const results=simulation?.events.filter(event=>event.message)??[]
  if (!results.length || dirty || !scenario) throw new Error('下書きを保存し、送信予定のあるシミュレーションを実行してください。')
  const url=base()+'/'+scenario.id
  const candidates=await api(url+'/testers')
  const jobs=await api(url+'/test-sends')
  const box=node('div')
  const labels={queued:'待機中',submitting:'LINEへ提出中',accepted:'LINE受付済',failed:'失敗',unknown:'結果不明',cancelled:'取消'}
  let recipient=candidates[0]?.id
  let selected=results[0].id
  const key=crypto.randomUUID()
  const actualTagTest=graph.trigger==='tag_campaign'&&graph.purpose==='recruitment'&&!!scenario.published_version
  if(actualTagTest)box.append(node('p','公開済みタグ絞り込みでは、テスター本人の現在のタグを送信直前にも照合します。通常配信や通知同意は変更しません。','field-hint'))
  box.append(field('テスト送信するステップ',selected,value=>{selected=value},{
    items:Object.fromEntries(results.map(item=>[item.id,item.name])),
  }))
  if (!candidates.length) box.append(node('p','店舗・LINE接続画面で、同じ公式アカウントと用途のテスト利用者を新たに認証してください。'))
  else box.append(field('認証済みテスト利用者',recipient,value=>{recipient=value},{
    items:Object.fromEntries(candidates.map(({id,verified_at})=>[id,'認証 '+new Date(verified_at).toLocaleString('ja-JP')+' · '+id.slice(0,8)])),
  }),button('テスト利用者に1通送る',async()=>{
    const {zone,cutoff,...fixture}=person
    await api(url+'/test-sends','POST',{revision:scenario.revision,node:selected,tester:recipient,fixture,...(actualTagTest?{actual_tags:true}:{})},key)
    $('#dialog').close()
    announce('テスト送信を登録しました。送信結果はテスト送信画面で確認できます。')
  },'primary'))
  if (jobs.length) {
    const statuses=node('ul',null,'log')
    for(const item of jobs) statuses.append(node('li',new Date(item.created_at).toLocaleString('ja-JP')+' · '+labels[item.status]))
    box.append(statuses)
  }
  dialog('登録済み利用者へのテスト送信','シミュレーションで選ばれたメッセージをテスト表示付きで1通送ります。',box)
}

function resultView() {
  const wrap=node('div')
  wrap.append(node('p','配信を行わない模擬テストです。実際のLINE送信は別のボタンで実施します。','field-hint'))
  const failures=limits()
  if (failures.length) {
    const list=node('ul',null,'errors')
    for (const failure of failures) {
      const row=node('li')
      row.append(failure.nodeId?button(failure.message,()=>selectStep(failure.nodeId)):node('p',failure.message,'empty'))
      list.append(row)
    }
    wrap.append(list)
  }
  if (!person.start) person.start=nowInZone(person.zone)
  const box=node('div')
  function set(key) {return value=>{person[key]=value;simulation=null;matrix=null;clearResult();$('#matrix-result')?.replaceChildren()}}
  function clearResult() {
    const out=$('#simulation-result')
    if (out) out.replaceChildren()
    const record=$('#mark-tested')
    if (record) record.disabled=true
    $('#test-delivery')?.remove()
  }
  const presets=field('テスト条件',preset,value=>{
    preset=value
    person={...person,booked:value==='booked',stopped:value==='stopped',human:value==='human',
      blocked:false,cancelled:false,marketingStopped:false,consent:value!=='noConsent',adult:value!=='unverified'}
    simulation=null;matrix=null
    show()
  },{items:{unbooked:'未予約・同意あり',booked:'予約済み',unverified:'年齢未確認',noConsent:'同意なし',stopped:'全配信停止',human:'有人対応中'}})
  box.append(presets,field('シミュレーション開始日時（'+person.zone+'）',person.start,set('start'),{type:'datetime-local'}))
  const more=node('details')
  more.append(node('summary','対象者と配信条件'))
  const flags={booked:'予約あり',consent:'目的別同意あり',adult:'20歳以上を確認済み',blocked:'LINEブロック',
    stopped:'全配信停止',marketingStopped:'販促停止',responded:'返信あり',human:'有人対応中',assigned:'担当者あり',cancelled:'予約取消または辞退',
    bookingLinkValid:'予約変更URLの有効性を確認済み',eligible:'店舗の利用適格性を確認済み',
    contractActive:'契約上の配信権限あり',budgetAvailable:'利用可能な配信枠あり',bookingCurrent:'最新の予約版を参照'}
  for (const [key,label] of Object.entries(flags)) more.append(field(label,person[key],set(key),{type:'checkbox'}))
  more.append(field('予約日時',person.bookingAt,set('bookingAt'),{type:'datetime-local'}))
  for (const [key,label] of Object.entries(variables)) more.append(field(label,person.values[key],value=>{person.values[key]=value;simulation=null;clearResult()},{event:'input'}))
  if(graph.purpose==='recruitment'){for(const t of applicantCatalog.definitions.filter(t=>t.active))more.append(field('保有タグ：'+t.label,person.tags.includes(t.tag_key),checked=>set('tags')(checked?[...new Set([...person.tags,t.tag_key])]:person.tags.filter(k=>k!==t.tag_key)),{type:'checkbox'}))}
  else more.append(field('保有タグ（カンマ区切り）',person.tags.join(','),value=>set('tags')(value.split(',').map(item=>item.trim()).filter(Boolean))))
  const counts=node('div',null,'row')
  counts.append(field('直近1日の販促通数',person.dayCount,set('dayCount'),{type:'number',attributes:{min:'0'}}),
    field('直近7日の販促通数',person.weekCount,set('weekCount'),{type:'number',attributes:{min:'0'}}))
  more.append(counts)
  box.append(more,button('シミュレーションを実行',()=>{
    simulation=simulate(graph,person);matrix=simulationCases(graph,person)
    show()
  },'primary'))
  wrap.append(box)
  const output=node('div')
  output.id='simulation-result'
  if (simulation) {
    const list=node('ol',null,'log')
    const formatter=new Intl.DateTimeFormat('ja-JP',{timeZone:person.zone,month:'numeric',day:'numeric',
      hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    for (const event of simulation.events) {
      const row=node('li',null,event.state)
      const time=node('time',formatter.format(new Date(event.at)))
      time.dateTime=event.at
      row.append(time,node('strong',event.name),node('p',(event.state==='held'?'保留・除外　':'')+event.detail))
      if (event.message) {
        const detail=node('details')
        detail.append(node('summary','送信内容'),messagePreview(event.message,event.rich))
        row.append(detail)
      }
      list.append(row)
    }
    for (const error of simulation.errors) list.append(node('li',error.message,'held'))
    output.append(node('p','1人あたり概算 '+simulation.count+' 通','compact'))
    const timeline=node('section',null,'chat-timeline')
    timeline.append(node('h3','LINEトークの配信プレビュー'))
    for(const event of simulation.events.filter(e=>e.type==='message')){
      timeline.append(node('time',formatter.format(new Date(event.at))),event.message?messagePreview(event.message,event.rich):node('p','送信なし：'+event.detail,'held-note'))
    }
    if(timeline.children.length===1)timeline.append(node('p','この条件では送信されません。','field-hint'))
    output.append(timeline,list)
  }
  wrap.append(output)
  const matrixRoot=node('div',null,'matrix-result');matrixRoot.id='matrix-result'
  if(matrix){
    matrixRoot.append(node('h3','複数の応募者条件の自動テスト'),node('p','開始条件を満たすと想定した模擬計算です。実際の送達や対象人数ではありません。','field-hint'))
    for(const row of matrix){
      const entry=node('details',null,'matrix-row')
      const held=row.result.events.filter(e=>e.state==='held').length
      entry.append(node('summary',row.label+' · '+(row.result.errors.length?'要確認':row.result.count+'通／保留 '+held+'件')))
      for(const event of row.result.events.filter(e=>e.message||e.state==='held'))entry.append(node('p',event.name+'：'+(event.message??event.detail),'field-hint'))
      for(const error of row.result.errors)entry.append(node('p',error.message,'held-note'))
      matrixRoot.append(entry)
    }
  }
  wrap.append(matrixRoot)
  if (!demo && scenario && !dirty && simulation?.count>0) {
    const send=button('実LINEテスト送信・履歴',testDelivery)
    send.id='test-delivery'
    wrap.append(send)
  }
  if (scenario?.state==='draft'&&!dirty) {
    const mark=button('模擬テスト済みにする',()=>transition('test'))
    mark.id='mark-tested'
    mark.disabled=!simulation||!!simulation.errors.length||!!failures.length
    wrap.append(mark)
  }
  return wrap
}

function stepDescription(flow,n){
  const name=id=>flow.nodes.find(v=>v.id===id)?.name??'接続なし'
  const lines=[n.name+'（'+(kinds[n.type]??n.type)+'）']
  if(n.type==='message'){
    lines.push(n.body)
    if(n.rich)lines.push('形式：'+n.rich.kind,'タイトル：'+(n.rich.title??''),'画像：'+(n.rich.imageUrl??''),...n.rich.buttons.map(b=>b.label+' → '+b.url))
    if(n.tagGuard)lines.push('送信直前条件：'+n.tagGuard.tag+(n.tagGuard.exclude.length?' ／ 除外 '+n.tagGuard.exclude.join('、'):'')+(n.tagGuard.booked===undefined?'':n.tagGuard.booked?' ／ 予約済み':' ／ 未予約'))
  }
  if(n.type==='wait')lines.push(n.mode==='delay'?formatMinutes(n.minutes)+'待機':n.mode==='booking'?'予約の'+formatMinutes(n.minutes)+'前':n.mode==='business'?n.days+'営業日後 '+n.time:n.time??'未設定')
  if(n.type==='branch')lines.push((n.condition==='all'?'すべて（AND）':n.condition==='any'?'いずれか（OR）':'条件')+'：'+branchRules(n).map(r=>(conditions[r.condition]??r.condition)+(r.condition==='tag'?'：'+r.tag:'')+(r.negated?' を満たさない':'')).join(' ／ '),'はい → '+name(n.yes),'いいえ → '+name(n.no))
  else if(n.type!=='end')lines.push('次 → '+name(n.next))
  if(n.type==='tag')lines.push((n.action==='remove'?'解除':'追加')+'：'+n.tag)
  if(n.type==='task')lines.push(n.note)
  return lines.join('\n')
}
function diffSummary(before,after){
  const changes=compareFlows(before,after),box=node('div',null,'version-diff')
  const compact=node('div',null,'diff-summary')
  const labels={name:'名称',purpose:'用途',trigger:'開始条件',triggerTag:'開始タグ',channel:'配信先LINE',entry:'開始位置',windowStart:'送信開始時刻',windowEnd:'送信終了時刻',daily:'日次上限',weekly:'週次上限',holidays:'休業曜日',rejoin:'再参加',cooldownDays:'再参加間隔',missingAssignee:'担当者条件'}
  for(const [title,items] of [['追加',changes.added],['変更',changes.changed],['削除',changes.removed],['設定変更',changes.settings.map(k=>labels[k]??k)]]){
    const row=node('div',null,'diff-line');row.append(node('strong',title+' '+items.length+'件'),node('p',items.join('、')||'なし','field-hint'));compact.append(row)
  }
  box.append(compact)
  const old=new Map((before?.nodes??[]).map(n=>[n.id,n])),next=new Map(after.nodes.map(n=>[n.id,n]))
  const specific=node('details',null,'diff-details')
  specific.append(node('summary','変更内容の詳細（変更前・変更後）'))
  function row(label,from,to){
    const line=node('section',null,'diff-detail')
    line.append(node('h4',label))
    const pair=node('div',null,'diff-pair')
    for(const [heading,value] of [['変更前',from],['変更後',to]]){
      const item=node('div',null,'diff-detail-box');item.append(node('strong',heading),node('p',value,'diff-text'));pair.append(item)
    }
    line.append(pair);specific.append(line)
  }
  for(const n of after.nodes){
    const prev=old.get(n.id)
    if(!prev||JSON.stringify(prev)!==JSON.stringify(n))row(n.name,prev?stepDescription(before,prev):'（追加前のステップなし）',stepDescription(after,n))
  }
  for(const n of before?.nodes??[])if(!next.has(n.id))row(n.name,stepDescription(before,n),'（削除）')
  const display=(flow,key)=>{
    const v=flow?.[key]
    if(v===undefined)return '未設定'
    if(key==='channel')return channels.find(c=>c.id===v)?.label??'登録先が変わりました'
    if(key==='purpose')return purposes[v]??v
    if(key==='trigger')return triggers[v]??v
    if(key==='entry')return flow.nodes.find(n=>n.id===v)?.name??v
    if(key==='triggerTag')return applicantTagOptions(v)[v]??v
    if(typeof v==='boolean')return v?'有効':'無効'
    return Array.isArray(v)?v.join('、')||'なし':String(v)
  }
  for(const key of changes.settings)row(labels[key]??key,display(before,key),display(after,key))
  if(specific.children.length>1)box.append(specific)
  return box
}
async function reviewPublication(){
  if(!scenario||dirty||scenario.is_template)return
  const id=scenario.id,rev=scenario.revision
  let info
  if(demo){const stored=scenario.versions?.find(v=>v.version===scenario.published_version);info={published:stored,related:[]}}
  else info=await api(base()+'/'+id+'/publication-review')
  if(scenario.id!==id||scenario.revision!==rev||dirty||info.revision!==undefined&&info.revision!==rev)throw new Error('下書きが変更されました。再表示してください。')
  const box=node('div',null,'publish-review')
  const line=channels.find(c=>c.id===graph.channel)
  box.append(node('h3','送信先：'+store.name+' / '+(line?.label??'未設定')),
    node('p','開始条件：'+(triggers[graph.trigger]??graph.trigger)+(graph.triggerTag?' / '+(applicantTagOptions(graph.triggerTag)[graph.triggerTag]??graph.triggerTag):'')),
    node('p','配信対象は開始イベント・同意・店舗設定などにより送信時に判定されます。','field-hint'))
  const sample={...person,start:person.start||nowInZone(person.zone)}
  const cases=simulationCases(graph,sample)
  const results=node('div',null,'matrix-result')
  for(const c of cases)results.append(node('p',c.label+'：'+(c.result.errors.length?'要確認':c.result.count+'通／保留 '+c.result.events.filter(e=>e.state==='held').length+'件')))
  box.append(results)
  const messages=node('details',null,'diff-details')
  messages.append(node('summary','公開するLINEメッセージ（'+graph.nodes.filter(n=>n.type==='message').length+'ステップ）'))
  for(const item of graph.nodes.filter(n=>n.type==='message'))messages.append(node('h4',item.name),messagePreview(item.body,item.rich))
  if(messages.children.length>1)box.append(messages)
  box.append(node('h3',info.published?'現公開版と下書きの差分':'初回公開の内容'),diffSummary(info.published?.graph,graph))
  if(info.related.length){
    box.append(node('h3','同じ開始条件の公開シナリオ'))
    for(const related of info.related)box.append(node('p',related.name+'（v'+related.version+'）','copy-warning'))
    box.append(node('p','条件が同じため重複する可能性があります。配信内容を確認してください。','field-hint'))
  }else box.append(node('p','同じLINE・開始条件の公開シナリオは見つかりませんでした。異なる開始条件や他機能の通知との重複を保証するものではありません。','field-hint'))
  const check=field('店舗・LINE・対象条件・配信内容を確認しました',false,value=>{publish.disabled=!value||limits().length>0||cases.some(c=>c.result.errors.length)},{type:'checkbox'})
  const publish=button('この下書きを公開する',async()=>{
    if(scenario.id!==id||scenario.revision!==rev||dirty)throw new Error('状態が変わりました。再確認してください。')
    await transition('publish');$('#dialog').close()
  },'primary template-use')
  publish.disabled=true
  box.append(check,publish)
  dialog('公開前の最終確認','ここで公開が確定します。テストは実際の配信を行いません。',box)
  $('#dialog').classList.add('template-dialog')
}

function publication() {
  const wrap=node('div')
  if (!scenario || dirty) {
    wrap.append(node('p','承認・公開版の管理には、下書きの保存が必要です。','empty'))
    return wrap
  }
  if(scenario.is_template){wrap.append(node('p','このテンプレート自体は配信されません。複製して配信シナリオを作成します。','field-hint'),button('テンプレートから新規シナリオを作成',()=>openCopy(graph,store,false,scenario.folder),'primary'));return wrap}
  wrap.append(pill(steps[scenario.state]),node('p',scenario.published_version?'公開版 v'+scenario.published_version+
    (scenario.stopped?' · 停止中':''):'公開版はまだありません。','empty'))
  if (!demo) wrap.append(node('p',(graph.purpose==='recruitment'?'採用向け':'顧客向け')+'の対応イベントが発生すると、有効な店舗で対象者と最新の配信条件を照合します。','field-hint'))
  const row=node('div',null,'controls')
  if (scenario.state==='draft') row.append(button('配信前テストへ',()=>{tab='test';show()}))
  if (scenario.state==='tested') row.append(button('下書きを承認',()=>transition('approve'),'primary'))
  if (scenario.state==='approved') row.append(button('公開前の最終確認',reviewPublication,'primary'))
  if (scenario.published_version) {
    const action=scenario.stopped?'resume':'stop'
    const verb=scenario.stopped?'再開':'停止'
    row.append(button('シナリオを'+verb,()=>{
      let reason=''
      const content=node('div')
      content.append(field(verb+'理由','',value=>{reason=value},{event:'input',attributes:{maxlength:'200'}}),
        button(verb+'を確定',async()=>{
          if (!reason.trim()) throw new Error('理由を入力してください。')
          await transition(action,reason.trim())
          $('#dialog').close()
        },scenario.stopped?'primary':'danger'))
      dialog('シナリオを'+verb,'理由は操作履歴に記録されます。',content)
    },scenario.stopped?'quiet':'danger'))
  }
  wrap.append(row)
  const availableVersions=scenario.versions?.length?scenario.versions:scenario.published_version?[{version:scenario.published_version}]:[]
  if(availableVersions.length){
    const list=node('ul',null,'log')
    for(const version of availableVersions) {
      const item=node('li')
      item.append(button('v'+version.version+' の内容を見る',async()=>{
        const stored=version.graph?version:await api(base()+'/'+scenario.id+'/versions/'+version.version)
        const view=node('div',null,'version-review'),flow=node('ol',null,'log')
        for(const step of stored.graph.nodes) flow.append(node('li',step.name+' · '+kinds[step.type]+
          (step.type==='message'?'　'+step.body:'')))
        view.append(node('h3','現在の下書きとの差分'),diffSummary(stored.graph,graph),flow)
        view.append(button('この版を下書きとして復元',async()=>{
          if(savePromise)await savePromise
          $('#dialog').close()
          update(()=>{graph=structuredClone(stored.graph);selection=graph.entry;tab='edit'})
          announce('過去の版を下書きへ復元しました。現在の公開版は変更されていません。')
        },'primary'))
        dialog('公開版 v'+version.version,stored.graph.name,view);$('#dialog').classList.add('template-dialog')
      }))
      list.append(item)
    }
    wrap.append(node('div',null,'separ'),node('h3','公開版の履歴','compact'),list)
  }
  return wrap
}

function inspector() {
  const root=$('#inspector')
  if (!graph) {root.replaceChildren(panelHead('設定・プレビュー'));return}
  const tabs=node('nav',null,'tabs')
  tabs.setAttribute('aria-label','シナリオの設定')
  for (const [id,label] of Object.entries({edit:'ステップ',settings:'設定',test:'テスト',publish:'公開版',metrics:'実績'})) {
    const btn=button(label,()=>{tab=id;show();if(id==='metrics')loadMetrics()},tab===id?'active':'')
    btn.setAttribute('aria-pressed',String(tab===id))
    tabs.append(btn)
  }
  const panel=node('div',null,'panelbody')
  const chosen={edit:editStep,settings,test:resultView,publish:publication,metrics:metricsView}
  const validation=node('div',null,'validation-panel');validation.id='validation-panel';panel.append(validation,chosen[tab]())
  root.replaceChildren(panelHead('設定・プレビュー'),tabs,panel);updateValidation()
}

function show() {
  const inspectorScroll=$('#inspector')?.scrollTop??0;const libraryScroll=$('#library')?.scrollTop??0
  library();flowView();inspector();workbar();applyPanelMode();$('#inspector').scrollTop=inspectorScroll;$('#library').scrollTop=libraryScroll
}

function applyPanelMode(){
  const layout=$('#layout');layout.classList.toggle('hide-library',hideLibrary);layout.classList.toggle('hide-inspector',hideInspector);layout.classList.toggle('focus-mode',focusMode)
}
function validationIssues(){
  if(!graph)return []
  const errors=limits()
  if(graph.entry){const seen=new Set(),map=new Map(graph.nodes.map(n=>[n.id,n])),stack=[graph.entry];while(stack.length){const id=stack.pop();if(seen.has(id)||!map.has(id))continue;seen.add(id);stack.push(...links(map.get(id)))}for(const n of graph.nodes)if(!seen.has(n.id))errors.push({message:'開始条件から到達できないステップ：'+n.name,nodeId:n.id})}
  if(!Object.hasOwn(liveTriggers[graph.purpose]??{},graph.trigger))errors.push({message:'この開始イベントは実配信に未対応です。',nodeId:null})
  const channel=channels.find(c=>c.id===graph.channel)
  if(graph.channel&&(!channel||![graph.purpose,'shared'].includes(channel.purpose)))errors.push({message:'用途に対応する公式LINEを選んでください。',nodeId:null})
  if(graph.purpose==='recruitment')for(const n of graph.nodes){
    const tags=tagKeys({nodes:[n]}),active=applicantCatalog.definitions.filter(t=>t.active)
    if(tags.some(k=>!active.some(t=>t.tag_key===k||t.label===k)))errors.push({message:'現在の店舗で有効な採用タグを選んでください。',nodeId:n.id})
  }
  return errors
}
function updateValidation(){
  if(!graph)return
  const issues=validationIssues(),byStep=new Map()
  for(const issue of issues)if(issue.nodeId&&!byStep.has(issue.nodeId))byStep.set(issue.nodeId,issue.message)
  for(const card of document.querySelectorAll('[data-step-id]')){const msg=byStep.get(card.dataset.stepId);card.classList.toggle('invalid-step',!!msg);const badge=card.querySelector('.step-error');if(badge){badge.hidden=!msg;badge.textContent=msg?'⚠ '+msg:''}}
  const panel=$('#validation-panel');if(!panel)return
  const summary=node('details',null,'live-check '+(issues.length?'has-errors':'no-errors'))
  summary.append(node('summary',issues.length?'⚠ 設定の確認 '+issues.length+'件':'✓ フローの設定に問題なし'))
  const list=node('div',null,'validation-list')
  for(const issue of issues){const b=button(issue.message,()=>{if(issue.nodeId)selectStep(issue.nodeId);else{tab='settings';show();choosePiece('inspector')}});list.append(b)}
  if(!issues.length)list.append(node('p','実配信の開始条件・契約・LINE接続は公開前に別途確認します。','field-hint'))
  summary.append(list);summary.open=panel.querySelector('details')?.open??false;panel.replaceChildren(summary)
}
function newStepId(){return 'step-'+crypto.randomUUID().replaceAll('-','').slice(0,16)}
function copySelected(ids){
  const block=stepBlock(graph,ids)
  if(!block)throw new Error('一つにつながるステップを選択してください。')
  stepClipboard={store:store.id,purpose:graph.purpose,block}
  announce(block.nodes.length+'ステップをコピーしました。追加位置の「＋」から貼り付けられます。');if($('#dialog').open)$('#dialog').close()
}
function openStepCopy(){
  const chosen=new Set(selection?[selection]:[]),box=node('div',null,'step-copy-dialog'),list=node('div',null,'step-checklist'),hint=node('p','','field-hint')
  const apply=button('選択したステップをコピー',()=>copySelected([...chosen]),'primary')
  function refresh(){const block=stepBlock(graph,[...chosen]);hint.textContent=chosen.size+'件を選択'+(block?' · コピー可能':' · ひとつにつながる範囲を選択');apply.disabled=!block}
  for(const n of stepOutline(graph))list.append(field(n.name+'（'+kinds[n.type]+'）',chosen.has(n.id),v=>{if(v)chosen.add(n.id);else chosen.delete(n.id);refresh()},{type:'checkbox'}))
  box.append(hint,list,apply);refresh();dialog('ステップをコピー','同じ店舗・用途内で、連続したステップや分岐の一部を複製できます。選択範囲外の出口は挿入先へ接続します。終了を含む範囲は既存経路の途中に挿入できません。',box)
}
function openStepSearch(){
  const box=node('div',null,'step-search'),list=node('div',null,'step-search-results')
  const search=value=>{list.replaceChildren();const key=value.trim().toLocaleLowerCase();for(const entry of stepOutline(graph)){const n=graph.nodes.find(n=>n.id===entry.id),terms=[n.name,n.body,n.note,n.tag,n.type,...(n.rich?.buttons??[]).map(b=>b.label+' '+b.url),...tagKeys({nodes:[n]}).map(t=>applicantTagOptions(t)[t]??t)].filter(Boolean).join(' ').toLocaleLowerCase();if(!terms.includes(key))continue;const b=button('',()=>{$('#dialog').close();selectStep(n.id)},'mini-result');b.append(node('strong',n.name),node('small',kinds[n.type]+' · '+(n.body??n.note??'').slice(0,100)));list.append(b)}if(!list.children.length)list.append(node('p','一致するステップがありません。','empty'))}
  box.append(field('ステップ名・本文・タグを検索','',search,{event:'input',attributes:{type:'search',placeholder:'例：面談予約'}}),list);search('');dialog('フロー内検索','結果を選ぶと該当ステップへ移動します。',box);box.querySelector('input').focus()
}
function makeMinimap(){
  const area=node('section',null,'minimap'),head=node('div',null,'minimap-head');head.append(node('strong','フローの全体像'),node('small',graph.nodes.length+' ステップ'),button('閉じる',()=>{minimapOpen=false;show()}));area.append(head,miniGraph())
  const map=node('div',null,'minimap-nodes');for(const n of stepOutline(graph)){const b=button('',()=>selectStep(n.id),'minimap-node '+n.type+(n.id===selection?' selected':''));b.append(node('span',icons[n.type]),node('small',n.name));b.title=n.name;b.setAttribute('aria-label','移動：'+n.name);b.dataset.depth=String(Math.min(n.depth,3));map.append(b)}area.append(map);return area
}
function miniGraph(){
  const ns='http://www.w3.org/2000/svg',make=(tag,attrs={})=>{const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));return el}
  const outline=stepOutline(graph),byId=new Map(graph.nodes.map(n=>[n.id,n])),indegree=new Map(outline.map(n=>[n.id,0])),levels=new Map(outline.map(n=>[n.id,0]))
  for(const n of graph.nodes)for(const dest of links(n))if(indegree.has(dest))indegree.set(dest,indegree.get(dest)+1)
  const queue=outline.filter(n=>indegree.get(n.id)===0).map(n=>n.id),visited=new Set()
  while(queue.length){const id=queue.shift();visited.add(id);for(const dest of links(byId.get(id))){if(!indegree.has(dest))continue;levels.set(dest,Math.max(levels.get(dest),levels.get(id)+1));indegree.set(dest,indegree.get(dest)-1);if(indegree.get(dest)===0)queue.push(dest)}}
  for(const n of outline)if(!visited.has(n.id))levels.set(n.id,Math.max(0,...levels.values())+1)
  const columns=new Map();for(const n of outline){const l=levels.get(n.id);if(!columns.has(l))columns.set(l,[]);columns.get(l).push(n)}
  const width=Math.max(100,...[...columns.keys()].map(k=>k*54+78)),height=Math.max(64,...[...columns.values()].map(c=>c.length*27+20)),points=new Map()
  for(const [col,list] of columns)list.forEach((n,i)=>points.set(n.id,{x:col*54+38,y:height/2+(i-(list.length-1)/2)*27}))
  const svg=make('svg',{viewBox:`0 0 ${width} ${height}`,class:'mini-graph',role:'img','aria-label':'分岐と接続の縮小表示'})
  for(const n of graph.nodes){const a=points.get(n.id);if(!a)continue;for(const [i,target] of links(n).entries()){const b=points.get(target);if(!b)continue;svg.append(make('path',{d:`M${a.x+12} ${a.y} C${(a.x+b.x)/2} ${a.y},${(a.x+b.x)/2} ${b.y},${b.x-12} ${b.y}`,fill:'none',stroke:n.type==='branch'?(i===0?'#72d6b4':'#ffc17c'):'#a7a3cf','stroke-width':1.5}))}}
  for(const n of outline){const {x,y}=points.get(n.id),g=make('g',{class:'mini-svg-node'});g.append(make('rect',{x:x-12,y:y-8,width:24,height:16,rx:5,fill:n.type==='branch'?'#845f38':n.type==='message'?'#285f58':n.type==='end'?'#394155':'#444071',stroke:n.id===selection?'#ebe2ff':'#9d9bc3','stroke-width':n.id===selection?3:1.2}));const title=make('title');title.textContent=n.name;g.append(title);g.addEventListener('click',()=>selectStep(n.id));svg.append(g)}return svg
}
function messagePreview(body,rich){
  if(!rich)return node('p',body,'bubble')
  const box=node('div',null,'line-card-preview')
  if(rich.imageUrl){const img=node('div',null,'line-image-placeholder');img.append(node('strong','▧ 画像'),node('small',publicHttps(rich.imageUrl)?'LINE送信時に画像を表示':'画像URLが未設定'));if(publicHttps(rich.imageUrl)){const a=node('a','画像を別タブで確認');a.href=rich.imageUrl;a.target='_blank';a.rel='noopener noreferrer';img.append(a,button('画像をプレビュー',()=>{const photo=node('img');photo.alt='配信する画像';photo.referrerPolicy='no-referrer';photo.src=rich.imageUrl;photo.addEventListener('error',()=>{img.replaceChildren(node('p','画像を表示できません。公開URLを確認してください。'))});img.replaceChildren(photo)}))}box.append(img)}
  if(rich.title)box.append(node('strong',rich.title,'line-card-title'))
  box.append(node('p',body,'line-card-body'))
  for(const b of rich.buttons??[]){const row=node('div',null,'line-action');row.append(node('strong',b.label||'ボタン名未設定'),node('small',b.url||'URL未設定'));box.append(row)}
  return box
}
function richEditor(item){
  const wrap=node('div',null,'rich-editor'),rich=item.rich
  wrap.append(node('p','LINEには1枚のカードとして送信します。画像は公開HTTPS URLのJPEG/PNG、ボタンは公開HTTPS URLまたは受信者専用の予約URLを使えます。予約ボタンを設定すると本文にもURLを追加します。','field-hint'))
  if(rich.kind==='card'||rich.title)wrap.append(field('タイトル',rich.title??'',v=>update(()=>{rich.title=v}),{attributes:{maxlength:'60'}}))
  if(rich.kind!=='buttons'||rich.imageUrl)wrap.append(field('画像URL（'+(rich.kind==='image'?'必須':'任意')+'）',rich.imageUrl??'',v=>update(()=>{rich.imageUrl=v}),{attributes:{maxlength:'2000',placeholder:'https://…/image.jpg'}}))
  rich.buttons.forEach((b,i)=>{const r=node('section',null,'rule-row');r.append(node('strong','リンクボタン '+(i+1)),field('表示名',b.label,v=>update(()=>{b.label=v}),{attributes:{maxlength:'20'}}),field('リンク先URL',b.url,v=>update(()=>{b.url=v}),{attributes:{maxlength:'2000',placeholder:'https://…'}}),button('予約URLをボタンに設定',()=>update(()=>{const marker=graph.purpose==='recruitment'?'{{interview_link}}':'{{customer_link}}';b.url=marker;if(!item.body.includes(marker))item.body+='\n'+marker})),button('ボタンを削除',()=>update(()=>{rich.buttons.splice(i,1)})));wrap.append(r)})
  const add=button('＋ リンクボタンを追加',()=>update(()=>{rich.buttons.push({label:'詳細を見る',url:''})}));add.disabled=rich.buttons.length>=3;wrap.append(add);return wrap
}
function openWizard(empty=false){
  const box=node('div',null,'wizard-box')
  let purpose=channels.some(c=>c.purpose==='recruitment'||c.purpose==='shared')?'recruitment':'customer',name='',channel='',trigger='',tag='',first='',follow='',minutes=1440,unit=1440,amount=1,skipBooked=true,stage=0
  const choices=Object.fromEntries(Object.entries(purposes).filter(([key])=>channels.some(c=>c.purpose===key||c.purpose==='shared')))
  function defaults(){channel=channels.find(c=>c.purpose===purpose)?.id??channels.find(c=>c.purpose==='shared')?.id??'';trigger=purpose==='recruitment'?'form':'follow';name=purpose==='recruitment'?'応募受付・面談予約案内':'友だち追加・ご案内';first=purpose==='recruitment'?'{{store}}の採用窓口です。ご応募ありがとうございます。面談のご予約はこちらからお願いします。\n{{interview_link}}':'{{name}}さん、友だち追加ありがとうございます。{{store}}です。';follow=purpose==='recruitment'?'面談日時のご希望が決まりましたらこちらからご予約ください。\n{{interview_link}}':''}
  defaults()
  function candidate(){const flow=wizardFlow({purpose,name,channel,trigger,triggerTag:tag,first,follow,minutes,skipBooked});if(empty){flow.entry='end';flow.nodes=[{id:'end',type:'end',name:'終了'}]}return flow}
  function render(){box.replaceChildren();box.append(node('p','目的・開始条件 → メッセージ → 確認　 '+(stage+1)+'/3','wizard-progress'))
    if(stage===0){box.append(field('用途',purpose,v=>{purpose=v;defaults();render()},{items:choices}),field('シナリオ名',name,v=>{name=v},{event:'input',attributes:{maxlength:'100'}}),field('配信する公式LINE',channel,v=>{channel=v},{items:Object.fromEntries(channels.filter(c=>c.purpose===purpose||c.purpose==='shared').map(c=>[c.id,c.label]))}),field('何をきっかけに開始しますか？',trigger,v=>{trigger=v;render()},{items:Object.fromEntries(Object.entries(liveTriggers[purpose]).filter(([k])=>k!=='tag_campaign'&&(k!=='tag_added'||applicantCatalog.enabled)))}));if(trigger==='tag_added')box.append(field('きっかけのタグ',tag,v=>{tag=v},{items:applicantTagOptions(tag)}))}
    if(stage===1&&!empty){box.append(field('最初に送るメッセージ',first,v=>{first=v},{type:'textarea',event:'input',attributes:{maxlength:'5000'}}),field('再案内文（不要なら空欄）',follow,v=>{follow=v},{type:'textarea',event:'input',attributes:{maxlength:'5000'}}),field('再案内までの時間',amount,v=>{amount=v;minutes=amount*unit},{type:'number',attributes:{min:'1',max:'525600'}}),field('時間の単位',String(unit),v=>{unit=Number(v);minutes=amount*unit},{items:{'1':'分','60':'時間','1440':'日'}}),field('予約した方には再案内しない',skipBooked,v=>{skipBooked=v},{type:'checkbox'}),node('p','同意・店長対応・停止など実際の送信直前条件も従来どおり確認します。','field-hint'))}
    if(stage===2){const flow=candidate(),errs=validate(flow,true);box.append(node('h3',flow.name),node('p','開始：'+triggers[trigger]+' ／ '+channels.find(c=>c.id===channel)?.label));for(const n of stepOutline(flow))box.append(node('p',icons[n.type]+' '+n.name,'wizard-step'));for(const err of errs)box.append(node('p',err.message,'held-note'));const create=button('この内容で下書きを作成',()=>{$('#dialog').close();draftScenario(flow)},'primary');create.disabled=!!errs.length;box.append(create)}
    const nav=node('div',null,'controls');if(stage>0)nav.append(button('戻る',()=>{stage=empty?0:stage-1;render()}));if(stage<2)nav.append(button('次へ',()=>{if(stage===0&&(!name.trim()||!channel||trigger==='tag_added'&&!tag))throw new Error('名称・LINE・開始条件を選択してください。');stage=empty?2:stage+1;render()},'primary'));box.append(nav)
  }
  dialog(empty?'新規・空のシナリオ':'かんたん作成ウィザード','目的に合わせて下書きのシナリオを組み立てます。自動公開はしません。',box);render()
}
async function openBatchCopy(source){
  const initial=structuredClone(source),sourceStore=store,sourceCatalog=applicantCatalog,box=node('div',null,'batch-copy'),statuses=node('div'),targets=node('div',null,'batch-targets'),controls=node('div'),configs=new Map(),keys=initial.purpose==='recruitment'?tagKeys(initial):[]
  let name=initial.name,folder=scenario?.folder??'',running=false
  const confirm=button('選択店舗に未公開下書きを作成',async()=>{
    if(running)return;running=true;confirm.disabled=true;for(const el of box.querySelectorAll(':scope > label input'))if(el.type!=='checkbox')el.disabled=true;const work=[...configs.values()].filter(c=>c.selected&&c.ready&&!c.done);validateTargets()
    for(const c of work){c.attempted=true;try{const output=copyFlow(initial,{name,channel:c.channel,sourceName:sourceStore.name,targetName:c.store.name,tagMap:c.map,origin:location.origin});let created;const meta={folder:folder.trim(),is_template:false};if(demo){created={id:crypto.randomUUID(),graph:output,state:'draft',revision:1,stopped:false,published_version:null,versions:[],updated_at:stamp(),...meta};local[c.store.id].unshift(created);saveLocal()}else created=await api('/stores/'+c.store.id+'/scenarios','POST',{graph:output,...meta},c.key);c.done=true;c.result.textContent='✓ 下書き作成済み';if(c.store.id===store.id){scenarioList=[created,...scenarioList.filter(s=>s.id!==created.id)];library()}}catch(e){c.result.textContent='失敗：'+e.message+'（同じ内容で再試行できます）'}}
    running=false;statuses.textContent=[...configs.values()].filter(c=>c.done).length+'店舗に下書きを作成しました。公開処理は行っていません。';validateTargets()
  },'primary')
  const warning=node('p','画像やリンクボタン、外部URLを含む場合は店舗ごとに内容を確認してください。既存の公開版を上書きせず、新規下書きだけ作ります。','copy-warning')
  const check=field('コピー先のLINE・タグ・固定URLを確認した',false,()=>validateTargets(),{type:'checkbox'})
  function valid(c){return c.ready&&!!c.channel&&keys.every(k=>c.map[k])&&new Set(keys.map(k=>c.map[k])).size===keys.length}
  function validateTargets(){const selected=[...configs.values()].filter(c=>c.selected&&!c.done);confirm.disabled=running||!name.trim()||!check.querySelector('input').checked||!selected.length||selected.some(c=>!valid(c));for(const c of configs.values())for(const el of c.panel.querySelectorAll('input,select,button'))el.disabled=running||c.done||c.attempted}
  box.append(field('コピー後のシナリオ名',name,v=>{name=v;validateTargets()},{event:'input',attributes:{maxlength:'100'}}),field('フォルダ',folder,v=>{folder=v},{event:'input',attributes:{maxlength:'50'}}),warning,targets,check,statuses,controls);controls.append(confirm)
  for(const target of stores){const panel=node('section',null,'batch-target'),mappings=node('div'),result=node('p','','field-hint'),c={store:target,panel,selected:false,ready:false,done:false,channel:'',map:{},key:crypto.randomUUID(),result};configs.set(target.id,c);panel.append(field(target.name,false,async v=>{c.selected=v;mappings.hidden=!v;validateTargets();if(!v||c.ready)return;mappings.replaceChildren(node('p','設定を読み込み中…','field-hint'));try{const res=await readStoreResources(target);if(!panel.isConnected)return;const lines=res.channels.filter(ch=>ch.purpose===initial.purpose||ch.purpose==='shared');c.channel=target.id===sourceStore.id?initial.channel:lines.length===1?lines[0].id:'';mappings.replaceChildren(field('配信先の公式LINE',c.channel,v=>{c.channel=v;validateTargets()},{items:{'':'選択してください',...Object.fromEntries(lines.map(ch=>[ch.id,ch.label]))}}));const defs=res.catalog.enabled?res.catalog.definitions.filter(t=>t.active):[];for(const key of keys){const label=sourceCatalog.definitions.find(t=>t.tag_key===key)?.label??key;c.map[key]=(defs.find(t=>t.tag_key===key)??defs.find(t=>t.label===label))?.tag_key??'';mappings.append(field(label,c.map[key],v=>{c.map[key]=v;validateTargets()},{items:{'':'選択してください',...Object.fromEntries(defs.map(t=>[t.tag_key,t.label]))}}))}c.ready=true}catch(e){mappings.textContent='読み込み失敗：'+e.message}validateTargets()},{type:'checkbox'}),mappings,result);mappings.hidden=true;targets.append(panel)}
  dialog('複数店舗へ一括コピー','対象店舗を選び、店舗ごとの公式LINEとタグを確認してください。',box);$('#dialog').classList.add('template-dialog');validateTargets()
}
async function loadMetrics(version){
  if(!scenario?.published_version||metricsBusy)return
  const id=scenario.id,storeId=store.id;metricsBusy=true;inspector()
  try{const result=demo?{version:scenario.published_version,total:0,active:0,completed:0,ended:0,nodes:[]}:await api(base()+'/'+id+'/metrics'+(version?'?version='+version:''));if(scenario?.id===id&&store.id===storeId){metrics=result;show()}}catch(e){announce(e.message,true)}finally{metricsBusy=false;if(scenario?.id===id&&tab==='metrics')inspector()}
}
function metricsView(){
  const box=node('div',null,'metrics-view');if(!scenario?.published_version){box.append(node('p','公開後の実配信データを表示します。下書きには実績がありません。','empty'));return box}
  const versions=scenario.versions?.length?scenario.versions.map(v=>v.version):[scenario.published_version]
  box.append(field('公開版',String(metrics?.version??scenario.published_version),v=>loadMetrics(Number(v)),{items:Object.fromEntries(versions.map(v=>[String(v),'v'+v]))}),button('実績を更新',()=>loadMetrics(metrics?.version)))
  if(metricsBusy){box.append(node('p','実績読み込み中…','field-hint'));return box}
  if(!metrics){box.append(node('p','実績を更新してください。','empty'));return box}
  box.append(node('p','公開版 v'+metrics.version+' ／ 直近30日に参加した件数','field-hint'))
  const counts=node('div',null,'metrics-counts');for(const [title,n] of [['参加',metrics.total],['配信中',metrics.active],['完了',metrics.completed],['途中終了',metrics.ended]]){const b=node('div');b.append(node('small',title),node('strong',String(n)));counts.append(b)}box.append(counts)
  for(const row of metrics.nodes){const card=node('section',null,'metric-card');const name=row.name??nameOf(row.node_id);card.append(node('strong',name),node('p','通過 '+row.reached+'件 ／ 待機 '+row.waiting+'件 ／ 途中終了 '+row.ended+'件','field-hint'));if(row.type==='message')card.append(node('p','LINE受付 '+row.accepted+'件 ／ 受付未確認・失敗 '+row.not_accepted+'件','field-hint'));card.append(node('p','通過後の予約 '+row.booked_after+'件（'+(row.reached?Math.round(row.booked_after/row.reached*100):0)+'%）','field-hint'));const progress=node('progress');progress.max=Math.max(1,metrics.total);progress.value=row.reached;progress.setAttribute('aria-label',name+'の通過件数');card.append(progress);box.append(card)}
  box.append(node('p','件数は参加単位（同じ人の再参加は別件）。LINE受付は端末での表示・既読を意味しません。予約率は通過後の予約イベントとの関連であり、配信の効果を断定しません。改修以前の履歴は記録された範囲のみです。','field-hint'));return box
}
async function pollPresence(){
  if(demo||!scenario?.id||document.hidden)return
  const id=scenario.id,storeId=store.id,seq=++presenceSequence
  try{const data=await api(base()+'/'+id+'/presence','POST',{client:editorClient});if(seq===presenceSequence&&scenario?.id===id&&store.id===storeId){presenceInfo=data;renderPresence()}}catch{}
}
function renderPresence(){
  const root=$('#presence-state');if(!root)return
  const other=presenceInfo?.other_people??0,tabs=presenceInfo?.other_tabs??0,conflict=presenceInfo?.revision>scenario?.revision
  root.textContent=conflict?'⚠ 別の編集で新版あり。上書きせず複製できます。':other||tabs?'● 他の担当者 '+other+'人・別タブ '+tabs+'件が編集画面を開いています':''
  root.classList.toggle('conflict',!!conflict)
}

async function start() {
  $('#settings-link').href=workspacePath(controlled)
  $('#foot').textContent=demo?'GitHub Pages · 架空データで動作':'シナリオ管理'
  $('#mode').hidden=!demo
  for (const btn of document.querySelectorAll('.mobile button')) btn.onclick=()=>choosePiece(btn.dataset.part)
  $('#tag-templates').onclick=async()=>{
    if(!ready||!store)return
    if(!await finishBeforeLeave())return
    openTagTemplates()
  }
  $('#new').onclick=async()=>{
    if (!ready || !store) return
    if(!await finishBeforeLeave())return
    const content=node('div',null,'controls')
    content.append(button('かんたん作成ウィザード',()=>{$('#dialog').close();openWizard()},'primary'))
    content.append(button('完全に空のシナリオから開始',()=>{$('#dialog').close();openWizard(true)}))
    for(const [value,label] of Object.entries(purposes).filter(([value])=>channels.some(c=>c.purpose===value||c.purpose==='shared'))) content.append(button(label+'の基本シナリオ',()=>{
      $('#dialog').close()
      newScenario(value)
    },'primary'))
    content.append(button('採用タグ別テンプレートを選ぶ',()=>{$('#dialog').close();openTagTemplates()},'primary'))
    for(const template of recruitmentTemplates){
      const compatible=channels.some(account=>account.purpose==='recruitment'||!template.dedicated&&account.purpose==='shared')
      const choice=button(template.name,()=>{
        $('#dialog').close()
        newScenario('recruitment',template)
      })
      choice.disabled=!compatible
      content.append(choice)
    }
    dialog('新規シナリオ','用途や面談の進捗に合うテンプレートを選び、文面・時間を確認してから保存してください。',content)
  }
  addEventListener('beforeunload',event=>{if(dirty) event.preventDefault()})
  const session=demo?sessionDemo:await api('/session')
  currentSession=session;try{autosave=localStorage.getItem('npl-studio-auto-v2:'+session.actor.id)!=='false'}catch{}
  $('#saved-templates')?.addEventListener('click',()=>openSavedTemplates().catch(e=>announce(e.message,true)))
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){event.preventDefault();historyMove(event.shiftKey?'redo':'undo')}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save().catch(e=>announce(e.message,true))}})
  if(session.actor.agency){
    $('#studio-operations').hidden=true
    $('#settings-link').textContent='店舗運用'
  }
  if(session.actor.platform) (await import('/static/tour.mjs')).mountTour('studio')
  if(!demo&&!['admin','manager'].includes(session.actor.role)) throw new Error('ステップ配信の編集には管理会社の運用権限が必要です。')
  stores=session.stores
  const select=$('#store')
  for(const location of stores) select.add(new Option(location.name,location.id))
  if (!stores.length) throw new Error('店舗を登録してからシナリオを作成してください。')
  select.onchange=async()=>{
    const next=stores.find(location=>location.id===select.value)
    if(!await finishBeforeLeave()){select.value=store.id;return}
    searchText='';folderFilter='';libraryKind='all'
    try { await refreshStore(next);choosePiece('workspace');announce('') } catch(error) {announce(error.message,true)}
  }
  const requestedStore=new URLSearchParams(location.search).get('store')
  const initialStore=stores.find(item=>item.id===requestedStore) ?? stores[0]
  select.value=initialStore.id
  await refreshStore(initialStore)
  ready=true
  setInterval(pollPresence,45000)
  const templateRequest=new URLSearchParams(location.search).get('tag-template')
  if(templateRequest!==null&&initialStore.id===requestedStore&&!$('#dialog').open){const url=new URL(location.href);url.searchParams.delete('tag-template');history.replaceState(null,'',url);openTagTemplates(templateRequest)}
  if (demo) $('#foot').textContent='LINE通信は模擬 · 下書きはこのブラウザに保存'
}

start().catch(error=>{
  announce(error.status===401?'管理画面でログインしてください。':error.message,true)
  $('#new').disabled=true
  $('#store').disabled=true
  show()
})
