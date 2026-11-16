import type { DB } from './core.js'

type Location={id:string;timezone:string;monthly_limit:number}

export async function deliveryScope(db:DB,channel:string){
  const {rows:[state]}=await db.query<{version:string}>(`SELECT concat_ws(':',t.delivery_version,s.delivery_version,c.delivery_version) AS version
    FROM channel c JOIN store s ON s.id=c.store_id JOIN tenant t ON t.id=s.tenant_id WHERE c.id=$1`,[channel])
  return state.version
}

export async function messageBudget(db:DB,location:Location,customer:string|null,
  frequency?:{daily:number;weekly:number},except?:string) {
  const {rows:[counts]}=await db.query<{monthly:number;daily:number;weekly:number}>(`
    WITH relevant AS (
      SELECT id,customer_id,category,coalesce(accepted_at,first_attempt_at) AS at FROM automatic_send
      WHERE store_id=$1 AND status IN ('accepted','submitting','unknown')
      UNION ALL
      SELECT id,customer_id,'marketing',coalesce(accepted_at,first_attempt_at) FROM campaign_delivery
      WHERE store_id=$1 AND status IN ('accepted','submitting','unknown')
      UNION ALL
      SELECT id,NULL::uuid,'service',coalesce(accepted_at,first_attempt_at) FROM service_delivery
      WHERE store_id=$1 AND status IN ('accepted','submitting','unknown')
      UNION ALL
      SELECT id,NULL::uuid,'test',attempted_at FROM test_send
      WHERE store_id=$1 AND status IN ('accepted','submitting','unknown')
    )
    SELECT count(*) FILTER (WHERE at>=date_trunc('month',now() AT TIME ZONE $3) AT TIME ZONE $3)::int AS monthly,
      count(*) FILTER (WHERE customer_id=$2 AND category='marketing'
        AND (at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date)::int AS daily,
      count(*) FILTER (WHERE customer_id=$2 AND category='marketing' AND at>=now()-interval '7 days')::int AS weekly
    FROM relevant WHERE ($4::uuid IS NULL OR id<>$4)`,[location.id,customer,location.timezone,except??null])
  if(counts.monthly>=location.monthly_limit)return '店舗の月次配信上限に達しました'
  if(frequency&&(counts.daily>=frequency.daily||counts.weekly>=frequency.weekly))return '配信頻度の上限に達しました'
  return null
}
