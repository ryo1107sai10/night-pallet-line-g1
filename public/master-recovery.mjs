const recovery=location.hash.slice(1)
if(location.hash)history.replaceState(null,'',location.pathname)
const form=document.getElementById('recovery-form'),notice=document.getElementById('recovery-notice')
function message(value,error=false){notice.textContent=value;notice.classList.toggle('error',error)}
if(recovery){
  form.hidden=false;message('認証アプリを設定している方は6桁コードもご用意ください。')
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
    form.reset();form.hidden=true;message('パスワードの再設定が完了しました。認証アプリを使用する方は、コードが切り替わってからログインしてください。')
  }catch(error){message(error.message,true);code.value=''}finally{button.disabled=false}
}
