import { createHash } from 'node:crypto'
import { z } from 'zod'
import { audit, digest, Fault, forbidden, missing, newId, once, opaque, seal, token, unseal,
  type Actor, type Config, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'

const scope='https://www.googleapis.com/auth/calendar.events.freebusy'
const writeScope='https://www.googleapis.com/auth/calendar.events'
const timestamp=z.iso.datetime({offset:true})
export const calendarID=z.string().trim().max(250).regex(/^(?:primary|[A-Za-z0-9._+%#-]+@[A-Za-z0-9.-]+)$/)
export const managedCalendarInput=z.strictObject({calendar_id:z.string().trim().toLowerCase().max(250).regex(/^[a-z0-9._+%#-]+@group\.calendar\.google\.com$/)})
export const googleCalendarInput=z.strictObject({calendar_id:calendarID})
export const googleCalendarReturn=z.strictObject({state:opaque,code:z.string().min(1).max(4096)})
export const blockInput=z.strictObject({starts_at:timestamp,ends_at:timestamp,note:z.string().trim().max(120)})
type GoogleSetup={clientId:string;secret:string}
const serviceAccount=z.string().regex(/^[a-z][a-z0-9-]*@[a-z0-9-]+\.iam\.gserviceaccount\.com$/)
const sharedCalendarSettings=z.object({store:z.uuid(),calendar:calendarID.refine(id=>id!=='primary'),account:serviceAccount})
type SharedCalendar=z.infer<typeof sharedCalendarSettings>
export type CalendarCredential={calendar_id:string;refresh_box:string;tenant_id:string;store_id:string;write_granted:boolean}
export type Interval={starts_at:Date;ends_at:Date}
const boxContext=(tenant:string, store:string)=>'interview-google:'+tenant+':'+store
export const overlaps=(a:Interval,b:Interval)=>+a.starts_at<+b.ends_at && +a.ends_at>+b.starts_at
const unavailable=()=>new Fault(503,'GOOGLE_UNAVAILABLE','Googleカレンダーの空き状況を確認できません。時間をおいてお試しください。',true)
const invalidState=()=>new Fault(409,'GOOGLE_STATE','連携の有効期限が切れました。管理画面からやり直してください。')
const day=86400000

export class InterviewGoogle {
  private readonly redirect:string
  private readonly recent=new Map<string,{access:string;expires:number}>()
  private readonly sharedTokens=new Map<string,{access:string;expires:number}>()
  private readonly sharedCalendars:Map<string,SharedCalendar>
  constructor(private readonly cfg:Config, private readonly settings?:GoogleSetup, private readonly request=fetch,
    shared:SharedCalendar|SharedCalendar[]=[],readonly managedAccount?:string){
    this.redirect=cfg.origin+'/interview/google-return.html'
    const entries=Array.isArray(shared)?shared:[shared]
    this.sharedCalendars=new Map(entries.map(entry=>[entry.store,entry]))
    if(this.sharedCalendars.size!==entries.length||new Set(entries.map(entry=>entry.calendar)).size!==entries.length){
      throw new Error('Shared calendars must be assigned to distinct stores.')
    }
  }
  get configured(){return !!this.settings && new URL(this.cfg.origin).protocol==='https:'}

  sharedCalendar(store:string){return this.sharedCalendars.get(store)?.calendar}

  canManageLink(store:string){
    const legacy=this.sharedCalendars.get(store)
    return !!this.managedAccount&&(!legacy||legacy.account===this.managedAccount)
  }

  legacyCalendarOwner(calendar:string){
    return [...this.sharedCalendars.values()].find(entry=>entry.calendar.toLowerCase()===calendar.toLowerCase())?.store
  }

  async sharedBusy(store:string,range:Interval,calendar:string){
    const shared=this.sharedCalendars.get(store)
    if(!shared || calendar!==shared.calendar)throw unavailable()
    return this.accountBusy(shared.account,calendar,range)
  }

  async managedBusy(calendar:string,range:Interval){
    if(!this.managedAccount)throw unavailable()
    return this.accountBusy(this.managedAccount,calendar,range)
  }

  private async accountBusy(account:string,calendar:string,range:Interval){
    let cached=this.sharedTokens.get(account)
    if(!cached || cached.expires<=Date.now()){
      const metadata=await this.json('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{
        headers:{'Metadata-Flavor':'Google'},
      })
      const runtime=z.object({access_token:z.string().min(1)}).safeParse(metadata)
      if(!runtime.success)throw unavailable()
      const credentials='https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
      const data=await this.json(credentials+encodeURIComponent(account)+':generateAccessToken',{
        method:'POST',headers:{Authorization:'Bearer '+runtime.data.access_token,'Content-Type':'application/json'},
        body:JSON.stringify({scope:[scope],lifetime:'900s'}),
      })
      const token=z.object({accessToken:z.string().min(1),expireTime:timestamp}).safeParse(data)
      if(!token.success)throw unavailable()
      const expires=Date.parse(token.data.expireTime)-60000
      if(expires<=Date.now())throw unavailable()
      cached={access:token.data.accessToken,expires}
      this.sharedTokens.set(account,cached)
    }
    return this.query(cached.access,calendar,range)
  }

  authorization(store:string,raw:string,verifier:string,write=false){
    if(!this.configured || !this.settings)throw unavailable()
    const challenge=createHash('sha256').update(verifier).digest('base64url')
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search=new URLSearchParams({client_id:this.settings.clientId,redirect_uri:this.redirect,response_type:'code',
      scope:write?scope+' '+writeScope:scope,access_type:'offline',prompt:'consent',state:store+'.'+raw,
      code_challenge_method:'S256',code_challenge:challenge}).toString()
    return url.href
  }

  private async json(url:string,options:RequestInit){
    try{
      const response=await this.request(url,{...options,redirect:'error',signal:AbortSignal.timeout(3200)})
      if(!response.ok)throw unavailable()
      return await response.json() as unknown
    }catch{throw unavailable()}
  }

  private async tokens(data:Record<string,string>){
    if(!this.settings)throw unavailable()
    const payload=await this.json('https://oauth2.googleapis.com/token',{method:'POST',
      body:new URLSearchParams({...data,client_id:this.settings.clientId,client_secret:this.settings.secret})})
    const parsed=z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),
      expires_in:z.number().int().positive(),scope:z.string().optional()}).safeParse(payload)
    if(!parsed.success)throw unavailable()
    return parsed.data
  }

  async exchange(code:string,verifier:string,calendar:string,write=false){
    const tokens=await this.tokens({code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:this.redirect})
    if(!tokens.refresh_token || (tokens.scope && !tokens.scope.split(' ').includes(scope))) {
      throw new Fault(422,'GOOGLE_PERMISSION','継続的に空き状況を参照する権限をGoogleで許可してください。')
    }
    if(write&&!tokens.scope?.split(' ').includes(writeScope)){
      throw new Fault(422,'GOOGLE_PERMISSION','面談予定の登録・変更を行う権限をGoogleで許可してください。')
    }
    const now=Date.now()
    await this.query(tokens.access_token,calendar,{starts_at:new Date(now),ends_at:new Date(now+day)})
    return tokens.refresh_token
  }

  private async query(access:string,id:string,range:Interval){
    const data=await this.json('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',
      headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},
      body:JSON.stringify({timeMin:range.starts_at.toISOString(),timeMax:range.ends_at.toISOString(),
        items:[{id}],calendarExpansionMax:1,groupExpansionMax:1}),
    })
    const result=z.object({calendars:z.record(z.string(),z.object({errors:z.array(z.unknown()).optional(),
      busy:z.array(z.object({start:timestamp,end:timestamp})).optional()}))}).safeParse(data)
    if(!result.success)throw unavailable()
    const all=Object.values(result.data.calendars)
    const calendar=Object.hasOwn(result.data.calendars,id)?result.data.calendars[id]:
      id==='primary'&&all.length===1?all[0]:null
    if(!calendar?.busy || calendar.errors?.length)throw unavailable()
    const periods=calendar.busy.map(p=>({starts_at:new Date(p.start),ends_at:new Date(p.end)}))
    if(periods.some(p=>p.ends_at<=p.starts_at))throw unavailable()
    return periods
  }

  private async access(credential:CalendarCredential){
    if(!this.configured)throw unavailable()
    const key=credential.refresh_box
    let cached=this.recent.get(key)
    if(!cached||cached.expires<=Date.now()){
      let refresh:string
      try{refresh=unseal(this.cfg,boxContext(credential.tenant_id,credential.store_id),key)}
      catch{throw unavailable()}
      const tokens=await this.tokens({refresh_token:refresh,grant_type:'refresh_token'})
      cached={access:tokens.access_token,expires:Date.now()+(tokens.expires_in-60)*1000}
      if(this.recent.size>=100)this.recent.clear()
      this.recent.set(key,cached)
    }
    return cached.access
  }

  async busy(credential:CalendarCredential,range:Interval,calendar=credential.calendar_id) {
    return this.query(await this.access(credential),calendar,range)
  }

  async updateEvent(credential:CalendarCredential,calendar:string,id:string,range:Interval|null){
    if(!credential.write_granted)throw unavailable()
    const access=await this.access(credential)
    const root='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendar)+'/events'
    const event=root+'/'+encodeURIComponent(id)
    const headers={Authorization:'Bearer '+access,'Content-Type':'application/json'}
    const call=(url:string,method:string,body?:object)=>this.request(url+'?sendUpdates=none',{
      method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(3200),
    })
    try{
      if(!range){
        const response=await call(event,'DELETE')
        if(response.ok||[404,410].includes(response.status))return
        throw unavailable()
      }
      const data={summary:'Night PRO LINE 面談',visibility:'private',
        start:{dateTime:range.starts_at.toISOString()},end:{dateTime:range.ends_at.toISOString()}}
      const updated=await call(event,'PATCH',data)
      if(updated.ok)return
      if(updated.status!==404&&updated.status!==410)throw unavailable()
      const inserted=await call(root,'POST',{id,...data})
      if(inserted.ok)return
      if(inserted.status===409&&(await call(event,'PATCH',data)).ok)return
      throw unavailable()
    }catch{throw unavailable()}
  }
}

export function googleFromEnvironment(cfg:Config){
  const clientId=process.env.GOOGLE_CALENDAR_CLIENT_ID,secret=process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  const store=process.env.GOOGLE_SHARED_CALENDAR_STORE,calendar=process.env.GOOGLE_SHARED_CALENDAR_ID
  const account=process.env.GOOGLE_SHARED_CALENDAR_ACCOUNT
  const extra=process.env.GOOGLE_SHARED_CALENDARS
  const shared=extra?z.array(sharedCalendarSettings).max(100).parse(JSON.parse(extra)):[]
  if(store||calendar||account)shared.push(sharedCalendarSettings.parse({store,calendar,account}))
  return new InterviewGoogle(cfg,clientId&&secret?{clientId,secret}:undefined,fetch,shared,process.env.GOOGLE_STORE_CALENDAR_ACCOUNT?serviceAccount.parse(process.env.GOOGLE_STORE_CALENDAR_ACCOUNT):undefined)
}
export async function beginCalendarLink(db:DB,actor:Actor,store:string,calendar:string,google:InterviewGoogle){
  const state=token(),verifier=token()
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'google_calendar_enabled')
  const write=(await storeFeatures(db,store)).google_write_enabled
  const shared=await sharedCalendarFor(db,google,store)
  if(shared&&(!write||calendar!==shared.calendar_id))throw new Fault(409,'GOOGLE_SHARED_CALENDAR','共有カレンダーは空き時間を照合済みです。予定の書き込み連携には同じIDを指定してください。')
  const url=google.authorization(store,state,verifier,write)
  await db.query(`INSERT INTO interview_google_session
    (store_id,tenant_id,actor_id,state_hash,calendar_id,verifier,expires_at,write_requested)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes',$7)
    ON CONFLICT (store_id) DO UPDATE SET actor_id=excluded.actor_id,state_hash=excluded.state_hash,
      calendar_id=excluded.calendar_id,verifier=excluded.verifier,used=false,expires_at=excluded.expires_at,
      write_requested=excluded.write_requested`,
    [store,actor.tenant_id,actor.id,digest(state),calendar,verifier,write])
  return {url}
}

export async function claimCalendarLink(db:DB,actor:Actor,store:string,state:string){
  await requireFeature(db,store,'google_calendar_enabled')
  const {rows:[pending]}=await db.query<{calendar_id:string;verifier:string;write_requested:boolean}>(`UPDATE interview_google_session SET used=true
    WHERE store_id=$1 AND actor_id=$2 AND state_hash=$3 AND NOT used AND expires_at>clock_timestamp()
    RETURNING calendar_id,verifier,write_requested`,[store,actor.id,digest(state)])
  if(!pending)throw invalidState()
  return pending
}

export async function finishCalendarLink(db:DB,cfg:Config,actor:Actor,store:string,state:string,refresh:string){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'google_calendar_enabled')
  const {rows:[pending]}=await db.query<{calendar_id:string;write_requested:boolean}>(`DELETE FROM interview_google_session
    WHERE store_id=$1 AND actor_id=$2 AND state_hash=$3 AND used AND expires_at>clock_timestamp()
    RETURNING calendar_id,write_requested`,[store,actor.id,digest(state)])
  if(!pending)throw invalidState()
  await db.query(`INSERT INTO interview_google_calendar (store_id,tenant_id,calendar_id,refresh_box,write_granted)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT (store_id) DO UPDATE SET calendar_id=excluded.calendar_id,
      refresh_box=excluded.refresh_box,write_granted=excluded.write_granted`,
    [store,actor.tenant_id,pending.calendar_id,seal(cfg,boxContext(actor.tenant_id,store),refresh),pending.write_requested])
  await audit(db,actor.tenant_id,store,actor.id,'interview.google.link',store)
}

