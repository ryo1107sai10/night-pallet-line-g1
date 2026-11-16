export const interval=30
export const defaultHours=Object.freeze({start:18*60,end:24*60})
export const clockLabel=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')

export function timeOptions(start,end,includingEnd=false){
  return Array.from({length:Math.max(0,(end-start)/interval+Number(includingEnd))},(_,index)=>start+index*interval)
}

const formats=new Map()
export function localTime(instant,zone){
  if(!formats.has(zone)) formats.set(zone,new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}))
  const parts=Object.fromEntries(formats.get(zone).formatToParts(new Date(instant)).map(({type,value})=>[type,value]))
  return {date:parts.year+'-'+parts.month+'-'+parts.day,minutes:Number(parts.hour)*60+Number(parts.minute),seconds:Number(parts.second)}
}

function endMinute(first,last){
  if(first.date===last.date)return last.minutes
  const tomorrow=new Date(Date.parse(first.date+'T00:00:00Z')+86400000).toISOString().slice(0,10)
  return last.date===tomorrow && last.minutes===0 && last.seconds===0 ? 1440 : null
}

export function lastMinute(start,end,zone){
  return endMinute(localTime(start,zone),localTime(end,zone))
}

export function fitsHours(start,end,zone,hours){
  const first=localTime(start,zone),last=localTime(end,zone)
  const through=endMinute(first,last)
  return through!==null && first.seconds===0 && last.seconds===0 && new Date(start).getUTCMilliseconds()===0 &&
    new Date(end).getUTCMilliseconds()===0 && first.minutes%interval===0 && through%interval===0 &&
    first.minutes>=hours.start && through<=hours.end && through>first.minutes
}
