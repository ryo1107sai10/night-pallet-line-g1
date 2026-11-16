import liff from '@line/liff'
import { mountInterview } from '../public/interview/calendar.mjs'

const status = document.querySelector<HTMLParagraphElement>('#status')!
const form = document.querySelector<HTMLFormElement>('#verify')!
const signin = document.querySelector<HTMLButtonElement>('#signin')!
const connection = location.pathname.split('/')[2]
const labels = { customer:'顧客', recruitment:'採用' }
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
let source:string|undefined
let formId:string|undefined

async function prepare() {
  const response = await fetch('/api/v1/liff/' + encodeURIComponent(connection))
  const configuration = await response.json()
  if (!response.ok) throw new Error(configuration.message)
  try { await liff.init({ liffId:configuration.liff_id }) }
  catch { throw new Error('LINE公式アカウントから接続テスト画面を開き直してください。') }
  const query=new URLSearchParams(location.search)
  const code=query.get('source')
  source=code&&uuid.test(code)?code:undefined
  const formCode=query.get('form')
  formId=formCode&&uuid.test(formCode)?formCode:undefined
  if (!liff.isLoggedIn()) {
    status.textContent = 'LINEでログインして本人確認を続けてください。'
    signin.hidden = false
    const redirect=new URL(location.origin+location.pathname)
    if(source)redirect.searchParams.set('source',source)
    if(formId)redirect.searchParams.set('form',formId)
    const use=query.get('use')
    if(use==='customer'||use==='recruitment')redirect.searchParams.set('use',use)
    signin.onclick = () => liff.login({redirectUri:redirect.href})
    return
  }
  const select = form.elements.namedItem('purpose') as HTMLSelectElement
  for (const key of configuration.purposes as Array<keyof typeof labels>) select.add(new Option(labels[key],key))
  document.querySelector<HTMLElement>('#test-panel')!.hidden=false
  status.textContent = 'LINEでログインしました。'
  if (configuration.customer && configuration.recruitment) {
    const picker=document.querySelector<HTMLElement>('#liff-purpose')!
    picker.hidden=false
    picker.querySelector<HTMLButtonElement>('[data-use=customer]')!.onclick=()=>choosePurpose(openCustomer)
    picker.querySelector<HTMLButtonElement>('[data-use=recruitment]')!.onclick=()=>choosePurpose(openInterviews)
    if(query.get('use')==='recruitment')await choosePurpose(openInterviews)
    if(query.get('use')==='customer')await choosePurpose(openCustomer)
  } else {
    await choosePurpose(configuration.recruitment?openInterviews:openCustomer)
  }
  form.hidden = false
  form.onsubmit = async event => {
    event.preventDefault()
    const button = form.querySelector('button')!
    button.disabled = true
    try {
      const data = new FormData(form)
      const response = await fetch('/api/v1/auth/line/verify', { method:'POST',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({
          connection, purpose:data.get('purpose'), code:String(data.get('code')).trim(),
          id_token:liff.getIDToken(), allow_test_message:data.get('allow')==='on',
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message)
      form.reset()
      form.hidden = true
      status.textContent = '本人確認が完了しました。公式アカウントのトークに「接続テスト」と送ってください。'
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '接続を確認し、もう一度お試しください。'
    } finally { button.disabled = false }
  }
}

async function choosePurpose(open:()=>Promise<void>) {
  const picker=document.querySelector<HTMLElement>('#liff-purpose')!
  for(const button of picker.querySelectorAll('button')) button.disabled=true
  try {
    await open()
    picker.hidden=true
    document.querySelector<HTMLHeadingElement>('#heading')!.hidden=true
    status.hidden=false
  } catch (error) {
    status.textContent=error instanceof Error?error.message:'画面を開けませんでした。'
  } finally {
    for(const button of picker.querySelectorAll('button')) button.disabled=false
  }
}

async function openInterviews() {
  async function request(path:string,method='GET',body?:unknown) {
    const response=await fetch('/api/v1/interview'+path,{method,headers:body?{'Content-Type':'application/json'}:{},
      body:body?JSON.stringify(body):undefined})
    const data=await response.json()
    if(!response.ok) throw Object.assign(new Error(data.message??'操作できませんでした。'),{status:response.status})
    return data
  }
  await request('/login','POST',{connection,id_token:liff.getIDToken(),source})
  const root=document.querySelector<HTMLElement>('#interview')!
  await mountInterview(root,{
    calendar:start=>request('/calendar'+(start?'?start='+encodeURIComponent(start):'')),
    book:input=>request('/bookings','POST',input),
    change:(id,input)=>request('/bookings/'+encodeURIComponent(id),'PATCH',input),
  })
  document.body.classList.add('has-interviews')
  root.hidden=false
  await showWorkflowForm(request)
  await showInterviewNotices(request)
  document.title='面談予約 | Night PRO LINE'
}
type NoticeSettings={reminders:boolean;waitlist_enabled:boolean;notices:boolean;waitlist:{method:string;until_at:string;offered_at:string|null}|null}
async function showInterviewNotices(request:(path:string,method?:string,body?:unknown)=>Promise<unknown>){
  const root=document.querySelector<HTMLElement>('#interview-notices')!
  const draw=(data:NoticeSettings)=>{
    root.replaceChildren()
    root.hidden=!data.reminders&&!data.waitlist_enabled&&!data.notices&&!data.waitlist
    if(root.hidden)return
    const preferences=item('form')
    const label=item('label','LINEで予約の案内を受け取る')
    const input=item('input')
    input.type='checkbox'
    input.checked=data.notices
    label.prepend(input)
    preferences.append(label,item('button','通知設定を保存'))
    preferences.onsubmit=guarded(async()=>draw(await request('/notices','PUT',{enabled:input.checked}) as NoticeSettings))
    root.append(item('h2','面談のお知らせ'),preferences)
    if(data.waitlist){
      const current=item('form')
      current.append(item('p',data.waitlist.offered_at?'空きが出た枠の案内を準備しました。':'キャンセル待ちに登録済みです。'),
        item('button','キャンセル待ちを解除'))
      current.onsubmit=guarded(async()=>draw(await request('/waitlist','DELETE',{}) as NoticeSettings))
      root.append(current)
    }
    if(data.waitlist_enabled&&data.notices&&!data.waitlist){
      const join=item('form')
      const days=item('select')
      for(const day of [3,7,14,30])days.add(new Option(day+'日間',String(day)))
      const dayLabel=item('label','待つ期間')
      dayLabel.append(days)
      join.append(dayLabel,item('button','キャンセル待ちに登録'))
      join.onsubmit=guarded(async()=>draw(await request('/waitlist','PUT',{days:Number(days.value)}) as NoticeSettings))
      root.append(join)
    }
  }
  try{draw(await request('/notices') as NoticeSettings)}
  catch{status.textContent='通知の設定を確認できませんでした。'}
}

type Slot = {id:string;label:string;starts_at:string;remaining:number}
type Booking = {id:string;slot_id:string;party:number;status:string;revision:number;starts_at:string}
type Account = {revision:number;service_consent:boolean;marketing_consent:boolean;all_stop:boolean;policy_version:string;
  store:string;timezone:string;visits_enabled:boolean;slots:Slot[];bookings:Booking[]}
const bookingStates:Record<string,string>={pending:'仮受付',confirmed:'確定',cancelled:'取消',visited:'来店済',no_show:'不来店'}
async function accountRequest(path:string,method='GET',body?:unknown) {
  const response=await fetch('/api/v1/customer'+path,{method,headers:body?{'Content-Type':'application/json'}:{},
    body:body?JSON.stringify(body):undefined})
  const envelope=await response.json()
  if(!response.ok) throw new Error(envelope.message)
  return envelope
}
function item<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string) {
  const el=document.createElement(tag)
  if(text) el.textContent=text
  return el
}
function guarded(fn:()=>Promise<void>) {
  return async(event:Event)=>{
    event.preventDefault()
    const target=event.currentTarget
    const control=target instanceof HTMLFormElement?target.querySelector('button'):
      target instanceof HTMLButtonElement?target:null
    if(control) control.disabled=true
    try {await fn()} catch(error) {status.textContent=error instanceof Error?error.message:'処理できませんでした。'}
    finally {if(control) control.disabled=false}
  }
}
async function openCustomer() {
  await accountRequest('/login','POST',{connection,id_token:liff.getIDToken(),source})
  await drawAccount()
  await showWorkflowForm(accountRequest)
  document.querySelector<HTMLElement>('#customer')!.hidden=false
}
type FormField={key:string;label:string;kind:'text'|'long'|'choice'|'checkbox';required:boolean;options:string[]}
type PublishedForm={id:string;revision:number;title:string;description:string;submitted:boolean;fields:FormField[]}
async function showWorkflowForm(request:(path:string,method?:string,body?:unknown)=>Promise<unknown>){
  const region=document.querySelector<HTMLElement>('#workflow-form')!
  region.hidden=true
  region.replaceChildren()
  let page:PublishedForm|null
  try{page=await request('/form'+(formId?'?form='+encodeURIComponent(formId):'')) as PublishedForm|null}
  catch{status.textContent='回答フォームを読み込めませんでした。LINE内で開き直すと再試行できます。';return}
  if(!page){
    if(formId){region.append(item('p','この回答フォームは現在公開されていません。'));region.hidden=false}
    return
  }
  const published=page
  region.append(item('h2',page.title))
  if(page.description)region.append(item('p',page.description))
  region.hidden=false
  if(page.submitted){region.append(item('p','回答を送信済みです。'));return}
  const application=item('form')
  for(const field of page.fields){
    const label=item('label',field.label+(field.required?'（必須）':''))
    let control:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement
    if(field.kind==='choice'){
      const select=item('select')
      select.add(new Option('選択してください',''))
      for(const option of field.options)select.add(new Option(option,option))
      control=select
    }else if(field.kind==='long'){
      const input=item('textarea')
      input.maxLength=1000
      control=input
    }else{
      const input=item('input')
      input.type=field.kind==='checkbox'?'checkbox':'text'
      input.value=field.kind==='checkbox'?'yes':''
      input.maxLength=200
      control=input
    }
    control.name=field.key
    control.required=field.required
    label.append(control)
    application.append(label)
  }
  const submit=item('button','回答を送信')
  const result=item('p')
  result.setAttribute('role','status')
  application.append(submit,result)
  region.append(application)
  application.onsubmit=guarded(async()=>{
    const answers=Object.fromEntries(new FormData(application))
    try{
      await request('/form','POST',{form:published.id,revision:published.revision,answers})
      const success=item('p','回答を送信しました。')
      success.setAttribute('role','status')
      application.replaceWith(success)
    }catch(error){
      result.textContent=error instanceof Error?error.message:'回答を送信できませんでした。'
    }
  })
}
async function drawAccount(){
  const account:Account=await accountRequest('/account')
  document.querySelector('#store-name')!.textContent=account.store
  const date=(value:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:account.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value))
  const preferences=document.querySelector<HTMLFormElement>('#preferences')!
  const service=preferences.elements.namedItem('service') as HTMLInputElement
  const marketing=preferences.elements.namedItem('marketing') as HTMLInputElement
  const stop=preferences.elements.namedItem('stop') as HTMLInputElement
  service.checked=account.service_consent;marketing.checked=account.marketing_consent;stop.checked=account.all_stop
  stop.onchange=()=>{ if(stop.checked){service.checked=false;marketing.checked=false} }
  preferences.onsubmit=guarded(async()=>{
    await accountRequest('/preferences','PATCH',{version:account.policy_version,revision:account.revision,
      preferences:{service_consent:!stop.checked&&service.checked,marketing_consent:!stop.checked&&marketing.checked,all_stop:stop.checked}})
    await drawAccount()
    status.textContent='配信設定を保存しました。'
  })
  const reservation=document.querySelector<HTMLFormElement>('#reservation')!
  reservation.hidden=!account.visits_enabled
  const options=(select:HTMLSelectElement)=>{
    select.replaceChildren(new Option('空き枠を選択',''),...account.slots.filter(s=>s.remaining>0)
      .map(slot=>new Option(date(slot.starts_at)+' '+slot.label+'（残り '+slot.remaining+'人）',slot.id)))
  }
  options(reservation.elements.namedItem('slot') as HTMLSelectElement)
  reservation.onsubmit=guarded(async()=>{
    const data=new FormData(reservation)
    await accountRequest('/bookings','POST',{slot:data.get('slot'),party:Number(data.get('party'))})
    await drawAccount()
    status.textContent='仮受付を登録しました。確定は店舗が行います。'
  })
  const rows=document.querySelector('#my-bookings')!
  rows.replaceChildren()
  for (const booking of account.bookings) {
    const row=item('article')
    row.className='record'
    row.append(item('p',date(booking.starts_at)+' · '+booking.party+'名 · '+bookingStates[booking.status]))
    if (['pending','confirmed'].includes(booking.status)&&Date.parse(booking.starts_at)>Date.now()) {
      const cancel=item('button','この予約を取り消す')
      cancel.type='button'
      cancel.onclick=guarded(async()=>{
        if (!confirm('この予約を取り消しますか？')) return
        await accountRequest('/bookings/'+booking.id,'PATCH',{slot:booking.slot_id,party:booking.party,revision:booking.revision,status:'cancelled'})
        await drawAccount();status.textContent='予約を取り消しました。'
      })
      if (!account.visits_enabled) {
        rows.append(row)
        continue
      }
      const detail=item('details')
      detail.append(item('summary','日時・人数の変更を申し込む'))
      const change=item('form')
      const select=item('select')
      options(select)
      select.required=true
      if (!Array.from(select.options).some(option=>option.value===booking.slot_id)) {
        select.add(new Option(date(booking.starts_at)+'（現在の枠）',booking.slot_id))
      }
      select.value=booking.slot_id
      const party=item('input')
      party.type='number';party.min='1';party.max='200';party.required=true;party.value=String(booking.party)
      const dateLabel=item('label','変更先');dateLabel.append(select)
      const partyLabel=item('label','人数');partyLabel.append(party)
      change.append(dateLabel,partyLabel,item('button','変更を仮受付に戻す'))
      change.onsubmit=guarded(async()=>{
        await accountRequest('/bookings/'+booking.id,'PATCH',{slot:select.value,party:Number(party.value),revision:booking.revision,status:'pending'})
        await drawAccount();status.textContent='変更を仮受付しました。店舗の確定をお待ちください。'
      })
      detail.append(change)
      row.append(cancel,detail)
    }
    rows.append(row)
  }
  if(!rows.childElementCount) rows.append(item('p','予約はありません。'))
}
prepare().catch(error => { status.textContent = error instanceof Error ? error.message : '接続に失敗しました。' })
