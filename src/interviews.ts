import type pg from 'pg'
import { z } from 'zod'
import {
  audit, conflict, digest, email, Fault, keyed, missing, newId, once, opaque, revision, route, scope, seal, text, token, unseal, uuid,
  type Actor, type Config, type DB,
} from './core.js'
import { channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'
import { ensureRecruitmentCase, type WorkflowSubject } from './forms.js'
import { refreshMenu } from './rich-menus.js'
import { onInterviewReleased, scheduleInterviewNotices, setWaitlist } from './interview-notices.js'
import { issueManageInterviewLink } from './interview-link.js'
import { emitApplicantEvent } from './applicant-events.js'
import { applyApplicantTagRules } from './applicant-tags.js'
import { hostsFor, queueGoogleSync, requireHost } from './interview-hosts.js'
import { clockLabel, fitsHours, interval } from '../public/interview/hours.mjs'
import { localInstant } from '../public/studio/engine.mjs'
import { calendarRecord, managedCalendarRecord, googleBusy, localBlocks, overlaps, requireFree, type InterviewGoogle } from './interview-availability.js'

export const interviewSlotInput=z.strictObject({
  channel:uuid,starts_at:z.iso.datetime({offset:true}),ends_at:z.iso.datetime({offset:true}),
  method:z.literal('onsite').default('onsite'),instructions:text(800),published:z.boolean(),
  host_id:uuid.nullable().optional(),
})
const gridMinute=z.int().min(0).max(1440).refine(value=>value%interval===0)
export const interviewHours=z.strictObject({start:gridMinute,end:gridMinute,revision})
  .refine(value=>value.start<value.end,{path:['end'],message:'受付終了は受付開始より後にしてください。'})
export const interviewVisibility=z.strictObject({revision,published:z.boolean()})
const dateInput=z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const interviewBatchInput=z.strictObject({
  channel:uuid,first_day:dateInput,last_day:dateInput,
  weekdays:z.array(z.int().min(0).max(6)).min(1).max(7).transform(days=>[...new Set(days)].sort()),
  start:gridMinute,end:gridMinute,minutes:z.int().min(30).max(180).refine(value=>value%interval===0),
  instructions:text(800),host_id:uuid.nullable().default(null),
}).refine(input=>input.end-input.start>=input.minutes,{
  path:['end'],message:'終了時刻までに面談1枠分の時間を確保してください。',
})
export const interviewBatchPublish=z.strictObject({
  selection:interviewBatchInput,preview:z.string().regex(/^[a-f0-9]{64}$/),
})
export const interviewDates=z.strictObject({start:dateInput.optional()})
export const interviewCreate=z.strictObject({slot:uuid,name:text(80)})
export const guestInterviewCreate=interviewCreate.extend({email:email})
export const interviewChange=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('reschedule'),revision,slot:uuid}),
  z.strictObject({action:z.literal('cancel'),revision}),
])
type Applicant = {tenant_id:string;store_id:string;channel_id:string;applicant_key:string;guest?:true;
  link_token_hash?:string|null}
export const recruitmentSubject=(a:Applicant):WorkflowSubject=>({...a,purpose:'recruitment',subject:a.applicant_key})
type Booking = {id:string;slot_id:string;status:'confirmed'|'cancelled'|'completed';revision:number;applicant_name:string;
  starts_at:Date;ends_at:Date;method:'onsite'|'online';instructions:string}
type Hours={start:number;end:number;revision:number}
type Location={name:string;timezone:string;today:string;hours:Hours}
type Range = {starts_at:Date;ends_at:Date;method:'onsite'|'online';published:boolean;id:string;revision:number;host_id:string|null}
type SlotInterval = Pick<Range,'starts_at'|'ends_at'>
type BatchInput = z.infer<typeof interviewBatchInput>
const day=86400000

const taken=()=>new Fault(409,'INTERVIEW_SLOT_TAKEN','この枠は予約できなくなりました。空き枠を選び直してください。')
const unauthorized=()=>new Fault(401,'INTERVIEW_SESSION','LINEで本人確認を行ってください。')
const guestUnauthorized=()=>new Fault(401,'INTERVIEW_SESSION','予約ページを開き直してください。')

