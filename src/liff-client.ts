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
  status.textContent = '用途を選択し、テストコードを入力してください。'
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

prepare().catch(error => { status.textContent = error instanceof Error ? error.message : '接続に失敗しました。' })
