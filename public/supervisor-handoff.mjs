const handoff=location.hash.slice(1)
if(location.hash)history.replaceState(null,'',location.pathname)
const $=id=>document.getElementById(id)
const form=$('credentials'),notice=$('notice'),setup=$('setup')
function message(text,error=false){
  notice.textContent=text
  notice.classList.toggle('error',error)
}
async function request(action,data={}){
  const response=await fetch('/api/v1/platform/handoff/'+action,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handoff,...data}),
  })
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'確認できませんでした。')
  return result
}
form.onsubmit=async event=>{
  event.preventDefault()
  const {password,confirmation,code}=form.elements
  if(password.value!==confirmation.value){
    message('確認用のパスワードが一致していません。',true)
    confirmation.focus()
    return
  }
  const button=form.querySelector('button')
  button.disabled=true
  message('新しい認証を確認しています…')
  try{
    await request('complete',{password:password.value,code:code.value})
    form.reset()
    $('setup-key').value=''
    $('setup-qr').removeAttribute('src')
    setup.hidden=true
    $('login-link').hidden=false
    message('引き継ぎが完了しました。次の6桁のコードに切り替わったら、新しいパスワードでログインしてください。')
    $('login-link').focus()
  }catch(error){message(error.message,true)}
  finally{button.disabled=false}
}
if(handoff){
  try{
    const info=await request('setup')
    $('account-info').textContent='法人ID '+info.login_id+'　/　'+info.email
    $('setup-qr').src=info.qr
    $('setup-key').value=info.setup_key
    const expires=new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(info.expires_at))
    message('引き継ぎ期限 '+expires+'（日本時間）')
    setup.hidden=false
  }catch(error){message(error.message,true);$('login-link').hidden=false}
}else{
  message('北村さんに渡された引き継ぎリンクを開いてください。')
  $('login-link').hidden=false
}
