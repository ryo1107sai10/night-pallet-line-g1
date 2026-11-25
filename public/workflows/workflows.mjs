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
const initialQuery=new URLSearchParams(location.search)
let stores,current=initialQuery.get('tab'),openThread,refreshOpenChat,refreshInboxList,agency=false,view=0
let onlyFailures=initialQuery.get('failures')==='1'
let onlyUnanswered=initialQuery.get('unanswered')==='1'
const replyDrafts=new Map()
let actor
let tagFilters={include:[],exclude:[],match:'all',page:1,store:null}

function formEditor(root,data,path,refresh,use){
  root.append(el('h2',use==='recruitment'?'応募フォーム':'回答フォーム'))
  if(!data.channels.length){root.append(el('p','先にこの用途の公式LINEを登録してください。'));return}
  const picker=field('公式LINE','channel','',data.channels.find(c=>c.id===initialQuery.get('channel'))?.id??data.channels[0].id,channelOptions(data.channels))
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

function checkedGroup(title,entries,prefix,selected=[]){
  const group=el('fieldset',null,'tag-check-grid')
  group.append(el('legend',title))
  for(const [key,label] of entries)group.append(field(label,prefix+key,'checkbox',selected.includes(key)))
  return group
}
const selectedKeys=(values,prefix)=>Object.keys(values).filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length))
function tagManager(root,data,store,path,refresh){
  root.append(el('h2','採用タグ・絞り込み配信'),el('p',store.name+'専用。顧客タグや他店舗の応募者とは分かれています。'))
  const toggle=button(data.enabled?'この店舗の採用タグ機能を停止':'採用タグ機能を有効にする',async()=>{
    if(data.enabled&&!confirm('タグを使う自動配信と絞り込み配信を停止します。タグの記録は保持します。よろしいですか？'))return
    await api(path+'/settings','PATCH',{revision:data.revision,enabled:!data.enabled})
    tagFilters={...tagFilters,include:[],exclude:[],page:1}
    await refresh(data.enabled?'採用タグ機能を停止しました。':'採用タグ機能を有効にしました。')
  })
  root.append(controls(toggle))
  if(!data.enabled){root.append(el('p','現在は停止中です。既存のタグ・配信履歴は保存されています。','muted'));return}
  const active=data.definitions.filter(t=>t.active), options=active.map(t=>[t.tag_key,t.label]), labels=Object.fromEntries(options), events=Object.entries(data.events)
  const ruleForm=entry=>form([
    field('タグ名','label','text',entry?.label??''),field('分類','category','',entry?.category??'その他',data.categories.map(c=>[c,c])),
    checkedGroup('自動的に付けるタイミング',events,'add_',entry?.add_events??[]),checkedGroup('自動的に外すタイミング',events,'remove_',entry?.remove_events??[]),
    field('タグを有効にする','active','checkbox',entry?.active??true)
  ],entry?'設定を保存':'タグを追加',async values=>{
    await api(path+'/definitions','PUT',{...(entry?{key:entry.tag_key}:{}),revision:entry?.revision??0,label:values.label,category:values.category,
      add_events:selectedKeys(values,'add_'),remove_events:selectedKeys(values,'remove_'),active:!!values.active})
    tagFilters={...tagFilters,include:[],exclude:[],page:1}
    await refresh('タグ設定を保存しました。')
  })
  function templateLink(key=''){const link=el('a',key?'このタグのステップテンプレート':'採用タグ別テンプレートを選ぶ','studio-link tag-template-link');const query=new URLSearchParams({store:store.id,'tag-template':key});link.href=workspacePath('/studio/?'+query);return link}
  root.append(controls(templateLink()))
  const catalog=el('section',null,'record');catalog.append(el('h3','タグの登録・自動ルール'),el('p','標準タグは自由に名称・分類・付与条件を変更できます。無効化すると新規配信の条件から外れます。'),details('新しいタグを追加',ruleForm(null)))
  for(const category of data.categories){
    const list=el('div')
    for(const t of data.definitions.filter(t=>t.category===category)){
      const item=el('div',null,'tag-rule-item')
      item.append(el('p',[t.add_events.length?'自動付与：'+t.add_events.map(e=>data.events[e]).join('、'):'手動・ステップで付与',t.remove_events.length?'自動解除：'+t.remove_events.map(e=>data.events[e]).join('、'):''].filter(Boolean).join(' · '),'muted'),details('ルールを編集',ruleForm(t)))
      if(t.active)item.append(templateLink(t.tag_key))
      list.append(details(t.label+(t.active?'':'（無効）'),item))
    }
    catalog.append(details(category+'（'+data.definitions.filter(t=>t.category===category).length+'件）',list))
  }
  root.append(catalog)
  const filters=el('section',null,'record');filters.append(el('h3','応募者を絞り込む'),form([
    field('タグ条件','match','',tagFilters.match,[['all','すべてのタグを持つ（AND）'],['any','いずれかのタグを持つ（OR）']]),
    details('含めるタグ（'+tagFilters.include.length+'件選択）',checkedGroup('含めるタグ',options,'inc_',tagFilters.include)),details('除外するタグ（'+tagFilters.exclude.length+'件選択）',checkedGroup('除外するタグ',options,'exc_',tagFilters.exclude))
  ],'絞り込む',async values=>{tagFilters={...tagFilters,include:selectedKeys(values,'inc_'),exclude:selectedKeys(values,'exc_'),match:values.match,page:1};await refresh('対象を絞り込みました。')}),
    button('条件をクリア',async()=>{tagFilters={...tagFilters,include:[],exclude:[],page:1};await refresh()}))
  root.append(filters)
  const subjects=el('section',null,'record');subjects.append(el('h3','応募者・採用友だち '+data.total+'件'),el('p','LINE通知の同意がある応募者だけが自動配信の対象です。公開予約の応募者もタグで整理でき、LINE未接続の場合は送信されません。','muted'))
  for(const person of data.subjects){
    const card=el('article',null,'tag-subject');card.append(el('h4',person.applicant_name||'採用友だち '+person.id.slice(0,8)),el('p',person.channel_label+' · '+(person.stage?stages[person.stage]:person.interview_status==='confirmed'?'面談予約':person.interview_status==='cancelled'?'面談取消':'未応募')+' · '+(person.notices?'LINE通知同意あり':'LINE通知未同意・連携なし'),'muted'))
    const pills=el('div',null,'tag-pills');for(const key of person.tags)pills.append(el('span',labels[key]??key,'tag-pill'));if(!person.tags.length)pills.append(el('span','タグなし','muted'));card.append(pills)
    card.append(details('タグを編集',form([checkedGroup('付与するタグ',options,'tag_',person.tags)],'タグを保存',async values=>{await api(path+'/subjects/'+person.id,'PATCH',{revision:person.revision,tags:selectedKeys(values,'tag_')});await refresh('応募者のタグを保存しました。')})))
    subjects.append(card)
  }
  const pages=controls(button('前のページ',async()=>{if(tagFilters.page>1){tagFilters.page--;await refresh()}}),el('span',data.page+' / '+Math.max(1,Math.ceil(data.total/60))),button('次のページ',async()=>{if(tagFilters.page*60<data.total){tagFilters.page++;await refresh()}}));pages.firstChild.disabled=data.page===1;pages.lastChild.disabled=data.page*60>=data.total;subjects.append(pages);root.append(subjects)
  const send=el('section',null,'record');send.append(el('h3','タグ絞り込み配信'),el('p','ステップ配信で開始イベント「タグ絞り込み配信（手動）」を選んで公開したシナリオを使います。選択中のタグ条件を使い、対象人数を確認してから開始します。'))
  if(!data.scenarios.length){const link=el('a','ステップ配信を開く','studio-link');link.href=workspacePath('/studio/?store='+encodeURIComponent(store.id));send.append(link)}
  else{
    const confirmation=el('div')
    send.append(form([field('公開済みシナリオ','scenario','',data.scenarios[0].id,data.scenarios.map(s=>[s.id,s.name+' / '+s.channel_label+' (版 '+s.published_version+')']))], '配信対象を確認',async values=>{
      confirmation.replaceChildren();const criteria={include:[...tagFilters.include],exclude:[...tagFilters.exclude],match:tagFilters.match};const input={scenario:values.scenario,criteria}
      const result=await api(path+'/campaigns/preview','POST',input)
      confirmation.append(el('p',result.name+' · 版 '+result.version+'：配信対象 '+result.eligible+'人、同意・友だち・対応状態などで除外 '+result.excluded+'人'))
      const sendKey=crypto.randomUUID()
      if(!result.ready)confirmation.append(el('p','対象の照合は完了しました。契約・自動配信・公式LINEの検収が必要なため、実際の配信は開始できません。','muted'))
      if(result.ready&&result.eligible)confirmation.append(button(result.eligible+'人への配信を開始',async()=>{if(!confirm('表示の対象へ実際のLINEメッセージを配信します。開始しますか？'))return;const queued=await api(path+'/campaigns','POST',{...input,fingerprint:result.fingerprint},sendKey);await refresh(queued.queued+'人への配信を受け付けました。')}))
    }),confirmation)
  }
  for(const campaign of data.campaigns){const card=el('article',null,'tag-subject');card.append(el('h4',campaign.title),el('p',dateLabel(campaign.created_at,store.timezone)+' · 対象 '+campaign.recipients+'人 · 未処理 '+campaign.pending+' · 実行中 '+campaign.running+' · 終了 '+campaign.finished+' · LINE受付 '+campaign.accepted+'通'+(campaign.stopped?' · 停止済':'')))
    if(!campaign.stopped&&(campaign.pending||campaign.running))card.append(button('配信を停止',async()=>{if(!confirm('この絞り込み配信の残りを停止しますか？'))return;await api(path+'/campaigns/'+campaign.id+'/stop','POST',{});await refresh('配信を停止しました。')}));send.append(card)}
  root.append(send)
}

