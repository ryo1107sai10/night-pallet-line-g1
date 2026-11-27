// Shared by the agency workspace and the supervisor's tenant workspace.
export function masterTeam(info, actions) {
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}
  const button=(label,fn,cls)=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b}
  const root=el('div',null,'stack')
  const masters=info.masters??[{id:info.current_id,email:info.current_email}]
  const limit=info.master_limit??3
  root.append(el('p',`登録済みマスター ${masters.length}/${limit}名。全員が自社の全契約店舗を同じ権限で管理できます。ログイン情報は個人別です。`),
    el('p','「追加」は現在のマスターを残します。「交代」は選択した前任者だけのログインを終了します。','muted'))
  if(info.password_only)root.append(el('p','マスター全員の認証方式：メール・パスワードのみ（6桁コード不要）','muted'))
  const status=el('p');status.setAttribute('role','status')
  async function run(control,fn){
    control.disabled=true;status.textContent=''
    try{await fn()}catch(error){status.textContent=error.message??'操作できませんでした。'}finally{control.disabled=false}
  }
  for(const [index,master] of masters.entries()){
    const row=el('div',null,'record stack')
    row.append(el('strong',`マスター ${index+1} · ${master.email}`),el('p',master.active===false?'本人の有効化待ち':'有効・全契約店舗を管理','muted'))
    if(masters.length>1&&!info.pair)row.append(button('このマスターの権限を終了',event=>{
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
      const explanation=adding?`${info.pending_email} を兼任マスターに追加します。既存マスターは残ります。`:
        `${info.pending_replace_email??info.current_email} の権限とログインを終了し、${info.pending_email} に引き継ぎます。他のマスターは変更しません。`
      if(!window.confirm(explanation+' 確定しますか？'))return
      run(event.currentTarget,()=>actions.approve(info.pending_id,adding?null:info.pending_replace_id??info.current_id))
    },'primary')
    promote.disabled=!info.pending_active
    pending.append(promote)
    const issued=actions.inviteResult
    if(issued?.id===info.pending_id&&!info.pending_active&&issued.url){
      const value=el('input');value.readOnly=true;value.value=issued.url;value.setAttribute('aria-label','新しいマスターの専用招待リンク');pending.append(el('p','以下の専用リンクを本人にのみ渡してください。パスワードを設定すると登録が完了します（6桁コード不要）。'),value,
        button('専用招待リンクをコピー',event=>run(event.currentTarget,async()=>{await navigator.clipboard.writeText(issued.url);status.textContent='本人専用の招待リンクをコピーしました。'}),'secondary'))
    }else if(issued?.id===info.pending_id&&!info.pending_active&&issued.invite_code&&issued.setup_key){
      const value=[`招待コード　${issued.invite_code}`,`認証アプリ設定キー　${issued.setup_key}`,`期限　${new Date(issued.expires_at).toLocaleString('ja-JP')}`].join('\n')
      pending.append(el('p','以下の招待情報を本人にのみ渡してください。本人がログイン画面の「招待を受け取った方」からパスワード・認証アプリを設定します。'),el('pre',value),
        button('招待情報をコピー',event=>run(event.currentTarget,async()=>{await navigator.clipboard.writeText(value);status.textContent='本人へ渡す招待情報をコピーしました。'}),'secondary'))
    }else if(!info.pending_active)pending.append(el('p','招待情報は発行した直後だけ表示します。紛失・期限切れの場合は同じメールアドレスで招待を再発行してください。','muted'))
    root.append(pending)
  }
  const form=el('form',null,'stack'),mode=document.createElement('select'),target=document.createElement('select'),address=document.createElement('input')
  form.dataset.singleMaster='true'
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
  const pairPanel=el('section',null,'record stack')
  if(actions.pairInvite){
    pairPanel.append(el('h3',info.pair?.candidates.length===3?'3名へ個別招待リンクを発行':'2名へ個別招待リンクを発行'),el('p','新しい担当者へそれぞれ専用リンクを渡します。登録済みの担当者は空き枠があれば個別に有効化できます。全員が本人登録した後に、前任者の権限を終了して交代します。','muted'))
    if(info.pair){
      pairPanel.append(el('p',info.pair.mfa_required?'認証方式：パスワードと6桁コード':'認証方式：メール・パスワードのみ（6桁コード不要）','muted'))
      for(const [i,candidate] of info.pair.candidates.entries()){
        const row=el('div',null,'record stack');row.append(el('strong',`担当者 ${i+1} · ${candidate.email}`),el('p',candidate.approved?'有効・ログイン可能':candidate.active?'本人の登録完了・管理者の有効化待ち':candidate.expires_at?'招待期限：'+new Date(candidate.expires_at).toLocaleString('ja-JP'):'本人の登録待ち','muted'))
        const issued=actions.pairResult?.id===info.pair.id&&actions.pairResult.candidates.find(c=>c.id===candidate.id)
        if(issued?.url&&!candidate.active){const value=el('input');value.readOnly=true;value.value=issued.url;value.setAttribute('aria-label',`担当者 ${i+1} の専用招待リンク`);row.append(value,button('この担当者の専用リンクをコピー',event=>run(event.currentTarget,async()=>{await navigator.clipboard.writeText(issued.url);status.textContent='本人専用の招待リンクをコピーしました。'}),'secondary'))}
        if(candidate.active&&!candidate.approved&&actions.pairApproveCandidate){
          const activate=button('この担当者だけ先に有効化',event=>{
            if(!confirm(`${candidate.email} を今すぐエールの全店舗管理マスターに追加します。前任者と残りの招待は維持します。進めますか？`))return
            run(event.currentTarget,()=>actions.pairApproveCandidate({id:info.pair.id,target:candidate.id}))
          },'primary');activate.disabled=masters.length>=limit;row.append(activate)
          if(activate.disabled)row.append(el('p','現在は空き枠がありません。全員登録後、引き継ぎを確定してください。','muted'))
        }
        pairPanel.append(row)
      }
      if(info.pair.candidates.length===2&&actions.pairExtend){
        const extension=el('form',null,'stack'),email=document.createElement('input');email.type='email';email.required=true;email.autocomplete='off';email.placeholder='本人のメールアドレス';const label=el('label','3人目のメールアドレス','field');label.append(email);const issue=el('button','3人目の専用リンクを発行','primary');issue.type='submit';extension.append(label,el('p','既存2名の招待リンクと登録状態は変わりません。登録済みの担当者は先に有効化でき、全員登録後に引き継ぎを確定できます。','muted'),issue);extension.onsubmit=event=>{event.preventDefault();run(issue,()=>actions.pairExtend({id:info.pair.id,address:email.value.trim()}))};pairPanel.append(extension)
      }
      const n=info.pair.candidates.length
      const renew=button('未登録者の招待リンクを再発行',event=>{if(!confirm('未登録者の以前の招待リンクを無効化し、新しいリンクを発行します。進めますか？'))return;run(event.currentTarget,()=>actions.pairInvite({addresses:info.pair.candidates.map(c=>c.email),mfa_required:info.pair.mfa_required}))},'secondary');renew.disabled=info.pair.candidates.every(c=>c.active)
      const approve=button(n===3?'3名への引き継ぎを確定する':'2名への引き継ぎを確定する',event=>{if(!confirm('全員の本人登録を確認しましたか？ 前任のマスターの権限とログインが終了します。確定しますか？'))return;run(event.currentTarget,()=>actions.pairConfirm(info.pair.id))},'primary');approve.disabled=!info.pair.candidates.every(c=>c.active)
      pairPanel.append(renew,approve,button(`${n}名の招待を取り消す`,event=>{if(confirm('未使用の招待リンクを無効化します。現在のマスターは変更しません。取り消しますか？'))run(event.currentTarget,()=>actions.pairCancel(info.pair.id))},'secondary'))
      form.hidden=true
    }else{
      const f=el('form',null,'stack'),addresses=[1,2].map(i=>{const l=el('label',`担当者${i}のメールアドレス`),input=document.createElement('input');input.type='email';input.required=true;input.autocomplete='off';l.append(input);f.append(l);return input})
      const send=el('button','担当者2名の専用リンクを発行','primary');send.type='submit';send.disabled=!!info.pending_id;f.append(el('p','この2名はメールとパスワードのみでログインします。認証アプリの6桁コードは不要です。','muted'),send)
      if(info.pending_id)pairPanel.append(el('p','現在発行済みの1名分の手続きを先に完了してください。','muted'))
      f.onsubmit=event=>{event.preventDefault();const values=addresses.map(a=>a.value.trim());if(values[0].toLowerCase()===values[1].toLowerCase()){status.textContent='2名それぞれ異なるメールを指定してください。';return}run(send,()=>actions.pairInvite({addresses:values,mfa_required:false}))}
      pairPanel.append(f)
    }
  }
  root.append(button('最新の状態を取得',event=>run(event.currentTarget,actions.refresh),'secondary'),form,pairPanel,status)
  return root
}
