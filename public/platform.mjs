const notice = document.querySelector('#notice')
const tenants = document.querySelector('#tenants')
const logout = document.querySelector('#logout')

async function platformApi(path,method = 'GET') {
  const response = await fetch('/api/v1/platform'+path,method==='GET' ? {} : {
    method,headers:{'Content-Type':'application/json'},body:'{}',
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

try {
  const [{actor},records]=await Promise.all([platformApi('/session'),platformApi('/tenants')])
  document.querySelector('#account').textContent='全体管理者 · '+actor.email
  if (!records.length) notice.textContent='登録されている法人がありません。'
  for (const tenant of records) {
    const row=element('li',null,'record')
    const detail=element('div',null,'onboarding-store')
    detail.append(element('strong',tenant.legal_name),element('span',tenant.stores+'店舗 · 法人ID '+tenant.slug,'muted'))
    if (tenant.stopped) detail.append(element('span','配信停止中','status bad'))
    const open=element('button','法人の管理画面を開く')
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
} catch (error) { report(error) }