function sources(root,report,path,refresh,use){
  root.append(el('h2','流入分析'),el('p','経路リンクまたはQRからLINEを開き、表示されたメッセージを送信して個人別の予約リンクを開いた人を集計します。集計期間は直近30日間です。'))
  if(report.channels.length)root.append(form([
    field('経路名','label'),field('公式LINE','channel','',report.channels[0].id,channelOptions(report.channels)),
  ],'経路リンクを発行',async data=>{await api(path+'/sources','POST',data);await refresh('経路リンクを発行しました。')}))
  for(const entry of report.entries){
    const row=el('article',null,'record')
    row.append(el('h3',entry.label),el('p',entry.channel_label+(entry.active?' · 集計中':' · 停止中')),
      el('p','本人確認 '+entry.opened+'人 · 回答 '+entry.forms+'人 · 予約 '+entry.booked+'人'+
        (use==='recruitment'?' · 面談実施 '+entry.interviewed+'人 · 体入 '+entry.trials+'人 · 入店 '+entry.hired+'人':'')))
    const qr=el('div')
    if(entry.url){
      const link=el('input')
      link.type='url'
      link.readOnly=true
      link.value=entry.url
      link.setAttribute('aria-label',entry.label+'の流入リンク')
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
        })),qr)
    }else row.append(el('p','公式LINEの@IDが未確認です。接続確認後にリンクとQRコードを発行できます。','muted'))
    const postback=el('input')
    postback.readOnly=true
    postback.value=entry.postback
    postback.setAttribute('aria-label',entry.label+'のリッチメニュー用データ')
    row.append(el('p','リッチメニューで使うデータ','muted'),postback,controls(
      button('データをコピー',async()=>{await navigator.clipboard.writeText(entry.postback);notice('リッチメニュー用データをコピーしました。')}),
      button(entry.active?'計測を停止':'計測を再開',async()=>{
        await api(path+'/sources/'+entry.id,'PATCH',{active:!entry.active});await refresh('経路を更新しました。')
      })))
    if(use==='recruitment'&&entry.active&&entry.url){
      const proof=el('div'),test=el('section',null,'record')
      test.append(el('h4','テスター専用の流入確認'),el('p','接続テストの本人確認を行った方がこの流入QRまたはリンクを開き、LINEで表示された文を送信してください。通常配信を開始せず、その受信者1人にだけ個人別テストURLを送れます。'))
      const open=el('a','公式LINE接続を開く');open.href=workspacePath('/agency-line/?store='+new URLSearchParams(location.search).get('store'))
      test.append(open,button('QR経由の受信を確認',async()=>{
        proof.replaceChildren();const result=await api(path+'/sources/'+entry.id+'/testers')
        for(const row of result.history)proof.append(el('p','検証送信 '+new Date(row.created_at).toLocaleString('ja-JP')+' · '+(results[row.status]??row.status)))
        if(!result.testers.length){proof.append(el('p','本人確認後にこの経路をLINEで送信した未使用テスターがいません。'));return}
        proof.append(form([field('テスター','tester','',result.testers[0].id,result.testers.map(t=>[t.id,new Date(t.verified_at).toLocaleString('ja-JP')+' に本人確認']))],'テスター1人に検証URLを送信',async(values,key)=>{
          if(!confirm('本人確認済みの選択したテスター1人にだけ、検証URLを1通送信します。よろしいですか？'))return
          await api(path+'/sources/'+entry.id+'/test','POST',{tester:values.tester},key)
          proof.append(el('p','検証送信を受け付けました。送信状況は受信確認ボタンで更新できます。'))
        }))
      }),proof);row.append(test)
    }
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
    const rules=(entry.tag_rules??[]).map(rule=>({...rule}))
    const editor=form([
      field('通常時のメニューID','base_menu','text',entry.base_menu),
      field(use==='recruitment'?'面談が確定しているときのメニューID':'来店予約が確定しているときのメニューID','booked_menu','text',entry.booked_menu),
    ],'LINEで確認して保存',async values=>{
      const payload={channel:entry.id,revision:entry.revision,base_menu:values.base_menu.trim()||null,booked_menu:values.booked_menu.trim()||null}
      if(entry.tags_enabled){
        if(rules.some(rule=>!rule.tag||!rule.menu.trim()))throw new Error('各ルールのタグとメニューIDを入力してください。')
        if(new Set(rules.map(rule=>rule.tag)).size!==rules.length)throw new Error('同じタグは1回だけ指定してください。')
        payload.tag_rules=rules.map(rule=>({tag:rule.tag,menu:rule.menu.trim()}))
      }
      await api(path+'/rich-menus','PUT',payload)
      await refresh('リッチメニュー設定を保存しました。')
    })
    if(use==='recruitment'){
      const template=el('section',null,'record')
      template.append(el('h3','標準メニューをLINEに作成'),el('p','メニューIDを調べなくても、公式LINEに予約用メニューを作成できます。作成ボタンでこの店舗の公式LINEにメニューを1件追加します。設定を保存するまでは友だちの表示は変更されません。'))
      const templateResult=el('p',null,'muted')
      for(const [variant,label,fieldName] of [['normal','対面面談を予約','base_menu'],['booked','面談予約を確認','booked_menu']]){
        const generateKey=crypto.randomUUID()
        template.append(button(label+'を作成',async()=>{
          const result=await api(path+'/rich-menus/'+entry.id+'/templates','POST',{variant},generateKey)
          editor.querySelector('[name='+fieldName+']').value=result.menu
          templateResult.textContent=label+'のメニューを作成しました。下の設定を保存してください。'
        }))
      }
      template.append(templateResult);editor.insertBefore(template,editor.querySelector('.fields'))
      const section=el('section',null,'record')
      section.append(el('h3','採用タグ別のメニュー'),el('p','上から優先されます。該当するタグがない場合は予約状態に応じた通常の設定になります。タグの追加・解除でも自動的に再判定します。'))
      if(entry.tags_enabled){
        const list=el('div')
        const redraw=()=>{
          list.replaceChildren()
          rules.forEach((rule,index)=>{
            const card=el('div',null,'tag-subject')
            const options=[['','タグを選択'],...(entry.tags??[]).map(tag=>[tag.tag_key,tag.label+(tag.active?'':'（無効）')])]
            if(rule.tag&&!options.some(([key])=>key===rule.tag))options.push([rule.tag,'未登録のタグ（変更してください）'])
            const tagPicker=field('優先順位 '+(index+1)+'：タグ','rule-tag-'+index,'text',rule.tag,options)
            const menuPicker=field('メニューID','rule-menu-'+index,'text',rule.menu)
            tagPicker.querySelector('select').onchange=e=>rule.tag=e.target.value
            menuPicker.querySelector('input').oninput=e=>rule.menu=e.target.value
            const up=button('上へ',()=>{[rules[index-1],rules[index]]=[rules[index],rules[index-1]];redraw()})
            const down=button('下へ',()=>{[rules[index+1],rules[index]]=[rules[index],rules[index+1]];redraw()})
            up.disabled=index===0;down.disabled=index===rules.length-1
            card.append(tagPicker,menuPicker,controls(up,down,button('削除',()=>{rules.splice(index,1);redraw()})))
            list.append(card)
          })
          if(rules.length<10)list.append(button('タグ別の切り替えを追加',()=>{rules.push({tag:'',menu:''});redraw()}))
        }
        redraw();section.append(list)
      }else section.append(el('p','採用タグ機能をオンにすると設定できます。保存済みのタグ別ルールは保持されます。','muted'))
      editor.insertBefore(section,editor.querySelector('button.primary'))
    }
    row.append(editor)
    if(use==='recruitment'){
      const test=el('section',null,'record'),status=el('div')
      test.append(el('h3','本人確認済みテスターで表示を確認'),el('p','公式LINE接続画面でテストコードを発行し、テスターがLINEトークに送信した後、続けてメッセージを1通送ります。通常配信の設定を変えず、選んだテスター1人だけに保存済みのルールを適用します。'))
      const open=el('a','公式LINE接続を開く');open.href=workspacePath('/agency-line/?store='+new URLSearchParams(location.search).get('store'))
      test.append(open,button('テスターを読み込む',async()=>{
        status.replaceChildren();const testers=await api(path+'/rich-menus/'+entry.id+'/testers')
        if(!testers.length){status.append(el('p','有効なテスターがいません。接続テストを開始してください。'));return}
        status.append(form([field('本人確認済みテスター','tester','',testers[0].id,testers.map(t=>[t.id,new Date(t.verified_at).toLocaleString('ja-JP')+' に本人確認']))],'テスター1人の表示を確認',async values=>{
          if(!confirm('選択したテスター1人のLINEリッチメニューだけを切り替えます。よろしいですか？'))return
          const result=await api(path+'/rich-menus/'+entry.id+'/test','POST',{tester:values.tester})
          status.append(el('p','LINEの現在のメニューを照合しました：'+(result.linked??'既定メニュー')+(result.matched?'（タグルール適用）':'（通常・予約状態）')))
        }))
      }),status);row.append(test)
    }
    root.append(row)
  }
  if(!entries.length)root.append(el('p','対象の公式LINEを先に登録してください。'))
}
const results={queued:'待機中',submitting:'送信中',accepted:'LINE受付済み',cancelled:'停止・対象外',failed:'失敗',unknown:'結果不明'}
function deliveries(root,entries,store,path,refresh){
  const kinds={interview_confirm:'面談確定',interview_reminder:'面談前日',interview_reminder_3h:'面談3時間前',intake_prompt:'応募トーク',interview_waitlist:'空き枠案内',chat_reply:'個別返信',
    interview_link:'面談予約リンク',customer_link:'来店予約リンク',step:'ステップ配信',campaign:'絞り込み配信'}
  root.append(el('h2','LINE送信履歴'))
  const failed=field('過去7日間のエラーだけ表示','failures','checkbox',onlyFailures)
  failed.querySelector('input').onchange=event=>{
    onlyFailures=event.target.checked
    void render().catch(error=>notice(error.message,true))
  }
  root.append(controls(failed,button('履歴を更新',()=>refresh('最新の送信履歴を表示しました。'))))
  for(const entry of entries){
    const date=entry.accepted_at??entry.first_attempt_at??entry.next_at
    const when=Number.isFinite(Date.parse(date))?dateLabel(date,store.timezone):''
    const row=el('article',null,'record')
    row.append(el('strong',[kinds[entry.kind],results[entry.status]].filter(Boolean).join(' · ')),
      el('p',[entry.label,when,entry.reason].filter(Boolean).join(' · ')))
    if(entry.status==='unknown')row.append(el('p','LINEのトークで届いているか確認してください。二重送信を防ぐため、結果不明のメッセージはこの画面から再送できません。'))
    if(entry.reason==='LINE認証に失敗しました')row.append(el('p','管理者に公式LINEの接続確認を依頼してください。'))
    if(entry.reason==='LINEが宛先または内容を受け付けませんでした')row.append(el('p','相手の利用状況と本文を確認してください。'))
    if(entry.status==='failed'&&entry.kind==='step'){
      const link=el('a','ステップ配信の設定を開く')
      link.href=workspacePath('/studio/?store='+store.id)
      row.append(link)
    }
    if(entry.retryable)row.append(button('再送する',async()=>{
      await api(path+'/delivery/'+entry.id+'/retry','POST',{})
      await refresh('再送を受け付けました。送信履歴で結果を確認できます。')
    }))
    root.append(row)
  }
  if(!entries.length)root.append(el('p',onlyFailures?'該当する送信エラーはありません。':'送信の記録はまだありません。'))
}

