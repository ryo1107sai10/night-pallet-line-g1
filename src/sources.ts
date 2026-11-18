import { z } from 'zod'
import QRCode from 'qrcode'
import { audit, missing, newId, text, uuid, type Actor, type DB } from './core.js'
import { channel } from './line.js'
import type { WorkflowSubject } from './forms.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature } from './store-features.js'

export const sourceInput=z.strictObject({channel:uuid,label:text(100)})
export const sourceStatus=z.strictObject({active:z.boolean()})
export const sourceReportInput=z.strictObject({days:z.coerce.number().int().min(1).max(365).default(30)})
const sourceLink=(id:string,liffId:string,use:WorkflowSubject['purpose'])=>
  'https://liff.line.me/'+encodeURIComponent(liffId)+'?'+new URLSearchParams({source:id,use})

export async function recordSource(db:DB,identity:WorkflowSubject,source:string|undefined) {
  if(!source)return
  await db.query(`INSERT INTO workflow_attribution (tenant_id,store_id,channel_id,purpose,subject,source_id)
    SELECT w.tenant_id,w.store_id,w.channel_id,w.purpose,$4,w.id FROM workflow_source w
    JOIN store s ON s.id=w.store_id WHERE w.id=$1 AND w.channel_id=$2 AND w.purpose=$3 AND w.active AND s.sources_enabled
    ON CONFLICT(channel_id,purpose,subject) DO NOTHING`,[source,identity.channel_id,identity.purpose,identity.subject])
}

export async function sourceReport(db:DB,store:string,use:WorkflowSubject['purpose'],days:number) {
  await requireFeature(db,store,'sources_enabled')
  // LIFF未設定のチャネルでも流入元を作れる（帰属はトークン発行時の紐づけで記録される）。
  const {rows:channels}=await db.query(`SELECT id,label FROM channel WHERE purpose IN ($1,'shared')
    ORDER BY label,id`,[use])
  const {rows}=await db.query<{id:string;liff_id:string|null}>(`
    SELECT w.id,w.label,w.active,c.label AS channel_label,c.liff_id,
      coalesce(stats.opened,0) AS opened,coalesce(stats.forms,0) AS forms,
      coalesce(stats.booked,0) AS booked,coalesce(stats.interviewed,0) AS interviewed,
      coalesce(stats.trials,0) AS trials,coalesce(stats.hired,0) AS hired
    FROM workflow_source w JOIN channel c ON c.id=w.channel_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS opened,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM workflow_response a WHERE a.channel_id=t.channel_id AND a.purpose=t.purpose AND a.subject=t.subject
          AND a.submitted_at>=t.attributed_at))::int AS forms,
        count(*) FILTER (WHERE CASE WHEN t.purpose='recruitment' THEN EXISTS (
          SELECT 1 FROM interview_booking b WHERE b.channel_id=t.channel_id AND b.applicant_key=t.subject
          AND b.created_at>=t.attributed_at AND b.status IN ('confirmed','completed')
        ) ELSE EXISTS (
          SELECT 1 FROM visit_booking b JOIN customer q ON q.id=b.customer_id WHERE q.channel_id=t.channel_id AND q.id::text=t.subject
          AND b.created_at>=t.attributed_at AND b.status IN ('confirmed','visited')
        ) END)::int AS booked,
        count(*) FILTER (WHERE k.interview_done_at>=t.attributed_at)::int AS interviewed,
        count(*) FILTER (WHERE k.trial_done_at>=t.attributed_at)::int AS trials,
        count(*) FILTER (WHERE k.hired_at>=t.attributed_at)::int AS hired
      FROM workflow_attribution t
      LEFT JOIN recruitment_case k ON t.purpose='recruitment' AND k.channel_id=t.channel_id AND k.applicant_key=t.subject
      WHERE t.source_id=w.id AND t.attributed_at>=now()-make_interval(days=>$2)
    ) stats ON true WHERE w.purpose=$1 ORDER BY w.label,w.id`,[use,days])
  return {channels,entries:rows.map(({liff_id,...row})=>({
    ...row,
    // LIFFがあるチャネルは従来どおり LIFF URL を入口にする。LIFFがないチャネルでは、
    // リッチメニューの postback データにこの文字列を設定し、トークン発行時に紐づける。
    url:liff_id?sourceLink(row.id,liff_id,use):null,
    postback:'action='+(use==='recruitment'?'interview_link':'customer_link')+'&source='+row.id,
  }))}
}

export async function sourceQr(db:DB,store:string,use:WorkflowSubject['purpose'],id:string){
  await requireFeature(db,store,'sources_enabled')
  const {rows:[entry]}=await db.query<{liff_id:string}>(`SELECT c.liff_id FROM workflow_source s JOIN channel c ON c.id=s.channel_id
    WHERE s.id=$1 AND s.purpose=$2 AND c.liff_id IS NOT NULL`,[id,use])
  if(!entry)throw missing()
  return {image:await QRCode.toDataURL(sourceLink(id,entry.liff_id,use),{width:420,errorCorrectionLevel:'M'})}
}

export async function saveSource(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'],data:z.infer<typeof sourceInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'sources_enabled')
  const connection=await channel(db,data.channel)
  if(connection.store_id!==store||!['shared',use].includes(connection.purpose))throw missing()
  const {rows:[entry]}=await db.query(`INSERT INTO workflow_source (id,tenant_id,store_id,channel_id,purpose,label)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[newId(),actor.tenant_id,store,data.channel,use,data.label])
  await audit(db,actor.tenant_id,store,actor.id,'source.create',entry.id,null,{purpose:use})
  return entry
}

export async function setSourceStatus(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'],source:string,active:boolean) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'sources_enabled')
  const result=await db.query('UPDATE workflow_source SET active=$3 WHERE id=$1 AND purpose=$2',[source,use,active])
  if(!result.rowCount)throw missing()
  await audit(db,actor.tenant_id,store,actor.id,'source.status',source,null,{purpose:use,active})
  return {active}
}
