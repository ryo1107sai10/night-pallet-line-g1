import type pg from 'pg'
import { z } from 'zod'
import {
  audit, conflict, digest, Fault, keyed, missing, newId, once, opaque, revision, route, scope, text, token, tx, uuid,
  type Actor, type Config, type DB,
} from './core.js'
import { channel, type LineAPI } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'
import { ensureRecruitmentCase, type WorkflowSubject } from './forms.js'
import { recordSource } from './sources.js'
import { refreshMenu, rememberContact } from './rich-menus.js'
import { onInterviewReleased, scheduleInterviewNotices, setWaitlist } from './interview-notices.js'
import { hostsFor, queueGoogleSync, requireHost } from './interview-hosts.js'
import { clockLabel, fitsHours, interval } from '../public/interview/hours.mjs'
import { googleBusy, localBlocks, overlaps, requireFree, type InterviewGoogle } from './interview-availability.js'

const loginSchema=z.strictObject({connection:uuid,id_token:z.string().min(20).max(12000),source:uuid.optional()})
export const interviewSlotInput=z.strictObject({
  channel:uuid,starts_at:z.iso.datetime({offset:true}),ends_at:z.iso.datetime({offset:true}),
  method:z.enum(['onsite','online']).default('onsite'),instructions:text(800),published:z.boolean(),
  host_id:uuid.nullable().optional(),
})
const gridMinute=z.int().min(0).max(1440).refine(value=>value%interval===0)
export const interviewHours=z.strictObject({start:gridMinute,end:gridMinute,revision})
  .refine(value=>value.start<value.end,{path:['end'],message:'受付終了は受付開始より後にしてください。'})
export const interviewVisibility=z.strictObject({revision,published:z.boolean()})
const dateInput=z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const interviewDates=z.strictObject({start:dateInput.optional()})
export const interviewCreate=z.strictObject({slot:uuid,name:text(80)})
export const interviewChange=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('reschedule'),revision,slot:uuid}),
  z.strictObject({action:z.literal('cancel'),revision}),
])
type Applicant = {tenant_id:string;store_id:string;channel_id:string;applicant_key:string}
export const recruitmentSubject=(a:Applicant):WorkflowSubject=>({...a,purpose:'recruitment',subject:a.applicant_key})
type Booking = {id:string;slot_id:string;status:'confirmed'|'cancelled'|'completed';revision:number;applicant_name:string;
  starts_at:Date;ends_at:Date;method:'onsite'|'online';instructions:string}
type Hours={start:number;end:number;revision:number}
type Location={name:string;timezone:string;today:string;hours:Hours}
type Range = {starts_at:Date;ends_at:Date;method:'onsite'|'online';published:boolean;id:string;revision:number;host_id:string|null}

const taken=()=>new Fault(409,'INTERVIEW_SLOT_TAKEN','この枠は予約できなくなりました。空き枠を選び直してください。')
const unauthorized=()=>new Fault(401,'INTERVIEW_SESSION','LINEで本人確認を行ってください。')

async function recruitmentConnection(db:DB,id:string) {
  const c=await channel(db,id)
  if (c.purpose==='customer') throw missing()
  return c
}

