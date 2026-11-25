import {richErrors} from './message-format.mjs'
export const triggers = {
  follow:'友だち追加', form:'フォーム送信', consent:'明示同意', booking_created:'予約作成',
  booking_changed:'予約変更', booking_cancelled:'予約取消', visit:'来店登録',
  interview_booked:'面談予約', interview_changed:'面談変更', interview_cancelled:'面談取消',
  application:'応募状態変更', tag_added:'採用タグが付いたとき',tag_campaign:'タグ絞り込み配信（手動）', link:'リンク反応', manual:'手動登録',
}
// Keep the editor and server publication gate on the same supported events.
export const liveTriggers = Object.freeze({
  customer:Object.freeze(Object.fromEntries(['follow','consent','manual','booking_created','booking_changed','booking_cancelled','visit'].map(key=>[key,triggers[key]]))),
  recruitment:Object.freeze(Object.fromEntries(['follow','form','interview_booked','interview_changed','interview_cancelled','tag_added','tag_campaign'].map(key=>[key,triggers[key]]))),
})
export const kinds = { message:'メッセージ',wait:'待機',branch:'条件分岐',tag:'タグ更新',task:'担当タスク',end:'終了' }
export const conditions = { booked:'予約がある',consent:'目的別の同意がある',adult:'20歳以上の確認済み',
  responded:'返信がある',tag:'タグを持つ',assigned:'担当がいる' }
export function branchRules(node){return ['all','any'].includes(node.condition)?(node.rules??[]):[{condition:node.condition,tag:node.tag}]}
export function evaluateBranch(node,states,tags){
  const values=branchRules(node).map(rule=>{const match=rule.condition==='tag'?tags.includes(rule.tag):!!states[rule.condition];return rule.negated?!match:match})
  return values.length>0&&(node.condition==='any'?values.some(Boolean):values.every(Boolean))
}
export const variables = { name:'お名前',store:'店舗名',staff:'担当者',booking:'予約日時',price:'公開料金',booking_url:'予約変更 URL',interview_link:'面談予約 URL',customer_link:'来店予約・設定 URL' }
const valuePattern = /\{\{\s*([a-z_]+)\s*\}\}/g
const days = 86400000
const maxWait = 365*24*60
const timeFormat = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export function starter(purpose='customer') {
  return {
    name:purpose==='customer'?'友だち追加 · 初回来店フォロー':'面談予約 · 予約後フォロー',
    purpose,trigger:purpose==='customer'?'follow':'interview_booked',channel:'',windowStart:'12:00',windowEnd:'21:00',
    daily:1,weekly:3,cooldownDays:30,rejoin:false,missingAssignee:'manager',holidays:[],
    entry:'welcome', nodes:[
      {id:'welcome',type:'message',name:purpose==='customer'?'ウェルカムメッセージ':'面談予約の受付メッセージ',category:'service',
        body:purpose==='customer'?'{{name}}さん、友だち追加ありがとうございます。\n{{store}}です。ご来店の相談はこのトークからお気軽にどうぞ。':'{{name}}さん、{{store}}への面談予約を受け付けました。\n日時：{{booking}}\n当日のご案内はこのトークからお送りします。',next:'wait'},
      {id:'wait',type:'wait',name:'24時間待機',mode:'delay',minutes:1440,next:'branch'},
      {id:'branch',type:'branch',name:'予約の有無を確認',condition:'booked',tag:'',yes:'booked',no:'nudge'},
      {id:'booked',type:'end',name:'予約済みのため終了'},
      {id:'nudge',type:'message',name:purpose==='customer'?'初回来店のご案内':'面接予約のご案内',category:purpose==='customer'?'marketing':'service',
        body:purpose==='customer'?'{{name}}さん、{{store}}のご予約を受け付けています。\nご希望の日にちをこのトークでお知らせください。':'{{name}}さん、面接希望日が決まりましたら、このトークでご連絡ください。',next:'end'},
      {id:'end',type:'end',name:'フォロー終了'},
    ],
  }
}