export async function unlinkInterviewCalendar(db:DB,actor:Actor,store:string){
  await lockDispatch(db,actor.tenant_id)
  await db.query('DELETE FROM interview_google_session WHERE store_id=$1',[store])
  await db.query('DELETE FROM interview_google_calendar WHERE store_id=$1',[store])
  await audit(db,actor.tenant_id,store,actor.id,'interview.google.unlink',store)
  return {connected:false}
}

export async function calendarRecord(db:DB,store:string){
  return (await db.query<CalendarCredential>('SELECT * FROM interview_google_calendar WHERE store_id=$1',[store])).rows[0]
}

export async function managedCalendarRecord(db:DB,store:string){
  return (await db.query<{calendar_id:string;linked_at:Date}>(
    'SELECT calendar_id,linked_at FROM interview_shared_calendar WHERE store_id=$1',[store])).rows[0]
}
async function sharedCalendarFor(db:DB,google:InterviewGoogle,store:string){
  const record=await managedCalendarRecord(db,store)
  if(record)return {calendar_id:record.calendar_id,managed:true}
  const legacy=google.sharedCalendar(store)
  return legacy?{calendar_id:legacy,managed:false}:null
}

export async function linkManagedCalendar(db:DB,actor:Actor,store:string,calendar:string,google:InterviewGoogle){
  if(actor.role!=='admin')throw forbidden()
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'google_calendar_enabled')
  const unavailableLink=()=>new Fault(409,'GOOGLE_SHARED_CALENDAR','別の連携が設定済みです。店舗専用の未登録カレンダーを使用してください。')
  const legacyOwner=google.legacyCalendarOwner(calendar)
  if(!google.canManageLink(store)||(legacyOwner&&legacyOwner!==store))throw unavailableLink()
  const credential=await calendarRecord(db,store)
  if(credential&&credential.calendar_id!==calendar)throw unavailableLink()
  // Reserve only within this store; a unique constraint prevents sharing a
  // calendar between stores even if both operators act at the same moment.
  // The transaction rolls back if Google does not confirm access.
  try{
    await db.query(`INSERT INTO interview_shared_calendar(store_id,tenant_id,calendar_id,linked_by)
      VALUES($1,$2,$3,$4) ON CONFLICT (store_id) DO UPDATE SET calendar_id=excluded.calendar_id,
      linked_by=excluded.linked_by,linked_at=clock_timestamp()`,[store,actor.tenant_id,calendar,actor.id])
  }catch(error){if((error as {code?:string}).code==='23505')throw unavailableLink();throw error}
  const now=Date.now()
  try{await google.managedBusy(calendar,{starts_at:new Date(now),ends_at:new Date(now+day)})}
  catch{throw new Fault(422,'GOOGLE_SHARED_PERMISSION','Googleカレンダーを確認できません。カレンダーIDと共有権限（時間枠のみ）を確認してください。')}
  await db.query('DELETE FROM interview_google_session WHERE store_id=$1',[store])
  await audit(db,actor.tenant_id,store,actor.id,'interview.google.shared.link',store)
  return {connected:true}
}

