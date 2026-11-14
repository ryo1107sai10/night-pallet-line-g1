const $ = selector => document.querySelector(selector)
const content = $('#content')
const notice = $('#notice')
const types = { customer:'顧客',recruitment:'採用',shared:'顧客・採用兼用' }
const roles = { admin:'法人管理者',manager:'店舗責任者',sales:'営業担当',recruiter:'採用担当',reporter:'閲覧担当' }
const sendStatus = { queued:'待機中',submitting:'LINEへ提出中',accepted:'LINE受付済',failed:'送信失敗',unknown:'結果不明',cancelled:'取消' }
const checks = {
  ownership_verified:'法人が所有する公式アカウントと管理権限を確認した',
  provider_verified:'Messaging APIとLINEログインが同じプロバイダー内にある',
  redelivery_enabled:'Webhookの再送を有効にした',
  auto_reply_checked:'既存ツールと公式管理画面の応答重複を確認した',
  login_published:'LINEログインチャネルを公開した',
  non_developer:'開発者権限のない利用者をテストに使用する',
  delivery_confirmed:'テスト利用者の端末でメッセージの受信を確認した',
}
let session
let storeId
let channelId
let view = 0

function el(tag, value, className) {
  const element = document.createElement(tag)
  if (value != null) element.textContent = value
  if (className) element.className = className
  return element
}

function feedback(message, error = false) {
  notice.textContent = message
  notice.classList.toggle('error',error)
}

function report(error) {
  feedback(error.message ?? '通信に失敗しました。',true)
}

async function api(path, method = 'GET', data, idem = false) {
  const headers = {}
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  if (idem) headers['Idempotency-Key'] = idem === true ? crypto.randomUUID() : idem
  const response = await fetch('/api/v1' + path,{ method,headers,body:data === undefined ? undefined : JSON.stringify(data) })
  if (response.status===401 && session && path!=='/auth/login') signedOut()
  const result = await response.json()
  if (!response.ok) {
    const fields = Object.keys(result.field_errors ?? {})
    throw Object.assign(new Error(result.message + (fields.length ? ' (' + fields.join(', ') + ')' : '')),
      { status:response.status })
  }
  return result
}

function bind(form, submit) {
  form.onsubmit = async event => {
    event.preventDefault()
    const button = form.querySelector('button[type=submit]')
    if (button) button.disabled = true
    const fields = Object.fromEntries(new FormData(form))
    try {
      const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(fields)))).join(',')
      if (form.attempt !== fingerprint) {
        form.attempt = fingerprint
        form.requestKey = crypto.randomUUID()
      }
      await submit(fields,form.requestKey)
    }
    catch (error) { report(error) }
    finally { if (button) button.disabled = false }
  }
}

function button(label, action, kind = 'secondary') {
  const control = el('button',label,kind)
  control.type = 'button'
  control.onclick = async () => {
    control.disabled = true
    try { await action() } catch (error) { report(error) } finally { control.disabled = false }
  }
  return control
}

function details(title, ...children) {
  const node = el('details')
  node.append(el('summary',title),...children)
  return node
}

function panel(title, ...children) {
  const section = el('section',null,'panel')
  section.append(el('h2',title),...children)
  return section
}

function status(value, on, bad = false) {
  return el('span',value,'status' + (on ? ' good' : bad ? ' bad' : ''))
}

function field(label, name, options = {}) {
  const holder = el('label',label,options.type==='checkbox' ? 'check' : '')
  const control = options.choices ? el('select') : el('input')
  control.name = name
  if (options.choices) {
    for (const [choice,value] of Object.entries(options.choices)) control.add(new Option(value,choice))
  } else control.type = options.type ?? 'text'
  if (options.type === 'checkbox') {
    control.checked = !!options.value
    holder.prepend(control)
  } else {
    control.value = options.value ?? control.value
    control.required = options.required ?? true
    holder.append(control)
  }
  return holder
}

function formOf(nodes, label, submit, kind = '') {
  const form = el('form')
  const control = el('button',label,kind)
  control.type = 'submit'
  form.append(...nodes,control)
  bind(form,submit)
  return form
}

function template(id, values = {}) {
  const fragment = $('#' + id).content.cloneNode(true)
  for (const node of fragment.querySelectorAll('[name]')) {
    if (values[node.name] != null) node.value = values[node.name]
  }
  return fragment
}

