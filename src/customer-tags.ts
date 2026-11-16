import { z } from 'zod'
import { audit, conflict, missing, revision, text, type Actor, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature } from './store-features.js'

const tagName=text(80)
export const tagRuleInput=z.strictObject({
  name:tagName,trigger:z.enum(['follow','booking_created','visit']).nullable(),
})
export const tagFilter=z.strictObject({
  tag:z.union([tagName,z.array(tagName).min(1).max(30)]).optional(),
  match:z.enum(['all','any']).default('all'),
})
export const customerTagInput=z.strictObject({revision,tags:z.array(tagName).max(30)})
export const tagSegmentInput=z.strictObject({
  name:tagName,tags:z.array(tagName).min(1).max(30),match:tagFilter.shape.match,
})
export const tagSegmentDelete=tagSegmentInput.pick({name:true})

export async function listTags(db:DB) {
  const {rows}=await db.query(`SELECT known.name,r.trigger FROM (
    SELECT name FROM customer_tag_rule
    UNION SELECT unnest(tags) AS name FROM customer
  ) known LEFT JOIN customer_tag_rule r ON r.name=known.name ORDER BY known.name`)
  return rows
}

export async function saveTagRule(db:DB,actor:Actor,store:string,input:z.infer<typeof tagRuleInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'tags_enabled')
  await db.query(`INSERT INTO customer_tag_rule (tenant_id,store_id,name,trigger) VALUES ($1,$2,$3,$4)
    ON CONFLICT (tenant_id,store_id,name) DO UPDATE SET trigger=excluded.trigger,effective_at=excluded.effective_at
    WHERE customer_tag_rule.trigger IS DISTINCT FROM excluded.trigger`,
  [actor.tenant_id,store,input.name,input.trigger])
  await audit(db,actor.tenant_id,store,actor.id,'customer.tag.rule',store,null,input)
  return input
}

export async function applyTagRules(db:DB,customer:string,store:string,trigger:string,time:Date) {
  await db.query(`UPDATE customer c SET tags=c.tags||ARRAY(
      SELECT r.name FROM customer_tag_rule r WHERE r.trigger=$3 AND r.effective_at<=$4 AND NOT r.name=ANY(c.tags)
      ORDER BY r.name LIMIT greatest(0,30-cardinality(c.tags))
    ),revision=revision+1,updated_at=now()
    WHERE c.id=$1 AND EXISTS (SELECT 1 FROM store WHERE id=$2 AND tags_enabled
      AND (tags_enabled_at IS NULL OR $4>=tags_enabled_at))
      AND cardinality(c.tags)<30 AND EXISTS (
        SELECT 1 FROM customer_tag_rule r WHERE r.trigger=$3 AND r.effective_at<=$4 AND NOT r.name=ANY(c.tags)
      )`,[customer,store,trigger,time])
}

export async function saveCustomerTags(db:DB,actor:Actor,store:string,customer:string,input:z.infer<typeof customerTagInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'tags_enabled')
  const current=await db.query('SELECT id FROM customer WHERE store_id=$1 AND id=$2',[store,customer])
  if (!current.rowCount) throw missing()
  const tags=[...new Set(input.tags)]
  const {rows:[result]}=await db.query(`UPDATE customer SET tags=$2,revision=revision+1,updated_at=now()
    WHERE id=$1 AND revision=$3 RETURNING id,tags,revision`,[customer,tags,input.revision])
  if (!result) throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'customer.tags',customer)
  return result
}

export async function listTagSegments(db:DB) {
  return (await db.query('SELECT name,tags,match_mode AS match FROM customer_tag_filter ORDER BY name')).rows
}

export async function saveTagSegment(db:DB,actor:Actor,store:string,input:z.infer<typeof tagSegmentInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'tags_enabled')
  const tags=[...new Set(input.tags)]
  await db.query(`INSERT INTO customer_tag_filter (tenant_id,store_id,name,tags,match_mode) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id,store_id,name) DO UPDATE SET tags=excluded.tags,match_mode=excluded.match_mode`,
  [actor.tenant_id,store,input.name,tags,input.match])
  await audit(db,actor.tenant_id,store,actor.id,'customer.tag_filter.save',store,null,{name:input.name})
  return {name:input.name,tags,match:input.match}
}

export async function removeTagSegment(db:DB,actor:Actor,store:string,name:string) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'tags_enabled')
  const result=await db.query('DELETE FROM customer_tag_filter WHERE store_id=$1 AND name=$2',[store,name])
  if (!result.rowCount) throw missing()
  await audit(db,actor.tenant_id,store,actor.id,'customer.tag_filter.remove',store,null,{name})
  return {removed:true}
}