export async function googleBusy(db:DB,google:InterviewGoogle,store:string,range:Interval,alternate?:string,required=false){
  const enabled=(await storeFeatures(db,store)).google_calendar_enabled
  if(!enabled){
    if(required)throw unavailable()
    return []
  }
  const shared=await sharedCalendarFor(db,google,store)
  const match=shared&&(!alternate||alternate===shared.calendar_id)
  const record=match?null:await calendarRecord(db,store)
  if(!match&&!record&&(alternate||required))throw unavailable()
  try{
    if(match&&shared)return await (shared.managed?google.managedBusy(shared.calendar_id,range):google.sharedBusy(store,range,shared.calendar_id))
    return record?await google.busy(record,range,alternate):[]
  }catch(error){
    console.warn(JSON.stringify({severity:'WARNING',event:'integration_failure',provider:'google',operation:'availability'}))
    throw error
  }
}

export async function availabilityOverview(db:DB,store:string,google:InterviewGoogle,canManage=false){
  const record=await calendarRecord(db,store)
  const shared=await sharedCalendarFor(db,google,store)
  const features=await storeFeatures(db,store)
  const {rows:blocks}=await db.query(`SELECT id,starts_at,ends_at,note FROM interview_block
    WHERE store_id=$1 AND ends_at>now() ORDER BY starts_at LIMIT 200`,[store])
  const connection=shared?{configured:shared.managed?!!google.managedAccount:true,connected:true,calendar_id:shared.calendar_id,shared:true}:
    {configured:google.configured,connected:!!record,calendar_id:record?.calendar_id??null}
  return {google:connection,
    ...(canManage&&google.canManageLink(store)?{managed_calendar_account:google.managedAccount}:{}),
    google_enabled:features.google_calendar_enabled,google_write_enabled:features.google_write_enabled,
    google_write_granted:record?.write_granted??false,blocks}
}