function templateEditor(root,templates,path,refresh){
  const templateFields=(entry={})=>[field('名前','label','text',entry.label),field('本文','body','textarea',entry.body)]
  const pane=el('div')
  pane.append(form(templateFields(),'定型文を追加',async(data,key)=>{
    await api(path,'POST',data,key)
    await refresh('定型文を追加しました。')
  }))
  for(const entry of templates){
    const item=el('div')
    item.append(form(templateFields(entry),'変更を保存',async data=>{
      await api(path+'/'+entry.id,'PATCH',{...data,revision:entry.revision})
      await refresh('定型文を更新しました。')
    }),button('この定型文の使用を終了する',async()=>{
      await api(path+'/'+entry.id,'DELETE',{revision:entry.revision})
      await refresh('定型文の使用を終了しました。')
    }))
    pane.append(details(entry.label,item))
  }
  root.append(details('この店舗の定型文を管理',pane))
}
function acquisitionSettings(settings,path,refresh){
  const pane=el('section',null,'record')
  pane.append(el('h3','店舗の採用機能設定'),el('p','エールのマスターは、この店舗の流入分析とリッチメニューを切り替えられます。通常の自動配信や契約状態は変更しません。'))
  pane.append(form([field('流入分析を有効にする','sources','checkbox',settings.sources_enabled),field('リッチメニューを有効にする','menus','checkbox',settings.rich_menus_enabled)],'機能設定を保存',async values=>{
    await api(path+'/settings/acquisition','PATCH',{revision:settings.revision,sources_enabled:values.sources==='on',rich_menus_enabled:values.menus==='on'})
    await refresh('店舗の採用機能設定を保存しました。')
  }))
  return pane
}
function checks(root,entries,store){
  root.append(el('h2','運用チェック'))
  if(!entries.length){root.append(el('p','現在の設定と処理履歴から、確認が必要な項目は見つかりませんでした。'));return}
  for(const entry of entries){
    const row=el('p',entry.text,'record')
    if(entry.section==='connection'||entry.section==='interviews'){
      const link=el('a','設定を開く')
      link.href=entry.section==='connection'&&agency&&actor.role==='admin'?'/agency-line/?store='+encodeURIComponent(store.id):$(entry.section==='interviews'?'#interviews':'#back').href
      row.append(' ',link)
    }else if(entry.section==='studio'){const link=el('a','ステップ配信を開く');link.href=workspacePath('/studio/?store='+store.id);row.append(' ',link)}
    else if(entry.section==='contract'){row.append(el('p','正式な契約・運用許可を確認し、北村さんの管理画面から設定してください。','muted'))}
    else row.append(' ',button('詳細を開く',async()=>{current=entry.section;await render()}))
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
  const unanswered=field('未返信だけ表示','unanswered','checkbox',onlyUnanswered)
  const selector=state.querySelector('select'),onlyUnread=unread.querySelector('input'),needsReply=unanswered.querySelector('input')
  const rows=el('div')
  const empty=el('p','該当する会話はありません。')
  const records=new Map()
  let loadingList=false
  if(!intake)templateEditor(root,data.templates,path+'/templates',refresh)

  function threadTitle(thread){
      const sender=thread.name??('会話 '+thread.id.slice(0,8))
      const handoff=thread.handoff_until && Date.parse(thread.handoff_until)>Date.now()
      return [thread.unread?'新着':null,sender,handoff?'店長対応中':states[thread.state],
        dateLabel(thread.last_received_at,store.timezone)].filter(Boolean).join(' · ')
  }
  function threadRow(thread){
      const sender=thread.name??('会話 '+thread.id.slice(0,8))
      const panel=el('div')
      panel.append(el('p',store.name+' · '+thread.label+' · '+sender))
      const chat=el('div')
      const threadPath=path+'/'+thread.id
      const handoff=thread.handoff_until && Date.parse(thread.handoff_until)>Date.now()
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
        panel.append(form([field('振り分け先','purpose','',agency?'recruitment':'customer',agency?[['recruitment','採用']]:[['customer','顧客'],['recruitment','採用']]),field('分類の根拠','reason')],
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
          const reply=(internal,draft='')=>form([field(internal?'内部メモ':'返信する本文','body','textarea',draft)],
            internal?'内部メモを保存':thread.label+'から送信',async (values,key)=>{
            await api(threadPath,'POST',{revision:thread.revision,body:values.body,internal},key)
            if(!internal)replyDrafts.delete(threadPath)
            await refresh(internal?'内部メモを保存しました。':'返信を送信待ちに登録しました。')
          })
          const composer=reply(false,replyDrafts.get(threadPath))
          const body=composer.elements.body
          body.maxLength=3500
          body.required=true
          body.oninput=()=>{
            if(body.value)replyDrafts.set(threadPath,body.value)
            else replyDrafts.delete(threadPath)
          }
          const recipient=el('p','送信先 '+store.name+' · '+thread.label+' · '+sender,'wrap')
          if(data.templates.length){
            const picker=field('定型文','template','','',[['','定型文を選択'],...data.templates.map(entry=>[entry.id,entry.label])])
            const input=picker.querySelector('select')
            input.removeAttribute('name')
            const insert=button('本文に挿入',async()=>{
              const selected=data.templates.find(entry=>entry.id===input.value)
              if(!selected)return
              const next=[body.value,selected.body].filter(Boolean).join('\n\n')
              if(next.length>body.maxLength)throw new Error('返信の本文は3500文字までです。')
              body.value=next
              body.oninput()
              body.focus()
            })
            composer.prepend(controls(picker,insert))
          }
          composer.prepend(recipient)
          panel.append(composer,details('内部メモ',reply(true)))
        }
      }
      const row=details(threadTitle(thread),panel)
      row.classList.add('record')
      let loading=false,previous
      const loadMessages=async()=>{
        if(!row.isConnected||!row.open||loading)return
        loading=true
        try{
          const messages=await api(threadPath)
          if(!row.isConnected||!row.open)return
          const snapshot=JSON.stringify(messages)
          if(snapshot===previous)return
          previous=snapshot
          chat.replaceChildren(...messages.map(message=>{
            const note=el('article',null,'record')
            const direction={incoming:'受信',outgoing:'公式LINEからの返信',internal:'内部メモ'}[message.direction]
            note.append(el('b',[direction,dateLabel(message.happened_at,store.timezone),results[message.status],message.staff].filter(Boolean).join(' · ')),
              el('p',message.withdrawn?'送信取消':message.body??'添付・非テキストメッセージ','wrap'))
            return note
          }))
          if(!messages.length)chat.append(el('p','表示できるメッセージがありません。'))
        }catch(error){
          if(previous===undefined)chat.replaceChildren(el('p',error.message))
        }finally{loading=false}
      }
      row.ontoggle=()=>{
        if(!row.open){
          if(refreshOpenChat===loadMessages){openThread=undefined;refreshOpenChat=undefined}
          return
        }
        for(const entry of records.values()){
          if(entry.row!==row)entry.row.open=false
        }
        openThread=threadPath
        refreshOpenChat=loadMessages
        if(previous===undefined)chat.replaceChildren(el('p','読み込み中…'))
        void loadMessages()
      }
      return {row,thread}
  }
  const rowState=thread=>JSON.stringify([thread.name,thread.label,thread.state,thread.assigned_to,thread.handoff_until])
  function renderThreads(){
    const visible=data.threads.filter(thread=>
      (!selector.value||thread.state===selector.value)&&(!onlyUnread.checked||thread.unread)&&(!needsReply.checked||thread.needs_reply))
    const keep=new Set(visible.map(thread=>thread.id))
    for(const [id,entry] of records){
      if(!keep.has(id)){entry.row.remove();records.delete(id)}
    }
    let position=rows.firstElementChild
    for(const thread of visible){
      let entry=records.get(thread.id)
      if(!entry||rowState(entry.thread)!==rowState(thread)){
        const reopened=entry?.row.open||openThread===path+'/'+thread.id
        const replacement=threadRow({...thread})
        if(entry){
          if(position===entry.row)position=entry.row.nextElementSibling
          entry.row.remove()
        }
        entry=replacement
        records.set(thread.id,entry)
        entry.row.open=reopened
      }else{
        Object.assign(entry.thread,thread)
        const summary=entry.row.firstElementChild
        const label=threadTitle(thread)
        if(summary.textContent!==label)summary.textContent=label
      }
      if(entry.row!==position)rows.insertBefore(entry.row,position)
      position=entry.row.nextElementSibling
    }
    empty.hidden=visible.length>0
  }
  selector.onchange=renderThreads
  onlyUnread.onchange=renderThreads
  needsReply.onchange=()=>{
    onlyUnanswered=needsReply.checked
    renderThreads()
  }
  root.append(controls(state,unread,unanswered),rows,empty)
  renderThreads()
  refreshInboxList=async()=>{
    if(loadingList||!root.isConnected)return
    loadingList=true
    try{
      const latest=await api(path)
      if(!root.isConnected)return
      data.threads=latest.threads
      data.staff=latest.staff
      renderThreads()
    }catch{/* Keep the visible list if a background refresh fails. */}
    finally{loadingList=false}
  }
}

async function render(){
  const marker=++view
  refreshOpenChat=undefined
  refreshInboxList=undefined
  const store=stores.find(entry=>entry.id===$('#store').value)
  if(!store)throw new Error('利用できる店舗がありません。')
  const use=$('#use').value
  const base='/stores/'+store.id
  const path=base+'/workflows/'+use
  const query=new URLSearchParams({store:store.id,use})
  if(current)query.set('tab',current)
  if(onlyUnanswered)query.set('unanswered','1')
  if(onlyFailures)query.set('failures','1')
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
  if(settings.forms_enabled&&(!agency||use==='recruitment'&&['admin','manager'].includes(actor.role)))
    sections.push(['forms',use==='recruitment'?'応募フォーム':'回答フォーム'],['responses','フォーム回答'])
  if(use==='recruitment'&&settings.recruitment_enabled&&['admin','manager'].includes(actor.role))sections.push(['recruitment','応募・選考'],['tags','採用タグ・配信'])
  const canManageAcquisition=!agency||use==='recruitment'&&['admin','manager'].includes(actor.role)
  const canToggleAcquisition=agency&&use==='recruitment'&&actor.role==='admin'
  if(canManageAcquisition){
    if(settings.sources_enabled||canToggleAcquisition)sections.push(['sources','流入分析'])
    if(use==='customer'&&settings.campaigns_enabled)sections.push(['campaigns','絞り込み配信'])
    if(settings.rich_menus_enabled||canToggleAcquisition)sections.push(['rich-menus','リッチメニュー'])
  }
  if(settings.inbox_enabled)sections.push(['inbox','LINE受信箱'])
  if(settings.inbox_enabled&&(agency&&['admin','manager'].includes(actor.role)||!agency&&use==='customer'))sections.push(['intake','受付保留'])
  sections.push(['delivery','LINE送信履歴'])
  if(!sections.length){content.replaceChildren(el('p','この店舗で有効な機能はありません。法人管理者が「店舗で使う機能」から設定できます。'));return}
  if(canManageAcquisition)sections.unshift(['checks','運用チェック'])
  // The dedicated shortcut must explain an unavailable feature instead of
  // silently taking the manager to an unrelated inbox tab.
  const formDisabled=agency&&['forms','responses'].includes(current)&&!settings.forms_enabled
  const tagsDisabled=use==='recruitment'&&current==='tags'&&!settings.recruitment_enabled
  const unavailableAcquisition=canManageAcquisition&&((current==='sources'&&!settings.sources_enabled)||(current==='rich-menus'&&!settings.rich_menus_enabled))?current:null
  if(!sections.some(([id])=>id===current))current=sections[0][0]
  for(const [key,label] of sections){
    const tab=button(label,async()=>{current=key;notice();await render()})
    if(current===key)tab.setAttribute('aria-current','page')
    tabs.append(tab)
  }
  if(unavailableAcquisition){
    content.replaceChildren(el('p',(unavailableAcquisition==='sources'?'流入分析':'リッチメニュー')+'はこの店舗では無効です。'+(canToggleAcquisition?'下の設定から有効にできます。':'管理者に有効化を依頼してください。')))
    if(canToggleAcquisition)content.append(acquisitionSettings(settings,path,async message=>{current=unavailableAcquisition;await render();notice(message)}))
    return
  }
  if(tagsDisabled){content.replaceChildren(el('p','この店舗の応募・選考管理が無効です。北村さんの管理画面で有効にすると採用タグを利用できます。'));return}
  if(formDisabled){content.replaceChildren(el('p','この店舗の応募フォーム機能は無効です。北村さんの管理画面で有効にすると、エールがフォームを管理できます。'));return}
  const key=current
  const endpoint=['recruitment','campaigns','intake'].includes(key)?base+'/'+key:path+'/'+key
  if(tagFilters.store!==store.id)tagFilters={include:[],exclude:[],match:'all',page:1,store:store.id}
  const tagQuery=new URLSearchParams({include:tagFilters.include.join(','),exclude:tagFilters.exclude.join(','),match:tagFilters.match,page:String(tagFilters.page)})
  const data=await api(endpoint+(key==='tags'?'?'+tagQuery:key==='delivery'&&onlyFailures?'?failures=1':''))
  if(key==='inbox')data.templates=await api(endpoint+'/templates')
  if(marker!==view)return
  const panel=el('div')
  const refresh=async message=>{if(marker===view){await render();notice(message)}}
  if(key==='forms')formEditor(panel,data,path,refresh,use)
  if(key==='responses')answersPanel(panel,data,store)
  if(key==='tags')tagManager(panel,data,store,path+'/tags',refresh)
  if(key==='recruitment')recruitment(panel,data,store,base+'/recruitment',refresh)
  if(key==='sources')sources(panel,data,path,refresh,use)
  if(key==='campaigns')campaigns(panel,data,store,base+'/campaigns',refresh)
  if(key==='rich-menus')richMenus(panel,data,path,refresh,use)
  if(key==='inbox'||key==='intake')inbox(panel,data,store,key==='inbox'?path+'/inbox':base+'/intake',refresh,key==='intake')
  if(key==='delivery')deliveries(panel,data,store,path,refresh)
  if(key==='checks'){if(canToggleAcquisition)panel.append(acquisitionSettings(settings,path,refresh));checks(panel,data,store)}
  content.replaceChildren(panel)
}

setInterval(()=>{
  if(!document.hidden){
    void refreshOpenChat?.()
    void refreshInboxList?.()
  }
},3000)

async function start(){
  const session=await api('/session')
  agency=session.actor.agency===true
  if(agency){
    $('#customers').hidden=true
    $('#use').closest('label').hidden=true
  }
  actor=session.actor
  if(actor.platform)(await import('/static/piyomaru.mjs')).mountPiyomaru('workflows')
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
