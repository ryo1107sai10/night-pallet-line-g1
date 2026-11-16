import { z } from 'zod'
import { audit, conflict, Fault, missing, revision, type Actor, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'

export const featureInput = z.strictObject({
  revision, tags_enabled:z.boolean(), visits_enabled:z.boolean(),
  interviews_enabled:z.boolean(), google_calendar_enabled:z.boolean(),
})
type StoreFeatures = z.infer<typeof featureInput>
type Feature = Exclude<keyof StoreFeatures,'revision'>
const labels:Record<Feature,string> = {
  tags_enabled:'顧客タグ',visits_enabled:'来店予約',interviews_enabled:'面談予約',
  google_calendar_enabled:'Googleカレンダーの照合',
}
const columns = 'revision,tags_enabled,visits_enabled,interviews_enabled,google_calendar_enabled'

export async function storeFeatures(db:DB,store:string) {
  const {rows:[settings]}=await db.query<StoreFeatures>('SELECT '+columns+' FROM store WHERE id=$1',[store])
  if (!settings) throw missing()
  return settings
}

export async function requireFeature(db:DB,store:string,feature:Feature) {
  if (!(await storeFeatures(db,store))[feature]) {
    throw new Fault(409,'STORE_FEATURE_DISABLED',labels[feature]+'はこの店舗で無効です。')
  }
}

export async function saveStoreFeatures(db:DB,actor:Actor,store:string,input:StoreFeatures) {
  await lockDispatch(db,actor.tenant_id)
  const {revision,...features}=input
  const {rows:[settings]}=await db.query<StoreFeatures>(`UPDATE store SET tags_enabled=$2,visits_enabled=$3,
    tags_enabled_at=CASE WHEN tags_enabled<>$2 THEN clock_timestamp() ELSE tags_enabled_at END,
    visits_enabled_at=CASE WHEN visits_enabled<>$3 THEN clock_timestamp() ELSE visits_enabled_at END,
    interviews_enabled=$4,google_calendar_enabled=$5,revision=revision+1
    WHERE id=$1 AND revision=$6 RETURNING ${columns}`,
  [store,features.tags_enabled,features.visits_enabled,features.interviews_enabled,features.google_calendar_enabled,revision])
  if (!settings) throw conflict()
  if (!features.google_calendar_enabled) await db.query('DELETE FROM interview_google_session WHERE store_id=$1',[store])
  await audit(db,actor.tenant_id,store,actor.id,'store.features',store,null,features)
  return settings
}
