// LIFFなし顧客向けページ（固有トークン方式）: URLの t を引換APIで customer_session に
// 交換してから、LIFF版と同じ来店予約・配信設定・回答フォームのUIを開く。
const connection = location.pathname.split('/').filter(Boolean).at(-1)
const status = document.querySelector('#status')
const fallback = document.querySelector('#fallback')
const formId = new URLSearchParams(location.search).get('form') ?? undefined

function item(tag, text) {
  const el = document.createElement(tag)
  if (text) el.textContent = text
  return el
}
function guarded(fn) {
  return async (event) => {
    event.preventDefault()
    const target = event.currentTarget
    const control = target instanceof HTMLFormElement ? target.querySelector('button')
      : target instanceof HTMLButtonElement ? target : null
    if (control) control.disabled = true
    try { await fn() } catch (error) { status.textContent = error instanceof Error ? error.message : '処理できませんでした。' }
    finally { if (control) control.disabled = false }
  }
}
async function accountRequest(path, method = 'GET', body) {
  const response = await fetch('/api/v1/customer' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const envelope = await response.json()
  if (!response.ok) throw Object.assign(new Error(envelope.message ?? '操作できませんでした。'), { status: response.status, code: envelope.code })
  return envelope
}

const fallbackReasons = {
  LINK_EXPIRED: 'このURLは有効期限が切れています。',
  LINK_INVALID: 'このURLは有効期限が切れているか、すでに使えなくなっています。',
}
function showFallback(code) {
  document.querySelector('#heading').hidden = true
  status.hidden = true
  document.querySelector('#fallback-reason').textContent =
    fallbackReasons[code] ?? 'このURLは有効期限が切れているか、すでに使えなくなっています。'
  fallback.hidden = false
}

const bookingStates = { pending: '仮受付', confirmed: '確定', cancelled: '取消', visited: '来店済', no_show: '不来店' }
async function drawAccount() {
  const account = await accountRequest('/account')
  document.querySelector('#store-name').textContent = account.store
  const date = (value) => new Intl.DateTimeFormat('ja-JP', { timeZone: account.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  const preferences = document.querySelector('#preferences')
  const service = preferences.elements.namedItem('service')
  const marketing = preferences.elements.namedItem('marketing')
  const stop = preferences.elements.namedItem('stop')
  service.checked = account.service_consent; marketing.checked = account.marketing_consent; stop.checked = account.all_stop
  stop.onchange = () => { if (stop.checked) { service.checked = false; marketing.checked = false } }
  preferences.onsubmit = guarded(async () => {
    await accountRequest('/preferences', 'PATCH', {
      version: account.policy_version, revision: account.revision,
      preferences: { service_consent: !stop.checked && service.checked, marketing_consent: !stop.checked && marketing.checked, all_stop: stop.checked },
    })
    await drawAccount()
    status.textContent = '配信設定を保存しました。'
  })
  const reservation = document.querySelector('#reservation')
  reservation.hidden = !account.visits_enabled
  const options = (select) => {
    select.replaceChildren(new Option('空き枠を選択', ''), ...account.slots.filter(s => s.remaining > 0)
      .map(slot => new Option(date(slot.starts_at) + ' ' + slot.label + '（残り ' + slot.remaining + '人）', slot.id)))
  }
  options(reservation.elements.namedItem('slot'))
  reservation.onsubmit = guarded(async () => {
    const data = new FormData(reservation)
    await accountRequest('/bookings', 'POST', { slot: data.get('slot'), party: Number(data.get('party')) })
    await drawAccount()
    status.textContent = '仮受付を登録しました。確定は店舗が行います。'
  })
  const rows = document.querySelector('#my-bookings')
  rows.replaceChildren()
  for (const booking of account.bookings) {
    const row = item('article')
    row.className = 'record'
    row.append(item('p', date(booking.starts_at) + ' · ' + booking.party + '名 · ' + bookingStates[booking.status]))
    if (['pending', 'confirmed'].includes(booking.status) && Date.parse(booking.starts_at) > Date.now()) {
      const cancel = item('button', 'この予約を取り消す')
      cancel.type = 'button'
      cancel.onclick = guarded(async () => {
        if (!confirm('この予約を取り消しますか？')) return
        await accountRequest('/bookings/' + booking.id, 'PATCH', { slot: booking.slot_id, party: booking.party, revision: booking.revision, status: 'cancelled' })
        await drawAccount(); status.textContent = '予約を取り消しました。'
      })
      if (!account.visits_enabled) {
        rows.append(row)
        continue
      }
      const detail = item('details')
      detail.append(item('summary', '日時・人数の変更を申し込む'))
      const change = item('form')
      const select = item('select')
      options(select)
      select.required = true
      if (!Array.from(select.options).some(option => option.value === booking.slot_id)) {
        select.add(new Option(date(booking.starts_at) + '（現在の枠）', booking.slot_id))
      }
      select.value = booking.slot_id
      const party = item('input')
      party.type = 'number'; party.min = '1'; party.max = '200'; party.required = true; party.value = String(booking.party)
      const dateLabel = item('label', '変更先'); dateLabel.append(select)
      const partyLabel = item('label', '人数'); partyLabel.append(party)
      change.append(dateLabel, partyLabel, item('button', '変更を仮受付に戻す'))
      change.onsubmit = guarded(async () => {
        await accountRequest('/bookings/' + booking.id, 'PATCH', { slot: select.value, party: Number(party.value), revision: booking.revision, status: 'pending' })
        await drawAccount(); status.textContent = '変更を仮受付しました。店舗の確定をお待ちください。'
      })
      detail.append(change)
      row.append(cancel, detail)
    }
    rows.append(row)
  }
  if (!rows.childElementCount) rows.append(item('p', '予約はありません。'))
}

async function showWorkflowForm() {
  const region = document.querySelector('#workflow-form')
  region.hidden = true
  region.replaceChildren()
  let page
  try { page = await accountRequest('/form' + (formId ? '?form=' + encodeURIComponent(formId) : '')) }
  catch { status.textContent = '回答フォームを読み込めませんでした。'; return }
  if (!page) {
    if (formId) { region.append(item('p', 'この回答フォームは現在公開されていません。')); region.hidden = false }
    return
  }
  const published = page
  region.append(item('h2', page.title))
  if (page.description) region.append(item('p', page.description))
  region.hidden = false
  if (page.submitted) { region.append(item('p', '回答を送信済みです。')); return }
  const application = item('form')
  for (const field of page.fields) {
    const label = item('label', field.label + (field.required ? '（必須）' : ''))
    let control
    if (field.kind === 'choice') {
      const select = item('select')
      select.add(new Option('選択してください', ''))
      for (const option of field.options) select.add(new Option(option, option))
      control = select
    } else if (field.kind === 'long') {
      const input = item('textarea')
      input.maxLength = 1000
      control = input
    } else {
      const input = item('input')
      input.type = field.kind === 'checkbox' ? 'checkbox' : 'text'
      input.value = field.kind === 'checkbox' ? 'yes' : ''
      input.maxLength = 200
      control = input
    }
    control.name = field.key
    control.required = field.required
    label.append(control)
    application.append(label)
  }
  const submit = item('button', '回答を送信')
  const result = item('p')
  result.setAttribute('role', 'status')
  application.append(submit, result)
  region.append(application)
  application.onsubmit = guarded(async () => {
    const answers = Object.fromEntries(new FormData(application))
    try {
      await accountRequest('/form', 'POST', { form: published.id, revision: published.revision, answers })
      const success = item('p', '回答を送信しました。')
      success.setAttribute('role', 'status')
      application.replaceWith(success)
    } catch (error) {
      result.textContent = error instanceof Error ? error.message : '回答を送信できませんでした。'
    }
  })
}

try {
  const raw = new URLSearchParams(location.search).get('t')
  if (!raw) {
    showFallback('LINK_INVALID')
  } else {
    const response = await fetch('/api/v1/customer-link/' + encodeURIComponent(connection) + '/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw }),
    })
    const data = await response.json()
    if (!response.ok) {
      showFallback(data.code)
    } else {
      // トークンをアドレスバーと履歴に残さない。
      history.replaceState(null, '', location.pathname)
      await drawAccount()
      document.querySelector('#customer').hidden = false
      document.querySelector('#heading').hidden = true
      status.textContent = '本人確認が完了しました。'
      await showWorkflowForm()
    }
  }
} catch {
  status.textContent = '画面を開けませんでした。時間をおいて再度お試しください。'
}