function date(value) {
  return new Intl.DateTimeFormat('ja-JP',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(value))
}

function signedOut() {
  session = undefined
  storeId = undefined
  channelId = undefined
  view++
  content.replaceChildren()
  $('#workspace').hidden = true
  $('#auth').hidden = false
  $('#account').textContent = ''
}

async function refresh() {
  session = await api('/session')
  $('#auth').hidden = true
  $('#workspace').hidden = false
  $('#account').textContent = roles[session.actor.role] + ' · ' + session.actor.email
  $('#tenant-name').textContent = session.tenant.legal_name
  if (!session.stores.some(store=>store.id===storeId)) storeId = session.stores[0]?.id
  await render()
}

async function change(path, method, data, message, idem = false) {
  await api(path,method,data,idem)
  await refresh()
  feedback(message)
}

function stopForm(path, entity, label) {
  const verb = entity.stopped ? '再開' : '停止'
  const form = formOf([field(verb+'理由','reason')],verb+'を確定',
    async ({reason})=>{
      const result = await api(path,'PATCH',{ reason,stopped:!entity.stopped,revision:entity.revision })
      await refresh()
      const detail = entity.stopped ? '' : '。未開始の取消 ' + result.cancelled + '件、提出処理中 ' + result.in_flight + '件'
      feedback(label+'を'+verb+'しました'+detail+'。')
    },entity.stopped ? '' : 'danger')
  return details(label+'を'+verb,form)
}

function auditPanel(path) {
  const wrap = el('div')
  const section = details('操作履歴',wrap)
  section.ontoggle = async () => {
    if (!section.open) return
    wrap.textContent = '読み込み中…'
    try {
      const entries = await api(path)
      wrap.replaceChildren(...entries.map(entry=>el('p',[
        date(entry.occurred_at),entry.operation,entry.actor,entry.reason,
      ].filter(Boolean).join(' · '),'record')))
      if (!entries.length) wrap.textContent = '履歴はまだありません。'
    } catch (error) { wrap.textContent = error.message }
  }
  return section
}

function teamPanel(staff) {
  const storeOptions = el('fieldset')
  storeOptions.append(el('legend','許可店舗'))
  for (const store of session.stores) storeOptions.append(field(store.name,store.id,{type:'checkbox'}))
  const result = el('pre')
  result.hidden = true
  const form = formOf([field('メールアドレス','email',{type:'email'}),
    field('役割','role',{choices:roles,value:'manager'}),storeOptions],'招待コードを発行',async (data,key)=>{
    const response = await api('/staff/invites','POST',{
      email:data.email,role:data.role,stores:session.stores.filter(store=>data[store.id]==='on').map(store=>store.id),
    },key)
    result.textContent = '招待コード　'+response.invite_code+'\n認証アプリ設定キー　'+response.setup_key+
      '\n期限（日本時間）　'+date(response.expires_at)
    result.hidden = false
    feedback('招待を発行しました。本人に安全な方法でお渡しください。')
    appendStaff(await api('/staff'))
  })
  const list = el('div')
  function appendStaff(records) {
    list.replaceChildren(...records.map(member=>{
      const row = el('div',null,'record')
      const state = member.disabled_at ? '無効' : member.activated ? '有効' : '招待中'
      row.append(el('p',member.email+' · '+roles[member.role]+' · '+state))
      if (member.id!==session.actor.id && !member.disabled_at) row.append(details('アカウントを無効化',
        formOf([field('無効化の理由','reason')],'セッションも失効',async ({reason})=>{
          await api('/staff/'+member.id+'/disable','POST',{reason})
          appendStaff(await api('/staff'))
          feedback('アカウントを無効化し、すべてのセッションを失効しました。')
        },'danger')))
      return row
    }))
  }
  appendStaff(staff)
  return panel('スタッフ招待と権限',details('スタッフを招待・再招待',form,result),details('スタッフ一覧',list))
}

