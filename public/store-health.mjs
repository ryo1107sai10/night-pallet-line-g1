const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
const btn=(label,fn,cls='secondary')=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b}
const resultLabels={ready:'確認済み',action:'要設定',warning:'要確認',off:'OFF'}
const destinations={store:'/master/',line:'/agency-line/',calendar:'/interview/staff.html',forms:'/workflows/',studio:'/studio/',delivery:'/workflows/'}
const formatTime=v=>v?new Intl.DateTimeFormat('ja-JP',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(v)):'未実施'

export function healthDestination(row,destination,platform=false){
 const params=new URLSearchParams({store:row.id})
 if(destination==='forms'||destination==='delivery'){params.set('use','recruitment');params.set('tab',destination==='forms'?'forms':'delivery');if(destination==='delivery')params.set('failures','1')}
 let page=destinations[destination]??'/master/'
 if(destination==='line'&&platform)page='/master/'
 return page+'?'+params+(destination==='line'&&platform?'#quick-line':destination==='calendar'?'#availability':'')
}

export function mountStoreHealth(root,{load,probe,accept,open,diagnose,compact=false}){
 if(!root)return
 let rows=[],busy=false,filter='all',query='',expanded=new Set()
 const title=el('div',undefined,'heading')
 const refresh=btn('更新',()=>reload())
 title.append(el('h2',compact?'店舗診断・導入状況':'全店舗の健康診断・導入チェック'),refresh)
 const lead=el('p','店舗別の設定・公開状況と、直近の接続照合結果を表示します。緑色の設定確認と実際の端末での受信確認は区別します。','muted')
 const summary=el('div',undefined,'health-summary')
 const tools=el('div',undefined,'health-tools')
 const search=el('input');search.type='search';search.placeholder='店舗名・管理会社を検索';search.setAttribute('aria-label','店舗を検索')
 const select=el('select');select.setAttribute('aria-label','診断結果で絞り込む');for(const [v,l] of [['all','全店舗'],['action','要対応・導入中'],['ready','実機確認済み']])select.add(new Option(l,v))
 tools.append(search,select)
 const status=el('p',undefined,'muted');status.setAttribute('role','status')
 const list=el('div',undefined,'health-grid')
 root.replaceChildren(title,lead,summary,tools,status,list);root.hidden=false
 function replaceRow(row){rows=rows.map(r=>r.id===row.id?row:r);expanded.add(row.id);render()}
 async function runAction(action,row,data){
  if(busy)return;busy=true;status.textContent='確認しています…';render()
  try{const result=await action(row,data);replaceRow(result);status.textContent='確認結果を更新しました。'}
  catch(error){status.textContent=error.message??'確認に失敗しました。'}
  finally{busy=false;render()}
 }
 function render(){
  summary.replaceChildren(...[
   ['全店舗',rows.length],['導入確認済み',rows.filter(r=>r.ready).length],['要対応',rows.filter(r=>!r.ready).length]
  ].map(([label,n])=>{const item=el('div',undefined,'health-metric');item.append(el('strong',String(n)),el('span',label));return item}))
  const term=query.toLocaleLowerCase('ja-JP')
  const filtered=rows.filter(r=>(filter==='all'||(filter==='ready'?r.ready:!r.ready))&&(r.name+' '+r.company).toLocaleLowerCase('ja-JP').includes(term))
  list.replaceChildren()
  if(!filtered.length){list.append(el('p',rows.length?'該当店舗がありません。':'登録された店舗はありません。','muted'));return}
  for(const row of filtered){
   const card=el('article',undefined,'health-card')
   const header=el('div',undefined,'health-card-head');const name=el('div');name.append(el('h3',row.name),el('small',row.company,'muted'))
   header.append(name,el('span',row.ready?'導入確認済み':'要対応','health-badge '+(row.ready?'ready':'action')))
   const progress=el('progress');progress.max=row.progress.total;progress.value=row.progress.done;progress.setAttribute('aria-label','導入チェックの進捗')
   const first=row.checks.find(c=>c.state==='action'&&c.id!=='test')??row.checks.find(c=>c.state==='warning')??row.checks.find(c=>c.id==='test'&&c.state!=='ready')
   const next=el('p',first?'次：'+first.label+' — '+first.detail:'必要な確認がそろっています。','health-next')
   const toolbar=el('div',undefined,'health-actions')
   const verify=btn('実際の接続を確認',()=>runAction(probe,row));verify.disabled=busy
   const disclosure=btn(expanded.has(row.id)?'詳細を閉じる':'詳細・導入チェックを開く',()=>{expanded.has(row.id)?expanded.delete(row.id):expanded.add(row.id);render()})
   toolbar.append(verify,disclosure)
   if(diagnose)toolbar.append(btn('ピヨ丸に診断を相談',()=>diagnose(row)))
   if(first&&first.destination!=='test')toolbar.append(btn('次の設定を開く',()=>open(row,first.destination),'health-primary'))
   card.append(header,el('small',row.progress.done+'/'+row.progress.total+' 項目確認済み','muted'),progress,next,toolbar,
    el('small','接続再照合：'+formatTime(row.probe_at)+(row.probe_at&&!row.probe_current?'（再確認が必要）':''),'muted'))
   if(expanded.has(row.id)){
    const checks=el('div',undefined,'health-checks')
    for(const c of row.checks){
     const entry=el('div',undefined,'health-check-row')
     const title=el('div',undefined,'health-check-name');title.append(el('strong',c.label),el('span',resultLabels[c.state]??c.state,'health-badge '+c.state))
     entry.append(title,el('p',c.detail,'muted'))
     if(c.destination!=='test')entry.append(btn('設定・詳細を開く',()=>open(row,c.destination)))
     checks.append(entry)
    }
    card.append(checks)
    if(row.acceptance_ready&&!row.ready){
     const form=el('form',undefined,'health-confirm')
     form.append(el('strong','実機確認の記録'),el('p','一般LINEの端末で実際に確認した項目だけを選んでください。','muted'))
     const items=[['received','公式LINEから検証メッセージを受信した'],['application','応募できた'],['booking','対面面談を確定した'],['overlap','Google予定と重なる枠は予約できなかった'],['notification','面談確定通知が実際に届いた']]
     for(const [key,label] of items){const l=el('label');const i=el('input');i.type='checkbox';i.name=key;i.required=true;l.append(i,document.createTextNode(label));form.append(l)}
     const commit=el('button','実機確認を記録する');commit.type='submit';commit.disabled=busy;form.append(commit)
     form.onsubmit=e=>{e.preventDefault();if(!items.every(([key])=>form.elements[key].checked))return
       runAction(accept,row,{fingerprint:row.fingerprint,...Object.fromEntries(items.map(([key])=>[key,true]))})}
     card.append(form)
    }
   }
   list.append(card)
  }
 }
 async function reload(){
  if(busy)return;busy=true;refresh.disabled=true;status.textContent='店舗の設定を確認しています…'
  try{rows=await load();render();status.textContent=''}
  catch(error){status.textContent=error.message??'読み込みに失敗しました。'}
  finally{busy=false;refresh.disabled=false;render()}
 }
 search.oninput=()=>{query=search.value;render()}
 select.onchange=()=>{filter=select.value;render()}
 void reload()
 return {reload}
}