async function recruitmentConnection(db:DB,id:string) {
  const c=await channel(db,id)
  if (c.purpose==='customer') throw missing()
  return c
}

export async function startGuestInterviewSession(db:DB,cfg:Config,connection:string) {
  const target=await route(db,connection)
  await scope(db,target.tenant_id,target.store_id)
  const c=await recruitmentConnection(db,target.id)
  await requireFeature(db,c.store_id,'guest_interviews_enabled')
  const raw=token()
  const maxAge=30*86400
  await db.query(`INSERT INTO interview_session
    (token_hash,tenant_id,store_id,channel_id,generation,applicant_key,expires_at,audience)
    VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second','guest')`,
    [digest(raw),c.tenant_id,c.store_id,c.id,c.generation,keyed(cfg,'guest-interview:'+c.id+':'+raw),maxAge])
  await db.query("DELETE FROM interview_session WHERE channel_id=$1 AND audience='guest' AND expires_at<=now()",[c.id])
  const secure=cfg.external?'; Secure':''
  return `night_guest_interview=${c.id}.${raw}; Path=/api/v1/guest-interview/${c.id}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export async function interviewApplicant(db:DB,credential:string|undefined,write=false,guestConnection?:string) {
  const [channelId,key,extra]=(credential??'').split('.')
  const invalid=guestConnection?guestUnauthorized:unauthorized
  if (extra!==undefined || !uuid.safeParse(channelId).success || !opaque.safeParse(key).success ||
    (guestConnection&&guestConnection!==channelId)) throw invalid()
  const target=await route(db,channelId)
  await scope(db,target.tenant_id,target.store_id)
  if (write) await lockDispatch(db,target.tenant_id)
  const {rows:[applicant]}=await db.query<Applicant>(`SELECT s.tenant_id,s.store_id,s.channel_id,s.applicant_key,s.link_token_hash
    FROM interview_session s JOIN channel c ON c.id=s.channel_id AND (s.audience='guest' OR c.generation=s.generation)
    WHERE s.token_hash=$1 AND s.channel_id=$2 AND s.audience=ANY($3) AND s.expires_at>now()
      AND c.purpose<>'customer' AND (s.audience='guest' OR NOT c.stopped)`,
    [digest(key),channelId,guestConnection?['guest']:['token']])
  if (!applicant) throw invalid()
  return guestConnection?{...applicant,guest:true as const}:applicant
}

export async function interviewAccess(db:DB,actor:Actor,store:string) {
  if (!['admin','manager','recruiter'].includes(actor.role)) throw new Fault(403,'FORBIDDEN','採用担当の権限が必要です。')
  await scope(db,actor.tenant_id,store)
  const allowed=await db.query(`SELECT 1 FROM store WHERE id=$1 AND ($2='admin' OR EXISTS
    (SELECT 1 FROM store_grant WHERE store_id=$1 AND staff_id=$3))`,[store,actor.role,actor.id])
  if (!allowed.rowCount) throw missing()
}

async function locationFor(db:DB,id:string) {
  const {rows:[location]}=await db.query<Location>(`SELECT name,timezone,(now() AT TIME ZONE timezone)::date::text AS today,
    json_build_object('start',interview_open_minute,'end',interview_close_minute,'revision',interview_hours_revision) AS hours
    FROM store WHERE id=$1`,[id])
  if(!location)throw missing()
  return location
}

export async function saveInterviewHours(db:DB,actor:Actor,store:string,input:z.infer<typeof interviewHours>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'interviews_enabled')
  const {rows:[saved]}=await db.query<Hours>(`UPDATE store SET interview_open_minute=$2,interview_close_minute=$3,
    interview_hours_revision=interview_hours_revision+1 WHERE id=$1 AND interview_hours_revision=$4
    RETURNING interview_open_minute AS start,interview_close_minute AS end,interview_hours_revision AS revision`,
    [store,input.start,input.end,input.revision])
  if (!saved) throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'interview.hours',store,null,{start:saved.start,end:saved.end})
  return saved
}

function assertSlotHours(location:Location,start:Date,end:Date) {
  if (!fitsHours(start,end,location.timezone,location.hours)) {
    throw new Fault(422,'INTERVIEW_HOURS',
      `受付時間（${clockLabel(location.hours.start)}〜${clockLabel(location.hours.end)}）内の30分刻みで選択してください。`)
  }
}

export async function staffInterviewOverview(db:DB,store:string,cfg:Config,google?:InterviewGoogle) {
  const location=await locationFor(db,store)
  const features=await storeFeatures(db,store)
  const hosts=features.interviewers_enabled?await hostsFor(db,store):[]
  const {rows:channels}=await db.query("SELECT id,label FROM channel WHERE store_id=$1 AND purpose<>'customer' ORDER BY label",[store])
  const {rows:slots}=await db.query(`SELECT f.*,c.label AS channel_label,b.applicant_name,b.id AS booking_id,b.guest_email_box,h.name AS host_name,
    g.status AS calendar_status,g.last_error AS calendar_error
    FROM interview_slot f JOIN channel c ON c.id=f.channel_id
    LEFT JOIN interview_booking b ON b.slot_id=f.id AND b.status='confirmed'
    LEFT JOIN interview_host h ON h.id=f.host_id LEFT JOIN interview_google_sync g ON g.booking_id=b.id
    WHERE f.store_id=$1 AND f.ends_at>now()-interval '1 day' AND (f.method='onsite' OR b.id IS NOT NULL)
    ORDER BY f.starts_at LIMIT 200`,[store])
  const candidates=slots.filter(slot=>!slot.booking_id&&slot.published&&+slot.ends_at>Date.now())
  const calendar=google&&features.google_calendar_enabled?await busyForSchedule(db,google,store,candidates.map(slot=>({
    starts_at:slot.starts_at,ends_at:slot.ends_at,host_calendar:hosts.find(host=>host.id===slot.host_id)?.calendar_id,
  }))):new Map<string|null,SlotInterval[]|null>()
  return {channels,hosts,interviewers_enabled:features.interviewers_enabled,hours:location.hours,today:location.today,
    timezone:location.timezone,interviews_enabled:features.interviews_enabled,
    slots:slots.map(({guest_email_box,...slot})=>({...slot,
      ...(guest_email_box?{guest_email:unseal(cfg,'guest-interview-email:'+slot.booking_id,guest_email_box)}:{}),
      in_hours:fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours),
      google_status:candidates.includes(slot)?calendarSlotStatus(calendar,slot,hosts.find(host=>host.id===slot.host_id)?.calendar_id):null}))}
}

async function busyForSchedule(db:DB,google:InterviewGoogle,store:string,
  slots:(SlotInterval & {host_calendar?:string|null})[]){
  const result=new Map<string|null,SlotInterval[]|null>()
  if(!slots.length)return result
  const range={starts_at:slots[0].starts_at,ends_at:new Date(Math.max(...slots.map(slot=>+slot.ends_at)))}
  const calendars=[...new Set<string|null>([null,...slots.map(slot=>slot.host_calendar??null)])]
  // The store-wide calendar always applies, even when an individual interviewer has a calendar.
  await Promise.all(calendars.map(async id=>{
    try{result.set(id,await googleBusy(db,google,store,range,id??undefined,true))}
    catch(error){
      if(!(error instanceof Fault)||error.code!=='GOOGLE_UNAVAILABLE')throw error
      result.set(id,null)
    }
  }))
  return result
}

function calendarSlotStatus(busy:Map<string|null,SlotInterval[]|null>,slot:SlotInterval,hostCalendar?:string|null){
  const ranges=[busy.get(null),hostCalendar?busy.get(hostCalendar):undefined]
  if(ranges.some(range=>range?.some(entry=>overlaps(slot,entry))))return 'google_busy'
  return ranges.includes(null)?'google_unavailable':null
}

function expandInterviewBatch(location:Location,input:BatchInput){
  const first=new Date(input.first_day+'T00:00:00Z'),last=new Date(input.last_day+'T00:00:00Z')
  const dateOK=(date:Date,value:string)=>Number.isFinite(+date)&&date.toISOString().slice(0,10)===value
  if(!dateOK(first,input.first_day)||!dateOK(last,input.last_day)||input.first_day<location.today||
    +last<+first||+last-+first>=14*day||+last>Date.parse(location.today+'T00:00:00Z')+90*day){
    throw new Fault(422,'INTERVIEW_BATCH_DATE','本日から90日以内で、14日間までの範囲を指定してください。')
  }
  if(input.start<location.hours.start||input.end>location.hours.end){
    throw new Fault(422,'INTERVIEW_HOURS','店舗の面談受付時間内で指定してください。')
  }
  const slots:SlotInterval[]=[]
  for(let date=+first;date<=+last;date+=day){
    const selected=new Date(date)
    if(!input.weekdays.includes(selected.getUTCDay()))continue
    const civil=selected.toISOString().slice(0,10)
    for(let start=input.start;start+input.minutes<=input.end;start+=input.minutes){
      const at=localInstant(civil+'T'+clockLabel(start),location.timezone)
      if(at===null)continue
      const slot={starts_at:new Date(at),ends_at:new Date(at+input.minutes*60000)}
      if((!slots.length||slot.starts_at>=slots[slots.length-1].ends_at)&&
        fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours))slots.push(slot)
    }
  }
  if(!slots.length||slots.length>200)throw new Fault(422,'INTERVIEW_BATCH_COUNT','対象の曜日と時間を調整し、1〜200枠を選んでください。')
  return slots
}

async function batchConfiguration(db:DB,store:string,input:BatchInput){
  const features=await storeFeatures(db,store)
  if(!features.interviews_enabled)await requireFeature(db,store,'interviews_enabled')
  await recruitmentConnection(db,input.channel)
  const host=input.host_id?await requireHost(db,store,input.host_id):null
  return {location:await locationFor(db,store),hostCalendar:host?.calendar_id??null,
    googleEnabled:features.google_calendar_enabled,
    calendarRevision:features.google_calendar_enabled?JSON.stringify([(await calendarRecord(db,store))?.refresh_box??null,await managedCalendarRecord(db,store)??null]):null}
}

async function checkBatchSlots(db:DB,store:string,cfg:Config,input:BatchInput,slots:SlotInterval[],
  busy:Map<string|null,SlotInterval[]|null>,hostCalendar:string|null){
  const range={starts_at:slots[0].starts_at,ends_at:slots[slots.length-1].ends_at}
  const blocked=await localBlocks(db,store,range)
  const {rows:existing}=await db.query<SlotInterval & {reserved:boolean}>(`
    SELECT f.starts_at,f.ends_at,b.id IS NOT NULL AS reserved FROM interview_slot f
    LEFT JOIN interview_booking b ON b.slot_id=f.id AND b.status='confirmed'
    WHERE f.store_id=$1 AND f.starts_at<$3 AND f.ends_at>$2
    AND ($4::uuid IS NULL OR f.host_id IS NULL OR f.host_id=$4)
    AND (f.published AND f.method='onsite' OR b.id IS NOT NULL)`,
  [store,range.starts_at,range.ends_at,input.host_id])
  const evaluated=slots.map(slot=>{
    const matches=existing.filter(entry=>overlaps(slot,entry))
    const reason=+slot.starts_at<=Date.now()?'past':matches.some(entry=>entry.reserved)?'reserved':
      matches.length?'published':blocked.some(entry=>overlaps(slot,entry))?'blocked':calendarSlotStatus(busy,slot,hostCalendar)
    return {...slot,reason}
  })
  return {slots:evaluated,preview:keyed(cfg,JSON.stringify([store,input,evaluated]))}
}

export async function checkInterviewBatch(db:DB,cfg:Config,store:string,input:BatchInput,google:InterviewGoogle){
  const settings=await batchConfiguration(db,store,input)
  const slots=expandInterviewBatch(settings.location,input)
  const busy=settings.googleEnabled?await busyForSchedule(db,google,store,slots.map(slot=>({...slot,host_calendar:settings.hostCalendar}))):
    new Map<string|null,SlotInterval[]|null>()
  return checkBatchSlots(db,store,cfg,input,slots,busy,settings.hostCalendar)
}

export async function publishInterviewBatch(db:DB,cfg:Config,actor:Actor,store:string,key:string,
  request:z.infer<typeof interviewBatchPublish>,google:InterviewGoogle){
  const input=request.selection
  return once(db,cfg,actor,'interview.slot.batch',key,{store,request},async()=>{
    const settings=await batchConfiguration(db,store,input)
    const slots=expandInterviewBatch(settings.location,input)
    const busy=settings.googleEnabled?await busyForSchedule(db,google,store,slots.map(slot=>({...slot,host_calendar:settings.hostCalendar}))):
      new Map<string|null,SlotInterval[]|null>()
    await lockDispatch(db,actor.tenant_id)
    const latest=await batchConfiguration(db,store,input)
    if(latest.googleEnabled!==settings.googleEnabled||latest.hostCalendar!==settings.hostCalendar||
      latest.calendarRevision!==settings.calendarRevision||
      latest.location.timezone!==settings.location.timezone||latest.location.hours.revision!==settings.location.hours.revision)throw conflict()
    const plan=await checkBatchSlots(db,store,cfg,input,slots,busy,settings.hostCalendar)
    if(plan.preview!==request.preview)throw new Fault(409,'INTERVIEW_BATCH_CHANGED','空き状況が変わりました。公開前の確認をやり直してください。')
    const available=plan.slots.filter(slot=>slot.reason===null)
    if(!available.length)throw new Fault(409,'INTERVIEW_BATCH_EMPTY','公開できる面談枠がありません。')
    const ids=available.map(()=>newId())
    await db.query(`INSERT INTO interview_slot(id,tenant_id,store_id,channel_id,starts_at,ends_at,method,instructions,published,host_id)
      SELECT item.id,$1,$2,$3,item.starts_at,item.ends_at,'onsite',$7,true,$8 FROM
      unnest($4::uuid[],$5::timestamptz[],$6::timestamptz[]) AS item(id,starts_at,ends_at)`,
    [actor.tenant_id,store,input.channel,ids,available.map(slot=>slot.starts_at),available.map(slot=>slot.ends_at),input.instructions,input.host_id])
    await audit(db,actor.tenant_id,store,actor.id,'interview.slot.batch',input.channel,null,
      {first_day:input.first_day,last_day:input.last_day,published:ids.length,skipped:slots.length-ids.length})
    return {published:ids.length,skipped:slots.length-ids.length}
  })
}

export async function publishInterviewSlot(db:DB,cfg:Config,actor:Actor,store:string,key:string,input:z.infer<typeof interviewSlotInput>) {
  await lockDispatch(db,actor.tenant_id)
  return once(db,cfg,actor,'interview.slot',key,{store,input},async()=>{
    await requireFeature(db,store,'interviews_enabled')
    await recruitmentConnection(db,input.channel)
    const start=new Date(input.starts_at),end=new Date(input.ends_at)
    const duration=+end-+start
    if(input.host_id)await requireHost(db,store,input.host_id)
    if (+start<=Date.now() || duration<interval*60000 || duration>180*60000) {
      throw new Fault(422,'INTERVIEW_TIME','将来の日時を指定し、所要時間を30〜180分にしてください。')
    }
    assertSlotHours(await locationFor(db,store),start,end)
    if (input.published) await checkOverlap(db,store,start,end,input.host_id??null)
    const id=newId()
    await db.query(`INSERT INTO interview_slot(id,tenant_id,store_id,channel_id,starts_at,ends_at,method,instructions,published,host_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,actor.tenant_id,store,input.channel,start,end,input.method,input.instructions,input.published,input.host_id??null])
    await audit(db,actor.tenant_id,store,actor.id,'interview.slot.create',id,null,{published:input.published})
    return {id}
  })
}

