const minuteDate=(value,zone)=>new Intl.DateTimeFormat('ja-JP',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',
  weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))
function el(tag,text,cls){
  const node=document.createElement(tag)
  if(text)node.textContent=text
  if(cls)node.className=cls
  return node
}
function button(text,fn){
  const b=el('button',text)
  b.type='button';b.onclick=fn
  return b
}
function field(label,type,name,value='',max){
  const wrapper=el('label',label,'field'),input=el('input')
  input.type=type;input.name=name;input.value=value
  if(max)input.maxLength=max
  wrapper.append(input)
  return wrapper
}

export function drawAvailability(root,state,zone,controls){
  const busyList=el('section',null,'box stack')
  busyList.append(el('h2','Googleカレンダー連携'))
  busyList.append(el('p',state.google_enabled===false?'この店舗ではGoogleカレンダーの照合を停止しています。':state.google.connected?(controls.demo?'サンプル予定を反映中 · 各日20:15〜21:00':state.google.shared?'共有カレンダーの空き時間を照合します。':'連携中 · '+state.google.calendar_id):
    '連携すると、予定ありの時間帯と重なる面談枠を受付対象から外します。'))
  if(controls.demo){
    busyList.append(button(state.google.connected?'サンプル予定の反映を停止':'サンプル予定を反映',
      event=>run(event.currentTarget,()=>controls.toggleDemo(!state.google.connected))))
  }else if(state.google_enabled!==false&&state.google.configured&&(!state.google.shared||state.google_write_enabled)){
    const link=el('form',null,'stack')
    const calendar=field('GoogleカレンダーID','text','calendar_id',state.google.calendar_id??'primary',250)
    calendar.querySelector('input').required=true
    link.append(calendar,el('p','自分のメインカレンダーは primary。共有カレンダーは設定画面にあるカレンダーIDを入力してください。'),
      el('button',state.google.connected?'Googleで再連携する':'Googleで連携する','primary'))
    link.onsubmit=event=>{
      event.preventDefault()
      const id=new FormData(link).get('calendar_id')
      run(link.querySelector('button'),()=>controls.connect(id))
    }
    busyList.append(link)
  }else if(state.google_enabled!==false&&!state.google.shared)busyList.append(el('p','Google OAuth クライアントをアプリに設定すると連携できます。'))
  if(state.google_enabled!==false&&state.google_write_enabled){
    busyList.append(el('p',state.google_write_granted?'面談が確定すると、予約名を含めずGoogleカレンダーに予定を登録します。':
      '予定の登録・変更を行うには「Googleで連携」から書き込み権限を許可してください。'))
    if(state.google_write_granted)busyList.append(button('予定の反映を再試行',event=>run(event.currentTarget,controls.retryWrites)))
  }
  if(!controls.demo&&state.google.connected&&(!state.google.shared||state.google_write_granted)){
    const remove=el('details')
    remove.append(el('summary','連携を解除する'),el('p','解除後はGoogleの予定を照合せず、店内の確定予約と受付停止時間で空きを判定します。'),
      button('連携解除を確定',event=>run(event.currentTarget,controls.disconnect)))
    busyList.append(remove)
  }

  const blocks=el('section',null,'box stack')
  blocks.append(el('h2','面談を受け付けない時間'))
  const form=el('form',null,'stack')
  const times=el('div',null,'time-fields')
  times.append(field('停止開始','datetime-local','start'),field('停止終了','datetime-local','end'))
  for(const input of times.querySelectorAll('input'))input.required=true
  form.append(times,field('管理用メモ（任意）','text','note','',120),el('button','受付停止時間を追加','primary'))
  form.onsubmit=event=>{
    event.preventDefault()
    run(form.querySelector('button'),async()=>{
      const input=new FormData(form)
      const start=controls.localInstant(input.get('start'),zone)
      const end=controls.localInstant(input.get('end'),zone)
      if(start===null||end===null||end<=start)throw new Error('終了は開始より後の有効な日時を入力してください。')
      if(end<=Date.now())throw new Error('終了日時を現在より後にしてください。')
      await controls.add({starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),note:input.get('note')})
    })
  }
  blocks.append(el('p','停止時間に重なる枠の新規予約・日程変更を止めます。確定済みの面談は維持されます。'))
  if(state.interviews_enabled!==false)blocks.append(form)
  for(const block of state.blocks) {
    const row=el('div',null,'record stack')
    row.append(el('strong',minuteDate(block.starts_at,zone)+' 〜 '+minuteDate(block.ends_at,zone)))
    if(block.note)row.append(el('p',block.note,'wrap'))
    row.append(button('受付停止を解除',event=>run(event.currentTarget,()=>controls.remove(block.id))))
    blocks.append(row)
  }
  if(!state.blocks.length)blocks.append(el('p','受付停止時間は設定されていません。'))
  root.replaceChildren(busyList,blocks)

  async function run(control,fn){
    control.disabled=true
    try{await fn()}catch(error){controls.report(error.message??'操作できませんでした。')}
    finally{control.disabled=false}
  }
}