export const recruitmentTemplates = Object.freeze([
  {id:'application-guide',name:'友だち追加 → 面談予約案内',trigger:'follow',dedicated:true,
    body:'{{store}}の採用窓口です。ご希望の面談日時は次のリンクから選んでいただけます。\n{{interview_link}}'},
  {id:'interview-preparation',name:'面談予約後の準備案内',trigger:'interview_booked',dedicated:false,
    body:'{{name}}さん、面談予定に関するご質問・持ち物の確認は、このトークからご連絡ください。'},
  {id:'interview-rescheduled',name:'面談日程変更のフォロー',trigger:'interview_changed',dedicated:false,
    body:'{{name}}さん、日程のご調整ありがとうございます。当日のご質問がありましたら、このトークからお知らせください。'},
  {id:'interview-cancelled',name:'面談キャンセル後の案内',trigger:'interview_cancelled',dedicated:false,
    body:'{{name}}さん、面談のキャンセルを受け付けました。再度ご希望の場合は、このトークにご連絡ください。'},
])

export function recruitmentTemplate(id,channel) {
  const template=recruitmentTemplates.find(item=>item.id===id)
  if(!template)throw new Error('選択したテンプレートが見つかりません。')
  return {...starter('recruitment'),name:template.name,trigger:template.trigger,channel,
    nodes:[{id:'welcome',type:'message',name:template.name,category:'service',body:template.body,next:'end'},
      {id:'end',type:'end',name:'終了'}]}
}

export const links = node => node.type==='branch' ? [node.yes,node.no] : node.type==='end' ? [] : [node.next]

