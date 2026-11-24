import type pg from 'pg'
import { z } from 'zod'
import { audit, conflict, missing, newId, revision, scope, text, tx, uuid,
  type Actor, type DB, type Route } from './core.js'
import { calendarID,calendarRecord, type InterviewGoogle } from './interview-availability.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature,storeFeatures } from './store-features.js'

export const hostInput=z.strictObject({id:uuid.optional(),revision:revision.optional(),name:text(80),
  calendar_id:calendarID.nullable(),active:z.boolean()})
type Host={id:string;name:string;calendar_id:string|null;active:boolean;revision:number}

export async function hostsFor(db:DB,store:string){
  await requireFeature(db,store,'interviewers_enabled')
  return (await db.query<Host>(`SELECT id,name,calendar_id,active,revision FROM interview_host WHERE store_id=$1 ORDER BY active DESC,name,id`,[store])).rows
}

export async function saveHost(db:DB,actor:Actor,store:string,data:z.infer<typeof hostInput>){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'interviewers_enabled')
  const id=data.id??newId()
  const result=data.id
    ? await db.query<Host>(`UPDATE interview_host SET name=$2,calendar_id=$3,active=$4,revision=revision+1
      WHERE id=$1 AND revision=$5 RETURNING id,name,calendar_id,active,revision`,[id,data.name,data.calendar_id,data.active,data.revision])
    : await db.query<Host>(`INSERT INTO interview_host (id,tenant_id,store_id,name,calendar_id,active)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,calendar_id,active,revision`,[id,actor.tenant_id,store,data.name,data.calendar_id,data.active])
  const [saved]=result.rows
  if(!saved)throw conflict()
  if(!data.active)await db.query('UPDATE interview_slot SET published=false,revision=revision+1 WHERE host_id=$1 AND published',[id])
  if(data.id){
    const {rows}=await db.query<{id:string}>(`SELECT b.id FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
      WHERE s.host_id=$1 AND b.status='confirmed' AND s.starts_at>now()`,[id])
    for(const booking of rows)await queueGoogleSync(db,store,booking.id)
  }
  await audit(db,actor.tenant_id,store,actor.id,'interview.host.save',id,null,{active:data.active})
  return saved
}

export async function requireHost(db:DB,store:string,id:string){
  await requireFeature(db,store,'interviewers_enabled')
  const {rows:[host]}=await db.query<{calendar_id:string|null}>(
    'SELECT calendar_id FROM interview_host WHERE store_id=$1 AND id=$2 AND active',[store,id])
  if(!host)throw missing()
  return host
}

export async function queueGoogleSync(db:DB,store:string,booking?:string){
  const flags=await storeFeatures(db,store)
  if(!flags.google_calendar_enabled||!flags.google_write_enabled){
    if(booking)await db.query(`UPDATE interview_google_sync SET status='queued',next_at=now(),attempts=0 WHERE booking_id=$1`,[booking])
    return
  }
  await db.query(`INSERT INTO interview_google_sync (booking_id,tenant_id,store_id,channel_id,revision)
    SELECT b.id,b.tenant_id,b.store_id,b.channel_id,b.revision FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
    WHERE b.store_id=$1 AND ($2::uuid IS NOT NULL AND b.id=$2 OR $2::uuid IS NULL AND
      (b.status='confirmed' AND s.starts_at>now() OR EXISTS (SELECT 1 FROM interview_google_sync old WHERE old.booking_id=b.id AND old.status<>'synced')))
    ON CONFLICT(booking_id) DO UPDATE SET revision=excluded.revision,status='queued',attempts=0,next_at=now(),last_error=NULL`,
  [store,booking??null])
}

type Job={booking_id:string;calendars:string[];revision:number;attempts:number;status:string;
  booking_revision:number;booking_status:string;starts_at:Date;ends_at:Date;calendar_id:string|null}
const entry=`SELECT g.*,b.revision AS booking_revision,b.status AS booking_status,s.starts_at,s.ends_at,h.calendar_id
  FROM interview_google_sync g JOIN interview_booking b ON b.id=g.booking_id JOIN interview_slot s ON s.id=b.slot_id
  LEFT JOIN interview_host h ON h.id=s.host_id`
export async function runGoogleSync(pool:pg.Pool,google:InterviewGoogle,r:Route){
  if(!google.configured)return
  const locked=<T>(work:(db:DB)=>Promise<T>)=>tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    return work(db)
  })
  const claim=await locked(async db=>{
    const flags=await storeFeatures(db,r.store_id)
    if(!flags.google_calendar_enabled||!flags.google_write_enabled)return
    const credential=await calendarRecord(db,r.store_id)
    if(!credential?.write_granted)return
    const {rows:[job]}=await db.query<Job>(entry+` WHERE g.channel_id=$1 AND g.status='queued' AND g.next_at<=now()
      ORDER BY g.next_at,g.booking_id LIMIT 1 FOR UPDATE OF g`,[r.id])
    if(!job)return
    if(job.attempts>=5){
      await db.query("UPDATE interview_google_sync SET status='failed',last_error='Googleで予定の反映を確認できませんでした' WHERE booking_id=$1",[job.booking_id])
      return
    }
    const target=job.booking_status==='confirmed'&&+job.starts_at>Date.now()?job.calendar_id??credential.calendar_id:null
    const calendars=[...new Set([...job.calendars,...(target?[target]:[])])]
    await db.query(`UPDATE interview_google_sync SET revision=$2,calendars=$3,attempts=attempts+1,
      next_at=now()+interval '1 minute' WHERE booking_id=$1`,[job.booking_id,job.booking_revision,calendars])
    return {job,calendars,target,connection:credential.refresh_box,attempt:job.attempts+1}
  })
  if(!claim)return
  const {job,calendars,target}=claim
  await locked(async db=>{
    const {rows:[fresh]}=await db.query<Job>(entry+' WHERE g.booking_id=$1',[job.booking_id])
    const flags=await storeFeatures(db,r.store_id)
    const credential=await calendarRecord(db,r.store_id)
    if(!fresh||fresh.status!=='queued'||fresh.attempts!==claim.attempt||fresh.booking_revision!==job.booking_revision||
      !flags.google_calendar_enabled||!flags.google_write_enabled||!credential?.write_granted||credential.refresh_box!==claim.connection)return
    const id='night'+job.booking_id.replaceAll('-','')
    try{
      if(fresh.booking_status==='completed'||fresh.booking_status==='confirmed'&&+fresh.starts_at<=Date.now()){
        await db.query("UPDATE interview_google_sync SET status='synced',last_error=NULL WHERE booking_id=$1",[job.booking_id])
        return
      }
      for(const previous of calendars){
        if(previous!==target)await google.updateEvent(credential,previous,id,null)
      }
      if(target)await google.updateEvent(credential,target,id,fresh)
      await db.query("UPDATE interview_google_sync SET status='synced',calendars=$2,last_error=NULL WHERE booking_id=$1",
        [job.booking_id,target?[target]:[]])
    }catch{
      await db.query(`UPDATE interview_google_sync SET last_error='Googleの共有権限と連携を確認してください',
        status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END WHERE booking_id=$1`,[job.booking_id])
    }
  })
}
