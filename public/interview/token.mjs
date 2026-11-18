import { mountInterview } from './calendar.mjs'

// LIFFなし面談予約（固有トークン方式）: URLの t を引換APIでセッションに交換してから
// LIFF版と同じカレンダー・フォーム・通知UIを開く。
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

async function request(path, method = 'GET', body) {
  const response = await fetch('/api/v1/interview' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.message ?? '操作できませんでした。'), { status: response.status, code: data.code })
  return data
}

const fallbackReasons = {
  LINK_EXPIRED: 'この予約URLは有効期限が切れているか、発行から時間が経っています。',
  LINK_USED: 'この予約URLはすでに予約が完了しています。予約内容はLINEにお送りした確定通知をご確認ください。',
  LINK_INVALID: 'この予約URLは有効期限が切れているか、すでに予約が完了しています。',
}
function showFallback(code) {
  document.querySelector('#heading').hidden = true
  status.hidden = true
  document.querySelector('#fallback-reason').textContent =
    fallbackReasons[code] ?? 'この予約URLは有効期限が切れているか、すでに予約が完了しています。'
  fallback.hidden = false
}

async function showInterviewNotices() {
  const root = document.querySelector('#interview-notices')
  const draw = (data) => {
    root.replaceChildren()
    root.hidden = !data.reminders && !data.waitlist_enabled && !data.notices && !data.waitlist
    if (root.hidden) return
    const preferences = item('form')
    const label = item('label', 'LINEで予約の案内を受け取る')
    const input = item('input')
    input.type = 'checkbox'
    input.checked = data.notices
    label.prepend(input)
    preferences.append(label, item('button', '通知設定を保存'))
    preferences.onsubmit = guarded(async () => draw(await request('/notices', 'PUT', { enabled: input.checked })))
    root.append(item('h2', '面談のお知らせ'), preferences)
    if (data.waitlist) {
      const current = item('form')
      current.append(item('p', data.waitlist.offered_at ? '空きが出た枠の案内を準備しました。' : 'キャンセル待ちに登録済みです。'),
        item('button', 'キャンセル待ちを解除'))
      current.onsubmit = guarded(async () => draw(await request('/waitlist', 'DELETE', {})))
      root.append(current)
    }
    if (data.waitlist_enabled && data.notices && !data.waitlist) {
      const join = item('form')
      const days = item('select')
      for (const day of [3, 7, 14, 30]) days.add(new Option(day + '日間', String(day)))
      const dayLabel = item('label', '待つ期間')
      dayLabel.append(days)
      join.append(dayLabel, item('button', 'キャンセル待ちに登録'))
      join.onsubmit = guarded(async () => draw(await request('/waitlist', 'PUT', { days: Number(days.value) })))
      root.append(join)
    }
  }
  try { draw(await request('/notices')) }
  catch { status.textContent = '通知の設定を確認できませんでした。' }
}

async function showWorkflowForm() {
  const region = document.querySelector('#workflow-form')
  region.hidden = true
  region.replaceChildren()
  let page
  try { page = await request('/form' + (formId ? '?form=' + encodeURIComponent(formId) : '')) }
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
      await request('/form', 'POST', { form: published.id, revision: published.revision, answers })
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
    const response = await fetch('/api/v1/interview-link/' + encodeURIComponent(connection) + '/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: raw }),
    })
    const data = await response.json()
    if (!response.ok) {
      showFallback(data.code)
    } else {
      // トークンをアドレスバーと履歴に残さない。
      history.replaceState(null, '', location.pathname)
      const root = document.querySelector('#interview')
      await mountInterview(root, {
        calendar: start => request('/calendar' + (start ? '?start=' + encodeURIComponent(start) : '')),
        book: input => request('/bookings', 'POST', input),
        change: (id, input) => request('/bookings/' + encodeURIComponent(id), 'PATCH', input),
      })
      document.body.classList.add('has-interviews')
      root.hidden = false
      document.querySelector('#heading').hidden = true
      status.textContent = '本人確認が完了しました。予約が確定すると、内容をLINEにもお送りします。'
      await showWorkflowForm()
      await showInterviewNotices()
    }
  }
} catch {
  status.textContent = '画面を開けませんでした。時間をおいて再度お試しください。'
}