export function validate(flow, publish=false) {
  const errors = []
  const add = (message, nodeId=null) => errors.push({message,nodeId})
  const fields = flow.nodes
  if (!flow.name.trim()) add('シナリオ名を入力してください。')
  if (!flow.channel && publish) add('配信先の公式アカウントを選択してください。')
  if (!Object.hasOwn(triggers,flow.trigger) || (flow.trigger==='application' && flow.purpose!=='recruitment') ||
    (['booking_created','booking_changed','booking_cancelled','visit'].includes(flow.trigger) && flow.purpose!=='customer') ||
    (['interview_booked','interview_changed','interview_cancelled','tag_added','tag_campaign'].includes(flow.trigger) && flow.purpose!=='recruitment')) {
    add('この開始イベントはシナリオの用途と一致しません。')
  }
  if(flow.trigger==='tag_added'&&!flow.triggerTag?.trim())add('開始条件の採用タグを選択してください。')
  if (!timeFormat.test(flow.windowStart) || !timeFormat.test(flow.windowEnd) || flow.windowStart>=flow.windowEnd) {
    add('配信可能時間は同じ日付内で、終了を開始より後に設定してください。')
  }
  if (![flow.daily,flow.weekly,flow.cooldownDays].every(Number.isInteger) || flow.daily<1 ||
    flow.weekly<flow.daily || flow.weekly>50 || flow.cooldownDays<1 || flow.cooldownDays>365) {
    add('配信上限または再参加間隔を確認してください。')
  }
  if (!Array.isArray(flow.holidays) || new Set(flow.holidays).size>6) add('配信可能な曜日を1日以上残してください。')
  if (fields.length>100) add('ステップ数は100件までです。')
  const byId = new Map(fields.map(node=>[node.id,node]))
  if (byId.size!==fields.length) add('ステップのIDが重複しています。')
  if (!byId.has(flow.entry)) add('最初のステップを選択してください。')
  for (const node of fields) {
    if (!node.name.trim()) add('ステップ名を入力してください。',node.id)
    if (!Object.hasOwn(kinds,node.type)) add('未対応のステップです。',node.id)
    if (links(node).some(id=>!byId.has(id))) add('次のステップをつないでください。',node.id)
    if (node.type==='branch' && (!branchRules(node).length || branchRules(node).length>8 || branchRules(node).some(r=>!Object.hasOwn(conditions,r.condition)||r.condition==='tag'&&!r.tag?.trim()) || (!['all','any'].includes(node.condition)&&node.rules))) add('分岐条件を入力してください。',node.id)
    if ((node.type==='tag' && !node.tag?.trim()) || (node.type==='task' && !node.note?.trim())) add('タグ名またはタスク内容を入力してください。',node.id)
    if (node.type==='wait') {
      if (!['delay','fixed','business','booking'].includes(node.mode)) add('待機方法を選択してください。',node.id)
      if (node.mode==='delay' && (!Number.isInteger(node.minutes) || node.minutes<1 || node.minutes>maxWait)) add('待機は1分から365日の範囲で設定してください。',node.id)
      if (node.mode==='fixed' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(node.time??'')) add('実日付と時刻を入力してください。',node.id)
      if (node.mode==='business' && (!Number.isInteger(node.days) || node.days<0 || node.days>365 || !timeFormat.test(node.time??''))) add('営業日までの日数と時刻を入力してください。',node.id)
      if (node.mode==='booking' && (!Number.isInteger(node.minutes) || node.minutes<0 || node.minutes>maxWait)) add('予約の何分前かを入力してください。',node.id)
    }
    if (node.type==='message') {
      if (!node.body.trim() || node.body.length>5000) add('本文は1〜5000文字で入力してください。',node.id)
      const remaining = node.body.replace(valuePattern,(_value,key)=>{
        if (!Object.hasOwn(variables,key)) add('未対応の差し込み項目があります。',node.id)
        return ''
      })
      if (remaining.includes('{{') || remaining.includes('}}')) add('差し込み項目の形式を確認してください。',node.id)
      for(const problem of richErrors(node.rich,node.body))add(problem,node.id)
      if(node.tagGuard&&(flow.purpose!=='recruitment'||typeof node.tagGuard.tag!=='string'||!node.tagGuard.tag.trim()||!Array.isArray(node.tagGuard.exclude)||node.tagGuard.exclude.includes(node.tagGuard.tag)||new Set(node.tagGuard.exclude).size!==node.tagGuard.exclude.length||node.tagGuard.booked!==undefined&&typeof node.tagGuard.booked!=='boolean'))add('送信直前の採用タグ条件を確認してください。',node.id)
      if (flow.purpose==='recruitment' && node.category==='marketing') add('採用シナリオに顧客向け販促は追加できません。',node.id)
      if (flow.purpose!=='recruitment' && /\{\{\s*interview_link\s*\}\}/.test(node.body)) add('面談予約 URLの差し込みは採用シナリオでのみ使えます。',node.id)
      if (flow.purpose!=='customer' && /\{\{\s*customer_link\s*\}\}/.test(node.body)) add('来店予約・設定 URLの差し込みは顧客シナリオでのみ使えます。',node.id)
    }
  }
  const visiting = new Set()
  const counts = new Map()
  let loop = false
  function visit(id) {
    if (!byId.has(id)) return 0
    if (visiting.has(id)) { loop=true; return 0 }
    if (counts.has(id)) return counts.get(id)
    visiting.add(id)
    const node = byId.get(id)
    const outgoing = links(node)
    const count = (node.type==='message'?1:0) + Math.max(0,...outgoing.map(visit))
    visiting.delete(id)
    counts.set(id,count)
    return count
  }
  const sends = visit(flow.entry)
  if (counts.size!==fields.length) add('開始ステップから到達できないステップがあります。')
  for (const node of fields) visit(node.id)
  if (loop) add('循環する接続があります。終了に向かうよう修正してください。')
  if (!fields.some(node=>node.type==='end')) add('終了ステップを追加してください。')
  if (sends>20) add('1人あたりの送信が20通を超える経路があります。')
  return errors
}

export function localPart(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
  const {year,month,day,hour,minute} = Object.fromEntries(formatter.formatToParts(instant).map(p=>[p.type,p.value]))
  return { date:year+'-'+month+'-'+day, time:hour+':'+minute }
}

