import { clockLabel, defaultHours, fitsHours, interval, lastMinute, localTime, timeOptions } from './hours.mjs'

const days=['日','月','火','水','木','金','土']
const methods={onsite:'対面',online:'オンライン'}
const range=7
const dayMs=86400000
const shift=(date,amount)=>new Date(Date.parse(date+'T00:00:00Z')+amount*dayMs).toISOString().slice(0,10)
export const dateKey=(date,zone)=>localTime(date,zone).date
const weekday=date=>new Date(date+'T00:00:00Z').getUTCDay()
const label=date=>Number(date.slice(5,7))+'/'+Number(date.slice(8,10))
export function formatAppointment(slot,zone){
  const {date,minutes}=localTime(slot.starts_at,zone)
  const finish=localTime(slot.ends_at,zone)
  const end=lastMinute(slot.starts_at,slot.ends_at,zone)
  const endLabel=end===null?label(finish.date)+' '+clockLabel(finish.minutes):clockLabel(end)
  return label(date)+'（'+days[weekday(date)]+'） '+clockLabel(minutes)+'〜'+endLabel
}
const duration=slot=>Math.round((Date.parse(slot.ends_at)-Date.parse(slot.starts_at))/60000)+'分'

function el(tag,text,cls){
  const node=document.createElement(tag)
  if(text!=null)node.textContent=text
  if(cls)node.className=cls
  return node
}
function action(label,fn,cls){
  const b=el('button',label,cls)
  b.type='button';b.onclick=fn
  return b
}
function group(...items){const node=el('div',null,'controls');node.append(...items);return node}
function box(title){const node=el('section',null,'box stack');node.append(el('h2',title));return node}
function item(slot,zone){
  const card=el('div',null,'slot-summary')
  card.append(el('strong',formatAppointment(slot,zone)),el('p',methods[slot.method]+' · 所要 '+duration(slot)))
  return card
}

