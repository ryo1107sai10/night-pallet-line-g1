import type pg from 'pg'
import { z } from 'zod'
import {
  audit, conflict, digest, Fault, keyed, missing, newId, once, opaque, revision, route, scope, text, token, tx, uuid,
  type Actor, type Config, type DB,
} from './core.js'
import { channel, type LineAPI } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { clockLabel, fitsHours, interval } from '../public/interview/hours.mjs'
import { googleBusy, localBlocks, overlaps, requireFree, type InterviewGoogle } from './interview-availability.js'

const loginSchema=z.strictObject({connection:uuid,id_token:z.string().min(20).max(12000)})
export const interviewSlotInput=z.strictObject({
  channel:uuid,starts_at:z.iso.datetime({offset:true}),ends_at:z.iso.datetime({offset:true}),
  method:z.enum(['onsite','online']),instructions:text(800),published:z.boolean(),
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
type Booking = {id:string;slot_id:string;status:'confirmed'|'cancelled'|'completed';revision:number;applicant_name:string;
  starts_at:Date;ends_at:Date;method:'onsite'|'online';instructions:string}
type Hours={start:number;end:number;revision:number}
type Location={name:string;timezone:string;today:string;hours:Hours}
type Range = {starts_at:Date;ends_at:Date;method:'onsite'|'online';published:boolean;id:string;revision:number}

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
  const [location,{rows:channels},{rows:slots}]=await Promise.all([
    locationFor(db,store),
    db.query("SELECT id,label FROM channel WHERE store_id=$1 AND purpose<>'customer' ORDER BY label",[store]),
    db.query(`SELECT f.*,c.label AS channel_label,b.applicant_name,b.id AS booking_id
      FROM interview_slot f JOIN channel c ON c.id=f.channel_id
      LEFT JOIN interview_booking b ON b.slot_id=f.id AND b.status='confirmed'
      WHERE f.store_id=$1 AND f.ends_at>now()-interval '1 day' ORDER BY f.starts_at LIMIT 200`,[store]),
  ])
  return {channels,hours:location.hours,today:location.today,timezone:location.timezone,
    slots:slots.map(slot=>({...slot,in_hours:fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours)}))}

}

