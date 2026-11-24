import { storeList } from './auth.js'
import { forbidden, scope, type Actor, type DB } from './core.js'
import { needsInboxReply } from './inbox.js'
import { deliveryNeedsAttention } from './service-delivery.js'

export async function operationsDashboard(db:DB,actor:Actor) {
  if(!['admin','manager','recruiter'].includes(actor.role))throw forbidden()
  const stores=await storeList(db,actor)
  const result=[]
  const uses=actor.agency||actor.role==='recruiter'?['recruitment']:['recruitment','customer','unclassified']
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
        SELECT d.purpose,count(*)::int AS total FROM service_delivery d JOIN store s ON s.id=d.store_id
        WHERE d.store_id=$1 AND d.purpose=ANY($2) AND d.first_attempt_at>=now()-interval '7 days'
        AND (s.inbox_enabled OR d.purpose='recruitment' AND (s.reminders_enabled OR s.waitlist_enabled))
        AND ${deliveryNeedsAttention} GROUP BY d.purpose
      ) deliveries),'{}') AS failed`,[id,uses,timezone])
    result.push({id,name,timezone,inbox,interviews,failed})
  }
  return result
}
