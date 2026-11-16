const token = location.hash.slice(1)
const context = document.querySelector('#guide-context')
const status = document.querySelector('#guide-status')
const instructions = document.querySelector('#guide-instructions')
const form = document.querySelector('#guide-form')
const submit = form.querySelector('button')
const messages = {
  waiting:'招待URLを渡すと、管理会社がこの店舗の初期設定を進めます。',
  received:'招待URLを管理会社に渡しました。',
  setting:'管理会社が公式LINEの初期設定を進めています。',
  verified:'公式LINEの送受信確認が完了しました。',
}

async function load(suffix, fields={}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('管理会社から届いた案内リンクを開いてください。')
  const response = await fetch('/api/v1/line-onboarding/guide'+suffix,{
    method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',body:JSON.stringify({token,...fields}),
  })
  const result = await response.json()
  if (!response.ok) {
    const message = result.field_errors?.invitation
      ? 'LINE公式の管理画面で発行した招待URLを貼り付けてください。' : result.message
    throw new Error(message ?? '時間をおいて、もう一度お試しください。')
  }
  context.textContent = result.store+' · '+result.company
  context.hidden = false
  status.textContent = messages[result.status]
  instructions.hidden = result.status!=='waiting'
}

form.addEventListener('submit',async event=>{
  event.preventDefault()
  submit.disabled = true
  try {
    const invitation = form.elements.invitation.value
    await load('/submit',{invitation})
    form.reset()
  } catch (error) {
    status.textContent = error.message
  } finally {
    submit.disabled = false
  }
})

try { await load('') }
catch (error) { status.textContent = error.message }
