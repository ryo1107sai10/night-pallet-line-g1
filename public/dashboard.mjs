import {workspacePath} from '/static/workspace-path.mjs'

const make=(tag,text)=>{
  const node=document.createElement(tag)
  if(text!==undefined)node.textContent=text
  return node
}
const uses={recruitment:'採用',customer:'顧客',unclassified:'受付保留'}
const link=(label,path,query)=>{
  const node=make('a',label)
  node.href=workspacePath(path+'?'+new URLSearchParams(query))
  return node
}

export function mountDashboard(root,load){
  const top=make('div')
  top.className='heading'
  const refresh=make('button','更新')
  refresh.type='button'
  refresh.className='secondary'
  top.append(make('h2','今日の対応'),refresh)
  const status=make('p')
  status.setAttribute('role','status')
  const grid=make('div')
  grid.className='dashboard-grid'
  root.replaceChildren(top,status,grid)
  root.hidden=false

  async function render(){
    refresh.disabled=true
    status.textContent='店舗の状況を確認しています。'
    try{
      const rows=await load()
      grid.replaceChildren(...rows.map(store=>{
        const card=make('article')
        card.className='dashboard-card'
        const actions=make('div')
        actions.className='dashboard-actions'
        const storeArg={store:store.id}
        for(const [use,total] of Object.entries(store.inbox)){
          const query=use==='unclassified'?{use:'customer',tab:'intake'}:{use,tab:'inbox'}
          actions.append(link(uses[use]+'の未返信 '+total+'件','/workflows/',{...storeArg,...query,unanswered:'1'}))
        }
        for(const [use,total] of Object.entries(store.failed)){
          actions.append(link(uses[use]+'の送信エラー '+total+'件','/workflows/',{...storeArg,use,tab:'delivery',failures:'1'}))
        }
        if(!actions.childElementCount)actions.append(make('span','未返信・送信エラーはありません。'))
        const slots=make('div')
        slots.className='dashboard-actions'
        const time=new Intl.DateTimeFormat('ja-JP',{timeStyle:'short',timeZone:store.timezone})
        for(const slot of store.interviews.slice(0,6)){
          slots.append(link(time.format(new Date(slot.starts_at))+'の面談','/interview/staff.html',{...storeArg,slot:slot.id,today:'1'}))
        }
        slots.append(link('今日の面談 '+store.interviews.length+'件','/interview/staff.html',{...storeArg,today:'1'}))
        card.append(make('h3',store.name),actions,slots)
        return card
      }))
      status.textContent=rows.length?'':'操作できる店舗はありません。'
    }catch(error){status.textContent=error.message}
    finally{refresh.disabled=false}
  }
  refresh.onclick=render
  void render()
}
