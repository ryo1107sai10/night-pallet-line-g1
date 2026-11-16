import {liffAppId,lineSetupLinks} from './line-setup.mjs'

const $ = selector => document.querySelector(selector)
const content = $('#content')
const notice = $('#notice')
const types = { customer:'顧客',recruitment:'採用',shared:'顧客・採用兼用' }
const roles = { admin:'法人管理者',manager:'店舗責任者',sales:'営業担当',recruiter:'採用担当',reporter:'閲覧担当' }
const featureNames = {
  tags_enabled:'顧客タグ', visits_enabled:'来店予約',
  guest_interviews_enabled:'ログイン不要の対面面談予約',
  interviews_enabled:'面談予約', google_calendar_enabled:'面談時にGoogleカレンダーを照合',
  forms_enabled:'回答フォーム', recruitment_enabled:'応募・選考管理', sources_enabled:'流入分析',
  campaigns_enabled:'絞り込み配信',
  rich_menus_enabled:'リッチメニュー切り替え', reminders_enabled:'面談リマインド', waitlist_enabled:'面談のキャンセル待ち',
  inbox_enabled:'LINE受信箱',
  interviewers_enabled:'担当者別の面談枠', google_write_enabled:'Googleカレンダーへの面談登録',
}
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
let storeId = new URLSearchParams(location.search).get('store')
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

