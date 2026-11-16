import {workspacePath,scopeWorkspaceLinks} from '/static/workspace-path.mjs'
import {starter,kinds,conditions,triggers,variables,validate,simulate,renderMessage,links} from './engine.mjs'

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
  price:'60分 8,000円（税込）',booking_url:'https://example.test/reservations/sample'}}
let scenario,graph,selection,scenarioList=[],stores=[],channels=[],store,original='',dirty=false,tab='edit',part='workspace',simulation
let busy=false, ready=false, preset='unbooked', localCreateKey
const sessionDemo={
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
  part=value
  $('#layout').dataset.part=part
  for (const btn of document.querySelectorAll('.mobile button')) {
    if(btn.dataset.part===part) btn.setAttribute('aria-current','true')
    else btn.removeAttribute('aria-current')
  }
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
  box.replaceChildren(node('h2',title),node('p',text),content,button('閉じる',()=>box.close()))
  box.showModal()
}
function ask(question) {
  return new Promise(resolve=>{
    const actions=node('div',null,'controls')
    const finish=ok=>{ resolve(ok); $('#dialog').close() }
    actions.append(button('続ける',()=>finish(true),'primary'))
    dialog(question,'現在の画面で保存していない内容は破棄されます。',actions)
    $('#dialog').addEventListener('close',()=>resolve(false),{once:true})
  })
}
function update(change,rerender=true) {
  if (busy) return
  change()
  dirty=JSON.stringify(graph)!==original
  simulation=null
  if (rerender) show()
  else {
    const save=$('#save-work')
    if (save) {save.textContent=dirty?'変更を保存':'下書きを保存';save.disabled=!dirty&&!!scenario}
    const title=$('#workspace .editor-head h2')
    if (title) title.textContent=graph.name||'名称未設定'
    const selected=$('#workspace .node.selected .node-content strong')
    if(selected && currentNode()) selected.textContent=currentNode().name||kinds[currentNode().type]
    const excerpt=$('#workspace .node.selected .excerpt')
    if(excerpt && currentNode()?.type==='message') excerpt.textContent=currentNode().body.replace(/\s+/g,' ')
  }
}
function limits() { return validate(graph,true) }
const currentNode=()=>graph?.nodes.find(item=>item.id===selection)
function setupFlow(data) {
  scenario=data??null
  graph=data?structuredClone(data.graph):null
  original=graph?JSON.stringify(graph):''
  dirty=false
  simulation=null
  selection=graph?.entry
  tab='edit'
  show()
}

async function refreshStore(next) {
  store=next
  person={...person,zone:store.timezone,cutoff:store.cutoff,values:{...person.values,store:store.name}}
  channels=demo?channelDemo(store.id):await api('/stores/'+store.id+'/connections')
  scenarioList=demo?structuredClone(demoRecords()):await api(base())
  setupFlow(scenarioList[0])
}

async function openScenario(id) {
  if (scenario?.id===id) return choosePiece('workspace')
  if (dirty && !await ask('保存せずに別のシナリオを開きますか？')) return
  setupFlow(demo?structuredClone(demoRecords().find(item=>item.id===id)):await api(base()+'/'+id))
  choosePiece('workspace')
  announce('')
}

function newScenario(purpose='customer') {
  scenario=null
  localCreateKey=crypto.randomUUID()
  graph=starter(purpose)
  graph.channel=channels.find(item=>item.purpose===purpose || item.purpose==='shared')?.id??''
  original=''
  selection=graph.entry
  dirty=true
  simulation=null
  tab='settings'
  show()
  choosePiece('inspector')
  announce('下書きを作成しました。名称と公式アカウントを確認してください。')
}

async function save() {
  if (busy || !graph) return
  if (!graph.channel || !graph.name.trim()) throw new Error('シナリオ名と公式アカウントを入力してください。')
  busy=true
  try {
    if (demo) {
      const records=demoRecords()
      const existing=records.find(item=>item.id===scenario?.id)
      const data={...existing,id:existing?.id??crypto.randomUUID(),revision:(existing?.revision??0)+1,
        graph:structuredClone(graph),state:'draft',stopped:existing?.stopped??false,updated_at:stamp(),
        versions:existing?.versions??[],published_version:existing?.published_version??null}
      if (existing) Object.assign(existing,data)
      else records.unshift(data)
      saveLocal()
      scenario=structuredClone(data)
      scenarioList=structuredClone(records)
    } else {
      const created=await api(scenario?base()+'/'+scenario.id:base(),scenario?'PATCH':'POST',
        scenario?{graph,revision:scenario.revision}:graph,scenario?null:localCreateKey)
      scenario={versions:scenario?.versions??[],...created}
      scenarioList=await api(base())
    }
    original=JSON.stringify(graph)
    dirty=false
    announce('下書きを保存しました。')
    show()
  } finally {busy=false}
}