export async function publishInterviewSlot(db:DB,cfg:Config,actor:Actor,store:string,key:string,input:z.infer<typeof interviewSlotInput>) {
  await lockDispatch(db,actor.tenant_id)
  return once(db,cfg,actor,'interview.slot',key,{store,input},async()=>{
    await recruitmentConnection(db,input.channel)
    const start=new Date(input.starts_at),end=new Date(input.ends_at)
    const duration=+end-+start
    if (+start<=Date.now() || duration<interval*60000 || duration>180*60000) {
      throw new Fault(422,'INTERVIEW_TIME','将来の日時を指定し、所要時間を30〜180分にしてください。')
    }
    assertSlotHours(await locationFor(db,store),start,end)
    if (input.published) await checkOverlap(db,store,start,end)
    const id=newId()
    await db.query(`INSERT INTO interview_slot(id,tenant_id,store_id,channel_id,starts_at,ends_at,method,instructions,published)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,actor.tenant_id,store,input.channel,start,end,input.method,input.instructions,input.published])
    await audit(db,actor.tenant_id,store,actor.id,'interview.slot.create',id,null,{published:input.published})
    return {id}
  })
}

async function checkOverlap(db:DB,store:string,start:Date,end:Date,exclude?:string) {
  const result=await db.query(`SELECT 1 FROM interview_slot s WHERE s.store_id=$1
    AND s.starts_at<$3 AND s.ends_at>$2 AND s.id IS DISTINCT FROM $4::uuid
    AND (s.published OR EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed'))
    LIMIT 1`,[store,start,end,exclude??null])
  if (result.rowCount) throw new Fault(409,'INTERVIEW_OVERLAP','同じ店舗で公開・予約済みの面談枠と時間が重なっています。')
}

export async function changeInterviewVisibility(db:DB,actor:Actor,store:string,id:string,input:z.infer<typeof interviewVisibility>) {
  await lockDispatch(db,actor.tenant_id)
  const {rows:[slot]}=await db.query<Range>('SELECT * FROM interview_slot WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])
  if (!slot) throw missing()
  if (slot.revision!==input.revision) throw conflict()
  if (input.published) {
    if (+slot.starts_at<=Date.now()) throw taken()
    assertSlotHours(await locationFor(db,store),slot.starts_at,slot.ends_at)
    await checkOverlap(db,store,slot.starts_at,slot.ends_at,id)
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
  const start=requested??location.today
  const date=new Date(start+'T00:00:00Z')
  if (!Number.isFinite(+date) || date.toISOString().slice(0,10)!==start) {
    throw new Fault(422,'INTERVIEW_DATE','有効な日付を指定してください。')
  }
  const max=new Date(Date.parse(location.today+'T00:00:00Z')+90*86400000).toISOString().slice(0,10)
  if (start<location.today || start>max) throw new Fault(422,'INTERVIEW_DATE','本日から90日以内の日付を選択してください。')
  const {rows:slots}=await db.query<Pick<Range,'id'|'starts_at'|'ends_at'|'method'>&{available:boolean}>(`SELECT s.id,s.starts_at,s.ends_at,s.method,s.starts_at>now() AND
    NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed') AS available
    FROM interview_slot s WHERE s.channel_id=$1 AND s.published
      AND s.starts_at >= ($2::date::timestamp AT TIME ZONE $3)
      AND s.starts_at < (($2::date+7)::timestamp AT TIME ZONE $3)
    ORDER BY s.starts_at`,[a.channel_id,start,location.timezone])
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
    for(const slot of candidates) {
      slot.available=!googleUnavailable&&!local.some(block=>overlaps(slot,block))&&!external.some(busy=>overlaps(slot,busy))
    }
  }
  return {store:location.name,timezone:location.timezone,today:location.today,hours:location.hours,
    availability_warning:googleUnavailable,slots:visible,bookings:bookings.map(visibleBooking)}
}

function visibleBooking(booking:Booking) {
  const {instructions,...fields}=booking
  return {...fields,instructions:booking.status==='confirmed'?instructions:null}
}

async function availableSlot(db:DB,a:Applicant,id:string,google:InterviewGoogle) {
  const {rows:[slot]}=await db.query<Range>(`SELECT s.id,s.starts_at,s.ends_at FROM interview_slot s WHERE s.id=$1 AND s.channel_id=$2
    AND s.published AND s.starts_at>clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM interview_booking b WHERE b.slot_id=s.id AND b.status='confirmed')`,[id,a.channel_id])
  if (!slot) throw taken()
  const location=await locationFor(db,a.store_id)
  if (!fitsHours(slot.starts_at,slot.ends_at,location.timezone,location.hours)) throw taken()
  await requireFree(db,google,a.store_id,slot)
  if (+slot.starts_at<=Date.now()) throw taken()
}

export async function confirmInterview(db:DB,a:Applicant,input:z.infer<typeof interviewCreate>,google:InterviewGoogle) {
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
  await audit(db,a.tenant_id,a.store_id,null,'interview.confirm',id,null,{slot:input.slot})
  return visibleBooking(await ownBooking(db,a,id))
}

export async function updateInterview(db:DB,a:Applicant,id:string,input:z.infer<typeof interviewChange>,google:InterviewGoogle) {
  const existing=await ownBooking(db,a,id)
  if (existing.status==='cancelled' && input.action==='cancel') return visibleBooking(existing)
  if (input.action==='reschedule' && existing.status==='confirmed' && existing.slot_id===input.slot) return visibleBooking(existing)
  if (existing.revision!==input.revision || existing.status!=='confirmed' || +existing.starts_at<=Date.now()) throw conflict()
  if (input.action==='reschedule') await availableSlot(db,a,input.slot,google)
  await db.query(`UPDATE interview_booking SET slot_id=$2,status=$3,revision=revision+1,updated_at=now()
    WHERE id=$1`,[id,input.action==='reschedule'?input.slot:existing.slot_id,input.action==='cancel'?'cancelled':'confirmed'])
  await audit(db,a.tenant_id,a.store_id,null,'interview.'+input.action,id,null,
    {previous_slot:existing.slot_id,slot:input.action==='reschedule'?input.slot:existing.slot_id})
  return visibleBooking(await ownBooking(db,a,id))
}
