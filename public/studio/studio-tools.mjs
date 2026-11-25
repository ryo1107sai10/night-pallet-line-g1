import { kinds, links, simulate } from './engine.mjs'

export const edgeTarget=(flow,edge)=>edge.owner===null?flow.entry:flow.nodes.find(n=>n.id===edge.owner)?.[edge.key]
export function incomingEdges(flow,id){
  const edges=[]
  if(flow.entry===id)edges.push({owner:null,key:'entry'})
  for(const n of flow.nodes)for(const key of n.type==='branch'?['yes','no']:n.type==='end'?[]:['next']){
    if(n[key]===id)edges.push({owner:n.id,key})
  }
  return edges
}
export function outgoingEdges(flow,id){
  const n=flow.nodes.find(n=>n.id===id)
  return n?(n.type==='end'?incomingEdges(flow,id):n.type==='branch'?[{owner:id,key:'yes'},{owner:id,key:'no'}]:[{owner:id,key:'next'}]):[{owner:null,key:'entry'}]
}
export function insertStep(flow,edge,type,id){
  if(!Object.hasOwn(kinds,type)||flow.nodes.length>=100||flow.nodes.some(n=>n.id===id))return null
  const draft=structuredClone(flow)
  const parent=edge.owner===null?draft:draft.nodes.find(n=>n.id===edge.owner)
  if(!parent||(edge.owner===null?edge.key!=='entry':!(parent.type==='branch'?['yes','no']:parent.type==='end'?[]:['next']).includes(edge.key)))return null
  const target=parent[edge.key]
  if(type==='end'&&target)return null // do not sever an existing route
  const step={id,type,name:kinds[type]}
  if(type==='branch')Object.assign(step,{condition:'booked',yes:target??'',no:target??'',tag:''})
  else if(type!=='end')step.next=target??''
  if(type==='message')Object.assign(step,{body:'',category:'service'})
  if(type==='wait')Object.assign(step,{mode:'delay',minutes:60})
  if(type==='tag')step.tag=''
  if(type==='task')step.note=''
  parent[edge.key]=id
  const at=draft.nodes.findIndex(n=>n.id===target)
  draft.nodes.splice(at<0?draft.nodes.length:at,0,step)
  return draft
}
export function formatMinutes(minutes){
  if(!Number.isFinite(minutes))return '未設定'
  if(minutes%1440===0&&minutes>0)return minutes/1440+'日'
  if(minutes%60===0&&minutes>0)return minutes/60+'時間'
  return minutes+'分'
}
export function timeUnit(minutes){
  return minutes>0&&minutes%1440===0?{value:minutes/1440,unit:1440}:minutes>0&&minutes%60===0?{value:minutes/60,unit:60}:{value:minutes??0,unit:1}
}
export function tagKeys(flow){
  return [...new Set([flow.triggerTag,...flow.nodes.flatMap(n=>[
    n.type==='tag'||n.type==='branch'&&n.condition==='tag'?n.tag:null,n.tagGuard?.tag,...(n.tagGuard?.exclude??[]),
  ])].filter(Boolean))]
}
export function copyFlow(flow,{name,channel,sourceName,targetName,tagMap={},origin}){
  const draft=structuredClone(flow)
  draft.name=name.trim().slice(0,100)
  draft.channel=channel
  const mapped=k=>tagMap[k]??k
  if(draft.triggerTag)draft.triggerTag=mapped(draft.triggerTag)
  for(const n of draft.nodes){
    if((n.type==='tag'||n.type==='branch'&&n.condition==='tag')&&n.tag)n.tag=mapped(n.tag)
    if(n.tagGuard){n.tagGuard.tag=mapped(n.tagGuard.tag);n.tagGuard.exclude=[...new Set(n.tagGuard.exclude.map(mapped))].filter(x=>x!==n.tagGuard.tag)}
    if(n.type==='message'){
      if(sourceName&&targetName&&sourceName!==targetName)n.body=n.body.split(sourceName).join('{{store}}')
      // Convert only known app reservation links, not arbitrary external URLs.
      if(origin)n.body=n.body.replace(/https?:\/\/[^\s<>"'、。]+/g,raw=>{
        try{const url=new URL(raw);if(url.origin===origin&&draft.purpose==='recruitment'&&/^\/(?:reserve|book|interview-link|liff)\//.test(url.pathname))return '{{interview_link}}'
          if(url.origin===origin&&draft.purpose==='customer'&&/^\/(?:account|customer-link)\//.test(url.pathname))return '{{customer_link}}'
        }catch{}
        return raw
      })
    }
  }
  return draft
}
export function bodyReplacement(flow,find,replacement){
  if(!find)return {flow:structuredClone(flow),count:0,steps:0}
  const draft=structuredClone(flow);let count=0,steps=0
  for(const n of draft.nodes)if(n.type==='message'&&n.body.includes(find)){
    count+=n.body.split(find).length-1;steps++;n.body=n.body.split(find).join(replacement)
  }
  return {flow:draft,count,steps}
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
export function compareFlows(before,after){
  if(!before)return {added:after.nodes.map(n=>n.name),removed:[],changed:[],settings:[]}
  const old=new Map(before.nodes.map(n=>[n.id,n])),next=new Map(after.nodes.map(n=>[n.id,n]))
  return {
    added:after.nodes.filter(n=>!old.has(n.id)).map(n=>n.name),
    removed:before.nodes.filter(n=>!next.has(n.id)).map(n=>n.name),
    changed:after.nodes.filter(n=>old.has(n.id)&&!same(n,old.get(n.id))).map(n=>n.name),
    settings:[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>k!=='nodes'&&!same(before[k],after[k])),
  }
}
export function simulationCases(flow,person){
  const base=structuredClone(person)
  const nextDate=new Date(Date.parse(base.start+'Z')+2*86400000)
  if(!base.bookingAt&&Number.isFinite(+nextDate))base.bookingAt=nextDate.toISOString().slice(0,16)
  const target=flow.triggerTag??flow.nodes.find(n=>n.tagGuard)?.tagGuard?.tag
  if(target&&!base.tags.includes(target))base.tags=[...base.tags,target]
  const normal={...base,consent:true,adult:true,blocked:false,stopped:false,human:false,cancelled:false}
  const cases=[
    ['未予約・同意あり',{...normal,booked:false}],
    ['予約済み・同意あり',{...normal,booked:true}],
    ['通知同意なし',{...normal,consent:false}],
    ['店長対応中',{...normal,human:true}],
    ['LINEブロック中',{...normal,blocked:true}],
    ['全配信停止中',{...normal,stopped:true}],
  ]
  if(flow.purpose==='customer')cases.push(['年齢未確認',{...normal,adult:false}])
  if(target)cases.push(['対象タグなし',{...normal,tags:normal.tags.filter(k=>k!==target)}])
  return cases.map(([label,fixture])=>({label,result:simulate(flow,fixture)}))
}
export function routeSteps(flow,id,limit=100){
  const seen=new Set(),byId=new Map(flow.nodes.map(n=>[n.id,n])),queue=[id]
  while(queue.length&&seen.size<limit){
    const key=queue.shift(),step=byId.get(key)
    if(!step||seen.has(key))continue
    seen.add(key);queue.push(...links(step))
  }
  return seen.size
}
