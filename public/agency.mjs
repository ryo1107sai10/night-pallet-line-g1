const $=id=>document.getElementById(id)
const status=$('agency-status')
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
  if(options.length){
    store.replaceChildren(...options)
    const selected=new URLSearchParams(location.search).get('store')
    if(session.stores.some(item=>item.id===selected))store.value=selected
    function renderLinks(){
      const url=new URL(location.href)
      url.searchParams.set('store',store.value)
      history.replaceState(null,'',url)
      const query='?store='+encodeURIComponent(store.value)
      $('agency-studio').href='/studio/'+query
      $('agency-calendar').href='/interview/staff.html'+query
      $('agency-inbox').href='/workflows/'+query+'&use=recruitment'
    }
    store.onchange=renderLinks
    renderLinks()
    $('agency-steps').hidden=!['admin','manager'].includes(session.actor.role)
    $('agency-interview').hidden=!['admin','manager','recruiter'].includes(session.actor.role)
    $('agency-stores').hidden=false
    $('agency-tools').hidden=false
    if($('agency-steps').hidden&&$('agency-interview').hidden)status.textContent='操作権限が付与された機能はありません。'
  }else status.textContent='操作できる店舗がありません。'
}catch(error){status.textContent=error.message}

// マスター管理: 自法人の現マスターだけが GET /agency-master に成功し、この欄が表示される。
// マスターでない代理店スタッフや他法人のアカウントでは 403 になるため欄は隠れたまま。
const masterSection=$('agency-master')
const masterStatus=$('agency-master-status')
let masterInfo=null
let lastMasterInvite=null
async function masterCall(path,method='GET',data){
  const response=await fetch('/api/v1'+path,{
    method,
    headers:{'Content-Type':'application/json',...(method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{})},
    body:data===undefined?undefined:JSON.stringify(data),
  })
  const result=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
function renderMaster(){
  const info=masterInfo
  $('agency-master-current').textContent='現在のマスター · '+info.current_email
  const pending=$('agency-master-pending')
  const promote=$('agency-master-promote')
  if(info.pending_id){
    pending.textContent='招待中 · '+info.pending_email+' · '+
      (info.pending_active?'本人による有効化が完了':info.expires_at?'有効期限 '+new Date(info.expires_at).toLocaleString('ja-JP'):'本人の有効化待ち')
    promote.hidden=false
    promote.disabled=!info.pending_active
  }else{
    pending.textContent=''
    promote.hidden=true
  }
  const note=$('agency-master-invite-note'),issued=$('agency-master-invite-result')
  if(lastMasterInvite&&lastMasterInvite.id===info.pending_id&&!info.pending_active){
    note.hidden=false
    issued.hidden=false
    issued.textContent=['招待コード　'+lastMasterInvite.invite_code,
      '認証アプリ設定キー　'+lastMasterInvite.setup_key,
      '期限　'+new Date(lastMasterInvite.expires_at).toLocaleString('ja-JP')].join('\n')
  }else{
    note.hidden=true
    issued.hidden=true
  }
}
async function loadMaster(){
  try{
    masterInfo=await masterCall('/agency-master')
    masterSection.hidden=false
    renderMaster()
  }catch{masterSection.hidden=true}
}
$('agency-master-refresh').onclick=()=>loadMaster()
$('agency-master-invite').onsubmit=async event=>{
  event.preventDefault()
  masterStatus.textContent=''
  try{
    lastMasterInvite=await masterCall('/agency-master/invite','POST',{address:$('agency-master-address').value})
    masterStatus.textContent='招待を発行しました。招待の有効化が済むと切り替えられます。'
    await loadMaster()
  }catch(error){masterStatus.textContent=error.message}
}
$('agency-master-promote').onclick=async()=>{
  if(!masterInfo?.pending_id)return
  if(!window.confirm(masterInfo.pending_email+' に切り替えると、前任者のログインは終了します。切り替えますか？'))return
  const promote=$('agency-master-promote')
  promote.disabled=true
  try{
    await masterCall('/agency-master/promote','POST',{pending:masterInfo.pending_id})
    masterStatus.textContent='マスターを切り替えました。新しいマスターでログインしてください。'
    setTimeout(()=>location.reload(),1500)
  }catch(error){masterStatus.textContent=error.message;promote.disabled=false}
}
loadMaster()
