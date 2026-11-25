// A rich step is one LINE Flex message, keeping frequency/budget accounting unchanged.
export function publicHttps(value){
  if(typeof value!=='string'||value.length>2000||/\s|[{}]/.test(value))return false
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')&&!u.hostname.endsWith('.local')&&!/^\d+\./.test(u.hostname)}catch{return false}
}
export const dynamicButtonUrls=['{{interview_link}}','{{customer_link}}']
export function richErrors(rich,body){
  if(!rich)return []
  const problems=[]
  if(!['image','buttons','card'].includes(rich.kind))problems.push('メッセージ形式を選択してください。')
  if(body!==undefined&&body.length>1000)problems.push('画像・カード付き本文は1000文字以内にしてください。')
  if(rich.kind==='image'&&!publicHttps(rich.imageUrl)||rich.imageUrl&&!publicHttps(rich.imageUrl))problems.push('画像の公開HTTPS URLを入力してください。')
  if(rich.kind==='card'&&!rich.title?.trim())problems.push('カードタイトルを入力してください。')
  if(rich.title?.length>60)problems.push('カードタイトルは60文字以内にしてください。')
  if(!Array.isArray(rich.buttons)||rich.buttons.length>3||rich.kind==='buttons'&&!rich.buttons.length)problems.push('リンクボタンは1〜3個（カード・画像は0個でも可）にしてください。')
  if(rich.buttons?.some(b=>!b.label?.trim()||b.label.length>20||!publicHttps(b.url)&&!dynamicButtonUrls.includes(b.url)))problems.push('ボタン名（20文字以内）と公開HTTPS URLを入力してください。')
  if(body!==undefined&&rich.buttons?.some(b=>dynamicButtonUrls.includes(b.url)&&!body.includes(b.url)))problems.push('予約ボタンと同じ予約URLの差し込みを本文にも追加してください。')
  return problems
}
export function resolveRichButtons(rich,links={}){
  if(!rich)return undefined
  const result=structuredClone(rich);for(const button of result.buttons)if(dynamicButtonUrls.includes(button.url)){const url=links[button.url];if(!publicHttps(url))throw new Error('予約ボタンのURLを発行できません。');button.url=url}return result
}
export function lineMessage(body,rich){
  if(!rich)return {type:'text',text:body}
  if(richErrors(rich).length||rich.buttons?.some(b=>dynamicButtonUrls.includes(b.url))||typeof body!=='string'||!body.trim()||body.length>5000)throw new Error('画像・カードの内容が無効です。')
  const content=[]
  if(rich.title?.trim())content.push({type:'text',text:rich.title,weight:'bold',size:'lg',wrap:true})
  content.push({type:'text',text:body,wrap:true,size:'sm',margin:'md'})
  const bubble={type:'bubble',body:{type:'box',layout:'vertical',contents:content}}
  if(rich.imageUrl)bubble.hero={type:'image',url:rich.imageUrl,size:'full',aspectRatio:'20:13',aspectMode:'cover'}
  if(rich.buttons?.length)bubble.footer={type:'box',layout:'vertical',spacing:'sm',contents:rich.buttons.map(b=>({type:'button',style:'primary',height:'sm',action:{type:'uri',label:b.label,uri:b.url}}))}
  return {type:'flex',altText:body.slice(0,400),contents:bubble}
}