export async function startInterviewSession(pool:pg.Pool,cfg:Config,api:LineAPI,input:unknown) {
  if (!cfg.external) throw unauthorized()
  const data=loginSchema.parse(input)
  const connection=await tx(pool,async db=>{
    const target=await route(db,data.connection)
    await scope(db,target.tenant_id,target.store_id)
    const c=await recruitmentConnection(db,target.id)
    if (!c.checks.provider_verified || !c.checks.login_published) throw unauthorized()
    return c
  })
  const user=await api.verifyID(connection.login_id,data.id_token)
  const raw=token()
  await tx(pool,async db=>{
    await scope(db,connection.tenant_id,connection.store_id)
    await lockDispatch(db,connection.tenant_id)
    const c=await recruitmentConnection(db,connection.id)
    if (c.generation!==connection.generation || !c.checks.provider_verified || !c.checks.login_published) throw unauthorized()
    const identity=keyed(cfg,'interview:'+c.id+':'+user)
    const subject=recruitmentSubject({tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.id,applicant_key:identity})
    await recordSource(db,subject,data.source)
    await rememberContact(db,cfg,c,user,subject)
    await db.query(`INSERT INTO interview_session VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
      [digest(raw),c.tenant_id,c.store_id,c.id,c.generation,identity])
    await db.query('DELETE FROM interview_session WHERE channel_id=$1 AND expires_at<=now()',[c.id])
  })
  return `night_interview=${connection.id}.${raw}; Path=/api/v1/interview/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`
}

export async function interviewApplicant(db:DB,credential:string|undefined,write=false) {
  const [channelId,key,extra]=(credential??'').split('.')
  if (extra!==undefined || !uuid.safeParse(channelId).success || !opaque.safeParse(key).success) throw unauthorized()
  const target=await route(db,channelId)
  await scope(db,target.tenant_id,target.store_id)
  if (write) await lockDispatch(db,target.tenant_id)
  const {rows:[applicant]}=await db.query<Applicant>(`SELECT s.tenant_id,s.store_id,s.channel_id,s.applicant_key
    FROM interview_session s JOIN channel c ON c.id=s.channel_id AND c.generation=s.generation
    WHERE s.token_hash=$1 AND s.channel_id=$2 AND s.expires_at>now()
      AND c.purpose<>'customer' AND c.checks->>'login_published'='true' AND c.checks->>'provider_verified'='true'`,
    [digest(key),channelId])
  if (!applicant) throw unauthorized()
  return applicant
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

export async function staffInterviewOverview(db:DB,store:string) {
  const location=await locationFor(db,store)
  const features=await storeFeatures(db,store)
  const hosts=features.interviewers_enabled?await hostsFor(db,store):[]
  const {rows:channels}=await db.query("SELECT id,label FROM channel WHERE store_id=$1 AND purpose<>'customer' ORDER BY label",[store])
  const {rows:slots}=await db.query(`SELECT f.*,c.label AS channel_label,b.applicant_name,b.id AS booking_id,h.name AS host_name,
    g.status AS calendar_status,g.last_error AS calendar_error
    FROM interview_slot f JOIN channel c ON c.id=f.channel_id
    LEFT JOIN interview_booking b ON b.slot_id=f.id AND b.status='confirmed'
    LEFT JOIN interview_host h ON h.id=f.host_id LEFT JOIN interview_google_sync g ON g.booking_id=b.id
    WHERE f.store_id=$1 AND f.ends_at>now()-interval '1 day' ORDER BY f.starts_at LIMIT 200`,[store])
  return {channels,hosts,interviewers_enabled:features.interviewers_enabled,hours:location.hours,today:location.today,
    timezone:location.timezone,interviews_enabled:features.interviews_enabled,
    slots:slots.map(slot=>({...slot,in_hours:fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours)}))}
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
    AND (s.published OR EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed'))
    LIMIT 1`,[store,start,end,exclude??null,host])
  if (result.rowCount) throw new Fault(409,'INTERVIEW_OVERLAP','公開・予約済みの面談枠と同じ担当者または店舗の時間が重なっています。')
}

export async function changeInterviewVisibility(db:DB,actor:Actor,store:string,id:string,input:z.infer<typeof interviewVisibility>) {
  await lockDispatch(db,actor.tenant_id)
  const {rows:[slot]}=await db.query<Range>('SELECT * FROM interview_slot WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])
  if (!slot) throw missing()
  if (slot.revision!==input.revision) throw conflict()
  if (input.published) {
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
    WHERE s.channel_id=$1 AND s.published AND $4 AND (s.host_id IS NULL OR ($5 AND h.active))
      AND s.starts_at >= ($2::date::timestamp AT TIME ZONE $3)
      AND s.starts_at < (($2::date+7)::timestamp AT TIME ZONE $3)
    ORDER BY s.starts_at`,[a.channel_id,start,location.timezone,features.interviews_enabled,features.interviewers_enabled])
  const {rows:bookings}=await db.query<Booking>(selectBooking+` WHERE b.channel_id=$1 AND b.applicant_key=$2
    ORDER BY (b.status='confirmed' AND s.starts_at>now()) DESC, b.updated_at DESC LIMIT 10`,[a.channel_id,a.applicant_key])
  const visible=slots.filter(slot=>fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours))
  const candidates=visible.filter(slot=>slot.available)
  let googleUnavailable=false
  if(candidates.length){
    const range={starts_at:candidates[0].starts_at,ends_at:new Date(Math.max(...candidates.map(slot=>+slot.ends_at)))}
    const local=await localBlocks(db,a.store_id,range)
    let external:typeof local=[]
    try {external=await googleBusy(db,google,a.store_id,range)}
    catch(error){
      if(!(error instanceof Fault)||error.code!=='GOOGLE_UNAVAILABLE')throw error
      googleUnavailable=true
    }
    const baseUnavailable=googleUnavailable
    const personal=new Map<string,typeof local|null>()
    if(!baseUnavailable)for(const calendar of new Set(candidates.map(slot=>slot.calendar_id))){
      if(!calendar)continue
      try{personal.set(calendar,await googleBusy(db,google,a.store_id,range,calendar))}
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
    interviews_enabled:features.interviews_enabled,availability_warning:googleUnavailable,
    slots:visible.map(({calendar_id,...slot})=>slot),bookings:bookings.map(visibleBooking)}
}

function visibleBooking(booking:Booking) {
  const {instructions,...fields}=booking
  return {...fields,instructions:booking.status==='confirmed'?instructions:null}
}

async function availableSlot(db:DB,a:Applicant,id:string,google:InterviewGoogle) {
  await requireFeature(db,a.store_id,'interviews_enabled')
  const {rows:[slot]}=await db.query<Range & {calendar_id:string|null}>(`SELECT s.id,s.starts_at,s.ends_at,s.host_id,h.calendar_id
    FROM interview_slot s LEFT JOIN interview_host h ON h.id=s.host_id WHERE s.id=$1 AND s.channel_id=$2
    AND s.published AND s.starts_at>clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed')`,[id,a.channel_id])
  if (!slot) throw taken()
  if(slot.host_id)await requireHost(db,a.store_id,slot.host_id)
  const location=await locationFor(db,a.store_id)
  if (!fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours)) throw taken()
  await requireFree(db,google,a.store_id,slot,slot.calendar_id??undefined)
  if (+slot.starts_at<=Date.now()) throw taken()
}

export async function confirmInterview(db:DB,cfg:Config,a:Applicant,input:z.infer<typeof interviewCreate>,google:InterviewGoogle) {
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
  await db.query(`INSERT INTO interview_booking (id,tenant_id,store_id,channel_id,applicant_key,slot_id,applicant_name,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed')`,[id,a.tenant_id,a.store_id,a.channel_id,a.applicant_key,input.slot,input.name])
  const subject=recruitmentSubject(a)
  await ensureRecruitmentCase(db,subject)
  await refreshMenu(db,subject)
  await setWaitlist(db,subject,null)
  await scheduleInterviewNotices(db,cfg,subject)
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
  await refreshMenu(db,subject)
  await onInterviewReleased(db,cfg,subject,existing)
  if(input.action==='reschedule')await scheduleInterviewNotices(db,cfg,subject)
  await queueGoogleSync(db,a.store_id,id)
  return visibleBooking(await ownBooking(db,a,id))
}
