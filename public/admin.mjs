import {workspace,workspacePath,scopeWorkspaceLinks} from '/static/workspace-path.mjs'
import {lineSetupLinks,lineConsoleId,lineBasicId} from './line-setup.mjs'
import {mountDashboard} from '/static/dashboard.mjs'

const $ = selector => document.querySelector(selector)
const masterEntry = /^\/master\/?$/i.test(location.pathname)
const platformEntry = /^\/platform\/?$/i.test(location.pathname)
const loginPath = platformEntry ? '/auth/platform/login' : masterEntry ? '/auth/master/login' : '/auth/login'
scopeWorkspaceLinks()
if (platformEntry) $('#login h1').textContent = '管理会社の監督画面にログイン'
const content = $('#content')
const notice = $('#notice')
const types = { customer:'顧客',recruitment:'採用',shared:'顧客・採用兼用' }
const roles = { admin:'管理会社マスター',manager:'管理会社の運用担当',sales:'営業担当',recruiter:'採用担当',reporter:'閲覧担当' }
const staffRoles = Object.fromEntries(Object.entries(roles).filter(([role])=>role!=='admin'))
const featureNames = {
  tags_enabled:'顧客タグ', visits_enabled:'来店予約',
  guest_interviews_enabled:'ログイン不要の対面面談予約',
  token_interviews_enabled:'LINEトークからの面談予約',
  token_customers_enabled:'LINEトークからの来店予約・設定',
  interviews_enabled:'面談予約', google_calendar_enabled:'面談時にGoogleカレンダーを照合',
  forms_enabled:'回答フォーム', recruitment_enabled:'応募・選考管理', sources_enabled:'流入分析',
  campaigns_enabled:'絞り込み配信',
  rich_menus_enabled:'リッチメニュー切り替え', reminders_enabled:'面談リマインド', waitlist_enabled:'面談のキャンセル待ち',
  inbox_enabled:'LINE受信箱',
  interviewers_enabled:'担当者別の面談枠', google_write_enabled:'Googleカレンダーへの面談登録',
}
const featureGuides = {
  tags_enabled:'友だちを条件で分類します。絞り込み配信や流入分析の土台になります。',
  visits_enabled:'お客様がLINEから来店予約を入れられるようにします。',
  interviews_enabled:'応募者が公開された面談枠を選んで予約できるようにします。',
  google_calendar_enabled:'面談枠の空き判定に、Googleカレンダーの予定を照合します。',
  forms_enabled:'応募・来店の前後で必要な情報をフォームで集めます。',
  recruitment_enabled:'応募者の選考状況を店舗で管理します。',
  sources_enabled:'どの経路から友だち追加や応募があったかを記録します。',
  campaigns_enabled:'タグなどの条件で対象を絞って配信します。',
  rich_menus_enabled:'予約の有無などに応じてリッチメニューを切り替えます。',
  reminders_enabled:'面談の前日・当日にLINEでリマインドを送ります。',
  waitlist_enabled:'満員の面談枠にキャンセル待ちを登録できるようにします。',
  inbox_enabled:'お客様とのトークを管理画面で確認し、返信します。',
  interviewers_enabled:'担当者ごとに面談枠を分けて管理します。',
  google_write_enabled:'確定した面談をGoogleカレンダーへ登録します。',
  guest_interviews_enabled:'ログイン不要の対面面談予約を受け付けます。',
  token_interviews_enabled:'LINEトークで送る専用URLから面談予約を受け付けます。',
  token_customers_enabled:'LINEトークで送る専用URLから来店予約と通知設定を受け付けます。',
}
const featureBilling = new Set(['campaigns_enabled','reminders_enabled','token_interviews_enabled','token_customers_enabled'])
const sendStatus = { queued:'待機中',submitting:'LINEへ提出中',accepted:'LINE受付済',failed:'送信失敗',unknown:'結果不明',cancelled:'取消' }
const checks = {
  ownership_verified:'法人が所有する公式アカウントと管理権限を確認した',
  provider_verified:'Messaging APIが法人のプロバイダー内にある',
  redelivery_enabled:'Webhookの再送を有効にした',
  auto_reply_checked:'既存ツールと公式管理画面の応答重複を確認した',
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
  const response = await fetch(workspacePath('/api/v1'+path),{ method,headers,body:data === undefined ? undefined : JSON.stringify(data) })
  if (response.status===401 && session && path!==loginPath) signedOut()
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

function lineShortcut(label,description,href) {
  const link=lineLink('',href)
  link.classList.add('line-shortcut')
  link.append(el('strong'),el('small'))
  updateShortcut(link,label,description,href)
  return link
}

function updateShortcut(link,label,description,href){
  link.href=href
  link.querySelector('strong').textContent=label+' ↗'
  link.querySelector('small').textContent=description
  link.setAttribute('aria-label',label+'（別タブで開く）')
}

function lineShortcutGrid(...links){
  const grid=el('div',null,'line-quick-grid')
  grid.append(...links)
  return grid
}

const mobileLineHelp='スマートフォンでも各リンクはブラウザーで開けます。Messaging APIの有効化はLINE公式のWeb管理画面（PC版）の機能です。スマホで設定が表示されない場合はPC用サイト表示、またはパソコンから続けてください。'

function basicIdField(value=''){
  const label=el('label','公式LINEの@ID または管理画面URL（任意）','line-full-field')
  const input=el('input')
  input.type='text'
  input.autocomplete='off'
  input.autocapitalize='off'
  input.spellcheck=false
  input.placeholder='@123abcd または LINE公式の管理画面URL'
  input.value=lineBasicId(value)
  label.append(input,el('small','入力すると対象公式LINEの設定ページへ直接移動できます。','muted'))
  // This is only a navigation hint, not connection credentials or form data.
  return {label,input}
}

function lineStep(title, instruction, links, ...fields) {
  const step = el('fieldset',null,'line-step')
  const actions = lineShortcutGrid(...links)
  const grid = el('div',null,'grid')
  grid.append(...fields)
  step.append(el('legend',title),el('p',instruction,'muted'),actions,grid)
  return step
}

function lineRegistration(base) {
  const destinations = lineSetupLinks()
  const {label:basicField,input:basic}=basicIdField()
  const manager=lineShortcut('Messaging APIを有効にする','公式LINEの管理画面から開始',destinations.manager)
  const provider = lineShortcut('プロバイダーIDを確認','プロバイダーの設定画面',destinations.provider)
  const basics = lineShortcut('チャネルID・シークレットを確認','チャネル基本設定',destinations.messagingBasics)
  const secretLink = lineShortcut('チャネルシークレットを取得','チャネル基本設定',destinations.messagingBasics)
  const messaging = lineShortcut('アクセストークンを確認・発行','Messaging API設定',destinations.messagingSettings)
  const webhook = lineShortcut('Webhook設定を開く','接続情報を登録した後に使用',destinations.messagingSettings)
  const form = formOf([
    el('div',mobileLineHelp,'line-device-note'),
    lineStep('1　公式LINEの管理画面を開く',
      '既存の公式LINEを選び、設定 → Messaging API で利用状況を確認します。アカウントがない場合のみ新規作成してください。',
      [manager,lineShortcut('LINE公式アカウント一覧','管理しているアカウントを選択',destinations.manager),
        lineShortcut('公式LINEを新規作成','まだ公式LINEがない場合',destinations.create),
        lineShortcut('公式の有効化手順','画像付きマニュアル',destinations.enableHelp)],basicField),
    lineStep('2　プロバイダーとチャネルを確認',
      '同じLINEアカウントでDevelopersにログインします。プロバイダー設定とチャネル基本設定のIDをコピーしてください。設定画面のURLをそのまま貼り付けてもIDを取り出します。',
      [lineShortcut('LINE Developersを開く','プロバイダー・チャネル一覧',destinations.console),provider,basics],
      template('messaging-fields')),
    lineStep('3　接続に必要な情報を取得',
      'チャネル基本設定の「チャネルシークレット」とMessaging API設定の「チャネルアクセストークン」を下の専用欄へ貼り付けます。既に有効なトークンの再発行は、他の連携ツールに影響するため必要な場合だけ行ってください。',
      [secretLink,messaging,lineShortcut('シークレットの確認方法','LINE公式マニュアル',destinations.secretHelp),
        lineShortcut('トークンの発行方法','LINE公式マニュアル',destinations.tokenHelp)],template('credentials-fields')),
    lineStep('4　店舗での利用情報',
      'この店舗での用途と、公式アカウントの管理権限を記録します。',[],template('channel-fields')),
    lineStep('5　登録後にWebhookを設定',
      '下の「接続情報を登録」を押すと、この店舗専用のWebhook URLを発行します。登録完了後にURLをコピーし、LINE側で検証とWebhook利用を有効にします。',
      [webhook,lineShortcut('Webhook・応答設定の公式手順','設定と動作確認',destinations.webhookHelp)]),
  ],'接続情報を登録',async (data,key)=>{
    data.provider_id=lineConsoleId(data.provider_id,'provider')
    data.messaging_id=lineConsoleId(data.messaging_id,'channel')
    if(!data.provider_id||!data.messaging_id)throw new Error('プロバイダーIDとチャネルIDは、数字またはLINE Developersの該当設定画面URLを入力してください。')
    for (const optional of ['existing_webhook','existing_tools']) if (!data[optional]) delete data[optional]
    const created = await api(base+'/connections','POST',data,key)
    channelId = created.id
    if (['#line-setup','#line-register'].includes(location.hash)) history.replaceState(null,'','#line-connection')
    await refresh()
    feedback('接続情報を登録しました。Webhookの設定に進んでください。')
  })
  const fields = form.elements
  function updateLinks() {
    const links = lineSetupLinks({basic_id:basic.value,provider_id:fields.provider_id.value,messaging_id:fields.messaging_id.value})
    updateShortcut(manager,'Messaging APIを有効にする',links.hasBasic?'対象の公式LINEのMessaging API設定':'公式LINE一覧 → 対象の店舗 → 設定',links.managerMessaging)
    updateShortcut(provider,'プロバイダーIDを確認',links.hasProvider?'対象プロバイダーの設定':'未入力：プロバイダーを選択',links.provider)
    updateShortcut(basics,'チャネルID・シークレットを確認',links.hasMessaging?'対象チャネルの基本設定':'未入力：対象チャネルを選択',links.messagingBasics)
    updateShortcut(secretLink,'チャネルシークレットを取得',links.hasMessaging?'対象チャネルの基本設定':'未入力：対象チャネルを選択',links.messagingBasics)
    updateShortcut(messaging,'アクセストークンを確認・発行',links.hasMessaging?'対象チャネルのMessaging API設定':'未入力：チャネル選択後、Messaging API設定',links.messagingSettings)
    updateShortcut(webhook,'Webhook設定を開く',links.hasMessaging?'対象チャネルのMessaging API設定':'未入力：対象チャネルを選択',links.messagingSettings)
  }
  form.addEventListener('input',updateLinks)
  for(const [name,type] of [['provider_id','provider'],['messaging_id','channel']]){
    fields[name].addEventListener('change',()=>{
      const id=lineConsoleId(fields[name].value,type)
      if(id)fields[name].value=id
      updateLinks()
    })
  }
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
  $('#operations-dashboard')?.replaceChildren()
  $('#workspace').hidden = true
  $('#auth').hidden = false
  $('#account').textContent = ''
}

async function refresh() {
  session = await api('/session')
  $('#auth').hidden = true
  $('#workspace').hidden = false
  $('#manage-line').hidden = session.actor.role!=='admin'
  $('#manage-line').href = session.actor.platform?'#quick-line':'#line-setup'
  $('#back-to-platform').hidden = !session.actor.platform
  $('#account').textContent = (session.actor.platform?'監督者':roles[session.actor.role]) + ' · ' + session.actor.email
  $('#tenant-name').textContent = session.tenant.legal_name
  const dashboard=$('#operations-dashboard')
  if(dashboard&&['admin','manager','recruiter'].includes(session.actor.role))mountDashboard(dashboard,()=>api('/dashboard'))
  if (!session.stores.some(store=>store.id===storeId)) storeId = session.stores[0]?.id
  await render()
  if(session?.actor.platform)(await import('/static/tour.mjs')).mountTour('master')
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
    field('役割','role',{choices:staffRoles,value:'manager'}),storeOptions],'招待コードを発行',async (data,key)=>{
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
      const state = member.disabled_at ? '無効' :
        member.role==='admin' && member.id!==session.actor.id ? 'マスター権限なし' :
        !member.agency_access ? '管理会社スタッフの権限なし' : member.activated ? '有効' : '招待中'
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
  return panel('管理会社スタッフの招待と権限',
    el('p','この招待は管理会社の担当者に使用します。店長には、店舗のLINE公式アカウント側でチャットの権限を付与してください。'),
    details('管理会社スタッフを招待・再招待',form,result),details('スタッフ一覧',list))
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
  const urlSettings = [connectionSetting('Webhook URL',c.webhook_url,'Webhook設定を開く',links.messagingSettings)]
  const urls = details('Webhookの設定先',...urlSettings)
  urls.open = c.status!=='connected'
  const shortcuts = el('div',null,'actions')
  shortcuts.append(lineLink('チャネルID・シークレットを確認',links.messagingBasics),
    lineLink('アクセストークン・Webhook設定',links.messagingSettings),
    lineLink('応答設定の公式手順',links.responseHelp))
  box.append(shortcuts,urls,el('p','設定記録を保存し、トークンとWebhookを確認してからテスト利用者を登録します。','muted'))
  const consoleInputs = Object.entries(checks)
    .map(([key,label])=>[key,key==='provider_verified'?'Messaging APIが法人のプロバイダー内にある':label])
    .map(([key,label])=>field(label,key,{type:'checkbox',value:c.checks[key]}))
  box.append(details('公式管理画面で確認した項目',formOf([...consoleInputs,field('確認者・根拠','reason')],
    '確認内容を保存',async data=>{
      const values = Object.fromEntries(Object.keys(checks).map(key=>[key,data[key]==='on']))
      await change(prefix+'/console','PATCH',{...values,reason:data.reason,revision:c.revision},'確認内容を保存しました。')
    })))
  const steps = [
    ['トークンとボットの照合','token_verified','token'],
    ['Webhookの疎通','webhook_verified','webhook'],
    ['テスター本人確認（メッセージ方式）','tester_verified'],
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
    invitation.textContent = 'テストコード　'+result.code+'\n公式アカウントのトークで「接続テスト '+result.code+'」と送信すると本人確認が完了します。'+
      '\n期限（日本時間）　'+date(result.expires_at)
    invitation.hidden = false
    feedback('発行しました。テスト利用者にコードを渡し、トークで送信してもらってください。')
  })
  const tests = details('テスト利用者の登録と送信',
    el('p','テストコードのメッセージで本人確認した後、テスト利用者から公式アカウントへメッセージを1通送ってもらいます。'),
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

function lineNavigationPanel(store, current, registration) {
  const box = el('section',null,'panel line-navigation')
  box.id='quick-line'
  box.append(el('h2','公式LINE連携 · 設定ナビ'),
    el('p','必要な設定画面を直接開き、情報を取得してこの画面へ貼り付けます。','muted'),
    el('p','対象店舗 · '+store.name,'line-navigation-store'))
  const switchStore=el('a','対象店舗を切り替える','studio-link')
  switchStore.href='#workspace-store'
  box.append(switchStore)
  if(current&&!current.module_channel_id){
    box.append(el('h3','登録済みの公式LINE · '+current.label),
      el('p',mobileLineHelp,'line-device-note'))
    const switchAccount=el('a','設定する公式LINEを選び直す','studio-link')
    switchAccount.href='#line-account-picker'
    box.append(switchAccount)
    const links=lineSetupLinks(current)
    const manager=lineShortcut('公式LINEのMessaging API設定',links.hasBasic?'対象の公式LINE設定':'公式LINE一覧 → 対象の店舗 → 設定',links.managerMessaging)
    if(!links.hasBasic){
      const {label,input}=basicIdField()
      input.addEventListener('input',()=>{
        const dest=lineSetupLinks({...current,basic_id:input.value})
        updateShortcut(manager,'公式LINEのMessaging API設定',dest.hasBasic?'対象の公式LINE設定':'公式LINE一覧 → 対象の店舗 → 設定',dest.managerMessaging)
      })
      box.append(label,el('p','「トークンとボットの照合」で公式LINEの@IDを自動取得できます。','muted'))
    }
    box.append(lineShortcutGrid(manager,
      lineShortcut('プロバイダーIDを確認',links.hasProvider?'対象プロバイダーの設定':'プロバイダー一覧',links.provider),
      lineShortcut('チャネルID・シークレットを確認',links.hasMessaging?'対象チャネルの基本設定':'チャネル一覧',links.messagingBasics),
      lineShortcut('アクセストークンを確認・発行',links.hasMessaging?'対象チャネルのMessaging API設定':'チャネル一覧',links.messagingSettings),
      lineShortcut('Webhook設定を開く','Webhookの設定・検証・再送',links.messagingSettings),
      lineShortcut('応答設定の確認方法','重複応答・手動返信の公式手順',links.responseHelp)),
      connectionSetting('Webhook URL',current.webhook_url,'Webhook設定を開く',links.messagingSettings))
    const checkLink=el('a','送受信の接続確認へ','studio-link')
    checkLink.href='#line-connection'
    box.append(checkLink)
  }
  box.append(registration)
  return box
}

let recentMasterInvite
function masterPanel(info) {
  const team=panel('エールのマスター管理',el('p','現在のマスター · '+info.current_email))
  team.id='supervisor-team'
  if(info.pending_id){
    team.append(el('p','招待中 · '+info.pending_email+' · '+
      (info.pending_active?'本人による有効化が完了':info.expires_at?'有効期限 '+date(info.expires_at):'本人の有効化待ち')))
    const refreshStatus=el('button','最新の状態を取得','secondary')
    refreshStatus.type='button'
    refreshStatus.onclick=()=>refresh().catch(report)
    team.append(refreshStatus)
    if(info.pending_active){
      const promote=el('button','マスターを切り替える')
      promote.type='button'
      promote.onclick=async()=>{
        if(!window.confirm(info.pending_email+' に切り替えると、前任者のログインは終了します。切り替えますか？'))return
        promote.disabled=true
        try {
          await change('/agency-master/promote','POST',{pending:info.pending_id},'エールのマスターを切り替えました。')
        }catch(error){report(error);promote.disabled=false}
      }
      team.append(promote)
    }
  }
  const invite=details('新しいマスターを招待',formOf([field('候補者のメールアドレス','address',{type:'email'})],'招待を発行',
    async (data,key)=>{
      recentMasterInvite=await api('/agency-master/invite','POST',data,key)
      await refresh()
      feedback('招待を発行しました。招待の有効化が済むと切り替えられます。')
    }))
  invite.id='supervisor-invite'
  if(recentMasterInvite&&recentMasterInvite.id===info.pending_id&&!info.pending_active){
    invite.open=true
    const {invite_code,setup_key,expires_at}=recentMasterInvite
    invite.append(el('p','招待コードと設定キーを候補者の本人に渡してください。候補者はエールのログイン画面から有効化できます。'),
      el('pre',['招待コード　'+invite_code,'認証アプリ設定キー　'+setup_key,'期限　'+date(expires_at)].join('\n')))
  }
  team.append(invite)
  return team
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
  box.append(tests,stopForm(prefix+'/stop',c,'公式アカウントの配信'))
  return box
}

function connectionSetting(label,value,linkLabel,href) {
  const row = el('section',null,'line-setting')
  const actions = el('div',null,'actions')
  const code=el('textarea',null,'line-copy-value')
  code.rows=2
  code.value=value
  code.readOnly=true
  code.setAttribute('aria-label',label)
  actions.append(button(label+'をコピー',async ()=>{
    try {
      await navigator.clipboard.writeText(value)
      feedback(label+'をコピーしました。')
    } catch {
      code.focus();code.select();code.setSelectionRange(0,code.value.length)
      feedback('表示した'+label+'を長押し、またはコピー操作でコピーしてください。')
    }
  }),lineLink(linkLabel,href))
  row.append(el('h3',label),code,actions)
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
  link.href = workspacePath('/master/?'+params+'#'+anchor)
  return link
}

function revealLineAnchor() {
  if (!['#quick-line','#line-setup','#line-register','#line-connection'].includes(location.hash)) return
  const target = $(location.hash) ?? (location.hash==='#line-setup' ? $('#line-register') : null)
  if (target instanceof HTMLDetailsElement) target.open = true
  target?.scrollIntoView()
}

window.addEventListener('hashchange',revealLineAnchor)

const minuteLabel = value => String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0')
const setupStepNames = { profile:'店舗情報', features:'使う機能', hours:'面談の受付時間', line:'LINE接続' }
const setupAutoChecks = {
  token_verified:'トークンとボットの照合', webhook_verified:'Webhookの疎通',
  tester_verified:'テスター本人確認', receive_verified:'テスト利用者から受信', send_accepted:'LINEへのテスト送信受付',
}

function setupPanel(setup, store, base) {
  const wrap = panel('店舗セットアップ')
  wrap.id = 'store-setup'
  const done = Object.values(setup.steps).filter(Boolean).length
  if (setup.completed_at) {
    wrap.append(status('セットアップ完了',true),
      el('p','設定を変えると、そのステップは再確定が必要になります。変更の履歴は「操作履歴」で確認できます。','muted'))
  } else {
    wrap.append(el('p','この店舗の登録を4つのステップで進めます。各ステップで内容を自分で決めて「確定」してください。'+
      '管理会社の承認は不要で、進み具合は自動で保存されるため、途中まで決めて後から再開できます。（'+done+'/4ステップ確定済み）'))
  }
  const confirmStep = async step => {
    await api(base+'/setup/confirm','POST',{ step, revision:setup.revision })
  }
  const stepBox = (key, title, confirmedAt) => {
    const box = el('section',null,'line-step')
    const head = el('div',null,'actions')
    head.append(el('strong',title), setup.steps[key]
      ? status('確定済'+(confirmedAt ? ' · '+date(confirmedAt) : ''),true)
      : status('未確定',false))
    box.append(head)
    return box
  }

  const profileBox = stepBox('profile','ステップ1 店舗情報',setup.profile.confirmed_at)
  profileBox.append(el('p','店舗の基本情報です。後から「店舗設定を編集」でも変更できます。変更すると再確定が必要になります。','muted'))
  if (!setup.profile.complete) profileBox.append(el('p','未設定の項目があります。入力して保存してください。','status bad'))
  profileBox.append(formOf([template('store-fields',store)],'保存して確定',async data=>{
    await api(base,'PATCH',{...data,revision:store.revision})
    await confirmStep('profile')
    await refresh()
    feedback('店舗情報を確定しました。')
  }))
  wrap.append(profileBox)

  const featuresBox = stepBox('features','ステップ2 使う機能',setup.features.confirmed_at)
  featuresBox.append(el('p','この店舗で使う機能を選びます。迷うものはオフのままにし、必要になってからオンにできます。すべて後から変更できます。','muted'))
  const featureFields = []
  for (const [key,label] of Object.entries(featureNames)) {
    featureFields.push(field(label,key,{type:'checkbox',value:setup.features[key]}))
    const guide = featureGuides[key] + (featureBilling.has(key)
      ? ' LINEのメッセージ送信を使うため、公式アカウントの料金プランの通数に数えられます。' : '')
    featureFields.push(el('p',guide,'muted'))
  }
  featuresBox.append(formOf(featureFields,'保存して確定',async data=>{
    const settings = Object.fromEntries(Object.keys(featureNames).map(key=>[key,data[key]==='on']))
    await api(base+'/features','PATCH',{...settings,revision:setup.features.revision})
    await confirmStep('features')
    await refresh()
    feedback('使う機能を確定しました。')
  }))
  wrap.append(featuresBox)

  const hoursBox = stepBox('hours','ステップ3 面談の受付時間',setup.hours.confirmed_at)
  hoursBox.append(el('p','面談を受け付ける時間帯です。公開できる面談枠はこの範囲内だけになります。後から変更できます。','muted'))
  const minuteChoices = Object.fromEntries(
    Array.from({length:49},(_,i)=>i*30).map(value=>[value,minuteLabel(value)]))
  hoursBox.append(formOf([
    field('開始','start',{choices:minuteChoices,value:String(setup.hours.start)}),
    field('終了','end',{choices:minuteChoices,value:String(setup.hours.end)}),
  ],'保存して確定',async data=>{
    await api(base+'/interviews/hours','PATCH',
      { start:Number(data.start), end:Number(data.end), revision:setup.hours.revision })
    await confirmStep('hours')
    await refresh()
    feedback('面談の受付時間を確定しました。')
  }))
  wrap.append(hoursBox)

  const lineBox = stepBox('line','ステップ4 LINE接続',null)
  lineBox.append(el('p','自動で判定できる項目は自動で確認します。公式管理画面でしか分からない項目は、'+
    '下のLINE接続パネルの「公式管理画面で確認した項目」で、自分で確認したものにチェックを入れてください。','muted'))
  if (!setup.line.connections.length) {
    lineBox.append(el('p','まだ公式アカウントが登録されていません。下の「公式LINEの接続情報を登録」から登録してください。'))
  }
  for (const connection of setup.line.connections) {
    lineBox.append(el('strong',connection.label),
      status(connection.status==='connected' ? '接続済' : '設定中',connection.status==='connected'))
    const autoList = el('ul',null,'onboarding-list')
    for (const [key,label] of Object.entries(setupAutoChecks)) {
      const row = el('li',null,'record')
      row.append(el('span',label),status(connection.auto[key] ? '確認済' : '未確認',!!connection.auto[key]))
      autoList.append(row)
    }
    lineBox.append(autoList)
    const manual = Object.entries(checks)
      .map(([key,label])=>label+'：'+(connection.manual[key] ? '確認済' : '未確認'))
    lineBox.append(el('p','公式管理画面で確認する項目（LINE接続パネルで保存）　'+manual.join(' / '),'muted'))
  }
  wrap.append(lineBox)

  const summaryBox = el('section',null,'line-step')
  summaryBox.append(el('strong','内容の確認'))
  const enabled = Object.entries(featureNames).filter(([key])=>setup.features[key]).map(([,label])=>label)
  summaryBox.append(
    el('p','店舗　'+setup.profile.name+' · '+setup.profile.address),
    el('p','使う機能　'+(enabled.length ? enabled.join('、') : 'なし')),
    el('p','面談の受付時間　'+minuteLabel(setup.hours.start)+'〜'+minuteLabel(setup.hours.end)),
    el('p','LINE接続　'+(setup.steps.line ? '接続済' : '未完了')),
  )
  if (setup.completed_at) {
    summaryBox.append(button('再編集する',async ()=>{
      await api(base+'/setup/reopen','POST',{revision:setup.revision})
      await refresh()
      feedback('セットアップを再編集できる状態にしました。')
    }))
  } else {
    summaryBox.append(button('内容を確認してセットアップを完了する',async ()=>{
      await api(base+'/setup/complete','POST',{revision:setup.revision})
      await refresh()
      feedback('セットアップを完了しました。')
    }))
  }
  wrap.append(summaryBox)
  return wrap
}

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
  const featurePromise = admin && store ? api(base+'/features') : Promise.resolve(null)
  const masterPromise = session.actor.platform ? api('/agency-master') : Promise.resolve(null)
  const setupPromise = admin && store ? api(base+'/setup') : Promise.resolve(null)
  const [staff,connections,features,onboarding,detail,agencyMaster,setup] = await Promise.all([
    staffPromise,connectionPromise,featurePromise,onboardingList,onboardingItem,masterPromise,setupPromise,
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
  const storeQuery = store ? '?store='+encodeURIComponent(store.id) : ''
  $('#manage-interviews').href = workspacePath('/interview/staff.html'+storeQuery)
  $('#manage-operations').href = workspacePath('/operations/'+storeQuery)
  $('#manage-workflows').href = workspacePath('/workflows/'+storeQuery)
  $('#manage-studio').href = workspacePath('/studio/'+storeQuery)
  const layout = el('div',null,'controls')
  const main = el('div')
  const side = el('div')
  const selector = field('操作する店舗','store',{
    choices:Object.fromEntries(session.stores.map(item=>[item.id,item.name])),value:storeId,
  })
  selector.querySelector('select').id='workspace-store'
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
  if (setup) main.append(setupPanel(setup,store,base))
  main.append(storePanel)
  let navigation
  if (manage && store) {
    const line = panel('LINE接続')
    line.id='supervisor-line'
    if (current) {
      const picker = field('公式アカウント','channel',{
        choices:Object.fromEntries(connections.map(item=>[item.id,item.label])),value:current.id,
      })
      picker.querySelector('select').id='line-account-picker'
      picker.querySelector('select').onchange = event => {
        channelId = event.target.value
        render().catch(report)
      }
      line.append(picker,connectedPanel(base,current,testers))
    } else line.append(el('p','この店舗に公式アカウントが登録されていません。'))
    const registration = details('公式LINEの接続情報を登録',lineRegistration(base))
    registration.id = 'line-register'
    registration.open = !current || ['#line-register','#line-setup'].includes(location.hash)
    if(session.actor.platform) navigation=lineNavigationPanel(store,current,registration)
    else line.append(registration)
    main.append(line)
  }
  if (agencyMaster) side.append(masterPanel(agencyMaster))
  if (admin) side.append(teamPanel(staff),panel('法人の配信管理',
    status(session.tenant.stopped?'配信停止中':'法人停止なし',false,session.tenant.stopped),
    stopForm('/tenant/stop',session.tenant,'法人の配信'),auditPanel('/tenant/audit')))
  layout.append(main,side)
  const sections=admin ? [onboardingPanel(onboarding,store,detail,connections),layout] : [layout]
  if (navigation) sections.unshift(navigation)
  content.replaceChildren(...sections)
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
if ($('#logout')) $('#logout').onclick = async () => {
  try { await api(workspace?'/platform/logout':'/auth/logout','POST',{}); location.replace(workspace?'/platform/':location.pathname) }
  catch (error) { report(error) }
}
bind($('#login'),async (data)=>{
  await api(loginPath,'POST',data)
  $('#login').reset()
  if (!$('#workspace')) {
    location.reload()
    return
  }
  await refresh()
  feedback('')
})
bind($('#activate'),async (data)=>{
  await api('/auth/activate','POST',data)
  $('#activate').reset()
  $('#show-login').click()
  feedback('招待を有効にしました。次に表示される新しい認証コードでログインしてください。')
})
if ($('#workspace')) {
  refresh().catch(error=>{ if (error.status!==401) report(error) })
} else {
  // A navigation from another site can omit the Strict cookie. The same-site request can use it.
  api(platformEntry?'/platform/session':'/session').then(result=>{
    if (masterEntry && result.actor.role!=='admin') location.replace('/')
    else location.reload()
  }).catch(error=>{ if (error.status!==401) report(error) })
}
