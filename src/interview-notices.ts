import { z } from 'zod'
import { localInstant, localPart } from '../public/studio/engine.mjs'
import { audit, Fault, type Config, type DB } from './core.js'
import type { WorkflowSubject } from './forms.js'
import { interruptService, queueService } from './service-delivery.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'

const allNotices=['interview_confirm','interview_reminder','interview_waitlist'] as const
export const noticeInput=z.strictObject({enabled:z.boolean()})
export const waitlistInput=z.strictObject({method:z.enum(['onsite','online']),days:z.int().min(1).max(30)})
const day=86400000

export async function interviewNotices(db:DB,identity:WorkflowSubject){
  const flags=await storeFeatures(db,identity.store_id)
  const {rows:[contact]}=await db.query<{notices:boolean}>(`SELECT notices FROM workflow_contact WHERE channel_id=$1
    AND purpose='recruitment' AND subject=$2`,[identity.channel_id,identity.subject])
  const {rows:[waitlist]}=await db.query(`SELECT method,until_at,offered_at FROM interview_waitlist
    WHERE channel_id=$1 AND applicant_key=$2 AND until_at>now()`,[identity.channel_id,identity.subject])
  return {reminders:flags.reminders_enabled,waitlist_enabled:flags.waitlist_enabled,
    notices:contact?.notices??false,waitlist:waitlist??null}
}

export async function setInterviewNotices(db:DB,cfg:Config,identity:WorkflowSubject,enabled:boolean){
  await lockDispatch(db,identity.tenant_id)
  const flags=await storeFeatures(db,identity.store_id)
  if(enabled&&!flags.reminders_enabled&&!flags.waitlist_enabled)await requireFeature(db,identity.store_id,'reminders_enabled')
  const result=await db.query(`UPDATE workflow_contact SET notices=$3,notices_changed_at=clock_timestamp()
    WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2`,
    [identity.channel_id,identity.subject,enabled])
  if(!result.rowCount&&enabled)throw new Fault(409,'REOPEN_LIFF','面談画面を開き直してLINEの本人確認を行ってください。')
  if(!enabled){
    await interruptService(db,'subject',identity.subject,'応募者が通知を停止',[...allNotices])
    await db.query('DELETE FROM interview_waitlist WHERE channel_id=$1 AND applicant_key=$2',[identity.channel_id,identity.subject])
  }else await scheduleInterviewNotices(db,cfg,identity)
  await audit(db,identity.tenant_id,identity.store_id,null,'interview.notification_preferences',identity.channel_id,null,{enabled})
  return interviewNotices(db,identity)
}

export async function scheduleInterviewNotices(db:DB,cfg:Config,identity:WorkflowSubject){
  const flags=await storeFeatures(db,identity.store_id)
  if(!flags.reminders_enabled)return
  const {rows:[booking]}=await db.query<{id:string;revision:number;starts_at:Date;timezone:string}>(`
    SELECT b.id,b.revision,s.starts_at,t.timezone FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
    JOIN store t ON t.id=b.store_id JOIN workflow_contact c ON c.channel_id=b.channel_id AND c.purpose='recruitment'
      AND c.subject=b.applicant_key AND c.notices
    WHERE b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed' AND s.starts_at>now()`,[identity.channel_id,identity.subject])
  if(!booking)return
  const input={object:booking.id,revision:booking.revision,expiry:booking.starts_at}
  await queueService(db,cfg,identity,{...input,kind:'interview_confirm',due:new Date()})
  const civilDate=localPart(+booking.starts_at,booking.timezone).date
  const eve=new Date(Date.parse(civilDate+'T00:00:00Z')-day).toISOString().slice(0,10)
  const due=localInstant(eve+'T18:00',booking.timezone)
  if(due!==null&&due>Date.now()+15*60000)await queueService(db,cfg,identity,{...input,kind:'interview_reminder',due:new Date(due)})
}

export async function setWaitlist(db:DB,identity:WorkflowSubject,data:z.infer<typeof waitlistInput>|null){
  await lockDispatch(db,identity.tenant_id)
  await interruptService(db,'subject',identity.subject,'応募者がキャンセル待ちを更新',['interview_waitlist'])
  if(!data){
    await db.query('DELETE FROM interview_waitlist WHERE channel_id=$1 AND applicant_key=$2',[identity.channel_id,identity.subject])
    return interviewNotices(db,identity)
  }
  await requireFeature(db,identity.store_id,'waitlist_enabled')
  await requireFeature(db,identity.store_id,'interviews_enabled')
  const state=await interviewNotices(db,identity)
  if(!state.notices)throw new Fault(409,'NOTICE_REQUIRED','LINEで面談の通知を受け取る設定を先に有効にしてください。')
  const confirmed=await db.query(`SELECT 1 FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
    WHERE b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed' AND s.starts_at>now()`,
  [identity.channel_id,identity.subject])
  if(confirmed.rowCount)throw new Fault(409,'WAITLIST_BOOKED','確定済みの面談があります。')
  await db.query(`INSERT INTO interview_waitlist (tenant_id,store_id,channel_id,applicant_key,method,until_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(channel_id,applicant_key) DO UPDATE
      SET method=excluded.method,until_at=excluded.until_at,created_at=now(),offered_at=NULL`,
  [identity.tenant_id,identity.store_id,identity.channel_id,identity.subject,data.method,new Date(Date.now()+data.days*day)])
  return interviewNotices(db,identity)
}

export async function onInterviewReleased(db:DB,cfg:Config,identity:WorkflowSubject,booking:{id:string;revision:number;slot_id:string}){
  await interruptService(db,'object_id',booking.id,'面談が変更または取消されました',[...allNotices])
  const features=await storeFeatures(db,identity.store_id)
  if(!features.waitlist_enabled||!features.interviews_enabled)return
  const {rows:[entry]}=await db.query<{applicant_key:string;starts_at:Date}>(`
    SELECT w.applicant_key,s.starts_at FROM interview_waitlist w JOIN interview_slot s ON s.channel_id=w.channel_id AND s.id=$2
    JOIN workflow_contact c ON c.channel_id=w.channel_id AND c.purpose='recruitment' AND c.subject=w.applicant_key AND c.notices
    WHERE w.channel_id=$1 AND w.applicant_key<>$3 AND w.offered_at IS NULL AND w.until_at>=s.starts_at AND w.method=s.method
      AND s.published AND s.starts_at>now() AND NOT EXISTS (
        SELECT 1 FROM interview_booking b JOIN interview_slot f ON f.id=b.slot_id
          WHERE b.channel_id=w.channel_id AND b.applicant_key=w.applicant_key AND b.status='confirmed' AND f.starts_at>now())
    ORDER BY w.created_at,w.applicant_key LIMIT 1`,[identity.channel_id,booking.slot_id,identity.subject])
  if(!entry)return
  const id=await queueService(db,cfg,{...identity,subject:entry.applicant_key},{
    kind:'interview_waitlist',object:booking.id,revision:booking.revision,due:new Date(),expiry:entry.starts_at,body:booking.slot_id,
  })
  if(id)await db.query('UPDATE interview_waitlist SET offered_at=now() WHERE channel_id=$1 AND applicant_key=$2',
    [identity.channel_id,entry.applicant_key])
}
