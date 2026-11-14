import liff from '@line/liff'

const status = document.querySelector<HTMLParagraphElement>('#status')!
const form = document.querySelector<HTMLFormElement>('#verify')!
const signin = document.querySelector<HTMLButtonElement>('#signin')!
const connection = location.pathname.split('/')[2]
const labels = { customer:'顧客', recruitment:'採用' }

async function prepare() {
  const response = await fetch('/api/v1/liff/' + encodeURIComponent(connection))
  const configuration = await response.json()
  if (!response.ok) throw new Error(configuration.message)
  try { await liff.init({ liffId:configuration.liff_id }) }
  catch { throw new Error('LINE公式アカウントから接続テスト画面を開き直してください。') }
  if (!liff.isLoggedIn()) {
    status.textContent = 'LINEでログインして本人確認を続けてください。'
    signin.hidden = false
    signin.onclick = () => liff.login({ redirectUri:location.origin + location.pathname })
    return
  }
  const select = form.elements.namedItem('purpose') as HTMLSelectElement
  for (const key of configuration.purposes as Array<keyof typeof labels>) select.add(new Option(labels[key],key))
  document.querySelector<HTMLElement>('#test-panel')!.hidden=false
  status.textContent = 'LINEでログインしました。'
  if (configuration.customer) {
    try { await openCustomer() } catch(error) {
      status.textContent=error instanceof Error?error.message:'顧客情報を開けませんでした。'
    }
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

type Slot = {id:string;label:string;starts_at:string;remaining:number}
type Booking = {id:string;slot_id:string;party:number;status:string;revision:number;starts_at:string}
type Account = {revision:number;service_consent:boolean;marketing_consent:boolean;all_stop:boolean;policy_version:string;
  store:string;timezone:string;slots:Slot[];bookings:Booking[]}
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
  await accountRequest('/login','POST',{connection,id_token:liff.getIDToken()})
  await drawAccount()
  document.querySelector<HTMLElement>('#customer')!.hidden=false
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