async function checkOverlap(db:DB,store:string,start:Date,end:Date,host:string|null,exclude?:string) {
  const result=await db.query(`SELECT 1 FROM interview_slot s WHERE s.store_id=$1
    AND s.starts_at<$3 AND s.ends_at>$2 AND s.id IS DISTINCT FROM $4::uuid
    AND ($5::uuid IS NULL OR s.host_id IS NULL OR s.host_id=$5)
    AND ((s.published AND s.method='onsite') OR EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed'))
    LIMIT 1`,[store,start,end,exclude??null,host])
  if (result.rowCount) throw new Fault(409,'INTERVIEW_OVERLAP','公開・予約済みの面談枠と同じ担当者または店舗の時間が重なっています。')
}

export async function changeInterviewVisibility(db:DB,actor:Actor,store:string,id:string,input:z.infer<typeof interviewVisibility>) {
  await lockDispatch(db,actor.tenant_id)
  const {rows:[slot]}=await db.query<Range>('SELECT * FROM interview_slot WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])
  if (!slot) throw missing()
  if (slot.revision!==input.revision) throw conflict()
  if (input.published) {
    if(slot.method!=='onsite')throw new Fault(422,'INTERVIEW_ONSITE_REQUIRED','公開できる枠は対面面談です。')
    await requireFeature(db,store,'interviews_enabled')
    if(slot.host_id)await requireHost(db,store,slot.host_id)
    if (+slot.starts_at<=Date.now()) throw taken()
    assertSlotHours(await locationFor(db,store),slot.starts_at,slot.ends_at)
    await checkOverlap(db,store,slot.starts_at,slot.ends_at,slot.host_id,id)
  }
  await db.query('UPDATE interview_slot SET published=$2,revision=revision+1 WHERE id=$1',[id,input.published])
  await audit(db,actor.tenant_id,store,actor.id,'interview.slot.visibility',id,null,{published:input.published})
  return {updated:true}
}

const selectBooking=`SELECT b.id,b.slot_id,b.status,b.revision,b.applicant_name,s.starts_at,s.ends_at,s.method,s.instructions
  FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id`
async function ownBooking(db:DB,a:Applicant,id:string) {
  const {rows:[found]}=await db.query<Booking>(selectBooking+' WHERE b.id=$1 AND b.channel_id=$2 AND b.applicant_key=$3',
    [id,a.channel_id,a.applicant_key])
  if (!found) throw missing()
  return found
}

export async function interviewCalendar(db:DB,a:Applicant,google:InterviewGoogle,requested?:string) {
  const location=await locationFor(db,a.store_id)
  const features=await storeFeatures(db,a.store_id)
  const accepting=features.interviews_enabled&&(!a.guest||features.guest_interviews_enabled)
  const start=requested??location.today
  const date=new Date(start+'T00:00:00Z')
  if (!Number.isFinite(+date) || date.toISOString().slice(0,10)!==start) {
    throw new Fault(422,'INTERVIEW_DATE','有効な日付を指定してください。')
  }
  const max=new Date(Date.parse(location.today+'T00:00:00Z')+90*86400000).toISOString().slice(0,10)
  if (start<location.today || start>max) throw new Fault(422,'INTERVIEW_DATE','本日から90日以内の日付を選択してください。')
  const {rows:slots}=await db.query<Pick<Range,'id'|'starts_at'|'ends_at'|'method'>&{available:boolean;calendar_id:string|null}>(`
    SELECT s.id,s.starts_at,s.ends_at,s.method,h.calendar_id,s.starts_at>now() AND
    NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed') AS available
    FROM interview_slot s LEFT JOIN interview_host h ON h.id=s.host_id
    WHERE s.channel_id=$1 AND s.method='onsite' AND s.published AND $4 AND (s.host_id IS NULL OR ($5 AND h.active))
      AND s.starts_at >= ($2::date::timestamp AT TIME ZONE $3)
      AND s.starts_at < (($2::date+7)::timestamp AT TIME ZONE $3)
    ORDER BY s.starts_at`,[a.channel_id,start,location.timezone,accepting,features.interviewers_enabled])
  const {rows:bookings}=await db.query<Booking>(selectBooking+` WHERE b.channel_id=$1 AND b.applicant_key=$2
    ORDER BY (b.status='confirmed' AND s.starts_at>now()) DESC, b.updated_at DESC LIMIT 10`,[a.channel_id,a.applicant_key])
  const visible=slots.filter(slot=>fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours))
  const candidates=visible.filter(slot=>slot.available)
  let googleUnavailable=false
  if(candidates.length){
    const range={starts_at:candidates[0].starts_at,ends_at:new Date(Math.max(...candidates.map(slot=>+slot.ends_at)))}
    const local=await localBlocks(db,a.store_id,range)
    let external:typeof local=[]
    try {external=await googleBusy(db,google,a.store_id,range,undefined,!!a.guest)}
    catch(error){
      if(!(error instanceof Fault)||error.code!=='GOOGLE_UNAVAILABLE')throw error
      googleUnavailable=true
    }
    const baseUnavailable=googleUnavailable
    const personal=new Map<string,typeof local|null>()
    if(!baseUnavailable)for(const calendar of new Set(candidates.map(slot=>slot.calendar_id))){
      if(!calendar)continue
      try{personal.set(calendar,await googleBusy(db,google,a.store_id,range,calendar,!!a.guest))}
      catch(error){
        if(!(error instanceof Fault)||error.code!=='GOOGLE_UNAVAILABLE')throw error
        googleUnavailable=true
        personal.set(calendar,null)
      }
    }
    for(const slot of candidates) {
      const host=slot.calendar_id?personal.get(slot.calendar_id):[]
      slot.available=!baseUnavailable&&host!==null&&!local.some(block=>overlaps(slot,block))&&
        !external.some(busy=>overlaps(slot,busy))&&!host?.some(busy=>overlaps(slot,busy))
    }
  }
  return {store:location.name,timezone:location.timezone,today:location.today,hours:location.hours,
    interviews_enabled:accepting,availability_warning:googleUnavailable,
    slots:visible.map(({calendar_id,...slot})=>slot),bookings:bookings.map(visibleBooking)}
}

