import { storeList } from './auth.js'
import { forbidden, scope, type Actor, type DB } from './core.js'
import { needsInboxReply } from './inbox.js'
import { deliveryNeedsAttention } from './service-delivery.js'

export async function operationsDashboard(db:DB,actor:Actor) {
  if(!['admin','manager','recruiter'].includes(actor.role))throw forbidden()
  const stores=await storeList(db,actor)
  const result=[]
  const uses=actor.role==='recruiter'?['recruitment']:actor.agency?['recruitment','unclassified']:['recruitment','customer','unclassified']
  for(const {id,name,timezone} of stores){
    await scope(db,actor.tenant_id,id)
    const {rows:[{inbox,interviews,failed}]}=await db.query(`
      SELECT coalesce((SELECT jsonb_object_agg(purpose,total) FROM (
        SELECT t.purpose,count(*)::int AS total FROM inbox_thread t JOIN store s ON s.id=t.store_id
        WHERE t.store_id=$1 AND t.purpose=ANY($2) AND s.inbox_enabled AND ${needsInboxReply}
        GROUP BY t.purpose
      ) messages),'{}') AS inbox,
      coalesce((SELECT jsonb_agg(item ORDER BY starts_at) FROM (
        SELECT f.id,f.starts_at,f.ends_at FROM interview_slot f
        JOIN interview_booking b ON b.slot_id=f.id AND b.status='confirmed'
        WHERE f.store_id=$1 AND f.starts_at>=date_trunc('day',now() AT TIME ZONE $3) AT TIME ZONE $3
          AND f.starts_at<(date_trunc('day',now() AT TIME ZONE $3)+interval '1 day') AT TIME ZONE $3
        ORDER BY f.starts_at,f.id
      ) item),'[]') AS interviews,
      coalesce((SELECT jsonb_object_agg(purpose,total) FROM (
        SELECT purpose,count(*)::int AS total FROM (
          SELECT d.purpose FROM service_delivery d WHERE d.store_id=$1
            AND d.first_attempt_at>=now()-interval '7 days' AND ${deliveryNeedsAttention}
          UNION ALL SELECT 'customer' FROM automatic_send WHERE store_id=$1
            AND first_attempt_at>=now()-interval '7 days' AND status IN ('failed','unknown')
          UNION ALL SELECT 'recruitment' FROM applicant_send WHERE store_id=$1
            AND first_attempt_at>=now()-interval '7 days' AND status IN ('failed','unknown')
          UNION ALL SELECT 'customer' FROM campaign_delivery WHERE store_id=$1
            AND first_attempt_at>=now()-interval '7 days' AND status IN ('failed','unknown')
        ) events WHERE purpose=ANY($2) GROUP BY purpose
      ) deliveries),'{}') AS failed`,[id,uses,timezone])
    result.push({id,name,timezone,inbox,interviews,failed})
  }
  return result
}
