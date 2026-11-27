// Store-centric beginner workspace. Every completion indicator is derived from
// saved server state; navigating steps does not mark anything as complete.
export const basicFeatures=['interviews_enabled','google_calendar_enabled','forms_enabled','recruitment_enabled','recruitment_tags_enabled','reminders_enabled','inbox_enabled','token_interviews_enabled','guest_interviews_enabled']
const essentialFeatures=['interviews_enabled','google_calendar_enabled','forms_enabled','recruitment_enabled','reminders_enabled','token_interviews_enabled']
export const recommendedFeatures=features=>({...features,...Object.fromEntries(basicFeatures.map(k=>[k,true]))})
const check=(journey,id)=>journey?.health?.checks?.find(c=>c.id===id)
const ready=(journey,id)=>check(journey,id)?.state==='ready'
export function guideStages(info,journey){
  const counts=journey?.counts??{},features=info?.features??{},known=!!(info&&journey)
  return [
    {number:1,title:'公式LINEを連携',ready:known&&!!info.eligible_at&&journey.connected&&essentialFeatures.every(k=>features[k]===true),status:journey?.connected?'接続確認済み':journey?.channels?.length?'送受信確認中':'未連携'},
    {number:2,title:'ステップを作る',ready:known&&(counts.drafts??0)>0,status:counts.published>0?'公開中':counts.drafts>0?'下書きあり':'未作成'},
    {number:3,title:'面談枠を作る',ready:known&&ready(journey,'calendar')&&ready(journey,'slots'),status:!ready(journey,'calendar')?'カレンダー未確認':ready(journey,'slots')?'空き枠あり':'面談枠未設定'},
    {number:4,title:'採用タグを設定',ready:known&&features.recruitment_enabled===true&&features.recruitment_tags_enabled===true&&(counts.active_tags??0)>0,status:features.recruitment_tags_enabled&&counts.active_tags>0?'使用中':'未設定'},
    {number:5,title:'テスト・運用開始',ready:known&&!!info.auto_enabled&&!!counts.published&&!!info.contract_active&&journey.connected&&ready(journey,'automation')&&ready(journey,'test'),status:!info?.auto_enabled?'自動配信OFF':!counts.published?'公開前':ready(journey,'test')&&ready(journey,'automation')?'実機確認済み':ready(journey,'automation')?'配信ON・実機確認待ち':'要確認'},
  ]
}
export function nextGuideStep(info,journey){return guideStages(info,journey).find(s=>!s.ready)?.number??5}
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e}
const btn=(title,fn,primary=false)=>{const b=el('button',title,primary?'guide-primary':'secondary');b.type='button';b.addEventListener('click',fn);return b}
const link=(title,url,primary=false)=>{const a=el('a',title,'studio-link guide-link'+(primary?' guide-primary':''));a.href=url;return a}
const box=(title,content)=>{const section=el('section',null,'guide-box');section.append(el('h4',title));if(content)section.append(el('p',content));return section}
const actions=(...items)=>{const div=el('div',null,'guide-actions');div.append(...items);return div}
const badge=(text,ok)=>el('span',text,'guide-badge'+(ok?' ready':''))
const checklist=items=>{const list=el('ul',null,'guide-checklist');for(const [ok,description] of items){const li=el('li');li.dataset.ready=String(!!ok);li.append(el('strong',ok?'✓':'○'),el('span',description));list.append(li)}return list}
const field=(label,name,typ='text',value='')=>{const l=el('label',label),i=document.createElement('input');i.name=name;i.type=typ;if(typ==='checkbox'){i.checked=!!value;l.prepend(i)}else{i.value=value;i.required=true;i.maxLength=200;l.append(i)}return {label:l,input:i}}
const lineFlags=[['token_verified','アクセストークンの確認'],['webhook_verified','LINE側のWebhook（受信の接続）'],['tester_verified','テスト利用者の本人確認'],['receive_verified','普通のメッセージを受信'],['send_accepted','接続テストを1通送信'],['delivery_confirmed','スマホへの到着を確認'],['non_developer','一般のLINE利用者で実機確認']]
export function createAgencyGuide(root,{storeName,storeId,info,journey,step,onStep,onAction,onRefresh,onDetail,message,error}){
  const state=guideStages(info,journey),recommended=nextGuideStep(info,journey),current=state.find(s=>s.number===step)??state[recommended-1],done=state.filter(s=>s.ready).length
  const q='?store='+encodeURIComponent(storeId),lineUrl='/agency-line/'+q,studio='/studio/'+q,calendar='/interview/staff.html'+q,workflows='/workflows/'+q+'&use=recruitment'
  const shell=el('section',null,'guide-shell'),hero=el('div',null,'guide-hero'),heading=el('div');heading.append(el('h2',storeName+' のかんたん設定','guide-store-name'),el('p',done===5?'準備がそろいました。日々の対応は下のボタンから進めます。':'次におすすめ：STEP '+recommended+' '+state[recommended-1].title));hero.append(heading)
  const counter=el('div',null,'guide-count'),progress=document.createElement('progress');progress.max=5;progress.value=done;progress.setAttribute('aria-label','設定の進捗');counter.append(el('strong',done+' / 5 ステップ確認済み'),progress);hero.append(counter);shell.append(hero)
  const steps=el('nav',null,'guide-steps');steps.setAttribute('aria-label','設定ステップ');for(const item of state){const b=btn(' ',()=>onStep(item.number));b.replaceChildren(el('span','STEP '+item.number,'guide-step-num'),el('span',item.title),el('small',item.ready?'✓ 確認済み':item.status));b.className='guide-step';b.dataset.ready=String(item.ready);if(item.number===current.number)b.setAttribute('aria-current','step');steps.append(b)}shell.append(steps)
  const body=el('div',null,'guide-body'),feedback=el('p',message??'','guide-feedback'+(error?' error':''));feedback.id='guide-feedback';feedback.setAttribute('role','status');feedback.hidden=!message;body.append(feedback)
  const header=el('div',null,'guide-status-line');header.append(badge('STEP '+current.number,false),badge(current.ready?'確認済み':current.status,current.ready));body.append(header,el('h3',current.title))
  const run=async(control,action,data={})=>{control.disabled=true;feedback.hidden=false;feedback.classList.remove('error');feedback.textContent='確認・保存しています…';try{await onAction(action,data)}catch(e){feedback.hidden=false;feedback.classList.add('error');feedback.textContent=e.message??'操作を完了できませんでした。'}finally{control.disabled=false}}
  function saveForm(section,description,items,label,action,data){const form=el('form');form.append(el('p',description),...items.map(f=>f.label));const submit=el('button',label,'guide-primary');submit.type='submit';form.append(submit);form.onsubmit=e=>{e.preventDefault();run(submit,action,data())};section.append(form);return form}
  if(current.number===1){
    body.append(el('p','店舗で利用できることを確認してから、採用用の公式LINEを登録します。初回の設定だけで大丈夫です。','guide-intro'))
    const eligible=box('店舗の利用条件',info.eligible_at?'利用条件は確認済みです。':'必要な許可・届出、LINE利用条件を店舗と確認してください。')
    if(!info.eligible_at){const valid=field(' 許可・届出とLINE利用条件を確認済み','verified','checkbox',false);valid.input.required=true;const ref=field('確認者・確認記録','reference');ref.input.placeholder='例：担当者名・確認日';saveForm(eligible,'確認後にチェックして保存します。',[valid,ref],'利用条件を保存','eligibility',()=>({verified:valid.input.checked,reference:ref.input.value.trim()}))}body.append(eligible)
    const flags=basicFeatures.filter(k=>!info.features?.[k]),features=box('採用の基本機能',flags.length?'面談予約・応募・通知など、採用に必要な機能をまとめて有効にできます。その他の詳細機能の設定は変更しません。':'必要な基本機能は有効です。')
    if(flags.length){const apply=btn('採用の基本機能を有効にする',e=>run(e.currentTarget,'features'),true);features.append(apply)}body.append(features)
    const connect=box('公式LINEの接続・テスト',journey.connected?'接続の確認が完了しました。':'LINEの管理画面にある情報を登録して、スマホで送受信を確認します。')
    const c=journey.channels?.find(x=>!x.stopped&&x.status!=='connected')??journey.channels?.find(x=>!x.stopped)
    if(c){connect.append(el('p',c.label+(c.basic_id?'（'+c.basic_id+'）':'')),checklist(lineFlags.map(([k,label])=>[!!c.checks?.[k],label])));const missing=lineFlags.find(([k])=>!c.checks?.[k]);if(missing)connect.append(el('p','次に行うこと：'+missing[1],'guide-muted'));connect.append(actions(link('LINE接続・動作確認を開く',lineUrl+(c?'&line_channel='+encodeURIComponent(c.id):'')+(c.checks?.token_verified&&c.checks?.webhook_verified?'#line-tester':'#line-connections'),true)))}else connect.append(actions(link('公式LINEを登録する',lineUrl,true)))
    body.append(connect)
  }else if(current.number===2){
    body.append(el('p','最初は「面談までの基本の型」を選ぶだけ。用意された案内の文章をその店舗用に編集します。','guide-intro'))
    const first=box('おすすめ：LINEトークで応募から面談まで','友だち追加 → 応募の同意 → 名前・最寄駅・年齢 → 面談予約 → 確定通知。予約リンクは自動で発行されます。');first.append(actions(link('面談までの基本の型を編集する',studio+'&start=intake',true)));body.append(first)
    const second=box('応募フォームから始める・自由に組む','応募フォーム送信後に予約を案内するパターンや、タグ別の配信を作りたいときはこちら。');second.append(actions(link('新規シナリオを作る',studio+'&start=wizard'),link('応募フォームを管理',workflows+'&tab=forms')));body.append(second)
    const saved=box('この店舗のステップ',`${journey.counts?.drafts??0}件作成済み ／ ${journey.counts?.published??0}件公開中。下書き保存の段階では配信されません。`);saved.append(actions(link('作成済みのステップを確認する',studio)));body.append(saved)
  }else if(current.number===3){
    body.append(el('p','面談の受付時間・曜日・会場を設定します。基本は対面、18:00〜24:00の30分枠です。','guide-intro'))
    for(const [id,title,description,hash,label] of [['calendar','1. Googleカレンダー','店舗専用カレンダーを連携すると、予定と重なる枠には予約できません。','#availability','Googleカレンダーを連携する'],['slots','2. 受付時間・面談枠','受付開始・終了、面談会場を決めて、受付曜日を選び面談枠をまとめて公開します。','#slot-batch','面談枠を作成する']]){const s=box(title,description);s.append(badge(ready(journey,id)?'設定確認済み':check(journey,id)?.detail??'未設定',ready(journey,id)),actions(link(label,calendar+hash,true)));body.append(s)}
    const more=box('受付時間の変更・予約したくない時間・予約一覧','Googleの予定以外にも任意の受付停止時間を追加できます。');more.append(actions(link('受付時間を変更する',calendar+'#interview-hours'),link('面談予約の管理を開く',calendar)));body.append(more)
  }else if(current.number===4){
    body.append(el('p','通常は自動タグの初期設定で使えます。タグを1つずつ手作業で設定する必要はありません。','guide-intro'))
    const tags=box('おすすめの採用タグ',`${journey.counts?.active_tags??0}種類有効 ／ うち自動付与ルール ${journey.counts?.automatic_tags??0}種類。応募・予約・選考の状況に合わせて自動更新されます。`)
    tags.append(el('p','標準タグの例（変更済みの店舗は現在の設定が優先されます）','guide-muted'),checklist([[true,'面談未予約 → 面談予約済（予約確定時）'],[true,'選考状況の変更 → 面談完了・体験入店予定など'],[true,'店長へ引き継ぎ → 店長対応中']]),el('p','既存の独自タグや編集済みのルールは上書きしません。標準タグが未作成なら追加します。','guide-muted'))
    tags.append(actions(btn('おすすめ採用タグを使う',e=>run(e.currentTarget,'tags'),true),link('タグの詳細設定を開く',workflows+'&tab=tags')));body.append(tags)
  }else{
    body.append(el('p','テスト・公開・自動配信は別です。通常配信を開始する前に、LINEの実際の送受信と予約結果を確認します。','guide-intro'))
    const preview=box('1. 配信内容を確認','基本の型はLINE風のプレビュー、自由なシナリオは模擬テストで確認してください。実LINEテストは送信先を限定して行えます。');preview.append(actions(link('ステップ配信の確認・テスト',studio),link('LINE接続テストの確認',lineUrl+'#line-tester')));body.append(preview)
    const contract=box('2. 契約確認',info.contract_active?'店舗の契約確認を保存済みです。':'契約・LINE運用の許可を確認して保存してください。自動配信はこの操作だけでは開始しません。')
    if(!info.contract_active){const valid=field(' 店舗との契約・LINE運用許可を確認済み','contract','checkbox',false);valid.input.required=true;const reason=field('確認者・変更理由','reason','text','');reason.input.placeholder='例：担当者名・契約確認日';saveForm(contract,'実際に確認できた場合だけ保存します。',[valid,reason],'契約確認だけ保存する','contract',()=>({contract:valid.input.checked,reason:reason.input.value.trim()}))}body.append(contract)
    const runBox=box('3. 自動配信のオン・オフ',info.auto_enabled?'現在、自動配信はONです。既存の公開中シナリオが動作します。':'現在、自動配信はOFFです。下書きやテストだけでは一般向けに送信されません。')
    if(journey.blockers?.length){const warnings=el('div',null,'guide-box guide-blocks');warnings.append(el('h4','配信開始できない理由'));const list=el('ul');for(const item of journey.blockers){const li=el('li',item.message);if(item.step!==5)li.append(btn('STEP '+item.step+' を開く',()=>onStep(item.step)));list.append(li)}warnings.append(list);runBox.append(warnings)}
    const limit=field('月あたりの送信上限','limit','number',String(info.monthly_limit??100));limit.input.min='1';limit.input.max='1000000';limit.input.step='1';const reason=field('変更理由','reason','text',info.auto_enabled?'自動配信の停止':'採用自動配信の運用開始');const form=el('form');form.append(limit.label,reason.label);const sw=el('button',info.auto_enabled?'自動配信を停止する':'自動配信を開始する',info.auto_enabled?'danger':'guide-primary');sw.type='submit';sw.disabled=!info.auto_enabled&&journey.blockers?.length>0;form.append(sw);form.onsubmit=e=>{e.preventDefault();const enabling=!info.auto_enabled;const text=enabling?'この店舗の公開済みシナリオが新しい対象者に配信されるようになります。内容を確認しましたか？':'この店舗の自動配信を停止します。進行中の配信は終了します。停止してよいですか？';if(confirm(text))run(sw,'automation',{enabled:enabling,monthly_limit:Number(limit.input.value),reason:reason.input.value.trim()})};runBox.append(form);body.append(runBox)
    const publish=box('4. ステップを公開',journey.counts.published>0?`${journey.counts.published}件公開中です。`:'未公開です。基本の型は自動配信ONの後、プレビューを確認して「この型を公開する」を押してください。');publish.append(actions(link('シナリオスタジオで公開する',studio,true)));body.append(publish)
    const accept=box('5. 実際の動作確認','スマホで応募・対面予約・通知到着を確認します。設定確認と実際の端末確認は別です。');accept.append(checklist([[['line','calendar','slots','steps','automation'].every(k=>ready(journey,k)),'LINE・カレンダー・面談枠・ステップ公開・通常配信の確認'],[ready(journey,'test'),'実機確認の記録']]));
    accept.append(actions(btn('現在のLINE・Googleの接続を再確認',e=>run(e.currentTarget,'probe')),btn('詳しい導入チェックを開く',()=>onDetail('#agency-health'))))
    if(journey.health?.acceptance_ready&&!ready(journey,'test')){const checks=[['received','一般LINEでメッセージを受信した'],['application','応募できた'],['booking','対面面談を確定した'],['overlap','Google予定と重なる枠は予約不可だった'],['notification','面談確定通知が届いた']].map(([name,text])=>field(' '+text,name,'checkbox',false));checks.forEach(x=>x.input.required=true);saveForm(accept,'実際に確認した内容のみ記録してください。',checks,'実機確認を記録する','acceptance',()=>({fingerprint:journey.health.fingerprint,...Object.fromEntries(checks.map(x=>[x.input.name,x.input.checked]))}))}body.append(accept)
  }
  shell.append(body);const bottom=el('div',null,'guide-bottom'),left=actions(btn('前へ',()=>onStep(Math.max(1,current.number-1))),btn('最新の進捗を更新',onRefresh));left.firstChild.disabled=current.number===1;bottom.append(left,btn(current.number===5?'おすすめの作業へ':'次へ：'+state[current.number].title,()=>onStep(current.number===5?recommended:current.number+1),true));shell.append(bottom)
  const daily=el('section',null,'panel guide-daily');daily.append(el('h2','日々の店舗運用'),el('p','設定が完了した店舗は、こちらから直接作業できます。','muted'));const grid=el('div',null,'guide-quick-grid');for(const [title,desc,url] of [['応募・選考管理','応募者の状況を更新',workflows+'&tab=recruitment'],['面談予約','予約一覧・受付時間',calendar],['トーク対応','受信箱・通知履歴',workflows+'&tab=inbox'],['ステップ配信','文章の編集・テスト',studio],['応募フォーム','質問・回答の管理',workflows+'&tab=forms'],['採用タグ','タグ・絞り込み配信',workflows+'&tab=tags']]){const a=el('a');a.href=url;a.append(el('strong',title),el('small',desc));grid.append(a)}daily.append(grid,actions(btn('詳細モードでその他の機能を開く',()=>onDetail())));root.replaceChildren(shell,daily)
}
