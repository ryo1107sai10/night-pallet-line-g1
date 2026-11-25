// Supervisor-only assistant. Static assets and every API are protected by the platform session.
const prefix='/api/v1/platform/piyomaru'
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==null&&text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
const button=(label,fn,cls='piyo-button')=>{const b=el('button',label,cls);b.type='button';b.onclick=()=>fn();return b}
const link=(label,url,cls='piyo-link')=>{const a=el('a',label,cls);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a}
const money=micros=>'$'+(Number(micros??0)/1e6).toFixed(3)
const hour=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')
async function request(path='',method='GET',body,key){
  const r=await fetch(prefix+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})})
  let data;try{data=await r.json()}catch{throw new Error('通信結果を確認できませんでした。')}
  if(!r.ok)throw new Error(data.message??'操作に失敗しました。')
  return data
}
function field(label,input,hint){const f=el('label',null,'piyo-field');f.append(el('span',label),input);if(hint)f.append(el('small',hint));return f}
function input(type='text',value='',max=120){const n=el('input');n.type=type;n.value=value;n.maxLength=max;n.autocomplete='off';return n}
function select(values,selected){const n=el('select');for(const [value,label] of values)n.add(new Option(label,value));if(selected!==undefined)n.value=selected;return n}
const sprite=state=>{const n=el('span',null,'piyo-sprite');n.dataset.expression=state;n.setAttribute('aria-hidden','true');return n}
const quickQuestions=['公式LINEのつなぎ方は？','面談予約の設定は？','ステップ配信の作り方は？','AIの利用料金は？']
export function mountPiyomaru(page='platform'){
  if(document.getElementById('piyo-launcher'))return
  const css=el('link');css.rel='stylesheet';css.href='/static/piyomaru.css?v=1';document.head.append(css)
  const mascot=sprite('normal'),speech=el('span','ピヨ丸に聞く','piyo-speech')
  const launch=button('',()=>toggle(),'piyo-launcher');launch.id='piyo-launcher'
  launch.append(speech,mascot);launch.setAttribute('aria-label','ピヨ丸に質問する');launch.setAttribute('aria-expanded','false')
  const panel=el('aside',null,'piyo-panel');panel.id='piyo-panel';panel.hidden=true;panel.setAttribute('aria-label','ピヨ丸 AIサポート')
  launch.setAttribute('aria-controls',panel.id)
  let info,activeJob,tab='chat',busy=false,loadError='',history=[],messages=[],sleepTimer,blinkTimer,mode='normal',jobKey,openJob
  const badge=el('span','準備中','piyo-badge'),face=sprite('normal')
  const heading=el('div',null,'piyo-heading');heading.append(face,el('div',null,'piyo-branding'),button('×',()=>close(),'piyo-close'))
  heading.querySelector('.piyo-branding').append(el('strong','ピヨ丸'),el('small','Night PRO LINE · 管理サポート'),badge)
  heading.querySelector('.piyo-close').setAttribute('aria-label','ピヨ丸を閉じる')
  const nav=el('nav',null,'piyo-nav'),content=el('div',null,'piyo-content'),notice=el('div',null,'piyo-notice')
  notice.setAttribute('role','status');notice.hidden=true
  const navs=[['chat','質問する'],['jobs','導入代行'],['settings','AI・知識']]
  const tabs=new Map(navs.map(([id,title])=>[id,button(title,()=>switchTab(id),'piyo-tab')]))
  for(const b of tabs.values())nav.append(b)
  panel.append(heading,nav,notice,content);document.body.append(launch,panel)
  if(page==='platform'){
    const actions=document.querySelector('main .heading .actions')
    if(actions){const emergency=button('緊急AI導入代行',()=>open('jobs'),'piyo-emergency-entry');actions.prepend(emergency)}
  }
  function state(expression,tip){
    mascot.dataset.expression=expression;face.dataset.expression=expression
    speech.textContent=tip??(expression==='working'?'作業中…':expression==='happy'?'できたよ！':expression==='confused'?'確認してね':expression==='sleep'?'タップして起こしてね':'ピヨ丸に聞く')
    clearTimeout(sleepTimer)
    if(!busy&&panel.hidden)sleepTimer=setTimeout(()=>state('sleep'),60000)
  }
  function clearNotice(){notice.hidden=true;notice.textContent='';notice.classList.remove('is-error')}
  function tell(message,error=false){notice.textContent=message;notice.hidden=!message;notice.classList.toggle('is-error',error);if(error)state('confused')}
  function updateBadge(){
    badge.textContent=!info?'読み込み中':info.connected?'Muse 接続確認済み':info.key_saved?'Muse APIキー登録済・疎通未確認':'標準ナビ · Muse未接続'
    badge.classList.toggle('online',!!info?.connected)
  }
  async function load(){
    try{info=await request();loadError='';updateBadge()}
    catch(error){loadError=error.message;updateBadge();tell(error.message,true)}
  }
  async function open(next){
    if(next)tab=next
    panel.hidden=false;launch.setAttribute('aria-expanded','true');state('normal');clearNotice()
    if(!info){render();await load()}
    render();if(tab==='chat')content.querySelector('textarea')?.focus()
  }
  function close(){panel.hidden=true;launch.setAttribute('aria-expanded','false');launch.focus();state(busy?'working':'normal')}
  function toggle(){return panel.hidden?open():close()}
  function switchTab(id){tab=id;clearNotice();render()}
  function render(){
    for(const [id,b] of tabs)b.setAttribute('aria-current',id===tab?'page':'false')
    content.replaceChildren();content.dataset.tab=tab
    if(!info){
      content.append(el('p',loadError||'ピヨ丸の準備中…','piyo-muted'))
      if(loadError)content.append(button('読み込み直す',async()=>{await load();render()}))
      return
    }
    if(tab==='chat')drawChat()
    else if(tab==='jobs')drawJobs()
    else drawSettings()
  }
  function drawChat(){
    const welcome=el('div',null,'piyo-welcome');welcome.append(el('span','こんにちは！ピヨ丸だよ。','piyo-kicker'),
      el('p','LINEの連携やステップ配信で困ったことを聞いてね。必要なら導入作業も一緒に進めるよ。'),
      button('緊急AI導入代行を始める',()=>switchTab('jobs'),'piyo-danger'))
    const log=el('div',null,'piyo-log');log.setAttribute('role','log');log.setAttribute('aria-live','polite')
    const continuation=el('div',null,'piyo-continuation')
    continuation.append(el('small','案内を読み終えたら、対象店舗を選んで準備やステップの構築を進められます。','piyo-muted'),
      button('公式LINE連携・ステップ構築を進める',()=>switchTab('jobs'),'piyo-primary'))
    const drawMessages=()=>{
      welcome.hidden=messages.length>0;chips.hidden=messages.length>0;log.hidden=messages.length===0
      continuation.hidden=!messages.some(m=>m.role==='assistant'&&m.source!=='ピヨ丸・確認事項')
      log.replaceChildren(...messages.map(m=>{
        const b=el('article',null,'piyo-message '+(m.role==='user'?'is-user':'is-piyo'))
        if(m.role!=='user')b.append(el('small',m.source??'ピヨ丸'))
        b.append(el('p',m.text));return b
      }));log.scrollTop=log.scrollHeight
    }
    const question=el('textarea');question.placeholder='操作方法や困っていることを入力…';question.maxLength=1500;question.rows=3;question.setAttribute('aria-label','ピヨ丸への質問')
    const form=el('form',null,'piyo-question')
    const modeSelect=select([['normal','低コスト（Ember）'],['deep','複雑な相談（Spark）'],['guide','無料の内蔵ナビ']],mode);modeSelect.setAttribute('aria-label','質問のモード');modeSelect.onchange=()=>mode=modeSelect.value
    const send=el('button','送信','piyo-primary');send.type='submit';send.disabled=busy
    const footer=el('div',null,'piyo-row');footer.append(modeSelect,send)
    const resetChat=button('新しい質問を始める',()=>{if(!busy){messages=[];history=[];drawMessages();question.focus()}},'piyo-chip')
    form.append(question,footer,resetChat,el('small','認証コード・パスワード・応募者の個人情報は入力しないでね。','piyo-muted'))
    form.onsubmit=async e=>{e.preventDefault();const value=question.value.trim();if(!value||busy)return;question.value='';await ask(value,drawMessages,send)}
    const chips=el('div',null,'piyo-chips')
    for(const q of quickQuestions)chips.append(button(q,()=>{question.value=q;question.focus()},'piyo-chip'))
    content.append(welcome,chips,log,continuation,form);drawMessages()
  }
  async function ask(q,drawMessages,send){
    if(busy)return
    busy=true;send.disabled=true;clearNotice();state('working')
    messages.push({role:'user',text:q});drawMessages()
    try{
      const reply=await request('/ask','POST',{question:q,mode,history:history.slice(-6),request:crypto.randomUUID(),...(activeJob&&!activeJob.cancelled?{job:activeJob.id}:{})})
      const source=reply.kind==='muse'?(reply.model.includes('spark')?'Muse Spark':'Muse Ember'):'ピヨ丸・内蔵ガイド'
      messages.push({role:'assistant',text:reply.answer,source})
      history.push({role:'user',text:q.slice(0,1500)},{role:'assistant',text:reply.answer.slice(0,1500)});history=history.slice(-6)
      info.spent_microusd=reply.spent_microusd;if(reply.kind==='muse')info.connected=true
      updateBadge();state('happy');drawMessages()
    }catch(error){messages.push({role:'assistant',text:error.message,source:'ピヨ丸・確認事項'});drawMessages();tell(error.message,true)}
    finally{busy=false;send.disabled=false;if(tab==='chat')render()}
  }
  function drawJobs(){
    const intro=el('div',null,'piyo-welcome piyo-job-intro')
    intro.append(el('span','導入代行アシスタント','piyo-kicker'),el('p','店舗の準備・LINE接続・カレンダー確認・下書き・公開条件を順番に確認するよ。未完了の作業は途中から再開できるよ。'))
    content.append(intro)
    if(activeJob){
      drawJob(activeJob);return
    }
    const row=el('div',null,'piyo-row');row.append(button('＋ 新しく導入代行を開始',()=>beginWizard(),'piyo-danger'),button('進捗を再読込',async()=>{await load();render()}))
    content.append(row)
    if(info.jobs.length){
      content.append(el('h3','保存済みの導入代行'))
      const list=el('div',null,'piyo-jobs')
      for(const job of info.jobs){
        const b=button('',async()=>{await resume(job.id)},'piyo-job-card')
        b.append(el('strong',job.display_name),el('small',job.cancelled?'終了済み':job.verified_by_user_at?'実機確認の記録あり':'途中から再開'))
        list.append(b)
      }
      content.append(list)
    }else content.append(el('p','まだ導入代行の記録はありません。','piyo-muted'))
  }
  async function resume(id){
    if(busy)return;busy=true;state('working');clearNotice()
    try{activeJob=await request('/jobs/'+id+'/refresh','POST',{});openJob=id;state('happy');render()}
    catch(e){tell(e.message,true)}
    finally{busy=false}
  }
  function beginWizard(){
    if(!info.companies.length){tell('監督対象の管理会社を用意してください。',true);return}
    const selected=info.companies[0]
    const company=select(info.companies.map(c=>[c.id,c.legal_name]),selected.id)
    const kind=select([['new','新しい契約店舗'],['existing','既存店舗を設定する']],'new')
    const existing=select([['','店舗を選択']])
    const group=el('div',null,'piyo-form-fields')
    const name=input(),addr=input('text','',240),business=input('text','',120),owner=input('text','',120)
    for(const n of [name,addr,business,owner])n.required=true
    const start=select(Array.from({length:48},(_,i)=>[String(i*30),hour(i*30)]),'1080')
    const end=select(Array.from({length:48},(_,i)=>[String((i+1)*30),hour((i+1)*30)]),'1440')
    const hours=el('div',null,'piyo-hours');hours.append(field('受付開始',start),field('受付終了',end))
    const faq=input('url','',2000),map=input('url','',2000)
    const form=el('form',null,'piyo-wizard')
    function fill(){
      const c=info.companies.find(c=>c.id===company.value)
      existing.replaceChildren(new Option('店舗を選択',''),...(c?.stores??[]).map(s=>new Option(s.name,s.id)))
      group.replaceChildren()
      if(kind.value==='new'){
        group.append(field('店舗名',name),field('所在地',addr),field('営業区分',business),field('責任者',owner),hours)
      }else group.append(field('対象店舗',existing,'既存の受付時間・設定は自動で上書きしません。'))
    }
    company.onchange=fill;kind.onchange=fill;fill()
    const proceed=el('button','内容を確認する','piyo-primary');proceed.type='submit'
    form.append(el('div','1 / 2　店舗情報を教えてね','piyo-kicker'),field('対象の管理会社',company),field('店舗の状態',kind),group,field('FAQ URL（任意）',faq),field('地図URL（任意）',map),proceed,button('戻る',()=>render()))
    form.onsubmit=e=>{
      e.preventDefault()
      if(kind.value==='existing'&&!existing.value){tell('既存店舗を選択してください。',true);return}
      if(+end.value<=+start.value){tell('受付時間の終了は開始より後にしてください。',true);return}
      const data={tenant:company.value,...(kind.value==='new'?{new_store:{name:name.value,address:addr.value,business_type:business.value,responsible:owner.value}}:{existing_store:existing.value}),
        settings:{start:+start.value,end:+end.value,faqUrl:faq.value,mapUrl:map.value}}
      review(data,form)
    }
    content.replaceChildren(form)
  }
  function review(data,form){
    jobKey=crypto.randomUUID()
    const title=data.new_store?.name??info.companies.find(c=>c.id===data.tenant)?.stores.find(s=>s.id===data.existing_store)?.name
    const box=el('div',null,'piyo-wizard');box.append(el('div','2 / 2　導入内容の確認','piyo-kicker'),el('h3',title),
      el('p',data.new_store?'新規店舗の登録と採用機能・対面の受付時間を準備します。':'既存店舗を参照し、必要な設定だけを確認します。'))
    if(data.new_store)box.append(el('p','受付時間：'+hour(data.settings.start)+'〜'+hour(data.settings.end)))
    box.append(el('p','配信はまだ開始しません。外部サービスの認証・規約同意は権限者が行います。','piyo-muted'))
    const apply=button('この内容で準備を開始',async()=>{
      if(busy)return;busy=true;apply.disabled=true;state('working');clearNotice()
      try{activeJob=await request('/jobs','POST',data,jobKey);openJob=activeJob.id;await load();state('happy');render();tell('店舗準備が完了したよ。次の作業へ進もう！');if(data.new_store)window.dispatchEvent(new Event('npl:piyomaru-store-created'))}
      catch(e){tell(e.message,true)}
      finally{busy=false;apply.disabled=false}
    },'piyo-primary')
    box.append(apply,button('入力を修正',()=>{content.replaceChildren(form)}));content.replaceChildren(box)
  }
  function drawJob(job){
    const done=job.steps.filter(s=>s.done).length
    const title=el('div',null,'piyo-job-title')
    title.append(el('strong',job.store_name),el('span',done+'/'+job.steps.length+' 完了','piyo-badge'))
    const bar=el('progress');bar.max=job.steps.length;bar.value=done;bar.setAttribute('aria-label','導入代行の進行状況')
    const toolbar=el('div',null,'piyo-row')
    toolbar.append(button('一覧に戻る',()=>{activeJob=null;openJob=null;render()}),button('接続・進捗を照合',()=>resume(job.id),'piyo-primary'))
    content.append(title,bar,toolbar)
    if(job.cancelled){content.append(el('p','この導入代行は終了しています。既存の店舗・配信は変更していません。','piyo-muted'));return}
    let selected=job.selected_channel??''
    if(job.channels.length===1&&selected)content.append(el('p','対象LINE：'+job.channels[0].label+(job.channels[0].basic_id?' · '+job.channels[0].basic_id:''),'piyo-muted'))
    if(job.channels.length>1||job.channels.length&& !selected){
      const choice=select([['','採用LINEを選択'],...job.channels.map(c=>[c.id,c.label])],selected)
      choice.onchange=()=>{if(choice.value)act(job,'select_channel',choice.value)}
      content.append(field('対象となる採用LINE',choice))
    }
    const first=job.steps.find(s=>!s.done)
    const explanation=el('div',null,'piyo-coach')
    explanation.append(sprite('working'),el('p',first?'次は「'+first.label+'」だよ。 '+first.description:'設定済みの項目がそろったよ！ 実際のLINEから応募・予約を確認してね。'))
    content.append(explanation)
    for(const step of job.steps){
      const card=el('section',null,'piyo-stage'+(step.done?' complete':''))
      card.append(el('strong',(step.done?'✓ ':'○ ')+step.label),el('p',step.description))
      const row=el('div',null,'piyo-links')
      if(step.topic==='store'){
        if(!step.done)row.append(button('必要な機能を準備',()=>act(job,'prepare'), 'piyo-primary'))
        row.append(link('店舗設定を開く',job.links.store))
      }
      if(step.topic==='line'){
        if(!step.done){if(!selected)row.append(link('公式LINE開設画面 ↗',job.links.official));row.append(link('Developers設定 ↗',job.links.developers))}
        row.append(link('Night PRO LINEの接続・テスト ↗',job.links.line))
        if(!step.done)card.append(el('p','公式画面の本人認証や同意を済ませ、接続後に「接続・進捗を照合」を押してね。','piyo-muted'))
      }
      if(step.topic==='calendar')row.append(link('Googleカレンダー連携 ↗',job.links.calendar))
      if(step.topic==='draft'){
        if(!step.done){const b=button('ピヨ丸が面談の型を構築',()=>act(job,'draft',job.selected_channel),'piyo-primary');b.disabled=!job.selected_channel||!job.features_ready;row.append(b)}
        row.append(link('シナリオスタジオで確認 ↗',job.links.studio))
      }
      if(step.topic==='slots')row.append(link('対面予約枠を設定 ↗',job.links.slots))
      if(step.topic==='publish'){
        if(!job.automation_ready)row.append(link('契約・自動配信の設定 ↗',job.links.store))
        if(!step.done&&job.readiness.length){for(const reason of job.readiness)card.append(el('small',reason,'piyo-muted'))}
        if(!step.done){const b=button('確認して公開する',()=>act(job,'publish',job.selected_channel,job.draft_revision),'piyo-primary');b.disabled=!job.publish_ready;row.append(b)}
      }
      card.append(row);content.append(card)
    }
    const verify=el('div',null,'piyo-stage')
    verify.append(el('strong',job.verified_by_user_at?'✓ 実機確認済み（利用者による記録）':'○ 最終実機確認'),
      el('p','一般LINEから応募・対面予約・確定通知・重複枠の予約不可を実際に確認してください。'))
    if(!job.verified_by_user_at){
      const b=button('実際に確認できたことを記録',()=>act(job,'confirm_test'));b.disabled=!job.steps.every(s=>s.done)||!job.automation_ready;verify.append(b)
    }
    content.append(verify,button('この代行を終了する',()=>act(job,'cancel'),'piyo-secondary'))
  }
  async function act(job,action,channel,revision){
    if(busy)return
    const confirmText={prepare:'対象店舗の採用機能を有効にします。既存の配信設定は変更しません。進めますか？',
      draft:'面談の基本の型を未公開の下書きとして作成します。既存の下書きがあれば上書きしません。',
      publish:'シナリオのプレビュー・通知内容を確認しましたか？ 選択した店舗の公式LINEで新規応募の自動案内が開始されます。',
      confirm_test:'一般LINEからの応募・予約・通知到着と、Googleカレンダーの重複防止を実際に確認しましたか？',
      cancel:'代行の記録を終了します。すでに作成・公開した店舗設定はそのまま残ります。'}
    if(confirmText[action]&&!confirm(confirmText[action]))return
    busy=true;state('working');clearNotice();content.setAttribute('aria-busy','true')
    try{
      activeJob=await request('/jobs/'+job.id+'/action','POST',{action,confirm:true,...(channel?{channel}:{}),...(revision?{revision}:{})})
      await load();state('happy');render();tell(action==='publish'?'公開したよ。一般LINEで実際の送受信を確認してね。':'確認できたよ。次の項目へ進もう！')
    }catch(e){tell(e.message,true)}
    finally{busy=false;content.removeAttribute('aria-busy')}
  }
  function drawSettings(){
    const section=el('section',null,'piyo-stage')
    section.append(el('strong','Muse APIと費用管理'),el('p',info.connected?'Museとの通信を確認済みです。':info.key_saved?'APIキーは保存済みです。接続テストを行ってね。':'まだMuseのAPIキーが登録されていません。公式の設定ページから取得してね。'),
      link('Meta Model APIの設定画面 ↗','https://dev.meta.ai/'),link('APIキーの発行手順 ↗','https://dev.meta.ai/docs/authentication'))
    const key=input('password','',512);key.placeholder=info.key_saved?'登録済み・交換する場合のみ入力':'LLM_…';key.autocomplete='off'
    const budget=input('number',String(info.budget_microusd/1e6));budget.min='.10';budget.max='20';budget.step='.10'
    const form=el('form',null,'piyo-config')
    const save=el('button','AI設定を保存','piyo-primary');save.type='submit'
    form.append(field('Muse APIキー',key,'この画面からのみ安全に登録します。チャットに貼り付けないでください。'),
      field('月間の利用上限（米ドル）',budget,'未使用時のAPI利用料は0。アプリの推定料金管理であり、Meta側の契約とは別です。'),save)
    form.onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;save.disabled=true;state('working')
      try{const value=key.value.trim();const r=await request('/settings','PUT',{budget_microusd:Math.round(Number(budget.value)*1e6),...(value?{key:value}:{})});key.value='';Object.assign(info,r);updateBadge();render();state('happy');tell('AI設定を保存したよ。')}
      catch(error){key.value='';tell(error.message,true)}
      finally{busy=false;save.disabled=false}}
    section.append(form)
    const status=el('p','今月の利用見込み：'+money(info.spent_microusd)+' ／ 上限 '+money(info.budget_microusd),'piyo-muted')
    section.append(status)
    if(info.key_saved)section.append(
      button('Museに接続テスト（1回）',async()=>{if(busy)return;busy=true;state('working');clearNotice()
        try{const reply=await request('/ask','POST',{question:'疎通確認です。短く挨拶してください。',mode:'normal',history:[],request:crypto.randomUUID()});await load();state('happy');render();tell('Museから実際に返答があったよ：'+reply.answer)}
        catch(e){tell(e.message,true)}finally{busy=false}
      },'piyo-primary'),
      button('APIキーの登録を解除',async()=>{if(busy||!confirm('Night PRO LINEからMuse APIキーの登録を解除します。Meta側のキーは別途管理できます。よろしいですか？'))return;busy=true
        try{await request('/settings','PUT',{budget_microusd:info.budget_microusd,remove:true});await load();render();tell('APIキーの登録を解除しました。')}catch(e){tell(e.message,true)}finally{busy=false}
      }))
    const learn=el('section',null,'piyo-stage');learn.append(el('strong','ピヨ丸の業務知識'),el('p','確認できた作業の種類と実績を蓄積します。応募者の個人情報・認証情報は知識に保存しません。'))
    const list=el('ul',null,'piyo-knowledge')
    for(const entry of info.knowledge){const li=el('li');li.append(el('span',entry.title),el('small',entry.verified_count+'件 確認'));list.append(li)}
    learn.append(list)
    const noteTopic=select(info.knowledge.map(k=>[k.topic,k.title]),'line')
    const note=el('textarea');note.maxLength=600;note.rows=3;note.placeholder='例：解決した設定手順、画面変更時の確認方法…';note.required=true
    const check=input('checkbox');check.value='yes';check.required=true
    const checkLabel=el('label','確認済みの手順で、個人情報・認証情報は含みません。','piyo-check');checkLabel.prepend(check)
    const noteForm=el('form',null,'piyo-config'),noteSubmit=el('button','確認済み手順を覚える','piyo-primary');noteSubmit.type='submit'
    noteForm.append(field('手順の分類',noteTopic),field('知識メモ（任意）',note),checkLabel,noteSubmit)
    noteForm.onsubmit=async event=>{event.preventDefault();if(busy||!check.checked)return;busy=true;noteSubmit.disabled=true;state('working')
      try{await request('/knowledge','POST',{topic:noteTopic.value,note:note.value,confirmed:true});await load();render();state('happy');tell('確認済みの手順を覚えたよ。')}
      catch(e){tell(e.message,true)}finally{busy=false;noteSubmit.disabled=false}}
    learn.append(noteForm)
    for(const memory of info.notes??[]){
      const card=el('div',null,'piyo-stage')
      card.append(el('small',info.knowledge.find(k=>k.topic===memory.topic)?.title??'知識メモ','piyo-muted'),el('p',memory.note),
        button('このメモを削除',async()=>{if(busy||!confirm('この知識メモを削除しますか？'))return;busy=true
          try{await request('/knowledge/'+memory.id,'DELETE',{});await load();render()}catch(e){tell(e.message,true)}finally{busy=false}}))
      learn.append(card)
    }
    content.append(section,learn)
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){e.stopPropagation();close()}})
  state('normal')
}