function shiftDate(date, count) { return new Date(Date.parse(date+'T00:00Z')+count*days).toISOString().slice(0,10) }

export function localInstant(dateTime, zone) {
  const guessed = Date.parse(dateTime+'Z')
  if (!Number.isFinite(guessed) || new Date(guessed).toISOString().slice(0,16)!==dateTime) return null
  const offsets = [-days,0,days].map(shift=>{
    const reference = guessed+shift
    const local = localPart(reference,zone)
    return Date.parse(local.date+'T'+local.time+'Z')-reference
  })
  const matches = [...new Set(offsets)].map(offset=>guessed-offset).filter(instant=>{
    const local = localPart(instant,zone)
    return local.date+'T'+local.time===dateTime
  })
  return matches.length===1 ? matches[0] : null
}

export function nextWindow(at, flow, zone) {
  const local = localPart(at,zone)
  const closed = date => flow.holidays.includes(new Date(date+'T00:00Z').getUTCDay())
  if (!closed(local.date) && local.time>=flow.windowStart && local.time<flow.windowEnd) return at
  const offset = local.time>=flow.windowEnd ? 1 : 0
  for (let day=offset;day<offset+8;day++) {
    const date = shiftDate(local.date,day)
    if (closed(date)) continue
    const next = localInstant(date+'T'+flow.windowStart,zone)
    if (next!==null && next>=at) return next
  }
  return null
}

export function renderMessage(body,person) {
  const missing=[]
  let usesBookingUrl=false
  let usesInterviewLink=false
  let usesCustomerLink=false
  const message=body.replace(valuePattern,(_match,key)=>{
    if (key==='booking_url') usesBookingUrl=true
    if (key==='interview_link') usesInterviewLink=true
    if (key==='customer_link') usesCustomerLink=true
    const value=Object.hasOwn(person.values,key)?person.values[key]:undefined
    if (typeof value==='string' && value.trim()) return value
    missing.push(variables[key]??key)
    return ''
  })
  if (missing.length) return { reason:'差し込み値不足：'+[...new Set(missing)].join('、') }
  if (usesBookingUrl) {
    let url
    try { url = new URL(person.values.booking_url) } catch { return {reason:'予約変更URLが無効です。'} }
    if (url.protocol!=='https:' || !person.bookingLinkValid) return {reason:'予約変更URLの有効性を確認できません。'}
  }
  if (usesInterviewLink) {
    let url
    try { url = new URL(person.values.interview_link) } catch { return {reason:'面談予約URLが無効です。'} }
    if (url.protocol!=='https:') return {reason:'面談予約URLが無効です。'}
  }
  if (usesCustomerLink) {
    let url
    try { url = new URL(person.values.customer_link) } catch { return {reason:'来店予約・設定URLが無効です。'} }
    if (url.protocol!=='https:') return {reason:'来店予約・設定URLが無効です。'}
  }
  if (message.length>5000) return {reason:'差し込み後に5000文字を超えています。'}
  return {message}
}

export function waitUntil(node,at,zone,cutoff,bookingAt) {
  if (node.mode==='delay') return at+node.minutes*60000
  if (node.mode==='fixed') return localInstant(node.time,zone)
  if (node.mode==='booking') return bookingAt===null?null:bookingAt-node.minutes*60000
  if (node.mode==='business') {
    const local=localPart(at,zone)
    const first=local.time<cutoff?-1:0
    const business=shiftDate(local.date,first+node.days)
    const calendar=shiftDate(business,node.time<cutoff?1:0)
    return localInstant(calendar+'T'+node.time,zone)
  }
  return null
}

