import {formatAppointment} from './calendar.mjs'
import {localInstant} from '../studio/engine.mjs'
import {clockLabel, timeOptions, interval} from './hours.mjs'
import {configureHours} from './hours-form.mjs'
const $=value=>document.querySelector(value)
let stores,selected,requestNumber=0
const form=$('#new-slot')
const hoursForm=$('#interview-hours')
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text}
function el(tag,text){const node=document.createElement(tag);node.textContent=text;return node}
async function api(path,method='GET',body,key){
  const response=await fetch('/api/v1'+path,{method,headers:{
    ...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),
  },body:body?JSON.stringify(body):undefined})
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
const path=store=>'/stores/'+store.id+'/interviews'
async function show(){
  const current=++requestNumber
  selected=stores.find(store=>store.id===$('#stores').value)
  if(!selected)throw new Error('採用を管理できる店舗がありません。')
  form.hidden=true
  hoursForm.hidden=true
  const store=selected
  const {channels,slots,hours,today}=await api(path(store))
  if(current!==requestNumber)return
  configureHours(hoursForm,hours)
  hoursForm.hidden=false
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
  form.hidden=!channels.length
  $('#slot-help').textContent=channels.length?'':'先に採用用または兼用の公式アカウントを登録してください。'
  $('#slots').replaceChildren(...slots.map(slot=>{
    const section=el('article','');section.className='record stack'
    section.append(el('strong',formatAppointment(slot,store.timezone)),
      el('p',(slot.method==='online'?'オンライン':'対面')+' · '+slot.channel_label+' · '+
      (slot.in_hours?(slot.published?'公開中':'非公開'):'受付時間外')+(slot.applicant_name?' · 予約済み '+slot.applicant_name+' さん':'')))
    if(Date.parse(slot.starts_at)>Date.now()&&(slot.published||slot.in_hours)){
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
      ends_at:new Date(start+Number(data.get('minutes'))*60000).toISOString(),method:data.get('method'),
      instructions:data.get('instructions'),published:data.get('published')==='on'}
    const fingerprint=JSON.stringify([store.id,settings])
    if(fingerprint!==pendingInput){pendingInput=fingerprint;pendingKey=crypto.randomUUID()}
    await api(path(store)+'/slots','POST',settings,pendingKey)
    pendingInput=null
    if(selected.id===store.id){form.reset();await show()}
    notice('面談枠を登録しました。')
  }catch(error){notice(error.message)}finally{button.disabled=false}
}
try{
  const session=await api('/session')
  if(!['admin','manager','recruiter'].includes(session.actor.role))throw new Error('採用担当の権限が必要です。')
  stores=session.stores
  $('#stores').append(...stores.map(store=>new Option(store.name,store.id)))
  $('#stores').onchange=()=>show().catch(error=>notice(error.message))
  await show()
}catch(error){notice(error.message)}