function connectedPanel(base, c, testers) {
  const prefix = base + '/connections/' + c.id
  const box = el('div')
  box.append(status(c.status==='connected' ? '接続済' : '設定中',c.status==='connected'),
    status(c.stopped ? '配信停止中' : 'OA停止なし',false,c.stopped),
    el('p',types[c.purpose]+' · '+c.owner_name+' · '+c.account_type,'muted'))
  const urls = details('Webhook・LIFFの設定先',
    el('p','LINE DevelopersのWebhook URL欄に登録'),el('pre',c.webhook_url),
    el('p','LIFFアプリのエンドポイントURLに登録'),el('pre',c.liff_url))
  box.append(urls,el('p','設定記録を保存し、トークンとWebhookを確認してからテスト利用者を登録します。','muted'))
  const consoleInputs = Object.entries(checks).map(([key,label])=>field(label,key,{type:'checkbox',value:c.checks[key]}))
  box.append(details('公式管理画面で確認した項目',formOf([...consoleInputs,field('確認者・根拠','reason')],
    '確認内容を保存',async data=>{
      const values = Object.fromEntries(Object.keys(checks).map(key=>[key,data[key]==='on']))
      await change(prefix+'/console','PATCH',{...values,reason:data.reason,revision:c.revision},'確認内容を保存しました。')
    })))
  const steps = [
    ['トークンとボットの照合','token_verified','token'],
    ['Webhookの疎通','webhook_verified','webhook'],
    ['LIFF本人確認','liff_verified'],
    ['テスト利用者から受信','receive_verified'],
    ['LINEへのテスト送信受付','send_accepted'],
  ]
  for (const [label,key,action] of steps) {
    const row = el('div',null,'record actions')
    row.append(el('span',label),status(c.checks[key]?'確認済':'未確認',c.checks[key]))
    if (action) row.append(button('確認する',async ()=>{
      const updated = await api(prefix+'/check-'+action,'POST',{revision:c.revision})
      await refresh()
      feedback(updated.checks[key] ? label+'を確認しました。' : label+'を確認できません。設定を確認してください。',!updated.checks[key])
    }))
    box.append(row)
  }
  const invitation = el('pre')
  invitation.hidden = true
  const selected = c.purpose==='shared' ? {customer:'顧客',recruitment:'採用'} : {[c.purpose]:types[c.purpose]}
  const invite = formOf([field('テスト用途','purpose',{choices:selected})],'テストコードを発行',async (data,key)=>{
    const result = await api(prefix+'/tests','POST',data,key)
    invitation.textContent = 'LINE内で開くURL　'+result.liff_url+'\nテストコード　'+result.code+
      '\n期限（日本時間）　'+date(result.expires_at)
    invitation.hidden = false
    feedback('発行しました。テスト利用者にURLとコードを渡してください。')
  })
  const tests = details('テスト利用者の登録と送信',
    el('p','本人確認後、テスト利用者から公式アカウントへメッセージを1通送ってもらいます。'),
    invite,invitation,button('テストの進捗を更新',refresh))
  for (const tester of testers) {
    const row = el('div',null,'record')
    const active = Date.parse(tester.expires_at)>Date.now()
    row.append(el('p',types[tester.purpose]+' · '+(tester.verified_at?'本人確認済':'本人確認待ち')+
      ' · '+(tester.received?'受信済':'受信待ち')+' · '+(sendStatus[tester.send_status]??'未送信')))
    if (!tester.send_status && tester.received && active) {
      row.append(button('接続テストを1通送る',async ()=>{
        await change(prefix+'/tests/'+tester.id+'/send','POST',{},'テスト送信を受け付けました。進捗を更新して確認してください。',true)
      }))
    }
    tests.append(row)
  }
  box.append(tests,details('トークンとシークレットを交換',formOf([
    template('credentials-fields'),field('交換する理由','reason'),
  ],'交換して再検証へ',data=>change(prefix+'/credentials','PATCH',{...data,revision:c.revision},
    '認証情報を更新しました。再度、接続テストを実施してください。'))),stopForm(prefix+'/stop',c,'公式アカウントの配信'))
  return box
}

