import {formatAppointment} from './calendar.mjs'
import {clockLabel,interval,timeOptions} from './hours.mjs'

export const slotReasons={past:'受付終了',reserved:'予約済み',published:'公開済み',blocked:'受付停止',
  google_busy:'Google予定と重複',google_unavailable:'Googleカレンダーを確認できません'}
const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)
const make=(tag,text='')=>{
  const node=document.createElement(tag)
  node.textContent=text
  return node
}

export function configureBatch(form,preview,store,settings,{request,active,report,refresh}){
  const {today,channels,hosts,hours}=settings
  const {first_day,last_day,channel,host,start,end,minutes}=form.elements
  preview.replaceChildren()
  const options=(select,values,label)=>select.replaceChildren(...values.map(value=>new Option(label(value),value)))
  channel.replaceChildren(...channels.map(item=>new Option(item.label,item.id)))
  host.replaceChildren(new Option('店舗共通',''),...hosts.filter(item=>item.active).map(item=>new Option(item.name,item.id)))
  host.closest('label').hidden=!settings.interviewers_enabled
  options(start,timeOptions(hours.start,hours.end-interval,true),clockLabel)
  options(end,timeOptions(hours.start+interval,hours.end,true),clockLabel)
  end.value=String(hours.end)
  options(minutes,timeOptions(interval,Math.min(180,hours.end-hours.start),true),value=>value+'分')
  first_day.min=last_day.min=today
  first_day.max=last_day.max=addDays(today,90)
  first_day.value=addDays(today,1)
  last_day.value=addDays(today,7)
  const selection=()=>{
    const fields=new FormData(form)
    return {channel:fields.get('channel'),host_id:fields.get('host')||null,
      first_day:fields.get('first_day'),last_day:fields.get('last_day'),weekdays:fields.getAll('weekday').map(Number),
      start:Number(fields.get('start')),end:Number(fields.get('end')),minutes:Number(fields.get('minutes')),
      instructions:fields.get('instructions')}
  }
  form.oninput=()=>preview.replaceChildren()
  form.onsubmit=async event=>{
    event.preventDefault()
    const button=form.querySelector('button[type="submit"]')
    button.disabled=true
    preview.replaceChildren()
    const input=selection()
    const signature=JSON.stringify(input)
    const current=()=>active() && signature===JSON.stringify(selection())
    try{
      const plan=await request('/slots/batch/preview',input)
      if(!current())return
      const count=plan.slots.filter(slot=>slot.reason===null).length
      const list=make('ul')
      for(const slot of plan.slots){
        list.append(make('li',formatAppointment(slot,store.timezone)+' · '+(slotReasons[slot.reason]??'公開可')))
      }
      const details=make('details')
      details.append(make('summary','日時と判定理由を見る'),list)
      preview.append(make('p','公開できる枠 '+count+'件 · 対象外 '+(plan.slots.length-count)+'件'),details)
      if(!count)return
      const publish=make('button',count+'枠を公開する')
      publish.type='button'
      publish.className='primary'
      const key=crypto.randomUUID()
      publish.onclick=async()=>{
        if(!current())return
        publish.disabled=true
        try{
          const result=await request('/slots/batch',{selection:input,preview:plan.preview},key)
          if(active())await refresh(result.published+'枠を公開しました。対象外 '+result.skipped+'件。')
        }catch(error){if(active())report(error.message)}
        finally{publish.disabled=false}
      }
      preview.append(publish)
    }catch(error){if(active())report(error.message)}
    finally{button.disabled=false}
  }
}
