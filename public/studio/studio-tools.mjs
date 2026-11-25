import { kinds, links, simulate, starter, branchRules } from './engine.mjs'

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
    n.type==='tag'?n.tag:null,...(n.type==='branch'?branchRules(n).filter(r=>r.condition==='tag').map(r=>r.tag):[]),n.tagGuard?.tag,...(n.tagGuard?.exclude??[]),
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
    if(n.type==='branch'&&n.rules)for(const rule of n.rules)if(rule.condition==='tag'&&rule.tag)rule.tag=mapped(rule.tag)
    if(n.tagGuard){n.tagGuard.tag=mapped(n.tagGuard.tag);n.tagGuard.exclude=[...new Set(n.tagGuard.exclude.map(mapped))].filter(x=>x!==n.tagGuard.tag)}
    if(n.type==='message'){
      if(sourceName&&targetName&&sourceName!==targetName){n.body=n.body.split(sourceName).join('{{store}}');if(n.rich?.title?.includes(sourceName))n.rich.title=n.rich.title.split(sourceName).join(targetName).slice(0,60);for(const b of n.rich?.buttons??[])try{const url=new URL(b.url);if(url.origin===origin&&/^\/(?:reserve|book|interview-link|liff|account|customer-link)\//.test(url.pathname))b.url=''}catch{}}
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

// A copied block must have one entry and be internally connected. External exits are
// reconnected to the insertion target; existing graph edges are never removed.
export function stepBlock(flow,selected){
  const ids=new Set(selected),all=new Map(flow.nodes.map(n=>[n.id,n]))
  if(!ids.size||[...ids].some(id=>!all.has(id)))return null
  const roots=[...ids].filter(id=>!flow.nodes.some(n=>ids.has(n.id)&&links(n).includes(id)))
  if(roots.length!==1)return null
  const visited=new Set(),stack=[roots[0]]
  while(stack.length){const id=stack.pop();if(!ids.has(id)||visited.has(id))continue;visited.add(id);stack.push(...links(all.get(id)))}
  if(visited.size!==ids.size)return null
  return {entry:roots[0],nodes:structuredClone(flow.nodes.filter(n=>ids.has(n.id)))}
}
export function pasteBlock(flow,edge,block,idFactory){
  if(!block||flow.nodes.length+block.nodes.length>100)return null
  const parent=edge.owner===null?flow:flow.nodes.find(n=>n.id===edge.owner)
  if(!parent||(edge.owner===null?edge.key!=='entry':!['next','yes','no'].includes(edge.key)||!Object.hasOwn(parent,edge.key)))return null
  const target=parent[edge.key];if(target&&block.nodes.some(n=>n.type==='end'))return null
  const draft=structuredClone(flow),map=new Map(block.nodes.map(n=>[n.id,idFactory()]))
  if(new Set(map.values()).size!==map.size||[...map.values()].some(id=>flow.nodes.some(n=>n.id===id)))return null
  const cloned=block.nodes.map(n=>{const copy=structuredClone(n);copy.id=map.get(n.id);copy.name=(copy.name+'（コピー）').slice(0,100);for(const key of n.type==='branch'?['yes','no']:n.type==='end'?[]:['next'])copy[key]=map.get(n[key])??target??'';return copy})
  const entry=map.get(block.entry);const dest=edge.owner===null?draft:draft.nodes.find(n=>n.id===edge.owner)
  dest[edge.key]=entry
  const at=draft.nodes.findIndex(n=>n.id===target);draft.nodes.splice(at<0?draft.nodes.length:at,0,...cloned)
  return {flow:draft,entry,ids:cloned.map(n=>n.id)}
}
// Ordered graph overview and the branch disclosures that must open to reach a card.
export function stepOutline(flow){
  const seen=new Set(),map=new Map(flow.nodes.map(n=>[n.id,n])),result=[]
  function walk(id,path=[],depth=0){if(!map.has(id)||seen.has(id))return;seen.add(id);const n=map.get(id);result.push({id,name:n.name,type:n.type,path,depth});if(n.type==='branch'){walk(n.yes,[...path,n.id+':yes'],depth+1);walk(n.no,[...path,n.id+':no'],depth+1)}else if(n.type!=='end')walk(n.next,path,depth)}
  walk(flow.entry);for(const n of flow.nodes)if(!seen.has(n.id))walk(n.id);return result
}
export function wizardFlow({purpose='recruitment',name,channel,trigger,triggerTag,first,follow='',minutes=1440,skipBooked=true}){
  const flow=starter(purpose);Object.assign(flow,{name,channel,trigger,entry:'welcome'});if(trigger==='tag_added')flow.triggerTag=triggerTag
  flow.nodes=[{id:'welcome',type:'message',name:'初回案内',category:'service',body:first,next:follow?'wait':'end'}]
  if(follow){flow.nodes.push({id:'wait',type:'wait',name:'再案内まで待機',mode:'delay',minutes,next:skipBooked?'check':'remind'});if(skipBooked)flow.nodes.push({id:'check',type:'branch',name:'予約済みか確認',condition:'booked',yes:'end',no:'remind'});flow.nodes.push({id:'remind',type:'message',name:'再案内',category:'service',body:follow,next:'end'})}
  flow.nodes.push({id:'end',type:'end',name:'終了'});return flow
}

// Editing operations never change the source graph. A reconnect may deliberately
// leave an unused route in the draft, but a cycle is never introduced.
function reachableIds(flow){const map=new Map(flow.nodes.map(n=>[n.id,n])),seen=new Set(),pending=[flow.entry];while(pending.length){const id=pending.pop();if(!map.has(id)||seen.has(id))continue;seen.add(id);pending.push(...links(map.get(id)))}return seen}
function hasCycle(flow){const map=new Map(flow.nodes.map(n=>[n.id,n])),visiting=new Set(),visited=new Set();function visit(id){if(visiting.has(id))return true;if(visited.has(id)||!map.has(id))return false;visiting.add(id);if(links(map.get(id)).some(visit))return true;visiting.delete(id);visited.add(id);return false}return flow.nodes.some(n=>visit(n.id))}
function setEdge(flow,edge,target){const owner=edge.owner===null?flow:flow.nodes.find(n=>n.id===edge.owner);if(!owner||!(edge.owner===null?edge.key==='entry':(owner.type==='branch'?['yes','no']:owner.type==='end'?[]:['next']).includes(edge.key)))return false;owner[edge.key]=target;return true}
export function reconnectEdge(flow,edge,target){
  if(!flow.nodes.some(n=>n.id===target)||edgeTarget(flow,edge)===target)return null
  const draft=structuredClone(flow);if(!setEdge(draft,edge,target)||hasCycle(draft))return null
  const before=reachableIds(flow),after=reachableIds(draft)
  return {flow:draft,detached:flow.nodes.filter(n=>before.has(n.id)&&!after.has(n.id)).map(n=>n.name)}
}
export function moveStepBlock(flow,selected,edge){
  const block=stepBlock(flow,selected);if(!block||block.nodes.some(n=>n.type==='end'))return null
  const ids=new Set(selected),entryEdges=incomingEdges(flow,block.entry).filter(e=>!ids.has(e.owner))
  if(entryEdges.length!==1||ids.has(edge.owner)||edgeTarget(flow,edge)===block.entry)return null
  // A single ingress is required for the selected range; shared downstream nodes stay put.
  if(block.nodes.some(n=>n.id!==block.entry&&incomingEdges(flow,n.id).some(e=>!ids.has(e.owner))))return null
  const exits=[]
  for(const n of block.nodes)for(const key of n.type==='branch'?['yes','no']:['next'])if(!ids.has(n[key]))exits.push({owner:n.id,key,target:n[key]})
  if(!exits.length||new Set(exits.map(e=>e.target)).size!==1)return null
  const target=edgeTarget(flow,edge);if(target===undefined||ids.has(target))return null
  const draft=structuredClone(flow);if(!setEdge(draft,entryEdges[0],exits[0].target??'')||!setEdge(draft,edge,block.entry))return null
  for(const exit of exits)if(!setEdge(draft,exit,target))return null
  if(hasCycle(draft))return null
  const before=reachableIds(flow),after=reachableIds(draft);if([...before].some(id=>!after.has(id)))return null
  return {flow:draft,entry:block.entry,ids:[...ids]}
}
export function selectOutlineRange(flow,from,to){const order=stepOutline(flow).map(n=>n.id),a=order.indexOf(from),b=order.indexOf(to);return a<0||b<0?[to]:order.slice(Math.min(a,b),Math.max(a,b)+1)}
