import {lineSetupLinks,lineConsoleId} from './line-setup.mjs'

const $=id=>document.getElementById(id)
const status=$('line-status'), store=$('line-store'), registration=$('line-register')
const detail=$('line-detail'), selection=$('connection-select')
let channelId, channels=[], busy=false, issued=null
const element=(tag,text,cls)=>{
  const item=document.createElement(tag)
  if(text!==undefined)item.textContent=text
  if(cls)item.className=cls
  return item
}
const action=(label,run)=>{
  const button=element('button',label,'secondary')
  button.type='button';button.onclick=()=>perform(run);return button
}
const link=(title,href)=>{
  const a=element('a',title,'studio-link');a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a
}
async function request(path,method='GET',data){
  const response=await fetch('/api/v1'+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{})},
    body:data===undefined?undefined:JSON.stringify(data)})
  if(response.status===401){location.replace('/master/');throw new Error('再ログインしてください。')}
  const result=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(result.message??'操作できませんでした。')
  return result
}
function base(){return '/stores/'+encodeURIComponent(store.value)+'/connections'}
function setBusy(value){
  busy=value;store.disabled=value;registration.querySelector('button').disabled=value
  for(const button of detail.querySelectorAll('button'))button.disabled=value||button.dataset.waiting==='true'
  const selector=selection.querySelector('select');if(selector)selector.disabled=value
}
async function perform(run){
  if(busy)return
  setBusy(true);status.textContent='処理中…'
  try{await run()}catch(error){status.textContent=error.message}
  finally{setBusy(false)}
}
function updateLinks(){
  const links=lineSetupLinks({basic_id:$('basic-id').value,provider_id:registration.elements.provider_id.value,messaging_id:registration.elements.messaging_id.value})
  $('manager-link').href=links.managerMessaging;$('developer-link').href=links.provider
  $('basic-link').href=links.messagingBasics;$('token-link').href=links.messagingSettings
}
registration.addEventListener('input',updateLinks)
registration.onsubmit=event=>{
  event.preventDefault()
  perform(async()=>{
    const data=Object.fromEntries(new FormData(registration));data.purpose='recruitment'
    data.provider_id=lineConsoleId(data.provider_id,'provider');data.messaging_id=lineConsoleId(data.messaging_id,'channel')
    if(!data.provider_id||!data.messaging_id)throw new Error('公式のIDまたはLINE Developers設定画面のURLを入力してください。')
    for(const name of ['existing_tools','existing_webhook'])if(!data[name])delete data[name]
    const created=await request(base(),'POST',data)
    channelId=created.id;issued=null;registration.reset();$('basic-id').value='';updateLinks()
    await loadConnections();status.textContent='登録しました。店舗専用Webhook URLの設定へ進んでください。'
    $('line-connections').scrollIntoView({behavior:'smooth',block:'start'})
  })
}
const manualFlags={ownership_verified:'公式LINEの管理権限を確認した',provider_verified:'店舗に対応したプロバイダーを確認した',redelivery_enabled:'Webhookの再送を有効にした',auto_reply_checked:'LINE側の自動応答が重複しないことを確認した',non_developer:'開発者権限のない利用者でも実機確認した',delivery_confirmed:'テストメッセージが端末に届いた'}
const proofFlags={token_verified:'トークンとボットの照合',webhook_verified:'Webhookの疎通',tester_verified:'テスト利用者の本人確認',receive_verified:'LINEからの受信',send_accepted:'LINEへのテスト送信受付'}
async function renderConnection(){
  detail.replaceChildren()
  const current=channels.find(item=>item.id===channelId)
  if(!current){detail.append(element('p','この店舗に採用用の手動LINE接続はまだありません。上のフォームで登録してください。'));return}
  const prefix=base()+'/'+current.id, checks=current.checks??{}, links=lineSetupLinks(current)
  detail.append(element('h3',current.label+'　'+(current.basic_id??'')),element('p',current.status==='connected'?'接続済み':'接続確認中'),
    element('p','Webhook URLをLINE DevelopersのMessaging API設定に貼り付け、検証・Webhook利用・再送を有効にします。'))
  const url=element('input');url.readOnly=true;url.value=current.webhook_url;url.setAttribute('aria-label','店舗専用Webhook URL')
  const linksRow=element('div',undefined,'actions')
  linksRow.append(link('Webhook設定を開く',links.messagingSettings),link('LINEの応答設定',links.responseHelp),action('Webhook URLをコピー',async()=>{
    await navigator.clipboard.writeText(current.webhook_url);status.textContent='Webhook URLをコピーしました。'
  }))
  detail.append(url,linksRow)
  const records=element('div');for(const [key,label] of Object.entries(proofFlags)){
    const row=element('div',undefined,'record actions');row.append(element('span',label+'：'+(checks[key]?'確認済':'未確認')))
    if(key==='token_verified'||key==='webhook_verified')row.append(action('確認する',async()=>{
      const result=await request(prefix+'/check-'+(key==='token_verified'?'token':'webhook'),'POST',{revision:current.revision})
      await loadConnections();status.textContent=result.checks?.[key]?'確認しました。':'未確認です。LINE側の設定を確認してください。'
    }))
    records.append(row)
  }
  detail.append(records)
  const form=element('form');form.id='line-console-checks';form.append(element('h3','公式LINEの設定確認記録'),element('p','まず上から4項目を確認してチェックし、確認者・根拠を入力して保存してください。下の2項目（実機・到着確認）はテスト後に保存します。','muted'))
  for(const [name,title] of Object.entries(manualFlags)){
    const label=element('label'), field=element('input');field.type='checkbox';field.name=name;field.checked=checks[name]===true
    label.append(field,document.createTextNode(' '+title));form.append(label)
  }
  const reason=element('input');reason.name='reason';reason.maxLength=200;reason.required=true;reason.placeholder='実際に確認した根拠・確認者';const reasonLabel=element('label','確認者・根拠');reasonLabel.append(reason);form.append(reasonLabel)
  const save=element('button','確認結果を保存');save.type='submit';form.append(save)
  form.onsubmit=event=>{event.preventDefault();perform(async()=>{
    const data=Object.fromEntries(Object.keys(manualFlags).map(key=>[key,form.elements[key].checked]));data.revision=current.revision;data.reason=reason.value
    await request(prefix+'/console','PATCH',data);await loadConnections();status.textContent='確認記録を保存しました。'
  })}
  const testHeading=element('h3','3. 実機の接続テスト');testHeading.id='line-tester';detail.append(form,testHeading)
  detail.append(element('p','スマホの通常LINEを用意してください。テストは次の順番です。テストだけでは一般向け自動配信は始まりません。'))
  const instructions=element('ol',undefined,'guide-checklist');for(const text of ['上の設定確認記録の最初の4項目を保存する','テストコードを発行する','本人のスマホから「接続テスト ＋ 発行コード」を1通送る','同じLINEで「動作確認」を別の1通として送る','この画面の「進捗を更新」を押す','「接続テストを1通送る」を押し、スマホへの到着を確認する','届いたら上の確認記録で「テストメッセージが端末に届いた」を選び保存する'])instructions.append(element('li',text));detail.append(instructions)
  const issue=action('テストコードを発行',async()=>{
    const result=await request(prefix+'/tests','POST',{purpose:'recruitment'});issued={channel:current.id,...result};await loadConnections();status.textContent='テストコードを発行しました。'
  });const waiting=!checks.ownership_verified||!checks.provider_verified;issue.dataset.waiting=String(waiting);issue.disabled=waiting;if(waiting){const help=element('p','先に上の公式LINEの管理権限・プロバイダーを確認し、確認結果を保存してください。','muted');detail.append(help)}detail.append(issue,action('進捗を更新',async()=>{await loadConnections();status.textContent='進捗を更新しました。'}))
  if(issued?.channel===current.id){detail.append(element('p','1通目：次の内容をコピーして送信'));detail.append(element('pre','接続テスト '+issued.code));detail.append(action('1通目をコピー',async()=>{await navigator.clipboard.writeText('接続テスト '+issued.code);status.textContent='コピーしました。次に別のメッセージで「動作確認」と送ってください。'}),element('p','2通目：動作確認（コードを付けず別のメッセージとして送る）'),element('p','有効期限 '+new Date(issued.expires_at).toLocaleString('ja-JP'),'muted'))}
  const testers=await request(prefix+'/tests')
  if(channelId!==current.id)return
  for(const tester of testers){
    const row=element('div',undefined,'record');row.append(element('p',(tester.verified_at?'本人確認済':'本人確認待ち')+' · '+(tester.received?'受信済':'受信待ち')+' · '+(tester.send_status??'未送信')))
    if(tester.verified_at&&!tester.received&&!tester.send_status&&Date.parse(tester.expires_at)>Date.now())row.append(element('p','あと1つ：同じスマホのLINEから「動作確認」と1通送り、進捗を更新してください。','muted'))
    if(tester.received&&!tester.send_status&&Date.parse(tester.expires_at)>Date.now())row.append(action('接続テストを1通送る',async()=>{
      await request(prefix+'/tests/'+tester.id+'/send','POST',{});await loadConnections();status.textContent='テスト送信を登録しました。スマートフォンで確認してください。'
    }))
    detail.append(row)
  }
}
async function loadConnections(){
  channels=(await request(base())).filter(item=>item.purpose==='recruitment'&&!item.module_channel_id)
  if(!channels.some(item=>item.id===channelId))channelId=channels[0]?.id
  selection.replaceChildren();if(channels.length){
    const label=element('label','公式LINE'), select=element('select');for(const item of channels)select.append(new Option(item.label+(item.basic_id?' '+item.basic_id:''),item.id))
    select.value=channelId;select.onchange=()=>perform(async()=>{channelId=select.value;await renderConnection();status.textContent='公式LINEを切り替えました。'})
    label.append(select);selection.append(label)
  }
  await renderConnection()
}
function storeChanged(wantedChannel){
  channelId=wantedChannel;issued=null;registration.reset();$('basic-id').value='';updateLinks()
  const url=new URL(location.href);url.searchParams.set('store',store.value);url.searchParams.delete('line_channel');history.replaceState(null,'',url)
  $('agency-return').href='/master/?store='+encodeURIComponent(store.value)
  return loadConnections()
}
try{
  const session=await request('/session')
  if(!session.actor.agency||session.actor.role!=='admin'){location.replace('/staff/');throw new Error('エールのマスター専用画面です。')}
  $('line-account').textContent=session.actor.email
  store.replaceChildren(...session.stores.map(item=>new Option(item.name,item.id)))
  if(!session.stores.length)throw new Error('管理する店舗がありません。')
  const wanted=new URLSearchParams(location.search).get('store');if(session.stores.some(item=>item.id===wanted))store.value=wanted
  store.onchange=()=>perform(async()=>{await storeChanged();status.textContent='店舗を切り替えました。'})
  $('line-workspace').hidden=false;await perform(async()=>{await storeChanged(new URLSearchParams(location.search).get('line_channel'));status.textContent='';if(['#line-connections','#line-console-checks','#line-tester'].includes(location.hash))$(location.hash.slice(1))?.scrollIntoView({block:'start'})})
}catch(error){status.textContent=error.message}
