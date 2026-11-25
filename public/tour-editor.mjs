import {mountPiyomaru} from './piyomaru.mjs'
import {tourRequest} from './tour.mjs'

const $=id=>document.getElementById(id)
const form=$('tour-editor'), selector=$('tour-select'), preview=$('tour-preview'), notice=$('notice')
const drafts=new Map()
let tours, selected, inputs=[], pending

function element(tag,text){
  const node=document.createElement(tag)
  if(text)node.textContent=text
  return node
}

function field(label,value,limit,tag='input'){
  const wrapper=element('label',label), input=element(tag)
  input.required=true
  input.maxLength=limit
  input.value=value
  if(tag==='textarea')input.rows=3
  wrapper.append(input)
  return {wrapper,input}
}

function collect(){
  return {title:$('tour-title').value.trim(),steps:inputs.map(({id,caption,body})=>({
    id,caption:caption.value.trim(),body:body.value.trim(),
  }))}
}

function load(id){
  selected=id
  const published=tours[id], copy=drafts.get(id)??published
  $('tour-title').value=copy.title
  $('tour-version').textContent=published.published_at
    ? '最終公開 '+new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(published.published_at))
    : '標準の案内を表示中'
  inputs=[]
  $('tour-steps').replaceChildren(...copy.steps.map((step,index)=>{
    const group=element('fieldset')
    group.className='line-step'
    const caption=field('見出し',step.caption,100)
    const body=field('案内文',step.body,500,'textarea')
    group.append(element('legend','手順 '+(index+1)),caption.wrapper,body.wrapper)
    inputs.push({id:step.id,caption:caption.input,body:body.input})
    return group
  }))
  notice.textContent=''
}

selector.onchange=()=>{
  drafts.set(selected,collect())
  load(selector.value)
}
form.onsubmit=event=>{
  event.preventDefault()
  const copy=collect()
  if(!copy.title||copy.steps.some(step=>!step.caption||!step.body)){
    notice.textContent='空欄の名前・見出し・案内文を入力してください。'
    return
  }
  pending={...copy,revision:tours[selected].revision}
  const list=element('ol')
  for(const step of copy.steps){
    const item=element('li')
    item.append(element('strong',step.caption),element('p',step.body))
    list.append(item)
  }
  $('preview-content').replaceChildren(element('h3',copy.title),list)
  $('preview-status').textContent=''
  preview.showModal()
}

$('edit-again').onclick=()=>preview.close()
$('publish-tour').onclick=async event=>{
  const button=event.currentTarget
  button.disabled=true
  $('edit-again').disabled=true
  try{
    const published=await tourRequest(selected,pending)
    tours[selected]=published
    selector.selectedOptions[0].textContent=published.title
    drafts.delete(selected)
    preview.close()
    load(selected)
    notice.textContent='公開しました。次に画面ツアーを開くと、この案内が表示されます。'
  }catch(error){$('preview-status').textContent=error.message}
  finally{button.disabled=false;$('edit-again').disabled=false}
}
preview.addEventListener('cancel',event=>{
  if($('publish-tour').disabled)event.preventDefault()
})
try{
  tours=await tourRequest();mountPiyomaru('tour-editor')
  selector.replaceChildren(...Object.entries(tours).map(([id,tour])=>new Option(tour.title,id)))
  load(selector.value)
  form.hidden=false
}catch(error){notice.textContent=error.message}