function lineLink(label, href) {
  const link = el('a',label,'studio-link')
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function lineStep(title, instruction, links, ...fields) {
  const step = el('fieldset',null,'line-step')
  const actions = el('div',null,'actions')
  actions.append(...links)
  const grid = el('div',null,'grid')
  grid.append(...fields)
  step.append(el('legend',title),el('p',instruction,'muted'),actions,grid)
  return step
}

function lineRegistration(base) {
  const destinations = lineSetupLinks()
  const provider = lineLink('プロバイダー設定を開く',destinations.provider)
  const basics = lineLink('チャネル基本設定を開く',destinations.messagingBasics)
  const messaging = lineLink('Messaging API設定を開く',destinations.messagingSettings)
  const login = lineLink('LINEログインの基本設定を開く',destinations.loginBasics)
  const liff = lineLink('LIFF設定を開く',destinations.liff)
  const form = formOf([
    lineStep('公式アカウントとMessaging API',
      '未設定なら公式アカウント管理画面でMessaging APIを有効にします。チャネル基本設定からIDとシークレット、Messaging API設定からトークンを取得します。',
      [lineLink('LINE公式アカウント管理を開く',destinations.manager),provider,basics,messaging],
      template('messaging-fields'),template('credentials-fields')),
    lineStep('LINEログインとLIFF',
      '同じプロバイダーでLINEログインを選び、LIFFを追加または確認します。LIFF IDかLIFF URLを貼り付けると、ログインのチャネルIDも入力されます。',
      [login,liff],template('liff-fields')),
    lineStep('店舗での利用情報',
      'この店舗での用途と、公式アカウントの管理権限を記録します。',[],template('channel-fields')),
  ],'接続情報を登録',async (data,key)=>{
    data.liff_id = liffAppId(data.liff_id)
    if (!data.liff_id) throw new Error('LINE Developersで発行されたLIFF IDまたはLIFF URLを入力してください。')
    for (const optional of ['existing_webhook','existing_tools']) if (!data[optional]) delete data[optional]
    const created = await api(base+'/connections','POST',data,key)
    channelId = created.id
    if (['#line-setup','#line-register'].includes(location.hash)) history.replaceState(null,'','#line-connection')
    await refresh()
    feedback('接続情報を登録しました。WebhookとLIFFの設定に進んでください。')
  })
  const fields = form.elements
  function updateLinks() {
    const links = lineSetupLinks({provider_id:fields.provider_id.value,messaging_id:fields.messaging_id.value,
      login_id:fields.login_id.value})
    provider.href = links.provider
    basics.href = links.messagingBasics
    messaging.href = links.messagingSettings
    login.href = links.loginBasics
    liff.href = links.liff
    messaging.hidden = links.messagingSettings===links.messagingBasics
    basics.textContent = messaging.hidden ? 'LINE Developersでチャネルを選ぶ' : 'チャネル基本設定を開く'
    liff.hidden = links.liff===links.loginBasics
    login.textContent = liff.hidden ? 'LINEログインチャネルを選ぶ' : 'LINEログインの基本設定を開く'
  }
  fields.liff_id.addEventListener('input',()=>{
    const id = liffAppId(fields.liff_id.value)
    if (id) fields.login_id.value = id.split('-')[0]
  })
  form.addEventListener('input',updateLinks)
  updateLinks()
  return form
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
  $('#manage-line').hidden = session.actor.role!=='admin'
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
  if (c.module_channel_id) return moduleConnection(base,c,testers)
  const prefix = base + '/connections/' + c.id
  const box = el('div')
  box.id = 'line-connection'
  box.append(status(c.status==='connected' ? '接続済' : '設定中',c.status==='connected'),
    status(c.stopped ? '配信停止中' : 'OA停止なし',false,c.stopped),
    el('p',types[c.purpose]+' · '+c.owner_name+' · '+c.account_type,'muted'))
  const links = lineSetupLinks(c)
  const urls = details('Webhook・LIFFの設定先',
    connectionSetting('Webhook URL',c.webhook_url,'Webhook設定を開く',links.messagingSettings),
    connectionSetting('LIFF エンドポイントURL',c.liff_url,'LIFFアプリ設定を開く',links.liffEdit))
  urls.open = c.status!=='connected'
  const shortcuts = el('div',null,'actions')
  shortcuts.append(lineLink('Messaging API設定を開く',links.messagingSettings),
    lineLink('LIFFアプリ設定を開く',links.liffEdit))
  box.append(shortcuts,urls,el('p','設定記録を保存し、トークンとWebhookを確認してからテスト利用者を登録します。','muted'))
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

function moduleConnect(base, configured) {
  const box = el('section',null,'line-setting')
  box.append(el('h3','公式LINEのかんたん連携'))
  if (!configured) {
    const start = el('button','公式LINEを連携')
    start.disabled = true
    box.append(el('p','かんたん連携は準備中です。手動設定から公式LINEを登録できます。','muted'),start)
    return box
  }
  const purpose = field('この店舗での用途','purpose',{choices:types,value:'recruitment'})
  box.append(el('p','LINEの画面で、対象の公式アカウントへの接続を許可してください。','muted'),
    formOf([purpose],'公式LINEを連携',async data=>{
      const result = await api(base+'/line-module','POST',data)
      location.assign(result.url)
    }))
  return box
}

function moduleConnection(base,c,testers) {
  const prefix = base+'/connections/'+c.id
  const box = el('div')
  box.id = 'line-connection'
  const states = {attached:'連携済み・受信確認待ち',active:'連携済み',
    standby:'LINE側で待機中',detached:'LINE側で連携解除済み',suspended:'LINE側で利用停止中'}
  box.append(status(states[c.module_status],['attached','active'].includes(c.module_status)),
    el('p',types[c.purpose]+' · '+c.basic_id,'muted'))
  if (c.module_status==='standby') {
    box.append(el('p','運営者に、LINE側でこのサービスがメッセージを送信できる状態か確認を依頼してください。','muted'))
  }
  if (c.module_status==='detached' || c.module_status==='suspended') return box
  box.append(status(c.checks.webhook_verified?'受信確認済み':'受信確認待ち',c.checks.webhook_verified),
    status(c.checks.delivery_confirmed?'端末での受信確認済み':'端末での受信確認待ち',c.checks.delivery_confirmed))
  if (!c.checks.token_verified) box.append(button('LINEとの接続を確認',async()=>{
    const updated = await api(prefix+'/check-token','POST',{revision:c.revision})
    await refresh()
    feedback(updated.checks.token_verified?'LINEとの接続を確認しました。':'LINEとの接続を確認できませんでした。',
      !updated.checks.token_verified)
  }))
  const invitation = el('pre')
  invitation.hidden = true
  const usage = c.purpose==='shared'?{customer:types.customer,recruitment:types.recruitment}:{[c.purpose]:types[c.purpose]}
  const invite = formOf([field('テスト用途','purpose',{choices:usage})],'テスト用メッセージを発行',async(data,key)=>{
    const result = await api(prefix+'/tests','POST',data,key)
    invitation.textContent = '公式アカウントに次の1行を送信してください。\n接続テスト '+result.code
    invitation.hidden = false
  })
  const tests = details('送受信テスト',el('p','テスト用メッセージを公式LINEに送り、続けて「動作確認」と送信してください。'),
    lineLink('公式LINEを開く','https://line.me/R/ti/p/'+encodeURIComponent(c.basic_id)),invite,invitation,
    button('テストの進捗を更新',refresh))
  tests.open = !c.checks.delivery_confirmed
  for (const tester of testers) {
    const row = el('div',null,'record')
    row.append(el('p',(tester.received?'受信済み':'受信待ち')+' · '+(sendStatus[tester.send_status]??'未送信')))
    if (!tester.send_status && tester.received && Date.parse(tester.expires_at)>Date.now() && c.module_status==='active') {
      row.append(button('テストを1通送る',async()=>{
        await change(prefix+'/tests/'+tester.id+'/send','POST',{},'テストメッセージを送信待ちにしました。',true)
      }))
    }
    tests.append(row)
  }
  if (c.checks.send_accepted && !c.checks.delivery_confirmed && c.module_status==='active') {
    tests.append(button('端末に届いたことを確認',async()=>{
      await change(prefix+'/module-delivery','POST',{revision:c.revision},'送受信の確認を記録しました。')
    }))
  }
  box.append(tests,el('p','LINE内の本人確認を使う応募・予約には、LIFFの設定が別途必要です。','muted'),
    stopForm(prefix+'/stop',c,'公式アカウントの配信'))
  return box
}

function connectionSetting(label,value,linkLabel,href) {
  const row = el('section',null,'line-setting')
  const actions = el('div',null,'actions')
  actions.append(button(label+'をコピー',async ()=>{
    await navigator.clipboard.writeText(value)
    feedback(label+'をコピーしました。')
  }),lineLink(linkLabel,href))
  row.append(el('h3',label),el('pre',value),actions)
  return row
}

const onboardingStages = {
  unknown:'状況未登録',uncreated:'未開設',waiting:'招待待ち',received:'招待を受領',
  setting:'設定中',verified:'送受信確認済み',
}
const onboardingModes = {
  create:'公式LINEがまだない',
  managed:'公式LINEがあり、管理権限がある',
  invite:'公式LINEがあり、店舗からの招待が必要',
}

function onboardingPatch(base,detail,action,message) {
  return change(base+'/line-onboarding','PATCH',{...action,revision:detail.revision},message)
}

function onboardingPanel(stores,selected,detail,connections) {
  const panel = details('公式LINEを設定する')
  panel.id = 'line-setup'
  panel.className = 'panel line-onboarding'
  panel.open = location.hash==='#line-setup' || $('#line-setup.line-onboarding')?.open || false
  if (!selected) {
    panel.append(el('p','管理画面で店舗を登録すると、公式LINEの初期設定を始められます。'))
    return panel
  }
  const next = el('section',null,'onboarding-next')
  const base = '/stores/'+selected.id
  const destinations = lineSetupLinks()
  const item = stores.find(store=>store.id===selected.id)
  const headline = el('div',null,'heading')
  headline.append(el('h3',selected.name),status(onboardingStages[item.stage],item.stage==='verified'))
  next.append(headline)
  const actions = el('div',null,'actions')
  const mode = formOf([field('公式LINEの状況','mode',{choices:{'':'選択してください',...onboardingModes},value:detail.mode??''})],
    '対応方法を保存',data=>onboardingPatch(base,detail,{action:'set-mode',mode:data.mode},'この店舗の対応方法を保存しました。'))
  if (item.stage==='unknown') next.append(mode)
  else {
    if (item.stage==='uncreated') {
      next.append(el('p','LINEの開設が済んだら、管理権限を確認して接続情報の登録へ進んでください。'))
      actions.append(lineLink('LINE公式の開設画面を開く ↗',destinations.create),
        button('開設・管理権限を確認した',()=>onboardingPatch(base,detail,{action:'set-mode',mode:'managed'},'接続情報の登録へ進んでください。')))
    } else if (detail.mode==='invite') {
      next.append(el('p','店舗に案内リンクを渡し、LINE公式側で管理者として招待してもらいます。'))
      if (detail.guide) {
        const copy = el('div',null,'actions onboarding-copy')
        const input = el('input')
        input.value = detail.guide.url
        input.readOnly = true
        input.setAttribute('aria-label','店舗に渡す案内リンク')
        copy.append(input,button('案内リンクをコピー',async()=>{
          try {
            await navigator.clipboard.writeText(input.value)
            feedback('案内リンクをコピーしました。店舗へ渡してください。')
          } catch {
            input.select()
            feedback('表示したリンクをコピーして店舗へ渡してください。')
          }
        }))
        next.append(copy,el('p','店舗向け案内の有効期限 '+date(detail.guide.expires_at),'muted'))
      }
      if (detail.invitation) {
        actions.append(lineLink('店舗から届いた招待URLを開く ↗',detail.invitation))
      } else if (detail.invitation_received_at) {
        next.append(el('p','招待URLの受け取りから24時間が過ぎました。店舗へ新しい招待URLを依頼してください。','muted'))
      }
      const issue = detail.guide ? details('案内リンクを再発行する',
        el('p','前の案内リンクが失効します。届いている招待URLがあれば、店舗に再発行を依頼してください。'),
        button('再発行する',()=>onboardingPatch(base,detail,{action:'issue-guide'},'新しい案内リンクを発行しました。'))) :
        button('店舗向けの案内リンクを発行',()=>onboardingPatch(base,detail,{action:'issue-guide'},'店舗向けの案内リンクを発行しました。'))
      actions.append(issue,button('進捗を更新',refresh))
    } else {
      if (item.next_connection) actions.append(onboardingLink(item.stage==='verified'?'接続の詳細を開く':'接続確認へ進む',item,'line-connection'))
      actions.append(lineLink('LINE公式の管理画面を開く ↗',destinations.manager),
        onboardingLink('接続情報を登録する',item,'line-register'))
    }
    next.append(actions)
    if (detail.mode==='invite') {
      const confirmFields = connections.length ? [field('確認した公式LINE','connection',{
        choices:{'':'このあと新しく登録する',...Object.fromEntries(connections.map(c=>[c.id,c.label]))},
        required:false,
      })] : []
      const confirm = formOf(confirmFields,'管理権限を確認した',data=>onboardingPatch(base,detail,
        {action:'confirm-access',connection:data.connection||null},'管理権限の確認を記録しました。'))
      next.append(details('LINE側で管理権限を確認できた方',confirm))
    }
    next.append(details('対応方法を変更',mode))
  }
  panel.append(next)
  const list = el('ul',null,'onboarding-list')
  for (const store of stores) {
    const row = el('li',null,'record')
    const name = el('div',null,'onboarding-store')
    name.append(el('strong',store.name),status(onboardingStages[store.stage],store.stage==='verified'))
    if (store.connections>1) name.append(el('span',' '+store.verified+'/'+store.connections+'件確認済み','muted'))
    const labels = {unknown:'手順を選ぶ',uncreated:'開設を進める',waiting:'招待の案内を開く',
      received:'届いた招待を確認',setting:store.next_connection?'接続確認へ進む':'接続情報を登録する',
      verified:'接続の詳細を開く'}
    const step = store.stage==='setting' ? (store.next_connection?'line-connection':'line-register') :
      store.stage==='verified' ? 'line-connection' : 'line-setup'
    row.append(name,onboardingLink(labels[store.stage],store,step))
    list.append(row)
  }
  panel.append(el('h3','店舗ごとの進捗'),list)
  return panel
}

function onboardingLink(label,store,anchor) {
  const link = el('a',label,'studio-link')
  const params = new URLSearchParams({store:store.id})
  if (anchor==='line-connection' && store.next_connection) params.set('line_channel',store.next_connection)
  link.href = '/?'+params+'#'+anchor
  return link
}

function revealLineAnchor() {
  if (!['#line-setup','#line-register','#line-connection'].includes(location.hash)) return
  const target = $(location.hash)
  if (target instanceof HTMLDetailsElement) target.open = true
  target?.scrollIntoView()
}

window.addEventListener('hashchange',revealLineAnchor)

async function render() {
  const generation = ++view
  const admin = session.actor.role==='admin'
  const manage = admin || session.actor.role==='manager'
  const store = session.stores.find(item=>item.id===storeId)
  const base = store ? '/stores/'+store.id : ''
  const staffPromise = admin ? api('/staff') : Promise.resolve([])
  const onboardingList = admin ? api('/line-onboarding') : Promise.resolve([])
  const onboardingItem = admin && store ? api(base+'/line-onboarding') : Promise.resolve(null)
  const connectionPromise = manage && store ? api(base+'/connections') : Promise.resolve([])
  const modulePromise = manage && store ? api(base+'/line-module') : Promise.resolve(null)
  const featurePromise = admin && store ? api(base+'/features') : Promise.resolve(null)
  const [staff,connections,features,module,onboarding,detail] = await Promise.all([
    staffPromise,connectionPromise,featurePromise,modulePromise,onboardingList,onboardingItem,
  ])
  if (generation!==view) return
  const url = new URL(location.href)
  const linked = connections.find(item=>item.id===url.searchParams.get('line_connected')&&item.module_channel_id)
  url.searchParams.delete('line_connected')
  const requestedChannel = connections.find(item=>item.id===url.searchParams.get('line_channel'))
  url.searchParams.delete('line_channel')
  if (linked || requestedChannel) channelId = (linked ?? requestedChannel).id
  if (!connections.some(item=>item.id===channelId)) channelId = connections[0]?.id
  const current = connections.find(item=>item.id===channelId)
  const testers = current ? await api(base+'/connections/'+current.id+'/tests') : []
  if (generation!==view) return
  if (store) url.searchParams.set('store',store.id)
  else url.searchParams.delete('store')
  history.replaceState(null,'',url)
  $('#manage-interviews').href = '/interview/staff.html'+(store ? '?store='+encodeURIComponent(store.id) : '')
  $('#manage-operations').href = '/operations/'+(store ? '?store='+encodeURIComponent(store.id) : '')
  $('#manage-workflows').href = '/workflows/'+(store ? '?store='+encodeURIComponent(store.id) : '')
  const layout = el('div',null,'controls')
  const main = el('div')
  const side = el('div')
  const selector = field('操作する店舗','store',{
    choices:Object.fromEntries(session.stores.map(item=>[item.id,item.name])),value:storeId,
  })
  selector.querySelector('select').onchange = async event => {
    const select = event.target
    const previousChannel = channelId
    storeId = select.value
    channelId = undefined
    content.inert = true
    $('#workspace .actions').inert = true
    feedback('')
    try { await render() }
    catch (error) {
      if (session) {
        storeId = store.id
        channelId = previousChannel
        select.value = store.id
      }
      report(error)
    } finally {
      content.inert = false
      $('#workspace .actions').inert = false
    }
  }
  const storePanel = panel('店舗',store ? selector : el('p','利用できる店舗がありません。'))
  if (store) {
    if (manage) storePanel.append(status(store.eligible_at?'適格性確認済':'適格性未確認',!!store.eligible_at),
      status(store.stopped?'配信停止中':'店舗停止なし',false,store.stopped))
    if (manage) storePanel.append(details('店舗設定を編集',
      formOf([template('store-fields',store)],'店舗設定を保存',
        data=>change(base,'PATCH',{...data,revision:store.revision},'店舗設定を保存しました。'))))
    if (features) storePanel.append(details('店舗で使う機能',
      el('p','Googleカレンダーの照合をオフにすると、Googleの予定を空き枠の判定に使いません。','muted'),
      formOf(Object.entries(featureNames).map(([key,label])=>field(label,key,{type:'checkbox',value:features[key]})),
        '機能設定を保存',async data=>{
          const settings=Object.fromEntries(Object.keys(featureNames).map(key=>[key,data[key]==='on']))
          await change(base+'/features','PATCH',{...settings,revision:features.revision},'この店舗の機能設定を保存しました。')
        }),
      el('p','LINE自動配信は「顧客・予約 → 自動配信」で店舗ごとに設定できます。','muted')))
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
    if (module.configured || !admin) {
      const connect = moduleConnect(base,module.configured)
      if (!admin) connect.id = 'line-setup'
      line.append(connect)
    }
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
    const registration = details('公式LINEの接続情報を登録',lineRegistration(base))
    registration.id = 'line-register'
    registration.open = location.hash==='#line-register' ||
      !admin && !module.configured && (!current || location.hash==='#line-setup')
    line.append(registration)
    main.append(line)
  }
  if (admin) side.append(teamPanel(staff),panel('法人の配信管理',
    status(session.tenant.stopped?'配信停止中':'法人停止なし',false,session.tenant.stopped),
    stopForm('/tenant/stop',session.tenant,'法人の配信'),auditPanel('/tenant/audit')))
  layout.append(main,side)
  content.replaceChildren(...(admin ? [onboardingPanel(onboarding,store,detail,connections),layout] : [layout]))
  if (linked) feedback(linked.label+'を連携しました。')
  revealLineAnchor()
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
