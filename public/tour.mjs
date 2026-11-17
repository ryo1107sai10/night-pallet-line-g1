import {workspacePath} from './workspace-path.mjs'

const stateKey='npl-supervisor-tour'
const storePattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const routes={master:'/master/',studio:'/studio/',interview:'/interview/staff.html'}

function save(state){
  if(state)sessionStorage.setItem(stateKey,JSON.stringify(state))
  else sessionStorage.removeItem(stateKey)
}

function restore(){
  try{
    const state=JSON.parse(sessionStorage.getItem(stateKey))
    if(typeof state?.id==='string'&&Number.isInteger(state.step)&&state.step>=0)return state
  }catch{}
  return null
}

function node(tag,text,className){
  const item=document.createElement(tag)
  if(text)item.textContent=text
  if(className)item.className=className
  return item
}
function button(text,action){
  const item=node('button',text,'npl-tour-button')
  item.type='button'
  item.onclick=action
  return item
}

export async function tourRequest(id,content){
  const response=await fetch('/api/v1/platform/tours'+(id?'/'+encodeURIComponent(id):''),content?{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(content),
  }:{})
  const result=await response.json()
  if(!response.ok)throw new Error(result.message??'画面ツアーを読み込めませんでした。')
  return result
}

export function mountTour(page,{enter}={}){
  if(document.querySelector('#npl-tour'))return
  const css=node('link')
  css.rel='stylesheet'
  css.href='/static/tour.css'
  document.head.append(css)
  const launcher=button('画面ツアー',()=>toggle())
  launcher.id='npl-tour'
  launcher.setAttribute('aria-controls','npl-tour-panel')
  launcher.setAttribute('aria-expanded','false')
  const panel=node('aside',null,'npl-tour-panel')
  panel.id='npl-tour-panel'
  panel.setAttribute('aria-label','画面ツアー')
  panel.hidden=true
  document.body.append(launcher,panel)
  let state=page==='platform'?null:restore()
  let marked=null, observer, tours
  const currentStep=()=>tours[state.id].steps[state.step]

  function clearTarget(){
    observer?.disconnect()
    marked?.classList.remove('npl-tour-target')
    marked=null
  }
  function highlight(selector){
    clearTarget()
    const find=()=>{
      const item=Array.from(document.querySelectorAll(selector)).find(element=>element.getClientRects().length)
      if(item===marked)return
      marked?.classList.remove('npl-tour-target')
      marked=item??null
      if(!marked)return
      marked.classList.add('npl-tour-target')
      marked.scrollIntoView({block:'center',inline:'nearest'})
    }
    observer=new MutationObserver(find)
    observer.observe(document.body,{childList:true,subtree:true,attributeFilter:['hidden','open']})
    find()
  }
  async function toggle(focus=true){
    if(!panel.hidden){hide();return}
    launcher.disabled=true
    try{
      tours=await tourRequest()
      if(state&&(!Object.hasOwn(tours,state.id)||!currentStep())){
        state=null
        save(null)
      }
      if(state&&currentStep().page!==page&&tours[state.id].steps[state.step+1]?.page===page){
        state={...state,step:state.step+1}
        save(state)
      }
      draw(focus===true)
    }catch(error){
      panel.replaceChildren(node('p',error.message),button('閉じる',hide))
      panel.hidden=false
      launcher.setAttribute('aria-expanded','true')
      panel.querySelector('button').focus()
    }finally{launcher.disabled=false}
  }
  function hide(){
    clearTarget()
    panel.hidden=true
    launcher.setAttribute('aria-expanded','false')
    launcher.focus()
  }
  function finish(){
    save(null)
    state=null
    hide()
  }
  function stepPage(next){
    const configuredStore=new URLSearchParams(location.search).get('store')
    const selected=document.querySelector('#workspace-store,#stores,#store')?.value
    const store=[selected,configuredStore].find(value=>storePattern.test(value??''))
    const url=new URL(workspacePath(routes[next]),location.origin)
    if(store)url.searchParams.set('store',store)
    location.assign(url.pathname+url.search)
  }
  function move(step){
    state={...state,step}
    save(state)
    const next=currentStep().page
    if(page!==next)stepPage(next)
    else draw(true)
  }
  function draw(focus=false){
    clearTarget()
    panel.hidden=false
    launcher.setAttribute('aria-expanded','true')
    const heading=node('h2',state?tours[state.id].title:'何をしますか？')
    heading.tabIndex=-1
    const close=button('閉じる',hide)
    const title=node('div',null,'npl-tour-title')
    title.append(heading,close)
    panel.replaceChildren(title)
    if(!state){
      const choices=node('div',null,'npl-tour-choices')
      const status=node('p')
      status.setAttribute('role','status')
      for(const [id,tour] of Object.entries(tours)){
        const choice=button(tour.title,async()=>{
          try{
            if(page==='platform'){
              choice.disabled=true
              const destination=await enter()
              const url=new URL(destination,location.origin)
              save({id,step:0})
              location.assign(url.pathname+url.search)
            }else{
              state={id,step:0}
              move(0)
            }
          }catch(error){status.textContent=error.message;choice.disabled=false}
        })
        choices.append(choice)
      }
      const editor=node('a','画面ツアーを編集','npl-tour-editor-link')
      editor.href='/platform/tours/'
      panel.append(choices,editor,status)
    }else{
      const {page:next,target,caption,body}=currentStep()
      const number=node('p',(state.step+1)+' / '+tours[state.id].steps.length,'npl-tour-count')
      panel.append(number,node('h3',caption),node('p',body))
      const actions=node('div',null,'npl-tour-actions')
      actions.append(button('目的を選び直す',()=>{state=null;save(null);draw(true)}))
      if(page!==next)actions.append(button('この画面を開く',()=>stepPage(next)))
      else{
        if(state.step>0)actions.append(button('前へ',()=>move(state.step-1)))
        actions.append(tours[state.id].steps.length===state.step+1?button('完了',finish):button('次へ',()=>move(state.step+1)))
      }
      panel.append(actions)
      if(page===next)highlight(target)
    }
    if(focus)heading.focus({preventScroll:true})
  }
  panel.addEventListener('keydown',event=>{if(event.key==='Escape')hide()})
  if(state)toggle(false)
}
