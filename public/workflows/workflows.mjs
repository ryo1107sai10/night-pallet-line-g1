import {workspacePath,scopeWorkspaceLinks} from '/static/workspace-path.mjs'
import {localInstant} from '../studio/engine.mjs'

scopeWorkspaceLinks()

const $=selector=>document.querySelector(selector)
const el=(tag,content,cls)=>{
  const node=document.createElement(tag)
  if(content!=null)node.textContent=content
  if(cls)node.className=cls
  return node
}
const controls=(...children)=>{
  const node=el('div',null,'controls')
  node.append(...children)
  return node
}
function notice(message='',error=false){
  const node=$('#message')
  node.textContent=message
  node.hidden=!message
  node.classList.toggle('error',error)
}
async function api(path,method='GET',data,idempotencyKey=crypto.randomUUID()){
  const response=await fetch(workspacePath('/api/v1'+path),{method,
    headers:data?{'Content-Type':'application/json','Idempotency-Key':idempotencyKey}:{},
    body:data?JSON.stringify(data):undefined})
  const value=await response.json()
  if(!response.ok)throw new Error(value.message??'操作できませんでした。')
  return value
}
function button(text,perform){
  const node=el('button',text)
  node.type='button'
  node.onclick=async()=>{
    node.disabled=true
    try{await perform()}catch(error){notice(error.message,true)}finally{node.disabled=false}
  }
  return node
}
function field(label,name,type='text',value='',options){
  const wrapper=el('label',label,type==='checkbox'?'check':'field')
  const input=el(options?'select':type==='textarea'?'textarea':'input')
  input.name=name
  if(options)input.append(...options.map(([key,text])=>new Option(text,key)))
  else if(type!=='textarea')input.type=type
  if(type==='checkbox'){input.checked=!!value;wrapper.prepend(input)}
  else{input.value=value??'';wrapper.append(input)}
  return wrapper
}
function form(fields,caption,perform){
  const node=el('form',null,'record')
  const fieldsRoot=el('div',null,'fields')
  fieldsRoot.append(...fields)
  const submit=el('button',caption,'primary')
  let lastPayload
  let lastKey
  node.append(fieldsRoot,submit)
  node.onsubmit=async event=>{
    event.preventDefault()
    submit.disabled=true
    const entries=[...new FormData(node)]
    const data=Object.fromEntries(entries)
    const payload=JSON.stringify(entries)
    if(payload!==lastPayload){lastPayload=payload;lastKey=crypto.randomUUID()}
    try{await perform(data,lastKey)}catch(error){notice(error.message,true)}finally{submit.disabled=false}
  }
  return node
}
function details(title,body){
  const node=el('details')
  node.append(el('summary',title),body)
  return node
}
const channelOptions=channels=>channels.map(channel=>[channel.id,channel.label])
const dateLabel=(date,timezone)=>new Intl.DateTimeFormat('ja-JP',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(date))
const types=[['text','短い入力'],['long','長い入力'],['choice','選択肢から1つ'],['checkbox','チェックボックス']]
const blankField=()=>({key:crypto.randomUUID(),kind:'text',label:'',required:false,options:[]})
const stages={applied:'応募',interviewed:'面談実施',trial_scheduled:'体入予定',trial_done:'体入実施',hired:'入店',withdrawn:'辞退・終了'}
const allowed={applied:['interviewed','withdrawn'],interviewed:['trial_scheduled','hired','withdrawn'],
  trial_scheduled:['trial_scheduled','trial_done','interviewed','withdrawn'],trial_done:['hired','withdrawn'],hired:[],withdrawn:[]}
let stores,current,openThread,agency=false,view=0
let actor