function visibleBooking(booking:Booking) {
  const {instructions,...fields}=booking
  return {...fields,instructions:booking.status==='confirmed'?instructions:null}
}

async function availableSlot(db:DB,a:Applicant,id:string,google:InterviewGoogle) {
  await requireFeature(db,a.store_id,'interviews_enabled')
  if(a.guest)await requireFeature(db,a.store_id,'guest_interviews_enabled')
  const {rows:[slot]}=await db.query<Range & {calendar_id:string|null}>(`SELECT s.id,s.starts_at,s.ends_at,s.host_id,h.calendar_id
    FROM interview_slot s LEFT JOIN interview_host h ON h.id=s.host_id WHERE s.id=$1 AND s.channel_id=$2
    AND s.published AND s.starts_at>clock_timestamp() AND s.method='onsite'
    AND NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed')`,[id,a.channel_id])
  if (!slot) throw taken()
  if(slot.host_id)await requireHost(db,a.store_id,slot.host_id)
  const location=await locationFor(db,a.store_id)
  if (!fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours)) throw taken()
  await requireFree(db,google,a.store_id,slot,slot.calendar_id??undefined,!!a.guest)
  if (+slot.starts_at<=Date.now()) throw taken()
}

export async function confirmInterview(db:DB,cfg:Config,a:Applicant,input:z.infer<typeof interviewCreate>,google:InterviewGoogle,guestEmail?:string) {
  const {rows:[current]}=await db.query<Booking>(selectBooking+` WHERE b.channel_id=$1 AND b.applicant_key=$2
    AND b.status='confirmed'`,[a.channel_id,a.applicant_key])
  if (current && +current.starts_at>Date.now()) {
    if (current.slot_id===input.slot && current.applicant_name===input.name) return visibleBooking(current)
    throw new Fault(409,'INTERVIEW_ALREADY_BOOKED','確定済みの面談があります。日程変更から手続きしてください。')
  }
  await availableSlot(db,a,input.slot,google)
  // Past appointments stay in history without blocking a new reservation.
  if (current) await db.query("UPDATE interview_booking SET status='completed' WHERE id=$1",[current.id])
  const id=newId()
  const emailBox=guestEmail?seal(cfg,'guest-interview-email:'+id,guestEmail):null
  await db.query(`INSERT INTO interview_booking (id,tenant_id,store_id,channel_id,applicant_key,slot_id,applicant_name,status,guest_email_box)
    VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed',$8)`,[id,a.tenant_id,a.store_id,a.channel_id,a.applicant_key,input.slot,input.name,emailBox])
  if (a.link_token_hash) {
    // トークン経路: 予約確定と同一トランザクションでリンクを消費する。
    await db.query('UPDATE interview_link_token SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL',
      [a.link_token_hash])
  }
  if(!a.guest){
    const subject=recruitmentSubject(a)
    await ensureRecruitmentCase(db,subject)
    await refreshMenu(db,subject)
    await setWaitlist(db,subject,null)
    // D4: トークン経路では変更・取消用の新しいリンクを発行し、確定通知に同梱する。
    const manageUrl=a.link_token_hash?await issueManageInterviewLink(db,cfg,subject,id):undefined
    await scheduleInterviewNotices(db,cfg,subject,manageUrl)
    // 採用シナリオの実配信（026）: 面談予約を開始イベントとして発行する。
    await emitApplicantEvent(db,{tenant_id:a.tenant_id,store_id:a.store_id,channel_id:a.channel_id,
      applicant_key:a.applicant_key},'interview:'+id+':1:booked','interview_booked',new Date(),{id,revision:1})
  }
  await applyApplicantTagRules(db,a,'interview_booked')
  await queueGoogleSync(db,a.store_id,id)
  await audit(db,a.tenant_id,a.store_id,null,'interview.confirm',id,null,{slot:input.slot})
  return visibleBooking(await ownBooking(db,a,id))
}

