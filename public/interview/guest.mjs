import { mountInterview } from './calendar.mjs'

const connection = location.pathname.split('/').filter(Boolean).at(-1)
const base = '/api/v1/guest-interview/' + encodeURIComponent(connection)
const status = document.querySelector('#status')

async function request(path,method='GET',data){
  const response=await fetch(base+path,{method,credentials:'same-origin',
    ...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})})
  const result=await response.json()
  if(!response.ok){
    const error=new Error(result.message??'面談予約を読み込めませんでした。')
    error.status=response.status
    throw error
  }
  return result
}

async function calendar(start){
  const path='/calendar'+(start?'?start='+encodeURIComponent(start):'')
  try{return await request(path)}
  catch(error){
    if(error.status!==401)throw error
    await request('/session','POST',{})
    return request(path)
  }
}

try{
  await mountInterview(document.querySelector('#interview'),{
    guest:true,calendar,
    book:input=>request('/bookings','POST',input),
    change:(id,input)=>request('/bookings/'+encodeURIComponent(id),'PATCH',input),
  })
  status.hidden=true
}catch(error){
  status.textContent=error.message
}
