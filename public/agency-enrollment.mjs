const invite=location.hash.slice(1)
if(location.hash)history.replaceState(null,'',location.pathname)
const $=id=>document.getElementById(id),form=$('enrollment-form'),notice=$('enrollment-notice')
function tell(msg,error=false){notice.textContent=msg;notice.classList.toggle('error',error)}
async function post(path,data){const response=await fetch('/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.message??'招待を確認できませんでした。');return result}
if(/^[A-Za-z0-9_-]{43}$/.test(invite)){
  try{const info=await post('/auth/master/enrollment',{invite});$('enrollment-identity').textContent='法人ID：'+info.login_id+' ／ メール：'+info.email;$('enrollment-expiry').textContent='招待の有効期限：'+new Date(info.expires_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});const mfa=info.mfa_required!==false;$('enrollment-factor-setup').hidden=!mfa;$('enrollment-factor').hidden=!mfa;form.elements.code.required=mfa;form.elements.code.disabled=!mfa;$('password-heading').textContent=(mfa?'3.':'2.')+' ご自身のパスワードを設定';if(mfa){$('enrollment-qr').src=info.qr;$('enrollment-key').value=info.setup_key}form.hidden=false;tell('このリンクはあなた専用です。第三者へ共有しないでください。')}
  catch(e){tell(e.message,true)}
}else tell('発行された本人専用の招待リンクから開いてください。',true)
$('enrollment-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('enrollment-key').value);tell('設定キーをコピーしました。認証アプリのキー欄に登録してください。')}catch{tell('設定キーを選択して手動でコピーしてください。')}}
form.onsubmit=async e=>{e.preventDefault();const {password,confirmation,code}=form.elements;if(password.value!==confirmation.value){tell('パスワードが一致していません。',true);return}const b=form.querySelector('[type=submit]');b.disabled=true;try{await post('/auth/activate',{invite,password:password.value,...(code.disabled?{}:{code:code.value})});form.reset();$('enrollment-key').value='';$('enrollment-qr').removeAttribute('src');form.hidden=true;tell('本人の登録が完了しました。管理者に登録完了をご連絡ください。個別に有効化するか、全員の引き継ぎを確定してもらうと、法人ID・メール・新しいパスワード（認証アプリを設定した方は6桁コードも）でログインできます。')}catch(e){tell(e.message,true);code.value=''}finally{b.disabled=false}}