export async function mountInterview(root,service) {
  root.classList.add('interview-app')
  let data,start,day,selected,existing,complete
  let stage='select',busy=false,message='',name=''
  let method='onsite'

  function show(focus=false){
    if(!data) return
    const heading=el('header',null,'hero')
    heading.append(el('h1','面談予約'),el('p',data.store+(service.demo?' · 操作デモ':' · 採用窓口')))
    const flow=el('ol',null,'flow')
    for(const [index,[step,title]] of [['select','日時選択'],['confirm','内容確認'],['done','完了']].entries()){
      const badge=el('li')
      if(stage===step)badge.setAttribute('aria-current','step')
      badge.append(el('b',String(index+1)),el('span',title))
      flow.append(badge)
    }
    const notice=el('div',message,'notice')
    notice.setAttribute('role','status');notice.hidden=!message
    const body=el('div',null,'columns')
    if(stage==='select')body.append(calendar(),selection())
    if(stage==='confirm')body.append(confirmation(),help())
    if(stage==='done')body.append(done(),help())
    if(stage==='cancel')body.append(cancelPane(),help())
    root.replaceChildren(heading,flow,notice,body)
    if(service.demo)root.append(el('footer','デモ用の空き枠です。操作内容はこのブラウザにのみ保存されます。'))
    if(focus){
      const title=body.querySelector('h2')
      title.tabIndex=-1
      title.focus({preventScroll:true})
      title.scrollIntoView({block:'nearest'})
    }
  }

  const run=async(fn,control)=>{
    if(busy)return
    busy=true
    if(control)control.disabled=true
    try{await fn()}
    catch (error){message=error.message||'処理できませんでした。';show()}
    finally{busy=false;if(control)control.disabled=false}
  }

  function help(){
    const guide=box('面談のご案内')
    guide.append(el('p','面談形式と所要時間は空き枠ごとに表示します。会場・参加方法は確定後にご確認いただけます。'))
    if(stage!=='done')guide.append(el('p','確定後は「自分の面談」から日程変更・取消ができます。'))
    return guide
  }

  function calendar(){
    const cal=box('空き枠を選ぶ')
    if(data.interviews_enabled===false){
      cal.append(el('p','この店舗では現在、新規の面談予約を受け付けていません。'))
      return cal
    }
    const dates=Array.from({length:range},(_,i)=>shift(start,i))
    const hours=data.hours??defaultHours
    const times=timeOptions(hours.start,hours.end)
    const current=dates.includes(day)?day:dates[0]
    const pending=new Map()
    const counts=new Map(dates.map(date=>[date,0]))
    for(const slot of data.slots){
      if(slot.method!==method)continue
      if(!fitsHours(slot.starts_at,slot.ends_at,data.timezone,hours))continue
      const {date,minutes}=localTime(slot.starts_at,data.timezone)
      if(!counts.has(date))continue
      const key=date+'/'+minutes
      const sameTime=pending.get(key)??[]
      sameTime.push(slot)
      pending.set(key,sameTime)
      if(slot.available)counts.set(date,counts.get(date)+1)
    }
    const bar=el('div',null,'weekbar')
    const prev=action('‹ 前週',event=>run(()=>week(-7),event.currentTarget))
    const forward=action('翌週 ›',event=>run(()=>week(7),event.currentTarget))
    prev.disabled=start<=data.today;forward.disabled=start>=shift(data.today,90)
    bar.append(prev,el('strong',label(dates[0])+' – '+label(dates.at(-1))),forward)
    const format=el('label',null,'interview-option')
    const online=el('input')
    online.id='interview-online'
    online.type='checkbox'
    online.checked=method==='online'
    online.onchange=()=>{
      method=online.checked?'online':'onsite'
      selected=null;message=''
      chooseFirstAvailableDay()
      show()
      root.querySelector('#interview-online')?.focus()
    }
    format.append(online,el('span','オンライン面談を希望する'))
    const summary=el('p',methods[method]+'面談の空き枠','small')
    summary.setAttribute('role','status')
    cal.append(el('p','受付時間 '+clockLabel(hours.start)+'〜'+clockLabel(hours.end)+' · '+interval+'分刻み'),format,summary,bar)

    const table=el('table',null,'grid desktop-calendar')
    table.append(el('caption','○ 空きあり　× 受付不可　— 受付枠なし'))
    const head=table.createTHead().insertRow()
    const timeHeading=el('th','時刻');timeHeading.scope='col';head.append(timeHeading)
    for(const date of dates){
      const th=el('th',null,weekday(date)%6===0?'weekend':'')
      th.scope='col'
      const text=el('time',label(date));text.dateTime=date
      th.append(text,el('small',days[weekday(date)]))
      head.append(th)
    }
    const tbody=table.createTBody()
    for(const key of times){
      const row=tbody.insertRow(), th=el('th',clockLabel(key));th.scope='row';row.append(th)
      for(const date of dates){
        const cell=row.insertCell()
        const slots=pending.get(date+'/'+key)??[]
        if(!slots.length)cell.textContent='—'
        for(const slot of slots){
          if(slot.available)cell.append(slotButton(slot,true))
          else {const marker=el('span','×');marker.setAttribute('aria-label','受付不可');cell.append(marker)}
        }
      }
    }
    const mobile=el('div',null,'mobile-calendar')
    const strip=el('div',null,'date-strip')
    strip.setAttribute('aria-label','日付を選択')
    for(const date of dates){
      const b=action('',()=>{
        day=date;show()
        root.querySelector('.date-strip [aria-pressed=true]')?.focus()
      })
      b.setAttribute('aria-pressed',String(current===date))
      b.setAttribute('aria-label',label(date)+' '+days[weekday(date)]+'曜日 空き'+counts.get(date)+'件')
      b.append(el('span',days[weekday(date)]),el('b',label(date)),el('small',counts.get(date)+'件'))
      strip.append(b)
    }
    const list=el('div',null,'mobile-slots')
    for(const key of times){
      const options=pending.get(current+'/'+key)??[]
      const free=options.filter(slot=>slot.available)
      if(free.length){list.append(...free.map(slot=>slotButton(slot,false)));continue}
      const closed=action('',null)
      closed.disabled=true
      closed.append(el('b',clockLabel(key)),el('span',options.length?'受付不可':'枠なし'))
      list.append(closed)
    }
    mobile.append(strip,list)
    cal.append(table,mobile)
    if(data.availability_warning)cal.insertBefore(el('p','Googleカレンダーの空き状況を確認できないため、現在は予約を受け付けていません。','notice'),table)
    if(!pending.size)cal.append(el('p','この週に公開中の'+methods[method]+'面談の枠はありません。翌週もご確認ください。','small'))
    return cal
  }
  function slotButton(slot,compact){
    const chosen=selected?.id===slot.id
    const b=action('',()=>{
      selected=slot;day=dateKey(slot.starts_at,data.timezone);message='';show()
      for(const control of root.querySelectorAll('button[data-slot]')){
        if(control.dataset.slot===slot.id&&control.getClientRects().length){control.focus();break}
      }
    })
    b.dataset.slot=slot.id
    b.setAttribute('aria-pressed',String(chosen))
    b.setAttribute('aria-label',formatAppointment(slot,data.timezone)+' '+methods[slot.method]+' 空きあり')
    b.append(el('b',compact?'○':clockLabel(localTime(slot.starts_at,data.timezone).minutes)),el('span',methods[slot.method]))
    return b
  }

  async function week(offset){
    const candidate=shift(start,offset),limit=shift(data.today,90)
    const next=candidate<data.today?data.today:candidate>limit?limit:candidate
    data=await service.calendar(next);start=next;selected=null;message='';chooseFirstAvailableDay();show()
    root.querySelector('.weekbar strong')?.scrollIntoView({block:'nearest'})
  }

  function selection(){
    const panel=box(existing?'変更する日時':'選択した日時')
    if(selected)panel.append(item(selected,data.timezone))
    else panel.append(el('p','カレンダーの「○」から希望の日時を選んでください。'))
    if(existing)panel.append(el('p','現在の面談 '+formatAppointment(existing,data.timezone)))
    const next=action('予約内容を確認する',()=>{
      message='';stage='confirm';show(true)
    },'primary')
    next.disabled=!selected
    panel.append(next)
    if(existing)panel.append(action('日程変更をやめる',()=>{existing=null;selected=null;message='';method='onsite';chooseFirstAvailableDay();show()}))
    const list=el('section')
    list.append(el('h3','自分の面談'))
    for(const booking of data.bookings){
      const active=booking.status==='confirmed'&&Date.parse(booking.starts_at)>Date.now()
      const row=el('div',null,'record stack')
      row.append(el('strong',active?'確定済み':booking.status==='cancelled'?'取消済み':'過去の予約'),item(booking,data.timezone))
      if(booking.instructions)row.append(el('p',booking.instructions,'wrap'))
      const change=data.interviews_enabled===false?[]:[action('日程変更',()=>{
        existing=booking;method=booking.method;selected=null;message='';chooseFirstAvailableDay();show(true)
      })]
      if(active)row.append(group(...change,action('取り消す',()=>{
        complete=booking;stage='cancel';show(true)
      })))
      list.append(row)
    }
    if(!data.bookings.length)list.append(el('p','予約はまだありません。'))
    panel.append(list)
    return panel
  }

  function confirmation(){
    const result=box(existing?'日程変更の確認':'予約内容の確認')
    const form=el('form',null,'stack')
    if(existing)form.append(el('p','変更前 '+formatAppointment(existing,data.timezone)))
    form.append(item(selected,data.timezone))
    if(!existing){
      const label=el('label',null,'field'), input=el('input')
      input.required=true;input.maxLength=80;input.autocomplete='name';input.value=name
      input.oninput=()=>{name=input.value}
      label.append(el('span','お名前（必須）'),input)
      form.append(label)
    }
    const submit=el('button',existing?'この日時に変更する':'この日時で面談を確定する','primary')
    submit.type='submit'
    form.append(el('p','他の方の予約状況により、確定時に空き枠を再確認します。'),
      group(action('日時選択に戻る',()=>{stage='select';message='';show(true)}),submit))
    form.onsubmit=event=>{
      event.preventDefault()
      run(async()=>{
        if(!existing&&!name.trim())throw new Error('お名前を入力してください。')
        try{complete=existing?await service.change(existing.id,{action:'reschedule',slot:selected.id,revision:existing.revision}):
          await service.book({slot:selected.id,name:name.trim()})}
        catch(error){
          if(error.status!==409)throw error
          await refresh()
          existing=existing&&data.bookings.find(booking=>booking.id===existing.id&&booking.status==='confirmed')
          selected=null;stage='select';message=error.message;show(true);return
        }
        message='';stage='done';show(true)
      },submit)
    }
    result.append(form)
    return result
  }

  function cancelPane(){
    const pane=box('面談を取り消しますか？')
    pane.append(item(complete,data.timezone),group(action('戻る',()=>{stage='select';show(true)}),
      action('取り消しを確定する',event=>run(async()=>{
        complete=await service.change(complete.id,{action:'cancel',revision:complete.revision})
        stage='done';message='';show(true)
      },event.currentTarget),'primary')))
    return pane
  }

  async function refresh(){
    data=await service.calendar(start)
    start=start??data.today
    if(!day)chooseFirstAvailableDay()
  }

  function chooseFirstAvailableDay(){
    const first=data.slots.find(slot=>slot.method===method&&slot.available)
    day=first?dateKey(first.starts_at,data.timezone):start
  }

  function done(){
    const success=box(complete.status==='cancelled'?'面談を取り消しました':existing?'面談の日程を変更しました':'面談予約が確定しました')
    success.append(el('span',complete.status==='cancelled'?'取消済み':'確定','success'),item(complete,data.timezone))
    if(complete.status==='confirmed'){
      success.append(el('p','お名前 '+complete.applicant_name))
      if(complete.instructions)success.append(el('p',complete.instructions,'wrap'))
    }
    success.append(action('自分の面談を見る',event=>run(async()=>{
      await refresh();existing=null;complete=null;selected=null;stage='select';method='onsite';chooseFirstAvailableDay();show(true)
    },event.currentTarget),'secondary'))
    return success
  }

  await refresh()
  show()
}