export function simulate(flow, person) {
  const errors = validate(flow)
  if (errors.length) return {errors,events:[],count:0}
  const events = []
  const byId = new Map(flow.nodes.map(node=>[node.id,node]))
  let at = localInstant(person.start,person.zone)
  if (at===null) return {errors:[{message:'開始日時が無効、またはタイムゾーン内で一意ではありません。'}],events,count:0}
  if (![person.dayCount,person.weekCount].every(count=>Number.isInteger(count)&&count>=0) || person.dayCount>person.weekCount) {
    return {errors:[{message:'直近の配信通数を確認してください。'}],events,count:0}
  }
  const bookingAt = person.bookingAt ? localInstant(person.bookingAt,person.zone) : null
  let count=0
  const recent=[]
  const tags=new Set(person.tags ?? [])
  const yes = { booked:person.booked,consent:person.consent,adult:person.adult,responded:person.responded,assigned:person.assigned }
  let id = flow.entry
  while (id) {
    const node = byId.get(id)
    const line = { id,type:node.type,name:node.name,at:new Date(at).toISOString(),state:'ok',detail:'' }
    events.push(line)
    id = node.next
    if (node.type==='wait') {
      const next=waitUntil(node,at,person.zone,person.cutoff,bookingAt)
      if (next===null || next<at) {
        line.state='held'; line.detail='待機時刻が無効か、基準時刻を過ぎています。'; break
      }
      at=next
      line.at=new Date(at).toISOString()
      line.detail='この時刻まで待機'
    } else if (node.type==='branch') {
      const passed = evaluateBranch(node,yes,[...tags])
      line.detail=(conditions[node.condition]??(node.condition==='all'?'すべての条件':'いずれかの条件'))+' → '+(passed?'はい':'いいえ')
      id=passed?node.yes:node.no
    } else if (node.type==='tag') {
      if(node.action==='remove')tags.delete(node.tag)
      else tags.add(node.tag)
      line.detail=(node.action==='remove'?'解除：':'付与：')+node.tag
    } else if (node.type==='task') {
      line.detail=(person.assigned?'担当者：':flow.missingAssignee==='manager'?'店舗責任者へ：':'保留：')+node.note
    } else if (node.type==='message') {
      const marketing=node.category==='marketing'
      const due=marketing ? nextWindow(at,flow,person.zone) : at
      const adjusts=due!==null && due!==at
      const guard=node.tagGuard
      const guardMismatch=guard&&(!tags.has(guard.tag)||guard.exclude.some(key=>tags.has(key))||guard.booked!==undefined&&guard.booked!==!!person.booked)
      const rejected=guardMismatch?'送信直前のタグ・面談予約条件に一致しません':person.stopped?'全配信停止':person.blocked?'LINEでブロックされています':!person.consent?'目的別の同意なし':
        person.eligible===false?'店舗の利用適格性が未確認':person.contractActive===false?'契約に有効な配信権限がありません':
        person.budgetAvailable===false?'利用可能な配信枠なし':
        (node.body.match(/\{\{\s*(booking|booking_url)\s*\}\}/) && person.bookingCurrent===false)?'予約の版が更新されています':
        marketing && person.marketingStopped?'販促停止':marketing && !person.adult?'20歳以上の確認なし':
        person.cancelled?'予約取消・辞退':marketing && person.responded?'返信があるため販促を保留':person.human?'有人対応中':due===null?'配信可能時間外':null
      const frequency=marketing && due!==null && (
        person.dayCount+recent.filter(date=>localPart(date,person.zone).date===localPart(due,person.zone).date).length>=flow.daily ||
        person.weekCount+recent.filter(date=>date>due-7*days).length>=flow.weekly)
      const rendered=renderMessage(node.body,person)
      const reason=rejected || (frequency?'配信頻度上限':rendered.reason)
      if (reason) { line.state='held'; line.detail=reason }
      else {
        at=due
        line.at=new Date(at).toISOString()
        line.detail=adjusts?'配信可能時間へ調整':'送信予定'
        line.message=rendered.message
        if(node.rich)line.rich=node.rich
        count++
        if (marketing) recent.push(at)
      }
    } else if (node.type==='end') line.detail='シナリオを終了'
  }
  return {errors,events,count}
}
