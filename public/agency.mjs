import {mountDashboard} from '/static/dashboard.mjs'
import {masterTeam} from '/static/master-team.mjs'

const $=id=>document.getElementById(id)
const status=$('agency-status')
const storeManagementStatus=$('agency-store-management-status')
const recruitmentFeatureLabels={
  interviews_enabled:'対面面談予約',google_calendar_enabled:'Googleカレンダー空き時間照合',
  forms_enabled:'応募フォーム',recruitment_enabled:'応募・選考管理',recruitment_tags_enabled:'採用タグ',
  sources_enabled:'流入分析',rich_menus_enabled:'リッチメニュー',reminders_enabled:'面談確定・リマインド通知',
  waitlist_enabled:'キャンセル待ち',inbox_enabled:'採用LINE受信箱',guest_interviews_enabled:'公開予約',
  token_interviews_enabled:'LINEトークからの予約',interviewers_enabled:'担当者別の面談枠',google_write_enabled:'Googleカレンダーへの予定登録',
}
let storeSetup=null,setupRequest=0
function renderFeatureOptions(settings){
  const box=$('agency-feature-options')
  box.replaceChildren(...Object.entries(recruitmentFeatureLabels).map(([name,label])=>{
    const wrapper=document.createElement('label'),input=document.createElement('input')
    input.type='checkbox';input.name=name;input.checked=settings[name]===true
    wrapper.append(input,document.createTextNode(' '+label));return wrapper
  }))
}
async function loadStoreSetup(id){
  const n=++setupRequest
  storeSetup=null
  storeManagementStatus.textContent=''
  $('agency-store-setup').hidden=true
  try{
    const info=await masterCall('/stores/'+encodeURIComponent(id)+'/recruitment/setup')
    if(n!==setupRequest)return false
    storeSetup={id,...info}
    const store=$('agency-store')
    $('agency-store-setup-name').textContent=store.selectedOptions[0]?.textContent+' の設定'
    $('agency-store-setup-state').textContent=[info.eligible_at?'適格性確認済み':'適格性未確認',info.contract_active?'契約確認済み':'契約未確認',info.auto_enabled?'自動配信有効':'自動配信停止中'].join(' ／ ')
    $('agency-store-eligibility').elements.verified.checked=!!info.eligible_at
    $('agency-store-eligibility').elements.reference.value=''
    renderFeatureOptions(info.features)
    const form=$('agency-store-automation')
    form.elements.contract.checked=info.contract_active
    form.elements.enabled.checked=info.auto_enabled
    form.elements.enabled.disabled=!info.process_enabled&&!info.auto_enabled
    form.elements.monthly_limit.value=info.monthly_limit
    form.elements.reason.value=''
    $('agency-automation-ready').textContent=info.process_enabled?'配信処理の準備済み。LINE接続・契約・利用条件を確認してから有効化できます。':'配信処理の店舗登録が未完了です。契約と機能設定は先に保存できます。'
    $('agency-store-setup').hidden=false
    return true
  }catch(error){if(n===setupRequest)storeManagementStatus.textContent=error.message;return false}
}
async function saveSetup(action){
  const selection=storeSetup
  if(!selection||selection.id!==$('agency-store').value)return
  const buttons=[...$('agency-store-setup').querySelectorAll('button')]
  buttons.forEach(button=>button.disabled=true)
  storeManagementStatus.textContent='保存中…'
  try{await action(selection);if(selection.id===$('agency-store').value&&await loadStoreSetup(selection.id)&&selection.id===$('agency-store').value)storeManagementStatus.textContent='店舗設定を保存しました。'}
  catch(error){if(selection.id===$('agency-store').value)storeManagementStatus.textContent=error.message}
  finally{buttons.forEach(button=>button.disabled=false)}
}
async function request(path,method='GET'){
  const response=await fetch('/api/v1'+path,method==='POST'?{
    method,headers:{'Content-Type':'application/json'},body:'{}',
  }:{})
  if(response.status===401){
    location.reload()
    throw new Error('ログインが必要です。')
  }
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'画面を開けませんでした。')
  return result
}
$('agency-logout').onclick=async()=>{
  try{await request('/auth/logout','POST');location.reload()}
  catch(error){status.textContent=error.message}
}
try{
  const session=await request('/session')
  const store=$('agency-store')
  const options=session.stores.map(item=>new Option(item.name,item.id))
  $('agency-name').textContent=session.tenant.legal_name+'の店舗運用'
  $('agency-account').textContent=session.actor.email
  const canManageStores=session.actor.agency&&session.actor.role==='admin'
  $('agency-store-management').hidden=!canManageStores
  if(['admin','manager','recruiter'].includes(session.actor.role)){
    mountDashboard($('operations-dashboard'),()=>request('/dashboard'))
  }
  if(options.length){
    store.replaceChildren(...options)
    const selected=new URLSearchParams(location.search).get('store')
    if(session.stores.some(item=>item.id===selected))store.value=selected
    function renderLinks(){
      const url=new URL(location.href)
      url.searchParams.set('store',store.value)
      history.replaceState(null,'',url)
      const query='?store='+encodeURIComponent(store.value)
      $('agency-line-link').href='/agency-line/'+query
      $('agency-studio').href='/studio/'+query
      $('agency-calendar').href='/interview/staff.html'+query
      $('agency-inbox').href='/workflows/'+query+'&use=recruitment'
      $('agency-form-editor').href='/workflows/'+query+'&use=recruitment&tab=forms'
      $('agency-tag-manager').href='/workflows/'+query+'&use=recruitment&tab=tags'
      $('agency-recruitment').href='/workflows/'+query+'&use=recruitment&tab=recruitment'
      $('agency-form-responses').href='/workflows/'+query+'&use=recruitment&tab=responses'
      $('agency-sources').href='/workflows/'+query+'&use=recruitment&tab=sources'
      $('agency-menus').href='/workflows/'+query+'&use=recruitment&tab=rich-menus'
      $('agency-checks').href='/workflows/'+query+'&use=recruitment&tab=checks'
      if(canManageStores)loadStoreSetup(store.value)
    }
    store.onchange=renderLinks
    renderLinks()
    $('agency-steps').hidden=!['admin','manager'].includes(session.actor.role)
    $('agency-line').hidden=!session.actor.agency||session.actor.role!=='admin'
    $('agency-tags').hidden=!['admin','manager'].includes(session.actor.role)
    $('agency-acquisition').hidden=!['admin','manager'].includes(session.actor.role)
    $('agency-forms').hidden=!['admin','manager'].includes(session.actor.role)
    $('agency-interview').hidden=!['admin','manager','recruiter'].includes(session.actor.role)
    $('agency-stores').hidden=false
    $('agency-tools').hidden=false
    if($('agency-steps').hidden&&$('agency-interview').hidden)status.textContent='操作権限が付与された機能はありません。'
  }else status.textContent='操作できる店舗がありません。'
}catch(error){status.textContent=error.message}