async function transition(action,reason) {
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
    show()
  } finally {busy=false}
}

function library() {
  const target=$('#library')
  const box=node('div',null,'panelbody')
  const rows=node('div',null,'library-list')
  const search=field('シナリオを検索','',value=>filter(value),{event:'input',attributes:{placeholder:'名称を検索',type:'search'}})
  function filter(value) {
    const shown=scenarioList.filter(item=>item.graph.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    rows.replaceChildren(...shown.map(item=>{
      const selected=item.id===scenario?.id
      const entry=button('',()=>openScenario(item.id),'scenario-card'+(selected?' selected':''))
      entry.setAttribute('aria-pressed',String(selected))
      const badges=node('div',null,'labels')
      badges.append(pill(purposes[item.graph.purpose]),pill(item.stopped?'停止中':item.published_version?'公開版 v'+item.published_version:steps[item.state],
        item.stopped?'warn':item.published_version?'good':''))
      entry.append(node('strong',item.graph.name),badges)
      return entry
    }))
    if (!shown.length) rows.append(node('p',value?'一致するシナリオがありません。':'シナリオがありません。','empty'))
  }
  filter('')
  box.append(search,rows)
  target.replaceChildren(panelHead('シナリオ一覧',scenarioList.length+'件'),box)
}

const selectStep = id=>{
  selection=id
  tab='edit'
  show()
  choosePiece(matchMedia('(max-width:950px)').matches?'inspector':'workspace')
  if (!matchMedia('(max-width:950px)').matches) $('#inspector h2')?.scrollIntoView({block:'nearest'})
}
const nameOf = id=>graph.nodes.find(item=>item.id===id)?.name??'接続なし'

function addStep() {
  if (graph.nodes.length>=100) return announce('ステップ数は100件までです。',true)
  const menu=node('div',null,'controls')
  for (const [type,label] of Object.entries(kinds)) menu.append(button(label,()=>{
    const id='step-'+crypto.randomUUID().slice(0,8)
    const end=graph.nodes.find(item=>item.type==='end')?.id??''
    const selected=currentNode()
    const onward=selected?.type==='branch'?selected.no:selected?.next??end
    const step={id,type,name:label}
    if (type!=='end' && type!=='branch') step.next=onward
    if (type==='message') Object.assign(step,{body:'',category:'service'})
    if (type==='wait') Object.assign(step,{mode:'delay',minutes:60})
    if (type==='branch') Object.assign(step,{condition:'booked',yes:end,no:onward,tag:''})
    if (type==='tag') step.tag=''
    if (type==='task') step.note=''
    $('#dialog').close()
    update(()=>{
      if (selected?.type==='branch') selected.no=id
      else if (selected && selected.type!=='end') selected.next=id
      graph.nodes.push(step)
      selection=id
      tab='edit'
    })
    choosePiece('inspector')
  }))
  dialog('ステップを追加','選択中のステップの次に接続します。分岐では「いいえ」の経路に追加します。',menu)
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
  if (!graph) {
    root.replaceChildren(panelHead('配信フロー'),node('p','「新規シナリオ」から配信の流れを設計できます。','empty'))
    return
  }
  const title=node('div',null,'panelhead editor-head')
  title.append(panelHead(graph.name||'名称未設定',purposes[graph.purpose]+'  ·  '+(channels.find(item=>item.id===graph.channel)?.label??'公式アカウント未選択')))
  title.append(pill(scenario?.stopped?'停止中':scenario?.published_version?'公開版 v'+scenario.published_version:steps[scenario?.state??'draft'],
    scenario?.stopped?'warn':scenario?.published_version?'good':''))
  const bar=node('div',null,'toolbar')
  bar.append(button('＋ ステップ追加',addStep),button('配信前テスト',()=>{
    tab='test'; simulation=null; show(); choosePiece('inspector')
  }),node('span',null,'spacer'))
  const saved=button(dirty?'変更を保存':'下書きを保存',save,'primary')
  saved.id='save-work'
  saved.disabled=!!scenario&&!dirty
  bar.append(saved)
  const board=node('div',null,'canvas')
  const trigger=node('div',null,'trigger')
  const triggerText=node('span')
  triggerText.append(node('small','開始条件'),node('strong',triggers[graph.trigger]??'未設定'))
  trigger.append(node('span','↳','icon'),triggerText)
  const list=node('div',null,'node-list')
  const map=new Map(graph.nodes.map(item=>[item.id,item]))
  const seen=new Set()
  function drawPath(id,parent,depth=0) {
    const item=map.get(id)
    if (!item) {
      parent.append(node('p','接続なし','path-ref'))
      return
    }
    if (seen.has(id) || depth>20) {
      parent.append(button('↪ '+nameOf(id),()=>selectStep(id),'path-ref'))
      return
    }
    seen.add(id)
    const card=button('',()=>selectStep(item.id),'node'+(item.id===selection?' selected':''))
    card.setAttribute('aria-pressed',String(item.id===selection))
    const copy=node('span',null,'node-content')
    copy.append(node('strong',item.name||kinds[item.type]),node('small',
      kinds[item.type]+(item.type==='wait'?' · '+(item.mode==='delay'?item.minutes+'分':waitTypes[item.mode]):'')+
      (item.type==='message'?' · '+(item.category==='marketing'?'販促':'業務案内'):'')+(item.id===graph.entry?' · 開始':'')))
    if (item.type==='message') copy.append(node('small',item.body.replace(/\s+/g,' '),'excerpt'))
    card.append(node('span',icons[item.type],'icon '+item.type),copy)
    parent.append(card)
    if (item.type==='branch') {
      const lanes=node('div',null,'branch-lanes')
      for (const [index,next] of links(item).entries()) {
        const lane=node('div',null,'branch-lane')
        lane.append(node('span',index===0?'はい':'いいえ','branch-label'))
        drawPath(next,lane,depth+1)
        lanes.append(lane)
      }
      parent.append(lanes)
    } else if (item.type!=='end') {
      parent.append(node('div',null,'connector'))
      drawPath(item.next,parent,depth+1)
    }
  }
  list.append(node('div',null,'connector'))
  if (graph.entry) drawPath(graph.entry,list)
  const disconnected=graph.nodes.filter(item=>!seen.has(item.id))
  if (disconnected.length) {
    const extra=node('div',null,'disconnected')
    extra.append(node('p','フローに接続されていないステップ','field-hint'))
    for (const item of disconnected) extra.append(button(item.name||kinds[item.type],()=>selectStep(item.id),'path-ref'))
    list.append(extra)
  }
  board.append(trigger,list)
  root.replaceChildren(title,bar,board)
}

function editStep() {
  const item=currentNode()
  if (!item) return node('p','フロー上のステップを選んで編集できます。','empty')
  const wrap=node('div')
  const set=(key,full=true)=>value=>update(()=>{item[key]=value},full)
  const destinations=Object.fromEntries([['','接続なし'],...graph.nodes.filter(choice=>choice.id!==item.id).map(choice=>[choice.id,choice.name])])
  wrap.append(field('ステップ名',item.name,set('name',false),{event:'input',attributes:{maxlength:'100'}}))
  if (item.type==='message') {
    wrap.append(field('連絡の用途',item.category,set('category'),{items:graph.purpose==='customer'?{service:'業務案内',marketing:'顧客向け販促'}:{service:'採用連絡'}}))
    const preview=node('div',null,'preview')
    const bubble=node('p',null,'bubble')
    preview.append(node('h3','LINEプレビュー'),bubble)
    function updatePreview() {
      const result=renderMessage(item.body,person)
      bubble.textContent=result.reason??(result.message||'メッセージを入力してください。')
    }
    const body=field('メッセージ本文',item.body,value=>{set('body',false)(value);updatePreview()},
      {type:'textarea',event:'input',attributes:{maxlength:'5000'}})
    const vars=node('div',null,'controls')
    for (const [key,label] of Object.entries(variables)) vars.append(button(label,()=>{
      const input=body.querySelector('textarea')
      input.setRangeText('{{'+key+'}}',input.selectionStart,input.selectionEnd,'end')
      set('body',false)(input.value)
      updatePreview()
      input.focus()
    },'chip'))
    updatePreview()
    wrap.append(body,vars,preview,node('div',null,'separ'))
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
    if (item.mode==='delay'||item.mode==='booking') wrap.append(field(item.mode==='delay'?'待機時間（分）':'予約の何分前',item.minutes,set('minutes'),{type:'number',attributes:{min:item.mode==='delay'?'1':'0'}}))
    if (item.mode==='fixed') wrap.append(field('実日付と時刻',item.time,set('time'),{type:'datetime-local'}))
    if (item.mode==='business') wrap.append(field('何営業日後',item.days,set('days'),{type:'number',attributes:{min:'0'}}),field('営業日内の時刻',item.time,set('time'),{type:'time'}))
  }
  if (item.type==='branch') {
    wrap.append(field('分岐する条件',item.condition,set('condition'),{items:conditions}))
    if (item.condition==='tag') wrap.append(field('タグ名',item.tag,set('tag',false),{event:'input',attributes:{maxlength:'80'}}))
    wrap.append(field('条件を満たす場合',item.yes,set('yes'),{items:destinations}),field('条件を満たさない場合',item.no,set('no'),{items:destinations}))
  } else if (item.type!=='end') wrap.append(field('次のステップ',item.next,set('next'),{items:destinations}))
  if (item.type==='tag') wrap.append(
    field('タグ操作',item.action??'add',set('action'),{items:{add:'付ける',remove:'外す'}}),
    field('タグ名',item.tag,set('tag',false),{event:'input',attributes:{maxlength:'80'}}))
  if (item.type==='task') wrap.append(field('担当者へ渡す内容',item.note,set('note',false),{type:'textarea',event:'input',attributes:{maxlength:'400'}}))
  wrap.append(button('ステップを削除',()=>{
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
    }),{items:purposes}),
    field('配信先の公式アカウント',graph.channel,set('channel'),{items:opts}))
  if (Object.keys(opts).length<2) wrap.append(node('p','対象店舗に対応する公式アカウントを登録してください。','field-hint'))
  wrap.append(field('開始イベント',graph.trigger,set('trigger'),{items:triggers}),
    field('開始ステップ',graph.entry,set('entry'),
      {items:Object.fromEntries(graph.nodes.map(item=>[item.id,item.name]))}))
  const window=node('div',null,'row')
  window.append(field('販促を開始できる時刻',graph.windowStart,set('windowStart'),{type:'time'}),
    field('販促を終了する時刻',graph.windowEnd,set('windowEnd'),{type:'time'}))
  const freq=node('div',null,'row')
  freq.append(field('1日あたりの上限',graph.daily,set('daily'),{type:'number',attributes:{min:'1',max:'50'}}),
    field('7日間の上限',graph.weekly,set('weekly'),{type:'number',attributes:{min:'1',max:'50'}}))
  wrap.append(window,freq)
  const holidays=node('details')
  holidays.append(node('summary','販促の休業曜日と再参加条件'))
  for (const [index,label] of ['日','月','火','水','木','金','土'].entries()) holidays.append(field(label+'曜日を休業',graph.holidays.includes(index),checked=>update(()=>{
    graph.holidays=checked?[...new Set([...graph.holidays,index])]:graph.holidays.filter(day=>day!==index)
  },false),{type:'checkbox'}))
  holidays.append(field('再参加を許可する',graph.rejoin,set('rejoin',false),{type:'checkbox'}),
    field('再参加の間隔（日）',graph.cooldownDays,set('cooldownDays',false),{type:'number',attributes:{min:'1',max:'365'}}))
  wrap.append(holidays,field('担当者が不在の場合',graph.missingAssignee,set('missingAssignee'),
    {items:{manager:'店舗責任者へ回す',hold:'保留'}}))
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
  box.append(field('テスト送信するステップ',selected,value=>{selected=value},{
    items:Object.fromEntries(results.map(item=>[item.id,item.name])),
  }))
  if (!candidates.length) box.append(node('p','店舗・LINE接続画面で、同じ公式アカウントと用途のテスト利用者を新たに認証してください。'))
  else box.append(field('認証済みテスト利用者',recipient,value=>{recipient=value},{
    items:Object.fromEntries(candidates.map(({id,verified_at})=>[id,'認証 '+new Date(verified_at).toLocaleString('ja-JP')+' · '+id.slice(0,8)])),
  }),button('テスト利用者に1通送る',async()=>{
    const {zone,cutoff,...fixture}=person
    await api(url+'/test-sends','POST',{revision:scenario.revision,node:selected,tester:recipient,fixture},key)
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
  function set(key) {return value=>{person[key]=value;simulation=null;clearResult()}}
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
    simulation=null
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
  more.append(field('保有タグ（カンマ区切り）',person.tags.join(','),value=>set('tags')(value.split(',').map(item=>item.trim()).filter(Boolean))))
  const counts=node('div',null,'row')
  counts.append(field('直近1日の販促通数',person.dayCount,set('dayCount'),{type:'number',attributes:{min:'0'}}),
    field('直近7日の販促通数',person.weekCount,set('weekCount'),{type:'number',attributes:{min:'0'}}))
  more.append(counts)
  box.append(more,button('シミュレーションを実行',()=>{
    simulation=simulate(graph,person)
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
        detail.append(node('summary','送信内容'),node('p',event.message,'bubble'))
        row.append(detail)
      }
      list.append(row)
    }
    for (const error of simulation.errors) list.append(node('li',error.message,'held'))
    output.append(node('p','概算 '+simulation.count+' 通','compact'),list)
  }
  wrap.append(output)
  if (!demo && scenario && !dirty && simulation?.count>0) {
    const send=button('テスト送信・履歴',testDelivery)
    send.id='test-delivery'
    wrap.append(send)
  }
  if (scenario?.state==='draft'&&!dirty) {
    const mark=button('テスト済みにする',()=>transition('test'))
    mark.id='mark-tested'
    mark.disabled=!simulation||!!simulation.errors.length||!!failures.length
    wrap.append(mark)
  }
  return wrap
}

function publication() {
  const wrap=node('div')
  if (!scenario || dirty) {
    wrap.append(node('p','承認・公開版の管理には、下書きの保存が必要です。','empty'))
    return wrap
  }
  wrap.append(pill(steps[scenario.state]),node('p',scenario.published_version?'公開版 v'+scenario.published_version+
    (scenario.stopped?' · 停止中':''):'公開版はまだありません。','empty'))
  if (!demo) wrap.append(node('p','顧客向けの対応イベントが発生すると、有効な店舗で対象者と最新の配信条件を照合します。','field-hint'))
  const row=node('div',null,'controls')
  if (scenario.state==='draft') row.append(button('配信前テストへ',()=>{tab='test';show()}))
  if (scenario.state==='tested') row.append(button('下書きを承認',()=>transition('approve'),'primary'))
  if (scenario.state==='approved') row.append(button('公開版を保存',()=>transition('publish'),'primary'))
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
  if (scenario.versions?.length) {
    const list=node('ul',null,'log')
    for(const version of scenario.versions) {
      const item=node('li')
      item.append(button('v'+version.version+' の内容を見る',async()=>{
        const stored=version.graph?version:await api(base()+'/'+scenario.id+'/versions/'+version.version)
        const flow=node('ol',null,'log')
        for(const step of stored.graph.nodes) flow.append(node('li',step.name+' · '+kinds[step.type]+
          (step.type==='message'?'　'+step.body:'')))
        dialog('公開版 v'+version.version,stored.graph.name,flow)
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
  for (const [id,label] of Object.entries({edit:'ステップ',settings:'設定',test:'テスト',publish:'公開版'})) {
    const btn=button(label,()=>{tab=id;show()},tab===id?'active':'')
    btn.setAttribute('aria-pressed',String(tab===id))
    tabs.append(btn)
  }
  const panel=node('div',null,'panelbody')
  const chosen={edit:editStep,settings,test:resultView,publish:publication}
  panel.append(chosen[tab]())
  root.replaceChildren(panelHead('設定・プレビュー'),tabs,panel)
}

function show() {
  library()
  flowView()
  inspector()
}

async function start() {
  $('#settings-link').href=workspacePath(controlled)
  $('#foot').textContent=demo?'GitHub Pages · 架空データで動作':'シナリオ管理'
  $('#mode').hidden=!demo
  for (const btn of document.querySelectorAll('.mobile button')) btn.onclick=()=>choosePiece(btn.dataset.part)
  $('#new').onclick=async()=>{
    if (!ready || !store) return
    if (dirty&&!await ask('保存せずに新規シナリオを作りますか？')) return
    const content=node('div',null,'controls')
    for(const [value,label] of Object.entries(purposes)) content.append(button(label,()=>{
      $('#dialog').close()
      newScenario(value)
    },'primary'))
    dialog('新規シナリオ','配信の用途を選んでください。',content)
  }
  addEventListener('beforeunload',event=>{if(dirty) event.preventDefault()})
  const session=demo?sessionDemo:await api('/session')
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
    if (dirty&&!await ask('保存せずに店舗を切り替えますか？')) {select.value=store.id;return}
    try { await refreshStore(next);choosePiece('workspace');announce('') } catch(error) {announce(error.message,true)}
  }
  const requestedStore=new URLSearchParams(location.search).get('store')
  const initialStore=stores.find(item=>item.id===requestedStore) ?? stores[0]
  select.value=initialStore.id
  await refreshStore(initialStore)
  ready=true
  if (demo) $('#foot').textContent='LINE通信は模擬 · 下書きはこのブラウザに保存'
}

start().catch(error=>{
  announce(error.status===401?'管理画面でログインしてください。':error.message,true)
  $('#new').disabled=true
  $('#store').disabled=true
  show()
})
