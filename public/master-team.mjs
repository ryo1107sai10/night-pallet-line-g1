// Shared by the agency workspace and the supervisor's tenant workspace.
export function masterTeam(info, actions) {
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}
  const button=(label,fn,cls)=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b}
  const root=el('div',null,'stack')
  const masters=info.masters??[{id:info.current_id,email:info.current_email}]
  const limit=info.master_limit??2
  root.append(el('p',`登録済みマスター ${masters.length}/${limit}名。2名とも自社の全契約店舗を同じ権限で管理できます。ログインと認証アプリは個人別です。`),
    el('p','「追加」は現在のマスターを残します。「交代」は選択した前任者だけのログインを終了します。','muted'))
  const status=el('p');status.setAttribute('role','status')
  async function run(control,fn){
    control.disabled=true;status.textContent=''
    try{await fn()}catch(error){status.textContent=error.message??'操作できませんでした。'}finally{control.disabled=false}
  }
  for(const [index,master] of masters.entries()){
    const row=el('div',null,'record stack')
    row.append(el('strong',`マスター ${index+1} · ${master.email}`),el('p',master.active===false?'本人の有効化待ち':'有効・全契約店舗を管理','muted'))
    if(masters.length>1)row.append(button('このマスターの権限を終了',event=>{
      if(!window.confirm(`${master.email} のマスター権限とログインを終了します。残るマスターの権限・設定は変更しません。進めますか？`))return
      run(event.currentTarget,async()=>{await actions.remove(master.id)})
    },'secondary'))
    root.append(row)
  }
  if(info.pending_id){
    const adding=info.pending_mode==='add'
    const pending=el('div',null,'record stack')
    pending.append(el('h3',adding?'兼任マスターの追加待ち':'マスターの交代待ち'),
      el('p',`候補者：${info.pending_email}`),
      el('p',adding?'現在のマスターは引き続き利用できます。':`交代対象：${info.pending_replace_email??info.current_email}`),
      el('p',info.pending_active?'本人による有効化が完了':info.expires_at?'招待の有効期限 '+new Date(info.expires_at).toLocaleString('ja-JP'):'本人の有効化待ち','muted'))
    const promote=button(adding?'兼任マスターに追加する':'選択したマスターを交代する',event=>{
      const explanation=adding?`${info.pending_email} を2人目のマスターに追加します。既存マスターは残ります。`:
        `${info.pending_replace_email??info.current_email} の権限とログインを終了し、${info.pending_email} に引き継ぎます。他のマスターは変更しません。`
      if(!window.confirm(explanation+' 確定しますか？'))return
      run(event.currentTarget,()=>actions.approve(info.pending_id,adding?null:info.pending_replace_id??info.current_id))
    },'primary')
    promote.disabled=!info.pending_active
    pending.append(promote)
    const issued=actions.inviteResult
    if(issued?.id===info.pending_id&&!info.pending_active&&issued.invite_code&&issued.setup_key){
      const value=[`招待コード　${issued.invite_code}`,`認証アプリ設定キー　${issued.setup_key}`,`期限　${new Date(issued.expires_at).toLocaleString('ja-JP')}`].join('\n')
      pending.append(el('p','以下の招待情報を本人にのみ渡してください。本人がログイン画面の「招待を受け取った方」からパスワード・認証アプリを設定します。'),el('pre',value),
        button('招待情報をコピー',event=>run(event.currentTarget,async()=>{await navigator.clipboard.writeText(value);status.textContent='本人へ渡す招待情報をコピーしました。'}),'secondary'))
    }else if(!info.pending_active)pending.append(el('p','招待情報は発行した直後だけ表示します。紛失・期限切れの場合は同じメールアドレスで招待を再発行してください。','muted'))
    root.append(pending)
  }
  const form=el('form',null,'stack'),mode=document.createElement('select'),target=document.createElement('select'),address=document.createElement('input')
  form.append(el('h3','新しいマスターの登録・引き継ぎ'))
  mode.name='mode';mode.append(new Option('兼任マスターを追加（既存のマスターを残す）','add'),new Option('指定したマスターを交代する','replace'))
  mode.options[0].disabled=masters.length>=limit
  if(masters.length>=limit)mode.value='replace'
  const modeLabel=el('label','操作内容','field');modeLabel.append(mode)
  target.name='replace_id';target.append(new Option('交代するマスターを選択',''),...masters.map(m=>new Option(m.email,m.id)))
  const targetLabel=el('label','交代する前任者','field');targetLabel.append(target)
  address.name='address';address.type='email';address.required=true;address.autocomplete='off';address.placeholder='本人のメールアドレス'
  const addressLabel=el('label','新しいマスターのメールアドレス','field');addressLabel.append(address)
  const submit=el('button','招待を発行','primary');submit.type='submit'
  const sync=()=>{const replacing=mode.value==='replace';targetLabel.hidden=!replacing;target.required=replacing;submit.textContent=replacing?'引き継ぎの招待を発行':'兼任マスターの招待を発行'}
  mode.onchange=sync;sync()
  form.append(modeLabel,targetLabel,addressLabel,el('p','招待を発行しただけでは権限は変わりません。本人の有効化と最終確定が必要です。','muted'),submit)
  form.onsubmit=event=>{
    event.preventDefault()
    if(info.pending_id&&!window.confirm('現在の招待・候補者を新しい招待に変更します。よろしいですか？'))return
    run(submit,()=>actions.invite({address:address.value.trim(),mode:mode.value,...(mode.value==='replace'?{replace_id:target.value}:{})}))
  }
  root.append(button('最新の状態を取得',event=>run(event.currentTarget,actions.refresh),'secondary'),form,status)
  return root
}