function formEditor(root,data,path,refresh,use){
  root.append(el('h2','回答フォーム'))
  if(!data.channels.length){root.append(el('p','先にこの用途の公式LINEを登録してください。'));return}
  const picker=field('公式LINE','channel','',data.channels[0].id,channelOptions(data.channels))
  const choice=picker.querySelector('select')
  const formPicker=field('編集するフォーム','form','','',[['','新規フォーム']])
  const active=formPicker.querySelector('select')
  const editor=el('div')
  const show=()=>{
    const existing=data.forms.find(form=>form.id===active.value&&form.channel_id===choice.value)
    const draft=existing?structuredClone(existing.fields):[blankField()]
    const fieldsRoot=el('div')
    const drawFields=()=>{
      fieldsRoot.replaceChildren(...draft.map((entry,index)=>{
        const section=el('fieldset',null,'record')
        section.append(el('legend','質問 '+(index+1)))
        const label=field('質問文','label','text',entry.label)
        const kind=field('回答の形式','kind','',entry.kind,types)
        const required=field('必須回答','required','checkbox',entry.required)
        const identity=field('選考台帳に応募者名として表示','identity','checkbox',entry.applicant_name)
        const identityInput=identity.querySelector('input')
        const options=field('選択肢を1行ずつ入力','options','textarea',entry.options.join('\n'))
        label.querySelector('input').required=true
        label.querySelector('input').maxLength=100
        label.querySelector('input').oninput=e=>entry.label=e.target.value
        required.querySelector('input').onchange=e=>entry.required=e.target.checked
        kind.querySelector('select').onchange=e=>{
          entry.kind=e.target.value
          options.hidden=entry.kind!=='choice'
          identity.hidden=entry.kind!=='text'||use!=='recruitment'
          if(identity.hidden){entry.applicant_name=false;identityInput.checked=false}
        }
        identity.hidden=entry.kind!=='text'||use!=='recruitment'
        identityInput.onchange=e=>{
          if(e.target.checked)for(const item of draft)item.applicant_name=false
          entry.applicant_name=e.target.checked
          drawFields()
        }
        options.querySelector('textarea').oninput=e=>entry.options=e.target.value.split('\n')
        options.hidden=entry.kind!=='choice'
        const remove=button('質問を削除',()=>{draft.splice(index,1);drawFields()})
        remove.disabled=draft.length===1
        section.append(label,kind,required,identity,options,remove)
        return section
      }))
      const add=button('質問を追加',()=>{draft.push(blankField());drawFields()})
      add.disabled=draft.length>=12
      fieldsRoot.append(add)
    }
    drawFields()
    const title=field('フォーム名','title','text',existing?.title)
    title.querySelector('input').required=true
    const node=form([title,field('案内文','description','textarea',existing?.description),fieldsRoot,
      field('LINE内で公開する','published','checkbox',existing?.published)],'フォームを保存',async (values,key)=>{
      await api(path+'/forms','PUT',{id:existing?.id,channel:choice.value,revision:existing?.revision??0,title:values.title,
        description:values.description,published:values.published==='on',
        fields:draft.map(entry=>({...entry,options:entry.kind==='choice'?entry.options.map(option=>option.trim()).filter(Boolean):[]}))},key)
      await refresh('フォームを保存しました。')
    })
    editor.replaceChildren(node)
    if(existing?.published){
      editor.prepend(el('p','公開中のフォームは、LINEトークで送られる専用URL（来店予約・設定／面談予約のリンク）から回答できます。'+
        '送信先ごとに発行されるURLのため、ここに固定リンクは表示しません。','muted'))
    }
  }
  const pickForms=()=>{
    const saved=data.forms.filter(form=>form.channel_id===choice.value)
    active.replaceChildren(new Option('新規フォーム',''),...saved.map(form=>new Option(form.title,form.id)))
    if(saved.length)active.value=saved[0].id
    show()
  }
  choice.onchange=pickForms
  active.onchange=show
  pickForms()
  root.append(picker,formPicker,editor)
}

function answersPanel(root,answers,store){
  root.append(el('h2','フォーム回答'))
  for(const answer of answers){
    const list=el('dl')
    for(const item of answer.answers)list.append(el('dt',item.label),el('dd',item.value||'未入力'))
    const row=details(answer.title+' · '+answer.label+' · '+dateLabel(answer.submitted_at,store.timezone),list)
    row.classList.add('record')
    root.append(row)
  }
  if(!answers.length)root.append(el('p','回答はまだありません。'))
}

