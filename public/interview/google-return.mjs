const params=new URLSearchParams(location.search)
history.replaceState(null,'',location.pathname)
const [store,state,extra]=(params.get('state')??'').split('.')
const code=params.get('code')
const back=document.querySelector('#back-to-staff')
const status=document.querySelector('#google-status')
const valid=extra===undefined&&/^[a-f0-9-]{36}$/i.test(store)&&/^[A-Za-z0-9_-]{43}$/.test(state)
if(valid)back.href='./staff.html?store='+encodeURIComponent(store)
try{
  if(!valid||!code)throw new Error('Googleカレンダーの連携が完了しませんでした。管理画面からやり直してください。')
  const response=await fetch('/api/v1/stores/'+encodeURIComponent(store)+'/interviews/availability/google/complete',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,code}),
  })
  const data=await response.json()
  if(!response.ok)throw new Error(data.message??'連携できませんでした。')
  location.replace(back.href+'&google=connected')
}catch(error){status.textContent=error.message}
