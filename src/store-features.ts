import { z } from 'zod'
import { audit, conflict, Fault, missing, revision, type Actor, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'

export const featureInput = z.strictObject({
  revision, tags_enabled:z.boolean(), visits_enabled:z.boolean(),
  interviews_enabled:z.boolean(), google_calendar_enabled:z.boolean(),
  forms_enabled:z.boolean().optional(),recruitment_enabled:z.boolean().optional(),sources_enabled:z.boolean().optional(),
  campaigns_enabled:z.boolean().optional(),
  rich_menus_enabled:z.boolean().optional(),reminders_enabled:z.boolean().optional(),waitlist_enabled:z.boolean().optional(),
  inbox_enabled:z.boolean().optional(),
  interviewers_enabled:z.boolean().optional(),google_write_enabled:z.boolean().optional(),
  guest_interviews_enabled:z.boolean().optional(),
  token_interviews_enabled:z.boolean().optional(),
})
type FeatureInput = z.infer<typeof featureInput>
type StoreFeatures = Required<FeatureInput>
type Feature = Exclude<keyof StoreFeatures,'revision'>
const labels:Record<Feature,string> = {
  tags_enabled:'顧客タグ',visits_enabled:'来店予約',interviews_enabled:'面談予約',
  google_calendar_enabled:'Googleカレンダーの照合',
  forms_enabled:'回答フォーム',recruitment_enabled:'応募・選考管理',sources_enabled:'流入分析',
  campaigns_enabled:'絞り込み配信',
  rich_menus_enabled:'リッチメニュー切り替え',reminders_enabled:'面談リマインド',waitlist_enabled:'面談のキャンセル待ち',
  inbox_enabled:'LINE受信箱',
  interviewers_enabled:'担当者別の面談枠',google_write_enabled:'Googleカレンダーへの面談登録',
  guest_interviews_enabled:'ログイン不要の対面面談予約',
  token_interviews_enabled:'LINEトークからの面談予約（LIFFなし）',
}
const columns = 'revision,'+Object.keys(labels).join(',')
const firstFeatures:Feature[]=['tags_enabled','visits_enabled','interviews_enabled','google_calendar_enabled']
const newFeatures=(Object.keys(labels) as Feature[]).filter(key=>!firstFeatures.includes(key))

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

export async function saveStoreFeatures(db:DB,actor:Actor,store:string,input:FeatureInput) {
  await lockDispatch(db,actor.tenant_id)
  const {revision,...features}=input
  const updates=newFeatures.map((key,index)=>key+'=coalesce($'+(index+7)+','+key+')')
  const {rows:[settings]}=await db.query<StoreFeatures>(`UPDATE store SET tags_enabled=$2,visits_enabled=$3,
    tags_enabled_at=CASE WHEN tags_enabled<>$2 THEN clock_timestamp() ELSE tags_enabled_at END,
    visits_enabled_at=CASE WHEN visits_enabled<>$3 THEN clock_timestamp() ELSE visits_enabled_at END,
    interviews_enabled=$4,google_calendar_enabled=$5,${updates.join(',')},revision=revision+1
    WHERE id=$1 AND revision=$6 RETURNING ${columns}`,
  [store,features.tags_enabled,features.visits_enabled,features.interviews_enabled,features.google_calendar_enabled,revision,
    ...newFeatures.map(key=>features[key]??null)])
  if (!settings) throw conflict()
  if (!features.google_calendar_enabled) await db.query('DELETE FROM interview_google_session WHERE store_id=$1',[store])
  if (features.google_write_enabled===false) await db.query('DELETE FROM interview_google_session WHERE store_id=$1 AND write_requested',[store])
  if (features.interviewers_enabled===false) {
    await db.query('UPDATE interview_slot SET published=false,revision=revision+1 WHERE store_id=$1 AND host_id IS NOT NULL AND published',[store])
  }
  if (features.campaigns_enabled===false||!features.tags_enabled) {
    await db.query(`WITH stopped AS (UPDATE campaign SET state='stopped' WHERE store_id=$1 AND state<>'stopped'
      AND ($2 OR jsonb_array_length(criteria->'tags')>0) RETURNING id)
      UPDATE campaign_delivery SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      next_at='infinity',reason='配信またはタグ機能を停止' WHERE campaign_id IN (SELECT id FROM stopped)
      AND status IN ('queued','submitting','unknown')`,[store,features.campaigns_enabled===false])
  }
  if (features.reminders_enabled===false||features.waitlist_enabled===false||features.inbox_enabled===false
    ||features.token_interviews_enabled===false) {
    await db.query(`UPDATE service_delivery SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      next_at='infinity',reason='店舗で機能を停止' WHERE store_id=$1 AND status IN ('queued','submitting','unknown')
      AND (($2 AND kind IN ('interview_confirm','interview_reminder')) OR ($3 AND kind='interview_waitlist') OR ($4 AND kind='chat_reply')
        OR ($5 AND kind='interview_link'))`,
    [store,features.reminders_enabled===false,features.waitlist_enabled===false,features.inbox_enabled===false,
      features.token_interviews_enabled===false])
  }
  await audit(db,actor.tenant_id,store,actor.id,'store.features',store,null,features)
  return settings
}