function recruitment(root,records,store,path,refresh){
  root.append(el('h2','応募・選考管理'))
  for(const entry of records){
    const row=el('article',null,'record')
    row.append(el('h3',entry.applicant_name??('応募者 '+entry.id.slice(0,8))),
      el('p',entry.label+' · '+stages[entry.stage]+(entry.source?' · '+entry.source:'')))
    if(entry.interview_at)row.append(el('p','面談 '+dateLabel(entry.interview_at,store.timezone)+(entry.interview_status==='cancelled'?'（取消）':'')))
    if(entry.trial_at)row.append(el('p','体入 '+dateLabel(entry.trial_at,store.timezone)))
    if(allowed[entry.stage].length){
      const stage=field('次の状態','stage','',allowed[entry.stage][0],allowed[entry.stage].map(key=>[key,stages[key]]))
      const trial=field('体入日時（店舗時刻）','trial_at','datetime-local')
      const select=stage.querySelector('select')
      const update=()=>{trial.hidden=select.value!=='trial_scheduled';trial.querySelector('input').required=!trial.hidden}
      select.onchange=update
      update()
      row.append(details('進捗を変更',form([stage,trial],'進捗を保存',async data=>{
        const time=data.stage==='trial_scheduled'?localInstant(data.trial_at,store.timezone):null
        if(data.stage==='trial_scheduled'&&time===null)throw new Error('体入日時を指定してください。')
        await api(path+'/'+entry.id,'PATCH',{revision:entry.revision,stage:data.stage,trial_at:time===null?null:new Date(time).toISOString()})
        await refresh('進捗を保存しました。')
      })))
    }
    root.append(row)
  }
  if(!records.length)root.append(el('p','応募はまだありません。'))
}

function sources(root,report,path,refresh,use){
  root.append(el('h2','流入分析'),el('p','直近30日間に、経路リンクを開いてLINEの本人確認を完了した人数を集計します。'))
  if(report.channels.length)root.append(form([
    field('経路名','label'),field('公式LINE','channel','',report.channels[0].id,channelOptions(report.channels)),
  ],'経路リンクを発行',async data=>{await api(path+'/sources','POST',data);await refresh('経路リンクを発行しました。')}))
  for(const entry of report.entries){
    const row=el('article',null,'record')
    row.append(el('h3',entry.label),el('p',entry.channel_label+(entry.active?' · 集計中':' · 停止中')),
      el('p','本人確認 '+entry.opened+'人 · 回答 '+entry.forms+'人 · 予約 '+entry.booked+'人'+
        (use==='recruitment'?' · 面談実施 '+entry.interviewed+'人 · 体入 '+entry.trials+'人 · 入店 '+entry.hired+'人':'')))
    const link=el('input')
    link.type='url'
    link.readOnly=true
    link.value=entry.url
    link.setAttribute('aria-label',entry.label+'の流入リンク')
    const qr=el('div')
    row.append(link,controls(button('リンクをコピー',async()=>{await navigator.clipboard.writeText(entry.url);notice('リンクをコピーしました。')}),
      button('QRコードを表示',async()=>{
        const data=await api(path+'/sources/'+entry.id+'/qr')
        const image=el('img')
        image.src=data.image
        image.width=210
        image.height=210
        image.alt=entry.label+'の流入QRコード'
        const download=el('a','QRコードを保存')
        download.href=data.image
        download.download='night-pro-line-'+entry.id+'.png'
        qr.replaceChildren(image,download)
      }),
      button(entry.active?'計測を停止':'計測を再開',async()=>{
        await api(path+'/sources/'+entry.id,'PATCH',{active:!entry.active});await refresh('経路を更新しました。')
      })),qr)
    root.append(row)
  }
  if(!report.entries.length)root.append(el('p','発行した経路リンクはまだありません。'))
}

