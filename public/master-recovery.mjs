const recovery=location.hash.slice(1)
if(location.hash)history.replaceState(null,'',location.pathname)
const form=document.getElementById('recovery-form'),notice=document.getElementById('recovery-notice')
function message(value,error=false){notice.textContent=value;notice.classList.toggle('error',error)}
let mfaRequired=true
if(recovery){
  try{
    message('再設定リンクを確認しています…')
    const response=await fetch('/api/v1/auth/master/recovery/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recovery})});const result=await response.json()
    if(!response.ok)throw new Error(result.message??'再設定リンクを確認できませんでした。')
    mfaRequired=result.mfa_required;document.getElementById('recovery-factor').hidden=!mfaRequired;form.elements.code.disabled=!mfaRequired;form.elements.code.required=mfaRequired
    form.hidden=false;message(mfaRequired?'認証アプリの6桁コードもご用意ください。':'新しいパスワードを設定してください。6桁コードは不要です。')
  }catch(error){message(error.message,true)}
}else message('管理会社の登録メールに送られた再設定リンクから開いてください。',true)
form.onsubmit=async event=>{
  event.preventDefault()
  const {password,confirmation,code}=form.elements
  if(password.value!==confirmation.value){message('確認用パスワードが一致していません。',true);return}
  const button=form.querySelector('button');button.disabled=true;message('本人確認を実行しています…')
  try{
    const response=await fetch('/api/v1/auth/master/recovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recovery,password:password.value,...(code.value?{code:code.value}:{})})})
    const result=await response.json()
    if(!response.ok)throw new Error(result.message??'再設定を確認できませんでした。')
    form.reset();form.hidden=true;message(mfaRequired?'パスワードの再設定が完了しました。認証コードが切り替わってからログインしてください。':'パスワードの再設定が完了しました。新しいパスワードでログインできます。')
  }catch(error){message(error.message,true);code.value=''}finally{button.disabled=false}
}
