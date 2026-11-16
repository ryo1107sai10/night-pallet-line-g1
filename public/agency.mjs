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