function campaigns(root,data,store,path,refresh){
  root.append(el('h2','絞り込み配信'),
    el('p','販促に同意し、20歳以上の確認が済んだ友だちが対象です。送信の承認前に対象人数を確認できます。'))
  if(data.channels.length){
    const filters=field('保存したタグ条件','filter','', '',[['','指定なし'],...data.filters.map(filter=>[filter.name,filter.name])])
    const time=field('配信予定（店舗時刻）','scheduled_at','datetime-local')
    time.querySelector('input').required=true
    root.append(details('配信を準備する',form([
      field('公式LINE','channel','',data.channels[0].id,channelOptions(data.channels)),
      field('管理用の件名','title'),field('LINEに送る本文','body','textarea'),filters,
      field('最終来店からの日数（任意）','last_visit_days','number'),time,
      field('送信可能時間の開始','windowStart','time','18:00'),
      field('送信可能時間の終了','windowEnd','time','23:00'),
    ],'送信対象を確認',async (values,key)=>{
      const time=localInstant(values.scheduled_at,store.timezone)
      if(time===null)throw new Error('配信予定を指定してください。')
      const selected=data.filters.find(filter=>filter.name===values.filter)
      const result=await api(path,'POST',{channel:values.channel,title:values.title,body:values.body,scheduled_at:new Date(time).toISOString(),
        criteria:{tags:selected?.tags??[],match:selected?.match??'all',last_visit_days:values.last_visit_days?Number(values.last_visit_days):null,
          assigned_to:null,windowStart:values.windowStart,windowEnd:values.windowEnd}},key)
      await refresh(result.eligible+'人の配信候補を確認しました。')
    })))
  }
  const states={draft:'承認待ち',approved:'承認済み',stopped:'停止済み'}
  for(const entry of data.entries){
    const counts=entry.counts,queued=counts.queued??0
    const row=el('article',null,'record')
    row.append(el('h3',entry.title),el('p',entry.channel_label+' · '+states[entry.state]+' · '+dateLabel(entry.scheduled_at,store.timezone)),
      el('p',entry.body,'wrap'),el('p','待機 '+queued+'人 · LINE受付 '+(counts.accepted??0)+'人 · 取消 '+(counts.cancelled??0)+
      '人 · 失敗 '+(counts.failed??0)+'人 · 結果不明 '+(counts.unknown??0)+'人'))
    const reasons=Object.entries(entry.exclusions).map(([reason,count])=>reason+' '+count+'人')
    if(reasons.length)row.append(el('p','候補から除外 · '+reasons.join(' · ')))
    if(entry.state==='draft'&&queued)row.append(form([field(queued+'人への送信を承認','approved','checkbox')],
      '承認して配信を予約',async values=>{
        if(values.approved!=='on')throw new Error('対象人数を確認してチェックしてください。')
        await api(path+'/'+entry.id+'/approve','POST',{recipients:queued,approved:true});await refresh('配信を承認しました。')
      }))
    if(entry.state!=='stopped')row.append(button('配信を停止',async()=>{
      await api(path+'/'+entry.id+'/stop','POST',{});await refresh('配信を停止しました。')
    }))
    root.append(row)
  }
  if(!data.entries.length)root.append(el('p','配信はまだありません。'))
}

