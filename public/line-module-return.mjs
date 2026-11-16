import {returnWorkspace,forgetReturnWorkspace} from './workspace-path.mjs'
const params = new URLSearchParams(location.search)
history.replaceState(null,'',location.pathname)
const state = params.get('state') ?? ''
const code = params.get('code')
const status = document.querySelector('#module-status')
const retry = document.querySelector('#retry-module')
const back = document.querySelector('#back-to-store')
const store = /^[0-9a-f]{96}$/.test(state) ? state.slice(0,32).replace(
  /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5') : null
const workspace = returnWorkspace('line',store)
if (store) back.href = workspace+'/staff/?store='+encodeURIComponent(store)+'#line-setup'

async function complete() {
  retry.hidden = true
  status.textContent = 'LINEの許可を確認しています。'
  try {
    const response = await fetch(workspace+'/api/v1/stores/'+store+'/line-module/complete',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,state}),
    })
    const data = await response.json()
    if (response.ok) {
      forgetReturnWorkspace('line')
      location.replace(workspace+'/staff/?'+new URLSearchParams({store,line_connected:data.id})+'#line-connection')
      return
    }
    status.textContent = response.status===401
      ? '管理画面にログインし直してから、公式LINEの連携を始めてください。'
      : data.message ?? '連携結果を確認できませんでした。'
    retry.hidden = !data.retryable
  } catch {
    status.textContent = '連携結果を確認できませんでした。時間をおいてもう一度お試しください。'
    retry.hidden = false
  }
}
retry.onclick = complete
if (store && code && !params.has('error')) await complete()
else status.textContent = 'LINEでの連携が完了しませんでした。店舗の連携画面からやり直してください。'