export async function localBlocks(db:DB,store:string,range:Interval){
  return (await db.query<Interval>(`SELECT starts_at,ends_at FROM interview_block
    WHERE store_id=$1 AND starts_at<$3 AND ends_at>$2`,[store,range.starts_at,range.ends_at])).rows
}

export async function addBlock(db:DB,cfg:Config,actor:Actor,store:string,key:string,input:z.infer<typeof blockInput>){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'interviews_enabled')
  return once(db,cfg,actor,'interview.block',key,{store,input},async()=>{
    const start=new Date(input.starts_at),end=new Date(input.ends_at)
    if(+end<=Date.now()||+end<=+start||+end-+start>31*day) {
      throw new Fault(422,'INTERVIEW_BLOCK_TIME','終了は開始より後にし、受付停止期間は31日以内で設定してください。')
    }
    const id=newId()
    await db.query('INSERT INTO interview_block VALUES($1,$2,$3,$4,$5,$6)',[id,actor.tenant_id,store,start,end,input.note])
    const {rows:[impact]}=await db.query(`SELECT count(*)::int AS count FROM interview_booking b
      JOIN interview_slot s ON b.slot_id=s.id WHERE b.status='confirmed' AND s.ends_at>now()
      AND s.starts_at<$2 AND s.ends_at>$1`,[start,end])
    await audit(db,actor.tenant_id,store,actor.id,'interview.block.add',id,null,{confirmed:impact.count})
    return {id,confirmed:impact.count}
  })
}

export async function removeBlock(db:DB,actor:Actor,store:string,id:string){
  await lockDispatch(db,actor.tenant_id)
  if(!(await db.query('DELETE FROM interview_block WHERE store_id=$1 AND id=$2',[store,id])).rowCount)throw missing()
  await audit(db,actor.tenant_id,store,actor.id,'interview.block.remove',id)
  return {removed:true}
}

export async function requireFree(db:DB,google:InterviewGoogle,store:string,slot:Interval,calendar?:string,required=false){
  const local=await localBlocks(db,store,slot)
  if(local.length||(await googleBusy(db,google,store,slot,undefined,required)).some(busy=>overlaps(busy,slot)))throw new Fault(409,'INTERVIEW_SLOT_BLOCKED','ほかの予定と重なっています。別の空き枠を選んでください。')
  if(calendar&&(await googleBusy(db,google,store,slot,calendar,required)).some(busy=>overlaps(busy,slot))){
    throw new Fault(409,'INTERVIEW_SLOT_BLOCKED','面談担当者のほかの予定と重なっています。別の空き枠を選んでください。')
  }
}