function richMenus(root,entries,path,refresh,use){
  root.append(el('h2','リッチメニュー切り替え'),
    el('p','公式LINEのMessaging APIで作成したリッチメニューを、本人確認と予約の状態に合わせて表示します。確定時のIDを省くと通常時の設定を使います。通常時のIDを省くと公式LINEの既定メニューに戻します。'))
  for(const entry of entries){
    const row=el('article',null,'record')
    row.append(el('h3',entry.label),el('p','切替済み '+entry.linked+'人'+(entry.verified?'':' · メニュー未照合')))
    row.append(form([
      field('通常時のメニューID','base_menu','text',entry.base_menu),
      field(use==='recruitment'?'面談が確定しているときのメニューID':'来店予約が確定しているときのメニューID','booked_menu','text',entry.booked_menu),
    ],'LINEで確認して保存',async values=>{
      await api(path+'/rich-menus','PUT',{channel:entry.id,revision:entry.revision,
        base_menu:values.base_menu.trim()||null,booked_menu:values.booked_menu.trim()||null})
      await refresh('リッチメニュー設定を保存しました。')
    }))
    root.append(row)
  }
  if(!entries.length)root.append(el('p','対象の公式LINEを先に登録してください。'))
}
const results={queued:'待機中',submitting:'送信中',accepted:'LINE受付済み',cancelled:'停止・対象外',failed:'失敗',unknown:'結果不明'}
function deliveries(root,entries,store){
  const kinds={interview_confirm:'面談確定',interview_reminder:'面談前日',interview_waitlist:'空き枠案内',chat_reply:'個別返信'}
  root.append(el('h2','LINE送信履歴'))
  for(const entry of entries){
    const date=entry.accepted_at??entry.first_attempt_at??entry.next_at
    const when=Number.isFinite(Date.parse(date))?dateLabel(date,store.timezone):''
    root.append(el('p',[kinds[entry.kind],results[entry.status],when,entry.reason].filter(Boolean).join(' · '),'record'))
  }
  if(!entries.length)root.append(el('p','送信の記録はまだありません。'))
}
function checks(root,entries){
  root.append(el('h2','運用チェック'))
  if(!entries.length){root.append(el('p','現在の設定と処理履歴から、確認が必要な項目は見つかりませんでした。'));return}
  for(const entry of entries){
    const row=el('p',entry.text,'record')
    if(entry.section==='connection'||entry.section==='interviews'){
      const link=el('a','設定を開く')
      link.href=$(entry.section==='interviews'?'#interviews':'#back').href
      row.append(' ',link)
    }else row.append(' ',button('詳細を開く',async()=>{current=entry.section;await render()}))
    root.append(row)
  }
}
function inbox(root,data,store,path,refresh,intake=false){
  root.append(el('h2',intake?'兼用LINEの受付保留':'LINE受信箱'))
  if(intake)root.append(el('p','兼用の公式LINEに届いたメッセージは、用途を確認してから該当する受信箱に移します。'))
  root.append(el('p','店長に返信を頼むときは、会話を開いて「店長へ引き継ぐ」を選びます。'))
  const states={open:'未対応',handling:'対応中',resolved:'対応済み'}
  const state=field('対応状態','state','','',[['','すべて'],...Object.entries(states)])
  const unread=field('未確認だけ表示','unread','checkbox')
  const selector=state.querySelector('select'),onlyUnread=unread.querySelector('input')
  const rows=el('div')
  function renderThreads(){
    rows.replaceChildren()
    for(const thread of data.threads){
      if(selector.value&&thread.state!==selector.value||onlyUnread.checked&&!thread.unread)continue
      const sender=thread.name??('会話 '+thread.id.slice(0,8))
      const panel=el('div')
      panel.append(el('p',store.name+' · '+thread.label+' · '+sender))
      const chat=el('div')
      const threadPath=path+'/'+thread.id
      const handoff=thread.handoff_until && Date.parse(thread.handoff_until)>Date.now()
      const title=[thread.unread?'未確認':null,sender,handoff?'店長対応中':states[thread.state],dateLabel(thread.last_received_at,store.timezone)].filter(Boolean).join(' · ')
      panel.append(chat)
      if(['admin','manager'].includes(actor.role)){
        const box=el('section',null,'record')
        if(handoff){
          const link=el('a','LINE公式アカウントのチャット管理を開く','studio-link')
          link.href='https://manager.line.biz/'
          link.target='_blank'
          link.rel='noopener noreferrer'
          box.append(el('strong','店長対応中 · '+dateLabel(thread.handoff_until,store.timezone)+'まで'),
            el('p','店長はLINE公式アカウントアプリでこのトークに返信します。期限が来ると自動対応に戻ります。'),
            controls(button('店長対応を終了する',async()=>{
              await api(threadPath+'/handoff','PATCH',{revision:thread.revision,minutes:null})
              await refresh('店長対応を終了しました。')
            }),link))
        }else{
          box.append(el('p','この相手への自動配信を一時停止します。停止中の配信は見送ります。'),
            form([field('引き継ぎ時間','minutes','','30',[[15,'15分'],[30,'30分'],[60,'1時間'],[120,'2時間']])],
              '店長へ引き継ぐ',async values=>{
                const result=await api(threadPath+'/handoff','PATCH',{revision:thread.revision,minutes:Number(values.minutes)})
                await refresh(dateLabel(result.handoff_until,store.timezone)+'まで店長に引き継ぎました。')
              }))
        }
        panel.append(box)
      }
      if(intake){
        panel.append(form([field('振り分け先','purpose','','customer',[['customer','顧客'],['recruitment','採用']]),field('分類の根拠','reason')],
          '受信箱へ振り分ける',async values=>{
            await api(threadPath,'PATCH',{...values,revision:thread.revision});await refresh('会話を振り分けました。')
          }))
      }else if(!handoff){
        const choices=[['','未割当'],...data.staff.map(person=>[person.id,person.id===actor.id?'自分':person.email])]
        panel.append(button('自分が担当する',async()=>{
          await api(threadPath,'PATCH',{revision:thread.revision,state:'handling',assigned_to:actor.id})
          await refresh('自分に割り当てました。')
        }))
        const process=form([field('対応状態','state','',thread.state,Object.entries(states)),
          field('担当者','assigned_to','',thread.assigned_to,choices)],'担当・状態を保存',async values=>{
          await api(threadPath,'PATCH',{revision:thread.revision,state:values.state,assigned_to:values.assigned_to||null})
          await refresh('対応状態を保存しました。')
        })
        panel.append(details('担当者と状態を変更',process))
        if(thread.assigned_to===actor.id&&thread.state==='handling'){
          const reply=internal=>form([field(internal?'内部メモ':'返信する本文','body','textarea')],internal?'内部メモを保存':'公式LINEから送信',async (values,key)=>{
            await api(threadPath,'POST',{revision:thread.revision,body:values.body,internal},key)
            await refresh(internal?'内部メモを保存しました。':'返信を送信待ちに登録しました。')
          })
          panel.append(reply(false),details('内部メモ',reply(true)))
        }
      }
      const row=details(title,panel)
      row.classList.add('record')
      row.ontoggle=async()=>{
        if(!row.open){if(openThread===threadPath)openThread=undefined;return}
        openThread=threadPath
        chat.replaceChildren(el('p','読み込み中…'))
        try{
          const messages=await api(threadPath)
          chat.replaceChildren(...messages.map(message=>{
            const note=el('article',null,'record')
            const direction={incoming:'受信',outgoing:'公式LINEからの返信',internal:'内部メモ'}[message.direction]
            note.append(el('b',[direction,dateLabel(message.happened_at,store.timezone),results[message.status],message.staff].filter(Boolean).join(' · ')),
              el('p',message.withdrawn?'送信取消':message.body??'添付・非テキストメッセージ','wrap'))
            return note
          }))
          if(!messages.length)chat.append(el('p','表示できるメッセージがありません。'))
        }catch(error){chat.replaceChildren(el('p',error.message))}
      }
      row.open=openThread===threadPath
      rows.append(row)
    }
    if(!rows.childElementCount)rows.append(el('p','該当する会話はありません。'))
  }
  selector.onchange=renderThreads
  onlyUnread.onchange=renderThreads
  root.append(controls(state,unread),rows)
  renderThreads()
}

