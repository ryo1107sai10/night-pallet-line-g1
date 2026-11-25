import {mountTour} from '/static/tour.mjs'

const notice = document.querySelector('#notice')
const tenants = document.querySelector('#tenants')
const logout = document.querySelector('#logout')

async function platformApi(path,method = 'GET',data,idem) {
  const headers = {}
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  if (idem) headers['Idempotency-Key'] = idem
  const response = await fetch('/api/v1/platform'+path,method==='GET' ? {} : {
    method,headers,body:data === undefined ? '{}' : JSON.stringify(data),
  })
  const result = await response.json()
  if (response.status===401) location.replace('/platform/')
  if (!response.ok) throw new Error(result.message ?? '操作に失敗しました。')
  return result
}

function report(error) {
  notice.textContent = error.message
  notice.classList.add('error')
}
function element(tag,text,className) {
  const node=document.createElement(tag)
  if (text) node.textContent=text
  if (className) node.className=className
  return node
}

logout.onclick = async()=>{
  logout.disabled=true
  try {
    await platformApi('/logout','POST')
    location.replace('/platform/')
  } catch (error) { report(error) }
  finally { logout.disabled=false }
}

const tenantStages = {
  master_pending:'招待の有効化待ち',registered:'登録直後',setting:'設定中',verified:'LINE接続の確認済み',
}
const lineStages = {
  unknown:'状況未登録',uncreated:'LINE未開設',waiting:'店舗からの招待待ち',received:'招待を受領',
  setting:'設定中',verified:'送受信確認済み',
}
const date = value => new Intl.DateTimeFormat('ja-JP',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tokyo'})
  .format(new Date(value))

const registrationForm = document.querySelector('#registration-form')
let registrationKey
registrationForm.onsubmit = async event => {
  event.preventDefault()
  const button = registrationForm.querySelector('button[type=submit]')
  const data = Object.fromEntries(new FormData(registrationForm))
  const fingerprint = JSON.stringify(data)
  if (registrationForm.attempt !== fingerprint) {
    registrationForm.attempt = fingerprint
    registrationKey = crypto.randomUUID()
  }
  button.disabled = true
  try {
    const result = await platformApi('/registrations','POST',data,registrationKey)
    const out = document.querySelector('#registration-result')
    out.textContent = [
      '法人ID（ログイン用）　'+result.tenant.slug,
      '招待コード　'+result.invite.invite_code,
      '認証アプリ設定キー　'+result.invite.setup_key,
      '招待の期限（日本時間）　'+date(result.invite.expires_at),
      'ログイン画面　'+result.urls.master,
      'Webhook URL　'+result.urls.webhook_format,
      '',
      '招待コードと設定キーをエール担当者へ安全な方法で渡してください。',
      '担当者がログインすると、店舗のセットアップ手順が始まります。',
    ].join('\n')
    out.hidden = false
    notice.textContent = '登録しました。招待を発行しています。'
    notice.classList.remove('error')
    await loadProgress()
  } catch (error) { report(error) }
  finally { button.disabled = false }
}

const progressList = document.querySelector('#registration-progress')
async function loadProgress() {
  const tenants = await platformApi('/registrations/progress')
  progressList.replaceChildren(...tenants.map(entry=>{
    const row = element('li',null,'record')
    const head = element('div',null,'onboarding-store')
    head.append(element('strong',entry.tenant.legal_name),
      element('span','法人ID '+entry.tenant.slug,'muted'),
      element('span',tenantStages[entry.stage] ?? entry.stage,'status'+(entry.stage==='verified'?' good':'')))
    if (entry.master) head.append(element('span',
      'マスター '+entry.master.email+' · '+(entry.master.activated?'有効化済':'招待中'),'muted'))
    if(entry.master?.co_email)head.append(element('span','兼任マスター '+entry.master.co_email+' · 有効化済','muted'))
    row.append(head)
    for (const store of entry.stores) {
      const line = element('div',null,'onboarding-store')
      line.append(element('span',store.name),
        element('span','LINE: '+(lineStages[store.line_stage] ?? store.line_stage),'muted'),
        element('span',store.setup.completed ? 'セットアップ完了'
          : 'セットアップ '+store.setup.confirmed+'/'+store.setup.total,'muted'))
      row.append(line)
    }
    const form = document.createElement('form')
    const label = element('label','代表マスターに指定する有効な管理者のメールアドレス')
    const input = document.createElement('input')
    input.type = 'email'
    input.required = true
    input.maxLength = 254
    label.append(input)
    const submit = element('button','この人をマスターに指定')
    submit.type = 'submit'
    form.append(label,submit)
    form.onsubmit = async event => {
      event.preventDefault()
      if(!window.confirm('代表マスターを変更します。兼任マスターはそのままです。新しい招待や引き継ぎは「契約店舗の管理を開く」→「マスター管理・引き継ぎ」を使用できます。実行しますか？'))return
      submit.disabled = true
      try {
        const result = await platformApi('/registrations/'+entry.tenant.id+'/master','POST',{address:input.value})
        notice.textContent = result.changed
          ? '代表マスターを指定しました。交代対象の前任者のログインを終了しました。'
          : 'すでにその人がマスターです。'
        notice.classList.remove('error')
        await loadProgress()
      } catch (error) { report(error) }
      finally { submit.disabled = false }
    }
    row.append(form)
    return row
  }))
}
document.querySelector('#progress-refresh').onclick = () => loadProgress().catch(report)

try {
  const [{actor},records]=await Promise.all([platformApi('/session'),platformApi('/tenants')])
  document.querySelector('#account').textContent=actor.organization+' · '+actor.display_name
  if (!records.length) notice.textContent='管理を担当する会社が登録されていません。'
  else mountTour('platform',{enter:async()=>(await platformApi('/tenants/'+records[0].id+'/enter','POST')).url})
  for (const tenant of records) {
    const row=element('li',null,'record')
    const detail=element('div',null,'onboarding-store')
    detail.append(element('strong',tenant.legal_name),element('span',tenant.stores+'店舗 · 法人ID '+tenant.slug,'muted'))
    if (tenant.stopped) detail.append(element('span','配信停止中','status bad'))
    const open=element('button','契約店舗の管理を開く')
    open.type='button'
    open.onclick=async()=>{
      open.disabled=true
      try {
        const result=await platformApi('/tenants/'+tenant.id+'/enter','POST')
        location.assign(result.url)
      } catch (error) { report(error) }
      finally { open.disabled=false }
    }
    row.append(detail,open)
    tenants.append(row)
  }
  await loadProgress()
} catch (error) { report(error) }
