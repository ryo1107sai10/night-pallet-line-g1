import { newId, type DB } from './core.js'
export type ApplicantIdentity={tenant_id:string;store_id:string;channel_id:string;applicant_key:string}
export async function emitApplicantEvent(db:DB,identity:ApplicantIdentity,key:string,kind:string,time=new Date(),
  booking?:{id:string;revision:number},extra?:{tagKey?:string;campaignId?:string}) {
  const result=await db.query(`INSERT INTO applicant_event
    (id,tenant_id,store_id,channel_id,applicant_key,origin_key,kind,booking_id,booking_revision,happened_at,scope_version,tag_key,campaign_id)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,concat_ws(':',t.delivery_version,s.delivery_version,c.delivery_version),$11,$12
      FROM tenant t JOIN store s ON s.tenant_id=t.id JOIN channel c ON c.store_id=s.id
      WHERE t.id=$2 AND s.id=$3 AND c.id=$4 AND NOT (t.stopped OR s.stopped OR c.stopped)
    ON CONFLICT(channel_id,origin_key) DO NOTHING`,
    [newId(),identity.tenant_id,identity.store_id,identity.channel_id,identity.applicant_key,key,kind,
     booking?.id??null,booking?.revision??null,time,extra?.tagKey??null,extra?.campaignId??null])
  return !!result.rowCount
}
