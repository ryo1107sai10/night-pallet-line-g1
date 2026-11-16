import {workspacePath} from './workspace-path.mjs'

const tours={
  line:{title:'公式LINEをつなぐ',steps:[
    ['master','#workspace-store','店舗を選ぶ','公式LINEを紐づける店舗を選んでください。'],
    ['master','#quick-line','公式LINEの接続を始める','用途を選び「公式LINEをつなぐ」を押します。LINEで対象アカウントを選んで許可してください。手動設定が表示された場合は、その案内に沿って進めます。'],
    ['master','#supervisor-line','接続結果を確認する','LINEの許可画面から戻ったら、選んだ店舗と公式アカウント名を照合してください。接続後は送受信を確認できます。'],
  ]},
  master:{title:'エールのマスターを管理する',steps:[
    ['master','#supervisor-team','現在のマスターを見る','「エールのマスター管理」で現在の担当者を確認します。'],
    ['master','#supervisor-invite','新しいマスターを招待する','「新しいマスターを招待」を開き、候補者のメールアドレスを入力して招待を発行します。招待情報は本人に安全な方法で渡してください。'],
    ['master','#supervisor-team','有効化を確認して引き継ぐ','候補者が招待を有効にしたら表示を更新します。「マスターを切り替える」を押すと、前任者のマスター権限が終了します。'],
  ]},
  scenario:{title:'ステップ配信を作る',steps:[
    ['master','#manage-studio','シナリオ画面を開く','対象の店舗を選び、「ステップ配信を組む」を押してください。'],
    ['studio','#new','新規シナリオを作る','「新規シナリオ」を押すと、配信フローが開きます。'],
    ['studio','#workspace','フローを編集して保存する','公式アカウント、開始条件、メッセージと待機時間を設定し、下書きを保存します。'],
    ['studio','#inspector','テストして公開する','「テスト」で配信の順序と本文を確認します。公開版で承認と公開を行います。'],
  ]},
  calendar:{title:'Googleカレンダーと面談予約をつなぐ',steps:[
    ['master','#manage-interviews','面談枠の管理を開く','対象の店舗を選んで「面談枠の管理」を押してください。'],
    ['interview','#google-calendar','Googleカレンダーを選ぶ','未連携ならカレンダーIDを入力して「Googleで連携する」を押し、Googleで許可します。連携済みの場合は、表示されているカレンダーを確認してください。'],
    ['interview','#interview-hours','受付時間を設定する','受付開始と終了を選び、「受付時間を保存する」を押してください。'],
    ['interview','#new-slot, #slot-help:not(:empty)','対面面談の枠を登録する','面談日、開始時刻、会場案内を入力します。登録フォームの代わりに案内が表示されている場合は、案内の内容を確認してください。'],
  ]},
}
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
    if(Object.hasOwn(tours,state?.id)&&Number.isInteger(state.step)&&tours[state.id].steps[state.step])return state
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

export function mountTour(page,{enter}={}){
  if(document.querySelector('#npl-tour'))return
  const css=node('link')
  css.rel='stylesheet'
  css.href='/static/tour.css'
  document.head.append(css)
  const launcher=button('画面ツアー',toggle)
  launcher.id='npl-tour'
  launcher.setAttribute('aria-controls','npl-tour-panel')
  launcher.setAttribute('aria-expanded','false')
  const panel=node('aside',null,'npl-tour-panel')
  panel.id='npl-tour-panel'
  panel.setAttribute('aria-label','画面ツアー')
  panel.hidden=true
  document.body.append(launcher,panel)
  let state=page==='platform'?null:restore()
  let marked=null, observer
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
  function toggle(){
    if(panel.hidden)draw(true)
    else hide()
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
    const [next]=currentStep()
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
      panel.append(choices,status)
    }else{
      const [next,target,caption,body]=currentStep()
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
  if(state){
    const next=tours[state.id].steps[state.step+1]
    if(currentStep()[0]!==page&&next?.[0]===page){
      state={...state,step:state.step+1}
      save(state)
    }
    draw()
  }
}