let createAttempt=null
$('agency-store-create').onsubmit=async event=>{
  event.preventDefault()
  const form=event.currentTarget,button=form.querySelector('button[type="submit"]')
  button.disabled=true;storeManagementStatus.textContent='店舗を登録しています…'
  try{
    const data=Object.fromEntries(new FormData(form)),fingerprint=JSON.stringify(data)
    if(createAttempt?.fingerprint!==fingerprint)createAttempt={fingerprint,key:crypto.randomUUID()}
    const result=await masterCall('/stores','POST',data,createAttempt.key)
    createAttempt=null
    location.assign('/master/?store='+encodeURIComponent(result.id))
  }catch(error){storeManagementStatus.textContent=error.message;button.disabled=false}
}
$('agency-feature-defaults').onclick=()=>{
  for(const input of $('agency-feature-options').querySelectorAll('input[type="checkbox"]'))
    input.checked=!['interviewers_enabled','google_write_enabled','waitlist_enabled'].includes(input.name)
}
$('agency-store-eligibility').onsubmit=event=>{
  event.preventDefault();const form=event.currentTarget,data=new FormData(form)
  saveSetup(s=>masterCall('/stores/'+encodeURIComponent(s.id)+'/eligibility','PATCH',{revision:s.revision,verified:data.has('verified'),reference:data.get('reference')}))
}
$('agency-store-features').onsubmit=event=>{
  event.preventDefault();const form=event.currentTarget,data=new FormData(form)
  saveSetup(s=>masterCall('/stores/'+encodeURIComponent(s.id)+'/recruitment/setup/features','PATCH',{revision:s.revision,...Object.fromEntries(Object.keys(recruitmentFeatureLabels).map(key=>[key,data.has(key)]))}))
}
$('agency-store-automation').onsubmit=event=>{
  event.preventDefault();const form=event.currentTarget,data=new FormData(form)
  saveSetup(s=>masterCall('/stores/'+encodeURIComponent(s.id)+'/recruitment/setup/automation','PATCH',{revision:s.revision,contract:data.has('contract'),enabled:form.elements.enabled.checked,monthly_limit:Number(data.get('monthly_limit')),reason:data.get('reason')}))
}

// マスター管理は登録された2名と監督者だけが利用できる。
const masterSection=$('agency-master')
const masterStatus=$('agency-master-status')
let masterInfo=null
let lastMasterInvite=null
async function masterCall(path,method='GET',data,key){
  const response=await fetch('/api/v1'+path,{
    method,
    headers:{'Content-Type':'application/json',...(method==='POST'?{'Idempotency-Key':key??crypto.randomUUID()}:{})},
    body:data===undefined?undefined:JSON.stringify(data),
  })
  const result=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
function renderMaster(){
  $('agency-master-content').replaceChildren(masterTeam(masterInfo,{
    inviteResult:lastMasterInvite,refresh:loadMaster,
    invite:async data=>{
      lastMasterInvite=await masterCall('/agency-master/invite','POST',data)
      await loadMaster()
      masterStatus.textContent=lastMasterInvite.existing_active?'既存のアカウントを候補者に登録しました。最終確定してください。':'招待を発行しました。本人が有効化した後、追加・交代を確定してください。'
    },
    approve:async (pending,replaces)=>{
      await masterCall('/agency-master/promote','POST',{pending,mode:replaces?'replace':'add',...(replaces?{replace_id:replaces}:{})})
      lastMasterInvite=null
      if(await loadMaster())masterStatus.textContent=replaces?'引き継ぎが完了しました。':'兼任マスターを追加しました。2名とも利用できます。'
      else{masterStatus.textContent='引き継ぎが完了しました。新しいマスターでログインしてください。';location.reload()}
    },
    remove:async target=>{
      await masterCall('/agency-master/remove','POST',{target})
      lastMasterInvite=null
      if(await loadMaster())masterStatus.textContent='対象のマスターの権限を終了しました。'
      else location.reload()
    },
  }))
}
async function loadMaster(){
  try{
    masterInfo=await masterCall('/agency-master')
    masterSection.hidden=false
    renderMaster()
    return true
  }catch{masterSection.hidden=true;return false}
}
loadMaster()
