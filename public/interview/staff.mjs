import {workspacePath,scopeWorkspaceLinks,rememberReturnWorkspace} from '/static/workspace-path.mjs'
import {formatAppointment} from './calendar.mjs'
import {localInstant} from '../studio/engine.mjs'
import {clockLabel, timeOptions, interval} from './hours.mjs'
import {configureHours} from './hours-form.mjs'
import {drawAvailability} from './availability.mjs'
scopeWorkspaceLinks()

const $=value=>document.querySelector(value)
let stores,selected,requestNumber=0
const form=$('#new-slot')
const hoursForm=$('#interview-hours')
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text}
function el(tag,text){const node=document.createElement(tag);node.textContent=text;return node}
async function api(path,method='GET',body,key){
  const response=await fetch(workspacePath('/api/v1'+path),{method,headers:{
    ...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),
  },body:body?JSON.stringify(body):undefined})
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
const path=store=>'/stores/'+store.id+'/interviews'
function drawHosts(root,hosts,store,refresh){
  const box=el('section','')
  box.className='box stack'
  box.append(el('h2','面談担当者'))
  for(const host of [null,...hosts]){
    const details=el('details','')
    details.append(el('summary',host?host.name+(host.active?'':'（停止中）'):'担当者を追加'))
    const editor=el('form','')
    editor.className='stack'
    const name=el('input',''),calendar=el('input',''),active=el('input','')
    name.required=true
    name.maxLength=80
    name.value=host?.name??''
    calendar.value=host?.calendar_id??''
    calendar.maxLength=250
    active.type='checkbox'
    active.checked=host?.active??true
    const nameLabel=el('label','担当者の表示名'),calendarLabel=el('label','共有GoogleカレンダーID（任意）')
    nameLabel.className=calendarLabel.className='field'
    nameLabel.append(name)
    calendarLabel.append(calendar)
    const activeLabel=el('label','面談担当として使う')
    activeLabel.prepend(active)
    const save=el('button','担当者を保存')
    save.className='primary'
    editor.append(nameLabel,calendarLabel,activeLabel,save)
    editor.onsubmit=async event=>{
      event.preventDefault()
      save.disabled=true
      try{
        await api(path(store)+'/hosts','PUT',{id:host?.id,revision:host?.revision,name:name.value,
          calendar_id:calendar.value.trim()||null,active:active.checked})
        await refresh('面談担当者を保存しました。')
      }catch(error){if(selected.id===store.id)notice(error.message)}finally{save.disabled=false}
    }
    details.append(editor)
    box.append(details)
  }
  root.append(box)
}
async function show(){
  const current=++requestNumber
  selected=stores.find(store=>store.id===$('#stores').value)
  if(!selected)throw new Error('採用を管理できる店舗がありません。')
  form.hidden=true
  hoursForm.hidden=true
  $('#slots').replaceChildren()
  $('#slot-help').textContent=''
  $('#availability').replaceChildren()
  $('#interview-hosts').replaceChildren()
  const store=selected
  const availabilityPath=path(store)+'/availability'
  const [{channels,slots,hours,today,interviews_enabled,hosts,interviewers_enabled},availability]=await Promise.all([api(path(store)),api(availabilityPath)])
  if(current!==requestNumber)return
  const refresh=async message=>{
    if(selected.id!==store.id)return
    await show()
    if(selected.id===store.id)notice(message)
  }
  if(interviewers_enabled)drawHosts($('#interview-hosts'),hosts,store,refresh)
  $('#host-field').hidden=!interviewers_enabled
  form.elements.host.replaceChildren(new Option('店舗共通',''),...hosts.filter(host=>host.active).map(host=>new Option(host.name,host.id)))
  drawAvailability($('#availability'),{...availability,interviews_enabled},store.timezone,{
    localInstant,report:message=>{
      if(selected.id===store.id)notice(message)
    },
    connect:async calendar_id=>{
      const result=await api(availabilityPath+'/google','POST',{calendar_id})
      if(current===requestNumber){
        rememberReturnWorkspace('google',store.id)
        location.assign(result.url)
      }
    },
    disconnect:async()=>{
      await api(availabilityPath+'/google','DELETE',{})
      await refresh('Googleカレンダーとの連携を解除しました。')
    },
    retryWrites:async()=>{
      await api(path(store)+'/calendar-sync','POST',{})
      await refresh('Googleカレンダーへの反映を待ち行列に登録しました。')
    },
    add:async input=>{
      const result=await api(availabilityPath+'/blocks','POST',input,crypto.randomUUID())
      const info=result.confirmed?' 確定済みの面談 '+result.confirmed+'件と重なっています。必要に応じて応募者と調整してください。':''
      await refresh('受付停止時間を追加しました。'+info)
    },
    remove:async id=>{
      await api(availabilityPath+'/blocks/'+id,'DELETE',{})
      await refresh('受付停止時間を解除しました。')
    },
  })
  configureHours(hoursForm,hours)
  hoursForm.hidden=!interviews_enabled
  hoursForm.onsubmit=async event=>{
    event.preventDefault()
    const button=hoursForm.querySelector('button')
    button.disabled=true
    try{
      await api(path(store)+'/hours','PATCH',{start:Number(hoursForm.elements.start.value),
        end:Number(hoursForm.elements.end.value),revision:hours.revision})
      if(selected.id===store.id)await show()
      notice('受付時間を保存しました。')
    }catch(error){notice(error.message)}finally{button.disabled=false}
  }
  const {date,minutes,time}=form.elements
  date.min=today
  const updateTimes=()=>{
    const last=hours.end-Number(minutes.value)
    const chosen=time.value
    const options=last<hours.start?[]:timeOptions(hours.start,last,true)
    time.replaceChildren(new Option('開始時刻を選択',''),...options.map(value=>new Option(clockLabel(value),clockLabel(value))))
    if(options.some(value=>clockLabel(value)===chosen))time.value=chosen
  }
  const selectedLength=minutes.value
  minutes.replaceChildren(...timeOptions(interval,Math.min(180,hours.end-hours.start),true)
    .map(value=>new Option(value+'分',String(value))))
  if(Array.from(minutes.options).some(option=>option.value===selectedLength))minutes.value=selectedLength
  minutes.onchange=updateTimes
  updateTimes()
  form.elements.channel.replaceChildren(...channels.map(channel=>new Option(channel.label,channel.id)))
  form.hidden=!interviews_enabled||!channels.length
  $('#slot-help').textContent=!interviews_enabled?'この店舗では面談予約の新規受付を停止しています。':
    channels.length?'':'先に採用用または兼用の公式アカウントを登録してください。'
  $('#slots').replaceChildren(...slots.map(slot=>{
    const section=el('article','');section.className='record stack'
    const stopped=availability.blocks.some(block=>Date.parse(slot.starts_at)<Date.parse(block.ends_at)&&
      Date.parse(slot.ends_at)>Date.parse(block.starts_at))
    section.append(el('strong',formatAppointment(slot,store.timezone)),
      el('p',(slot.method==='online'?'オンライン':'対面')+' · '+slot.channel_label+' · '+
      (stopped?'受付停止中':slot.in_hours?(slot.published?'公開中':'非公開'):'受付時間外')+(slot.applicant_name?' · 予約済み '+slot.applicant_name+' さん':'')))
    if(slot.guest_email)section.append(el('p','連絡先 '+slot.guest_email))
    if(slot.host_name)section.append(el('p','担当 '+slot.host_name))
    if(slot.calendar_status)section.append(el('p','Googleカレンダー '+({queued:'反映待ち',synced:'反映済み',failed:'反映できませんでした'}[slot.calendar_status])+
      (slot.calendar_error?' · '+slot.calendar_error:'')))
    if(Date.parse(slot.starts_at)>Date.now()&&(slot.published||(slot.method==='onsite'&&slot.in_hours&&interviews_enabled))){
      const toggle=el('button',slot.published?'公開を停止':'公開する')
      toggle.type='button';toggle.onclick=async()=>{
        toggle.disabled=true
        try{
          await api(path(store)+'/slots/'+slot.id,'PATCH',{revision:slot.revision,published:!slot.published})
          if(selected.id===store.id)await show()
          notice('公開状態を変更しました。')
        }catch(error){notice(error.message)}finally{toggle.disabled=false}
      }
      section.append(toggle)
    }
    return section
  }))
  if(!slots.length)$('#slots').append(el('p','面談枠はまだありません。'))
}
let pendingKey,pendingInput
form.onsubmit=async event=>{
  event.preventDefault()
  const data=new FormData(form),store=selected,button=form.querySelector('button')
  button.disabled=true
  try{
    const start=localInstant(data.get('date')+'T'+data.get('time'),store.timezone)
    if(start===null)throw new Error('店舗のタイムゾーンで有効な日時を指定してください。')
    const settings={channel:data.get('channel'),starts_at:new Date(start).toISOString(),
      ends_at:new Date(start+Number(data.get('minutes'))*60000).toISOString(),
      instructions:data.get('instructions'),published:data.get('published')==='on',host_id:data.get('host')||null}
    const fingerprint=JSON.stringify([store.id,settings])
    if(fingerprint!==pendingInput){pendingInput=fingerprint;pendingKey=crypto.randomUUID()}
    await api(path(store)+'/slots','POST',settings,pendingKey)
    if(selected.id===store.id){
      pendingInput=null
      form.reset()
      await show()
      if(selected.id===store.id)notice('面談枠を登録しました。')
    }
  }catch(error){if(selected.id===store.id)notice(error.message)}finally{button.disabled=false}
}
try{
  const session=await api('/session')
  if(!['admin','manager','recruiter'].includes(session.actor.role))throw new Error('採用担当の権限が必要です。')
  stores=session.stores
  $('#stores').append(...stores.map(store=>new Option(store.name,store.id)))
  const query=new URLSearchParams(location.search)
  if(stores.some(store=>store.id===query.get('store')))$('#stores').value=query.get('store')
  function storeNavigation(){
    const store=$('#stores').value
    $('#back-to-admin').href=workspacePath('/staff/'+(store?'?store='+encodeURIComponent(store):''))
    $('#back-to-operations').href=workspacePath('/operations/'+(store?'?store='+encodeURIComponent(store):''))
    $('#recruitment-operations').href=workspacePath('/workflows/?'+new URLSearchParams({store,use:'recruitment'}))
    const url=new URL(location.href)
    if(store)url.searchParams.set('store',store)
    else url.searchParams.delete('store')
    url.searchParams.delete('google')
    history.replaceState(null,'',url)
  }
  storeNavigation()
  $('#stores').onchange=async()=>{
    storeNavigation()
    const store=$('#stores').value
    form.reset()
    pendingInput=null
    notice('')
    try{await show()}catch(error){if($('#stores').value===store)notice(error.message)}
  }
  await show()
  if(query.get('google')==='connected'&&selected.id===query.get('store'))notice('Googleカレンダーの空き状況を確認できました。')
}catch(error){notice(error.message)}