export async function updateInterview(db:DB,cfg:Config,a:Applicant,id:string,input:z.infer<typeof interviewChange>,google:InterviewGoogle) {
  const existing=await ownBooking(db,a,id)
  if (existing.status==='cancelled' && input.action==='cancel') return visibleBooking(existing)
  if (input.action==='reschedule' && existing.status==='confirmed' && existing.slot_id===input.slot) return visibleBooking(existing)
  if (existing.revision!==input.revision || existing.status!=='confirmed' || +existing.starts_at<=Date.now()) throw conflict()
  if (input.action==='reschedule') await availableSlot(db,a,input.slot,google)
  await db.query(`UPDATE interview_booking SET slot_id=$2,status=$3,revision=revision+1,updated_at=now()
    WHERE id=$1`,[id,input.action==='reschedule'?input.slot:existing.slot_id,input.action==='cancel'?'cancelled':'confirmed'])
  await audit(db,a.tenant_id,a.store_id,null,'interview.'+input.action,id,null,
    {previous_slot:existing.slot_id,slot:input.action==='reschedule'?input.slot:existing.slot_id})
  const subject=recruitmentSubject(a)
  if(!a.guest)await refreshMenu(db,subject)
  await onInterviewReleased(db,cfg,subject,existing)
  if(!a.guest&&input.action==='reschedule')await scheduleInterviewNotices(db,cfg,subject)
  if(!a.guest){
    // 採用シナリオの実配信（026）: 面談の変更・取消を開始イベントとして発行する。
    const nextRevision=existing.revision+1
    const cancelled=input.action==='cancel'
    await emitApplicantEvent(db,{tenant_id:a.tenant_id,store_id:a.store_id,channel_id:a.channel_id,
      applicant_key:a.applicant_key},
      'interview:'+id+':'+nextRevision+':'+(cancelled?'cancelled':'changed'),
      cancelled?'interview_cancelled':'interview_changed',new Date(),{id,revision:nextRevision})
  }
  await applyApplicantTagRules(db,a,input.action==='cancel'?'interview_cancelled':'interview_booked')
  await queueGoogleSync(db,a.store_id,id)
  return visibleBooking(await ownBooking(db,a,id))
}
