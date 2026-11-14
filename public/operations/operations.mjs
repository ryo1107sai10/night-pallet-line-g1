const $=selector=>document.querySelector(selector)
const tabs={customers:'顧客台帳',bookings:'来店予約',automation:'自動配信'}
const statuses={pending:'仮受付',confirmed:'確定',cancelled:'取消',visited:'来店済',no_show:'不来店',
  accepted:'LINE受付済',submitting:'LINEへ提出中',failed:'失敗',unknown:'結果不明'}
let session,store,current='customers',epoch=0
function el(tag,text,cls){const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node}
function alert(text,error=false){const n=$('#message');n.textContent=text;n.hidden=!text;n.classList.toggle('error',error)}
async function api(path,method='GET',body){
  const response=await fetch('/api/v1'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),
    ...(method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body?JSON.stringify(body):undefined})
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
const base=()=>'/stores/'+store.id
const stamp=date=>new Intl.DateTimeFormat('ja-JP',{timeZone:store.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(date))
function field(label,key,type='text',value='',items){
  const wrap=el('label',label,type==='checkbox'?'check':'field')
  const input=el(items?'select':'input')
  input.name=key
  if(items) input.append(...items.map(([id,title])=>new Option(title,id)))
  else input.type=type
  if(type==='checkbox'){input.checked=!!value;wrap.prepend(input)}
  else{input.value=value??'';wrap.append(input)}
  return wrap
}
function button(label,fn){
  const control=el('button',label)
  control.type='button'
  control.onclick=async()=>{control.disabled=true;try{await fn()}catch(error){alert(error.message,true)}finally{control.disabled=false}}
  return control
}
function form(fields,caption,fn){
  const node=el('form')
  const group=el('div',null,'fields');group.append(...fields)
  const submit=el('button',caption,'primary')
  node.append(group,submit)
  node.onsubmit=async event=>{
    event.preventDefault();submit.disabled=true
    try{await fn(Object.fromEntries(new FormData(node)))}catch(error){alert(error.message,true)}finally{submit.disabled=false}
  }
  return node
}
function details(label,content){const d=el('details');d.append(el('summary',label),content);return d}
async function changed(path,method,data,message){
  await api(base()+path,method,data)
  await render()
  alert(message)
}
function customers(root,entries,staff){
  root.append(el('h2','顧客台帳'))
  const search=field('呼び名またはタグで絞り込み','filter','search')
  const list=el('div')
  function update(query) {
    const rows=[]
    for(const c of entries.filter(c=>((c.display_name??'')+' '+c.tags.join(' ')).includes(query))){
      const row=el('article',null,'record')
      const title=c.display_name??'呼び名未登録'
      row.append(el('b',title),el('p',c.channel_label+' · '+(c.verified_at?'本人確認済':'友だち追加で登録')+
        ' · '+(c.all_stop?'全配信停止':(c.service_consent?'業務同意あり':'業務同意なし')+' / '+(c.marketing_consent?'販促同意あり':'販促同意なし'))))
      if(c.last_reply_at) row.append(el('p','最後の受信 '+stamp(c.last_reply_at),'compact'))
      row.append(details('台帳を編集',form([field('呼び名','display_name','text',c.display_name),
        field('メモ','memo','text',c.memo),field('タグ（カンマ区切り）','tags','text',c.tags.join(', ')),
        field('担当者','assigned_to','',c.assigned_to,[['','未割当'],...staff.map(person=>[person.id,person.email])]),
        field('20歳以上を店頭等で確認済み','verified20','checkbox',c.verified_20_at),
        field('有人対応中・自動配信を保留','active_chat','checkbox',c.active_chat),field('確認・変更理由','reason')],
        '顧客台帳を保存',data=>changed('/customers/'+c.id,'PATCH',{...data,revision:c.revision,assigned_to:data.assigned_to||null,
          tags:data.tags.split(',').map(x=>x.trim()).filter(Boolean),verified20:data.verified20==='on',active_chat:data.active_chat==='on'},'顧客台帳を保存しました。'))),
        details('手動登録のシナリオを開始',form([field('理由','reason')],'開始イベントを登録',
          data=>changed('/customers/'+c.id+'/enroll','POST',data,'手動開始イベントを登録しました。'))))
      rows.push(row)
    }
    list.replaceChildren(...(rows.length?rows:[el('p','該当する顧客はいません。','empty')]))
  }
  search.querySelector('input').oninput=event=>update(event.target.value)
  update('')
  root.append(search,list)
}
function bookings(root,slots,entries,people){
  root.append(el('h2','来店予約'))
  root.append(details('受付枠を作成',form([
    field('枠名','label'),field('開始（例 2026-11-20T22:00+09:00）','starts_at'),
    field('終了（タイムゾーン付き）','ends_at'),field('定員','capacity','number',4),field('LIFFに公開','published','checkbox',true),
  ],'受付枠を作成',data=>changed('/slots','POST',{...data,capacity:Number(data.capacity),published:data.published==='on'},'受付枠を作成しました。'))))
  const choices=[['','選択してください'],...slots.map(s=>[s.id,stamp(s.starts_at)+' '+s.label+'（残り'+s.remaining+'人）'])]
  root.append(details('スタッフが予約を登録',form([
    field('顧客','customer','', '',[['','選択してください'],...people.map(p=>[p.id,(p.display_name??'呼び名未登録')+' · '+p.channel_label])]),
    field('受付枠','slot','','',choices),field('人数','party','number',1),field('確定として登録','confirm','checkbox',false),
  ],'予約を登録',data=>changed('/bookings','POST',{...data,party:Number(data.party),confirm:data.confirm==='on'},'予約を登録しました。'))))
  for(const b of entries){
    const row=el('article',null,'record')
    row.append(el('b',stamp(b.starts_at)+' · '+(b.display_name??'呼び名未登録')+' · '+b.party+'名'),
      el('p',statuses[b.status]+'　営業日 '+b.business_date+'　v'+b.revision,'compact'))
    if(['pending','confirmed'].includes(b.status)){
      const choicesStatus=b.status==='confirmed'?['pending','confirmed','cancelled','visited','no_show']:['pending','confirmed','cancelled']
      row.append(details('状態・日時・人数を更新',form([
        field('状態','status','',b.status,choicesStatus.map(key=>[key,statuses[key]])),field('受付枠','slot','',b.slot_id,choices),
        field('人数','party','number',b.party),field('更新理由','reason'),
      ],'予約を更新',data=>changed('/bookings/'+b.id,'PATCH',{...data,party:Number(data.party),revision:b.revision},'予約を更新しました。'))))
    }
    root.append(row)
  }
  if(!entries.length)root.append(el('p','予約はまだありません。','empty'))
}
function automation(root,data){
  root.append(el('h2','自動配信'))
  root.append(el('p',data.auto_enabled?'店舗の自動配信は有効です。':'店舗の自動配信は無効です。'))
  if(!data.process_enabled) root.append(el('p','公開HTTPS環境と AUTO_SEND_ENABLED の設定が必要です。','field-hint'))
  if(!data.eligible_at) root.append(el('p','LINE接続画面で店舗の利用適格性を確認してください。','field-hint'))
  if(session.actor.role==='admin') root.append(form([
    field('店舗の自動配信を有効にする','enabled','checkbox',data.auto_enabled),
    field('店舗の契約・配信権限を確認済み','contract','checkbox',data.contract_active),
    field('月間通数上限','monthly_limit','number',data.monthly_limit),field('設定の理由','reason'),
  ],'自動配信設定を保存',settings=>changed('/automation','PATCH',{revision:store.revision,enabled:settings.enabled==='on',
    contract:settings.contract==='on',monthly_limit:Number(settings.monthly_limit),reason:settings.reason},'配信設定を保存しました。')))
  root.append(el('h3','最近のLINE送信','section'))
  for(const j of data.jobs)root.append(el('p',stamp(j.first_attempt_at)+' · '+(statuses[j.status]??j.status)+
    (j.reason?' · '+j.reason:'')+(j.line_request_id?' · '+j.line_request_id:''),'record compact'))
  if(!data.jobs.length)root.append(el('p','送信履歴はまだありません。','empty'))
  root.append(el('h3','分岐・停止の記録','section'))
  for(const n of data.notes) root.append(el('p',stamp(n.occurred_at)+' · '+n.kind+' · '+(n.detail??''),'record compact'))
}
async function render(){
  const request=++epoch
  session=await api('/session')
  store=session.stores.find(item=>item.id===$('#store').value)??session.stores[0]
  if(!store)throw new Error('先に店舗を登録してください。')
  $('#store').value=store.id
  $('#tabs').replaceChildren(...Object.entries(tabs).map(([key,title])=>{
    const b=button(title,async()=>{current=key;await render()})
    if(current===key)b.setAttribute('aria-current','page')
    return b
  }),button('最新の状態を取得',render))
  const path=base(), page=current
  const fragment=el('div')
  if(page==='customers')customers(fragment,...await Promise.all([api(path+'/customers'),api(path+'/staff-options')]))
  if(page==='bookings'){
    const values=await Promise.all(['/slots','/bookings','/customers'].map(endpoint=>api(path+endpoint)))
    bookings(fragment,...values)
  }
  if(page==='automation')automation(fragment,await api(path+'/automation'))
  if(request===epoch)$('#content').replaceChildren(fragment)
}
async function start(){
  session=await api('/session')
  if(!['admin','manager'].includes(session.actor.role))throw new Error('法人管理者または店舗責任者でログインしてください。')
  for(const s of session.stores)$('#store').add(new Option(s.name,s.id))
  $('#store').onchange=()=>render().catch(error=>alert(error.message,true))
  await render()
}
start().catch(error=>alert(error.message,true))