async function render(){
  const marker=++view
  const store=stores.find(entry=>entry.id===$('#store').value)
  if(!store)throw new Error('利用できる店舗がありません。')
  const use=$('#use').value
  const base='/stores/'+store.id
  const path=base+'/workflows/'+use
  const query=new URLSearchParams({store:store.id,use})
  history.replaceState(null,'','?'+query)
  $('#back').href=workspacePath('/staff/?store='+store.id)
  $('#interviews').href=workspacePath('/interview/staff.html?store='+store.id)
  $('#customers').href=workspacePath('/operations/?store='+store.id)
  const content=$('#content')
  const tabs=$('#tabs')
  content.replaceChildren(el('p','読み込み中…'))
  tabs.replaceChildren()
  const settings=await api(path+'/settings')
  if(marker!==view)return
  const sections=[]
  if(!agency){
    if(settings.forms_enabled)sections.push(['forms','回答フォーム'],['responses','フォーム回答'])
    if(use==='recruitment'&&settings.recruitment_enabled)sections.push(['recruitment','応募・選考'])
    if(settings.sources_enabled)sections.push(['sources','流入分析'])
    if(use==='customer'&&settings.campaigns_enabled)sections.push(['campaigns','絞り込み配信'])
    if(settings.rich_menus_enabled)sections.push(['rich-menus','リッチメニュー'])
  }
  if(settings.inbox_enabled)sections.push(['inbox','LINE受信箱'])
  if(!agency&&use==='customer'&&settings.inbox_enabled)sections.push(['intake','受付保留'])
  if(settings.inbox_enabled||use==='recruitment'&&(settings.reminders_enabled||settings.waitlist_enabled))sections.push(['delivery','LINE送信履歴'])
  if(!sections.length){content.replaceChildren(el('p','この店舗で有効な機能はありません。法人管理者が「店舗で使う機能」から設定できます。'));return}
  if(!agency)sections.unshift(['checks','運用チェック'])
  if(!sections.some(([id])=>id===current))current=sections[0][0]
  for(const [key,label] of sections){
    const tab=button(label,async()=>{current=key;notice();await render()})
    if(current===key)tab.setAttribute('aria-current','page')
    tabs.append(tab)
  }
  const key=current
  const data=await api(['recruitment','campaigns','intake'].includes(key)?base+'/'+key:path+'/'+key)
  if(marker!==view)return
  const panel=el('div')
  const refresh=async message=>{if(marker===view){await render();notice(message)}}
  if(key==='forms')formEditor(panel,data,path,refresh,use)
  if(key==='responses')answersPanel(panel,data,store)
  if(key==='recruitment')recruitment(panel,data,store,base+'/recruitment',refresh)
  if(key==='sources')sources(panel,data,path,refresh,use)
  if(key==='campaigns')campaigns(panel,data,store,base+'/campaigns',refresh)
  if(key==='rich-menus')richMenus(panel,data,path,refresh,use)
  if(key==='inbox'||key==='intake')inbox(panel,data,store,key==='inbox'?path+'/inbox':base+'/intake',refresh,key==='intake')
  if(key==='delivery')deliveries(panel,data,store)
  if(key==='checks')checks(panel,data)
  content.replaceChildren(panel)
}

async function start(){
  const session=await api('/session')
  agency=session.actor.agency===true
  if(agency){
    $('#customers').hidden=true
    $('#use').closest('label').hidden=true
  }
  actor=session.actor
  stores=session.stores
  $('#store').append(...stores.map(store=>new Option(store.name,store.id)))
  const query=new URLSearchParams(location.search)
  if(stores.some(store=>store.id===query.get('store')))$('#store').value=query.get('store')
  const use=$('#use')
  if(session.actor.role==='recruiter'){
    use.value='recruitment'
    use.disabled=true
    $('#customers').hidden=true
  }else if(['admin','manager'].includes(session.actor.role)){
    if(agency||query.get('use')==='recruitment')use.value='recruitment'
  }else throw new Error('この業務を利用できる権限がありません。')
  for(const input of [$('#store'),use])input.onchange=()=>{notice();render().catch(error=>notice(error.message,true))}
  await render()
}
start().catch(error=>notice(error.message,true))