async function render() {
  const generation = ++view
  const admin = session.actor.role==='admin'
  const manage = admin || session.actor.role==='manager'
  const store = session.stores.find(item=>item.id===storeId)
  const base = store ? '/stores/'+store.id : ''
  const staffPromise = admin ? api('/staff') : Promise.resolve([])
  const connectionPromise = manage && store ? api(base+'/connections') : Promise.resolve([])
  const [staff,connections] = await Promise.all([staffPromise,connectionPromise])
  if (generation!==view) return
  if (!connections.some(item=>item.id===channelId)) channelId = connections[0]?.id
  const current = connections.find(item=>item.id===channelId)
  const testers = current ? await api(base+'/connections/'+current.id+'/tests') : []
  if (generation!==view) return
  const layout = el('div',null,'controls')
  const main = el('div')
  const side = el('div')
  const selector = field('操作する店舗','store',{
    choices:Object.fromEntries(session.stores.map(item=>[item.id,item.name])),value:storeId,
  })
  selector.querySelector('select').onchange = event => {
    storeId = event.target.value
    channelId = undefined
    render().catch(report)
  }
  const storePanel = panel('店舗',store ? selector : el('p','利用できる店舗がありません。'))
  if (store) {
    if (manage) storePanel.append(status(store.eligible_at?'適格性確認済':'適格性未確認',!!store.eligible_at),
      status(store.stopped?'配信停止中':'店舗停止なし',false,store.stopped))
    if (manage) storePanel.append(details('店舗設定を編集',
      formOf([template('store-fields',store)],'店舗設定を保存',
        data=>change(base,'PATCH',{...data,revision:store.revision},'店舗設定を保存しました。'))))
    if (admin) storePanel.append(details('店舗の利用適格性',formOf([
      field('許可・届出およびLINE利用条件を確認済み','verified',{type:'checkbox',value:store.eligible_at}),
      field('確認記録の参照番号または理由','reference'),
    ],'確認結果を保存',data=>change(base+'/eligibility','PATCH',{
      revision:store.revision,verified:data.verified==='on',reference:data.reference,
    },'適格性の確認結果を保存しました。'))))
    if (manage) storePanel.append(stopForm(base+'/stop',store,'店舗の配信'),auditPanel(base+'/audit'))
  }
  if (admin) storePanel.append(details('新しい店舗を登録',formOf([template('store-fields')],'店舗を登録',
    async (data,key)=>{
      const result = await api('/stores','POST',data,key)
      storeId = result.id
      await refresh()
      feedback('店舗を登録しました。')
    })))
  main.append(storePanel)
  if (manage && store) {
    const line = panel('LINE接続')
    if (current) {
      const picker = field('公式アカウント','channel',{
        choices:Object.fromEntries(connections.map(item=>[item.id,item.label])),value:current.id,
      })
      picker.querySelector('select').onchange = event => {
        channelId = event.target.value
        render().catch(report)
      }
      line.append(picker,connectedPanel(base,current,testers))
    } else line.append(el('p','この店舗に公式アカウントが登録されていません。'))
    const grid = el('div',null,'grid')
    grid.append(template('channel-fields'),template('credentials-fields'))
    line.append(details('公式アカウントを登録',formOf([grid],'接続情報を登録',async (data,key)=>{
      for (const key of ['existing_webhook','existing_tools']) if (!data[key]) delete data[key]
      const created = await api(base+'/connections','POST',data,key)
      channelId = created.id
      await refresh()
      feedback('接続情報を登録しました。')
    })))
    main.append(line)
  }
  if (admin) side.append(teamPanel(staff),panel('法人の配信管理',
    status(session.tenant.stopped?'配信停止中':'法人停止なし',false,session.tenant.stopped),
    stopForm('/tenant/stop',session.tenant,'法人の配信'),auditPanel('/tenant/audit')))
  layout.append(main,side)
  content.replaceChildren(layout)
}

$('#show-activate').onclick = () => {
  $('#login').hidden = true
  $('#activate').hidden = false
  $('#activate input').focus()
}
$('#show-login').onclick = () => {
  $('#activate').hidden = true
  $('#login').hidden = false
  $('#login input').focus()
}
$('#logout').onclick = async () => {
  try { await api('/auth/logout','POST',{}); signedOut(); feedback('ログアウトしました。') }
  catch (error) { report(error) }
}
bind($('#login'),async (data)=>{
  await api('/auth/login','POST',data)
  $('#login').reset()
  await refresh()
  feedback('')
})
bind($('#activate'),async (data)=>{
  await api('/auth/activate','POST',data)
  $('#activate').reset()
  $('#show-login').click()
  feedback('招待を有効にしました。次に表示される新しい認証コードでログインしてください。')
})
refresh().catch(error=>{ if (error.status!==401) report(error) })
