import { createHash } from 'node:crypto'
import { z } from 'zod'
import { audit, digest, Fault, missing, newId, once, opaque, seal, token, unseal,
  type Actor, type Config, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'

const scope='https://www.googleapis.com/auth/calendar.events.freebusy'
const timestamp=z.iso.datetime({offset:true})
const calendarID=z.string().trim().max(250).regex(/^(?:primary|[A-Za-z0-9._+%#-]+@[A-Za-z0-9.-]+)$/)
export const googleCalendarInput=z.strictObject({calendar_id:calendarID})
export const googleCalendarReturn=z.strictObject({state:opaque,code:z.string().min(1).max(4096)})
export const blockInput=z.strictObject({starts_at:timestamp,ends_at:timestamp,note:z.string().trim().max(120)})
type GoogleSetup={clientId:string;secret:string}
type Credential={calendar_id:string;refresh_box:string;tenant_id:string;store_id:string}
export type Interval={starts_at:Date;ends_at:Date}
const boxContext=(tenant:string, store:string)=>'interview-google:'+tenant+':'+store
export const overlaps=(a:Interval,b:Interval)=>+a.starts_at<+b.ends_at && +a.ends_at>+b.starts_at
const unavailable=()=>new Fault(503,'GOOGLE_UNAVAILABLE','Googleカレンダーの空き状況を確認できません。時間をおいてお試しください。',true)
const invalidState=()=>new Fault(409,'GOOGLE_STATE','連携の有効期限が切れました。管理画面からやり直してください。')
const day=86400000

export class InterviewGoogle {
  private readonly redirect:string
  private readonly recent=new Map<string,{access:string;expires:number}>()
  constructor(private readonly cfg:Config, private readonly settings?:GoogleSetup, private readonly request=fetch){
    this.redirect=cfg.origin+'/interview/google-return.html'
  }
  get configured(){return !!this.settings && new URL(this.cfg.origin).protocol==='https:'}

  authorization(store:string,raw:string,verifier:string){
    if(!this.configured || !this.settings)throw unavailable()
    const challenge=createHash('sha256').update(verifier).digest('base64url')
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search=new URLSearchParams({client_id:this.settings.clientId,redirect_uri:this.redirect,response_type:'code',
      scope,access_type:'offline',prompt:'consent',state:store+'.'+raw,code_challenge_method:'S256',code_challenge:challenge}).toString()
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

  async exchange(code:string,verifier:string,calendar:string){
    const tokens=await this.tokens({code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:this.redirect})
    if(!tokens.refresh_token || (tokens.scope && !tokens.scope.split(' ').includes(scope))) {
      throw new Fault(422,'GOOGLE_PERMISSION','継続的に空き状況を参照する権限をGoogleで許可してください。')
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

  async busy(credential:Credential,range:Interval) {
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
    return this.query(cached.access,credential.calendar_id,range)
  }
}

export function googleFromEnvironment(cfg:Config){
  const clientId=process.env.GOOGLE_CALENDAR_CLIENT_ID,secret=process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  return new InterviewGoogle(cfg,clientId&&secret?{clientId,secret}:undefined)
}
export async function beginCalendarLink(db:DB,actor:Actor,store:string,calendar:string,google:InterviewGoogle){
  const state=token(),verifier=token()
  const url=google.authorization(store,state,verifier)
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'google_calendar_enabled')
  await db.query(`INSERT INTO interview_google_session
    (store_id,tenant_id,actor_id,state_hash,calendar_id,verifier,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')
    ON CONFLICT (store_id) DO UPDATE SET actor_id=excluded.actor_id,state_hash=excluded.state_hash,
      calendar_id=excluded.calendar_id,verifier=excluded.verifier,used=false,expires_at=excluded.expires_at`,
    [store,actor.tenant_id,actor.id,digest(state),calendar,verifier])
  return {url}
}

export async function claimCalendarLink(db:DB,actor:Actor,store:string,state:string){
  await requireFeature(db,store,'google_calendar_enabled')
  const {rows:[pending]}=await db.query<{calendar_id:string;verifier:string}>(`UPDATE interview_google_session SET used=true
    WHERE store_id=$1 AND actor_id=$2 AND state_hash=$3 AND NOT used AND expires_at>clock_timestamp()
    RETURNING calendar_id,verifier`,[store,actor.id,digest(state)])
  if(!pending)throw invalidState()
  return pending
}

export async function finishCalendarLink(db:DB,cfg:Config,actor:Actor,store:string,state:string,refresh:string){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'google_calendar_enabled')
  const {rows:[pending]}=await db.query<{calendar_id:string}>(`DELETE FROM interview_google_session
    WHERE store_id=$1 AND actor_id=$2 AND state_hash=$3 AND used AND expires_at>clock_timestamp()
    RETURNING calendar_id`,[store,actor.id,digest(state)])
  if(!pending)throw invalidState()
  await db.query(`INSERT INTO interview_google_calendar VALUES($1,$2,$3,$4)
    ON CONFLICT (store_id) DO UPDATE SET calendar_id=excluded.calendar_id,refresh_box=excluded.refresh_box`,
    [store,actor.tenant_id,pending.calendar_id,seal(cfg,boxContext(actor.tenant_id,store),refresh)])
  await audit(db,actor.tenant_id,store,actor.id,'interview.google.link',store)
}

export async function unlinkInterviewCalendar(db:DB,actor:Actor,store:string){
  await lockDispatch(db,actor.tenant_id)
  await db.query('DELETE FROM interview_google_session WHERE store_id=$1',[store])
  await db.query('DELETE FROM interview_google_calendar WHERE store_id=$1',[store])
  await audit(db,actor.tenant_id,store,actor.id,'interview.google.unlink',store)
  return {connected:false}
}

async function calendarRecord(db:DB,store:string){
  return (await db.query<Credential>('SELECT * FROM interview_google_calendar WHERE store_id=$1',[store])).rows[0]
}

export async function googleBusy(db:DB,google:InterviewGoogle,store:string,range:Interval){
  if (!(await storeFeatures(db,store)).google_calendar_enabled) return []
  const record=await calendarRecord(db,store)
  return record?google.busy(record,range):[]
}

export async function availabilityOverview(db:DB,store:string,google:InterviewGoogle){
  const record=await calendarRecord(db,store)
  const features=await storeFeatures(db,store)
  const {rows:blocks}=await db.query(`SELECT id,starts_at,ends_at,note FROM interview_block
    WHERE store_id=$1 AND ends_at>now() ORDER BY starts_at LIMIT 200`,[store])
  return {google:{configured:google.configured,connected:!!record,calendar_id:record?.calendar_id??null},
    google_enabled:features.google_calendar_enabled,blocks}
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

export async function requireFree(db:DB,google:InterviewGoogle,store:string,slot:Interval){
  const local=await localBlocks(db,store,slot)
  if(local.length||(await googleBusy(db,google,store,slot)).some(busy=>overlaps(busy,slot)))throw new Fault(409,'INTERVIEW_SLOT_BLOCKED','ほかの予定と重なっています。別の空き枠を選んでください。')
}
