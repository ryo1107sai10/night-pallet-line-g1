import { z } from 'zod'
import { audit, automationForStore, conflict, digest, Fault, missing, newId, once, revision, text, unseal, uuid, type Actor, type Config, type DB } from './core.js'
import { lockDispatch } from './dispatch-lock.js'
import { emitApplicantEvent, type ApplicantIdentity } from './applicant-events.js'
import { channel, channelReady } from './line.js'
import type { Graph } from './scenario.js'
import { deliveryScope } from './delivery-budget.js'

export const tagEvents={follow:'友だち追加',form:'応募フォーム送信',form_unbooked:'応募フォーム送信（未予約）',
  interview_booked:'面談予約確定・変更',interview_cancelled:'面談キャンセル',stage_interviewed:'面談完了',
  stage_trial_scheduled:'体験入店予定',stage_trial_done:'体験入店済',stage_hired:'採用・入店',
  stage_withdrawn:'辞退・終了',handoff_started:'店長へ引き継ぎ',handoff_ended:'店長対応終了'} as const
const eventSchema=z.enum(Object.keys(tagEvents) as [keyof typeof tagEvents,...(keyof typeof tagEvents)[]])
type TagEvent=z.infer<typeof eventSchema>
const categories=['応募','面談','採用','対応','流入','経験','その他'] as const
const tagKey=text(80)
const keys=z.array(tagKey).max(50).refine(a=>new Set(a).size===a.length)
const rules=z.array(eventSchema).max(20).refine(a=>new Set(a).size===a.length)
export const tagDefinitionInput=z.strictObject({key:tagKey.optional(),revision:z.int().nonnegative(),label:text(60),category:z.enum(categories),
  add_events:rules,remove_events:rules,active:z.boolean()}).refine(d=>!!d.key===(d.revision>0)&&!d.add_events.some(e=>d.remove_events.includes(e)))
export const subjectTagsInput=z.strictObject({revision,tags:keys})
export const tagSettingsInput=z.strictObject({revision,enabled:z.boolean()})
const filters=z.strictObject({include:keys,match:z.enum(['all','any']),exclude:keys}).refine(d=>!d.include.some(k=>d.exclude.includes(k)))
type Filters=z.infer<typeof filters>
export const tagListQuery=z.strictObject({include:z.string().max(5000).optional(),exclude:z.string().max(5000).optional(),match:z.enum(['all','any']).default('all'),page:z.coerce.number().int().min(1).max(10000).default(1)})
export const tagCampaignInput=z.strictObject({scenario:uuid,criteria:filters})
export const tagCampaignConfirm=z.strictObject({scenario:uuid,criteria:filters,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)})
// The immutable key is saved in scenarios and assignments; changing a label never breaks a published graph.
type Definition={tag_key:string;label:string;category:typeof categories[number];add_events:TagEvent[];remove_events:TagEvent[];active:boolean;revision:number}
const defaults:[string,string,typeof categories[number],TagEvent[],TagEvent[]][]=[
 ['new_friend','新規友だち','応募',['follow'],['form','interview_booked']],
 ['new_application','新規応募','応募',['form'],['stage_interviewed','stage_withdrawn']],
 ['unanswered','未回答','応募',['follow'],['form']],['in_progress','対応中','応募',[],[]],
 ['interview_pending','面談未予約','面談',['form_unbooked','interview_cancelled'],['interview_booked','stage_interviewed','stage_withdrawn']],
 ['interview_booked','面談予約済','面談',['interview_booked'],['interview_cancelled','stage_interviewed','stage_withdrawn']],
 ['interview_done','面談完了','面談',['stage_interviewed'],[]],['interview_cancelled','キャンセル','面談',['interview_cancelled'],['interview_booked']],
 ['trial_scheduled','体験入店予定','採用',['stage_trial_scheduled'],['stage_trial_done','stage_hired','stage_interviewed','stage_withdrawn']],
 ['trial_done','体験入店済','採用',['stage_trial_done'],[]],['hired','採用','採用',['stage_hired'],[]],['joined','入店済','採用',[],[]],
 ['withdrawn','辞退・終了','採用',['stage_withdrawn'],[]],['waiting_reply','返信待ち','対応',[],[]],
 ['handoff','店長対応中','対応',['handoff_started'],['handoff_ended']],['follow_up','再連絡予定','対応',[],[]],
 ['job_site','求人サイト','流入',[],[]],['instagram','Instagram','流入',[],[]],['x','X','流入',[],[]],['referral','紹介','流入',[],[]],
 ['beginner','未経験','経験',[],[]],['experienced','経験者','経験',[],[]],
]

export async function tagState(db:DB,store:string){
  const {rows:[s]}=await db.query<{revision:number;recruitment_enabled:boolean;recruitment_tags_enabled:boolean;recruitment_tags_enabled_at:Date|null}>(
    'SELECT revision,recruitment_enabled,recruitment_tags_enabled,recruitment_tags_enabled_at FROM store WHERE id=$1',[store])
  if(!s)throw missing()
  return s
}
async function requireTags(db:DB,store:string){
  const state=await tagState(db,store)
  if(!state.recruitment_enabled||!state.recruitment_tags_enabled)throw new Fault(409,'RECRUITMENT_TAGS_DISABLED','この店舗の採用タグ機能を有効にしてください。')
  return state
}
export async function seedApplicantTags(db:DB,tenant:string,store:string){
  if((await db.query("SELECT 1 FROM applicant_tag WHERE store_id=$1 AND tag_key='new_friend'",[store])).rowCount)return
  await db.query(`INSERT INTO applicant_tag(tenant_id,store_id,tag_key,label,category,add_events,remove_events)
    SELECT $1,$2,t.key,t.label,t.category,ARRAY(SELECT jsonb_array_elements_text(t.add)),ARRAY(SELECT jsonb_array_elements_text(t.remove))
    FROM jsonb_to_recordset($3::jsonb) t(key text,label text,category text,add jsonb,remove jsonb)
    ON CONFLICT(store_id,tag_key) DO NOTHING`,[tenant,store,JSON.stringify(defaults.map(([key,label,category,add,remove])=>({key,label,category,add,remove})))])
  await backfillExistingTags(db,store)
}
async function definitions(db:DB,store:string){
  return (await db.query<Definition>('SELECT tag_key,label,category,add_events,remove_events,active,revision FROM applicant_tag WHERE store_id=$1 ORDER BY category,label,tag_key',[store])).rows
}
export async function applicantTagCatalog(db:DB,actor:Actor,store:string){
  await lockDispatch(db,actor.tenant_id)
  const state=await tagState(db,store)
  if(state.recruitment_enabled&&state.recruitment_tags_enabled)await seedApplicantTags(db,actor.tenant_id,store)
  return {enabled:state.recruitment_enabled&&state.recruitment_tags_enabled,definitions:await definitions(db,store),events:tagEvents,categories,revision:state.revision}
}
export async function saveApplicantTagSettings(db:DB,actor:Actor,store:string,data:z.infer<typeof tagSettingsInput>){
  await lockDispatch(db,actor.tenant_id)
  const state=await tagState(db,store)
  if(!state.recruitment_enabled)throw new Fault(409,'RECRUITMENT_DISABLED','先に応募・選考管理を有効にしてください。')
  if(state.revision!==data.revision)throw conflict()
  await db.query(`UPDATE store SET recruitment_tags_enabled=$2,recruitment_tags_enabled_at=CASE WHEN recruitment_tags_enabled<>$2 THEN clock_timestamp() ELSE recruitment_tags_enabled_at END,revision=revision+1 WHERE id=$1`,[store,data.enabled])
  await audit(db,actor.tenant_id,store,actor.id,'recruitment.tags.settings',store,null,{enabled:data.enabled})
  return {enabled:data.enabled}
}
export async function saveApplicantTag(db:DB,actor:Actor,store:string,data:z.infer<typeof tagDefinitionInput>){
  await lockDispatch(db,actor.tenant_id);await requireTags(db,store);await seedApplicantTags(db,actor.tenant_id,store)
  const key=data.key??newId()
  if(data.active&&(await db.query('SELECT 1 FROM applicant_tag WHERE store_id=$1 AND active AND lower(label)=lower($2) AND tag_key<>$3',[store,data.label,key])).rowCount)
    throw new Fault(409,'TAG_NAME_EXISTS','同じ名前のタグがあります。')
  const result=data.key?await db.query(`UPDATE applicant_tag SET label=$3,category=$4,add_events=$5,remove_events=$6,active=$7,revision=revision+1
    WHERE store_id=$1 AND tag_key=$2 AND revision=$8 RETURNING tag_key,revision`,[store,key,data.label,data.category,data.add_events,data.remove_events,data.active,data.revision]):
    await db.query(`INSERT INTO applicant_tag(tenant_id,store_id,tag_key,label,category,add_events,remove_events,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING tag_key,revision`,[actor.tenant_id,store,key,data.label,data.category,data.add_events,data.remove_events,data.active])
  if(!result.rowCount)throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'recruitment.tag.definition',store,null,{key,active:data.active})
  return result.rows[0]
}

type Subject=ApplicantIdentity & {id:string;revision:number}
async function ensureSubject(db:DB,identity:ApplicantIdentity){
  await db.query(`INSERT INTO applicant_tag_subject(id,tenant_id,store_id,channel_id,applicant_key) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(channel_id,applicant_key) DO NOTHING`,[newId(),identity.tenant_id,identity.store_id,identity.channel_id,identity.applicant_key])
  const {rows:[subject]}=await db.query<Subject>('SELECT * FROM applicant_tag_subject WHERE channel_id=$1 AND applicant_key=$2',[identity.channel_id,identity.applicant_key])
  if(!subject)throw missing()
  return subject
}
const activeTagSelect=`SELECT a.tag_key FROM applicant_tag_assignment a JOIN applicant_tag t USING(tenant_id,store_id,tag_key)
  WHERE a.subject_id=$1 AND a.active AND t.active AND (a.expires_at IS NULL OR a.expires_at>now())`
async function activeTags(db:DB,subjectId:string):Promise<string[]>{return (await db.query<{tag_key:string}>(activeTagSelect,[subjectId])).rows.map(r=>r.tag_key)}
export async function applicantTags(db:DB,identity:Pick<ApplicantIdentity,'channel_id'|'applicant_key'>):Promise<string[]>{
  const {rows:[s]}=await db.query<{id:string}>('SELECT id FROM applicant_tag_subject WHERE channel_id=$1 AND applicant_key=$2',[identity.channel_id,identity.applicant_key])
  return s?activeTags(db,s.id):[]
}
async function setAssignment(db:DB,subject:Subject,key:string,add:boolean,at:Date,expires:Date|null,emit:boolean){
  const {rows:[old]}=await db.query<{active:boolean;changed_at:Date;expires_at:Date|null}>('SELECT active,changed_at,expires_at FROM applicant_tag_assignment WHERE subject_id=$1 AND tag_key=$2',[subject.id,key])
  if(old&&+old.changed_at>+at)return false
  const wasActive=!!old?.active&&(!old.expires_at||+old.expires_at>Date.now())
  // Removal leaves a timestamped tombstone, so a late older event cannot reapply the tag.
  await db.query(`INSERT INTO applicant_tag_assignment(tenant_id,store_id,subject_id,tag_key,active,changed_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(subject_id,tag_key) DO UPDATE SET active=excluded.active,changed_at=excluded.changed_at,expires_at=excluded.expires_at`,
    [subject.tenant_id,subject.store_id,subject.id,key,add,at,add?expires:null])
  if(wasActive!==add||+(old?.expires_at??0)!==+(expires??0))await db.query('UPDATE applicant_tag_subject SET revision=revision+1,updated_at=now() WHERE id=$1',[subject.id])
  if(emit&&add&&!wasActive&&(!expires||+expires>Date.now())&&(await db.query(`SELECT 1 FROM workflow_contact WHERE channel_id=$1 AND purpose='recruitment' AND subject=$2 AND notices AND notices_changed_at<=$3`,[subject.channel_id,subject.applicant_key,at])).rowCount)return emitApplicantEvent(db,subject,'tag:'+newId(),'tag_added',at,undefined,{tagKey:key})
  return false
}
export async function applyApplicantTagRules(db:DB,identity:ApplicantIdentity,event:TagEvent,at=new Date(),expires:Date|null=null){
  const state=await tagState(db,identity.store_id)
  if(!state.recruitment_enabled||!state.recruitment_tags_enabled||state.recruitment_tags_enabled_at&&+at<+state.recruitment_tags_enabled_at)return false
  await seedApplicantTags(db,identity.tenant_id,identity.store_id)
  const subject=await ensureSubject(db,identity)
  const isApplicant=event==='follow'&&(await db.query('SELECT 1 FROM recruitment_case WHERE channel_id=$1 AND applicant_key=$2',[identity.channel_id,identity.applicant_key])).rowCount
  const {rows}=await db.query<Definition>(`SELECT * FROM applicant_tag WHERE store_id=$1 AND active AND ($2=ANY(add_events) OR $2=ANY(remove_events)) ORDER BY tag_key`,[identity.store_id,event])
  let queued=false
  for(const rule of rows){if(isApplicant&&['new_friend','unanswered'].includes(rule.tag_key))continue;if(await setAssignment(db,subject,rule.tag_key,rule.add_events.includes(event),at,event==='handoff_started'?expires:null,true))queued=true}
  return queued
}
export async function applyHandoffTags(db:DB,store:string,channelId:string,userKey:string,until:Date|null){
  const {rows}=await db.query<ApplicantIdentity>(`SELECT tenant_id,store_id,channel_id,subject AS applicant_key FROM workflow_contact
    WHERE store_id=$1 AND channel_id=$2 AND user_key=$3 AND purpose='recruitment'`,[store,channelId,userKey])
  let queued=false
  for(const identity of rows)if(await applyApplicantTagRules(db,identity,until?'handoff_started':'handoff_ended',new Date(),until))queued=true
  return queued
}
export async function setScenarioTag(db:DB,identity:ApplicantIdentity,reference:string,add:boolean){
  await requireTags(db,identity.store_id)
  const key=await resolveTag(db,identity.store_id,reference)
  if(!key)return false
  const subject=await ensureSubject(db,identity)
  await setAssignment(db,subject,key,add,new Date(),null,true)
  return true
}
export async function resolveTag(db:DB,store:string,value:string){
  const {rows:[entry]}=await db.query<{tag_key:string}>(`SELECT tag_key FROM applicant_tag WHERE store_id=$1 AND active AND (tag_key=$2 OR label=$2) ORDER BY (tag_key=$2) DESC LIMIT 1`,[store,value])
  return entry?.tag_key??null
}
export function graphUsesApplicantTags(graph:Graph){return ['tag_added','tag_campaign'].includes(graph.trigger)||graph.nodes.some(n=>n.type==='tag'||n.type==='branch'&&n.condition==='tag'||n.type==='message'&&!!n.tagGuard)}
function applicantGraphTagRefs(graph:Graph){return [...(graph.trigger==='tag_added'?[graph.triggerTag??'']:[]),...graph.nodes.flatMap(n=>n.type==='tag'||n.type==='branch'&&n.condition==='tag'?[n.tag??'']:n.type==='message'&&n.tagGuard?[n.tagGuard.tag,...n.tagGuard.exclude]:[])]}
export async function allowApplicantTagGraph(db:DB,actor:Actor,store:string,graph:Graph){
  if(graph.purpose!=='recruitment'||!graphUsesApplicantTags(graph))return
  await requireTags(db,store);await seedApplicantTags(db,actor.tenant_id,store)
  const refs=applicantGraphTagRefs(graph)
  for(const ref of refs)if(!await resolveTag(db,store,ref))throw new Fault(422,'APPLICANT_TAG_UNKNOWN','採用タグの一覧から有効なタグを選択してください。')
  // Canonicalize only the published graph (the caller has already checked the draft revision).
  if(graph.trigger==='tag_added')graph.triggerTag=(await resolveTag(db,store,graph.triggerTag!))!
  for(const node of graph.nodes){
    if(node.type==='tag'||node.type==='branch'&&node.condition==='tag')node.tag=(await resolveTag(db,store,node.tag!))!
    if(node.type==='message'&&node.tagGuard){node.tagGuard.tag=(await resolveTag(db,store,node.tagGuard.tag))!;node.tagGuard.exclude=[...new Set(await Promise.all(node.tagGuard.exclude.map(async k=>(await resolveTag(db,store,k))!)))];if(node.tagGuard.exclude.includes(node.tagGuard.tag))throw new Fault(422,'TAG_GUARD_CONFLICT','必要なタグを除外タグにも設定できません。')}
  }
}
export async function validApplicantTagsForRun(db:DB,store:string,graph:Graph,started:Date){
  if(!graphUsesApplicantTags(graph))return true
  const s=await tagState(db,store)
  if(!s.recruitment_enabled||!s.recruitment_tags_enabled||s.recruitment_tags_enabled_at&&+started<+s.recruitment_tags_enabled_at)return false
  const refs=applicantGraphTagRefs(graph)
  if(!refs.length)return true
  const active=(await definitions(db,store)).filter(t=>t.active)
  return refs.every(ref=>active.some(t=>t.tag_key===ref||t.label===ref))
}
async function requireKeys(db:DB,store:string,tags:string[]){
  const unique=[...new Set(tags)]
  if(unique.length&&(await db.query('SELECT tag_key FROM applicant_tag WHERE store_id=$1 AND active AND tag_key=ANY($2::text[])',[store,unique])).rowCount!==unique.length)
    throw new Fault(422,'APPLICANT_TAG_UNKNOWN','有効な採用タグを選択してください。')
}
async function syncSubjects(db:DB,store:string){
  // Existing contacts and applicants are visible without retroactively firing tag automations.
  await db.query(`INSERT INTO applicant_tag_subject(id,tenant_id,store_id,channel_id,applicant_key)
    SELECT gen_random_uuid(),x.tenant_id,x.store_id,x.channel_id,x.applicant_key FROM (
      SELECT tenant_id,store_id,channel_id,subject AS applicant_key FROM workflow_contact WHERE store_id=$1 AND purpose='recruitment'
      UNION SELECT tenant_id,store_id,channel_id,applicant_key FROM recruitment_case WHERE store_id=$1
      UNION SELECT tenant_id,store_id,channel_id,applicant_key FROM interview_booking WHERE store_id=$1
    ) x WHERE NOT EXISTS(SELECT 1 FROM applicant_tag_subject s WHERE s.channel_id=x.channel_id AND s.applicant_key=x.applicant_key) ON CONFLICT(channel_id,applicant_key) DO NOTHING`,[store])
}
// On first use, classify facts already present in the store without raising any
// tag_added events. Existing applicants are visible immediately but no historical
// action causes an unsolicited replay of a previously configured step.
async function backfillExistingTags(db:DB,store:string){
  await syncSubjects(db,store)
  await db.query(`WITH facts AS (
    SELECT s.*,r.stage,r.interview_done_at,r.trial_done_at,r.hired_at,
      w.user_key, h.until_at,
      EXISTS(SELECT 1 FROM workflow_response f WHERE f.channel_id=s.channel_id AND f.purpose='recruitment' AND f.subject=s.applicant_key) AS applied,
      EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=s.channel_id AND e.user_key=w.user_key AND e.kind='follow') AS followed,
      EXISTS(SELECT 1 FROM interview_booking b JOIN interview_slot sl ON sl.id=b.slot_id WHERE b.channel_id=s.channel_id AND b.applicant_key=s.applicant_key AND b.status='confirmed' AND sl.starts_at>now()) AS booked,
      (SELECT b.status FROM interview_booking b WHERE b.channel_id=s.channel_id AND b.applicant_key=s.applicant_key ORDER BY b.updated_at DESC LIMIT 1) AS booking_state
    FROM applicant_tag_subject s LEFT JOIN recruitment_case r ON r.channel_id=s.channel_id AND r.applicant_key=s.applicant_key
      LEFT JOIN workflow_contact w ON w.channel_id=s.channel_id AND w.purpose='recruitment' AND w.subject=s.applicant_key
      LEFT JOIN line_handoff h ON h.channel_id=s.channel_id AND h.user_key=w.user_key AND h.until_at>now()
    WHERE s.store_id=$1)
    INSERT INTO applicant_tag_assignment(tenant_id,store_id,subject_id,tag_key,active,changed_at,expires_at)
    SELECT f.tenant_id,f.store_id,f.id,t.tag_key,true,now(),CASE WHEN t.tag_key='handoff' THEN f.until_at ELSE NULL END
    FROM facts f JOIN applicant_tag t ON t.store_id=f.store_id AND t.active WHERE CASE t.tag_key
      WHEN 'new_friend' THEN f.followed AND NOT f.applied AND f.stage IS NULL AND f.booking_state IS NULL
      WHEN 'unanswered' THEN f.followed AND NOT f.applied AND f.stage IS NULL AND f.booking_state IS NULL
      WHEN 'new_application' THEN f.applied AND f.stage='applied'
      WHEN 'interview_pending' THEN f.applied AND f.stage='applied' AND NOT f.booked
      WHEN 'interview_booked' THEN f.booked
      WHEN 'interview_cancelled' THEN f.booking_state='cancelled' AND NOT f.booked
      WHEN 'interview_done' THEN f.interview_done_at IS NOT NULL
      WHEN 'trial_scheduled' THEN f.stage='trial_scheduled'
      WHEN 'trial_done' THEN f.trial_done_at IS NOT NULL
      WHEN 'hired' THEN f.hired_at IS NOT NULL
      WHEN 'withdrawn' THEN f.stage='withdrawn'
      WHEN 'handoff' THEN f.until_at IS NOT NULL ELSE false END
    ON CONFLICT(subject_id,tag_key) DO NOTHING`,[store])
}
const subjectSelect=`SELECT s.id,s.channel_id,s.applicant_key,s.revision,s.updated_at,c.label AS channel_label,r.id AS case_id,r.stage,r.display_name_box,
  b.applicant_name,b.status AS interview_status,coalesce(w.notices,false) AS notices,w.user_key,
  ARRAY(SELECT a.tag_key FROM applicant_tag_assignment a JOIN applicant_tag t USING(tenant_id,store_id,tag_key)
    WHERE a.subject_id=s.id AND a.active AND t.active AND (a.expires_at IS NULL OR a.expires_at>now()) ORDER BY a.tag_key) AS tags
  FROM applicant_tag_subject s JOIN channel c ON c.id=s.channel_id
  LEFT JOIN recruitment_case r ON r.channel_id=s.channel_id AND r.applicant_key=s.applicant_key
  LEFT JOIN workflow_contact w ON w.channel_id=s.channel_id AND w.subject=s.applicant_key AND w.purpose='recruitment'
  LEFT JOIN LATERAL(SELECT applicant_name,status FROM interview_booking WHERE channel_id=s.channel_id AND applicant_key=s.applicant_key ORDER BY updated_at DESC LIMIT 1) b ON true`
type SubjectRow={id:string;channel_id:string;applicant_key:string;case_id:string|null;revision:number;updated_at:Date;channel_label:string;stage:string|null;
  display_name_box:string|null;applicant_name:string|null;interview_status:string|null;notices:boolean;user_key:string|null;tags:string[]}
function matches(tags:string[],filter:Filters){return (!filter.include.length||(filter.match==='all'?filter.include.every(k=>tags.includes(k)):filter.include.some(k=>tags.includes(k))))&&!filter.exclude.some(k=>tags.includes(k))}
export async function tagOverview(db:DB,cfg:Config,actor:Actor,store:string,query:z.infer<typeof tagListQuery>){
  const catalog=await applicantTagCatalog(db,actor,store)
  if(!catalog.enabled)return {...catalog,subjects:[],total:0,page:1,scenarios:[],campaigns:[]}
  await syncSubjects(db,store)
  const filter=filters.parse({include:query.include?.split(',').filter(Boolean)??[],exclude:query.exclude?.split(',').filter(Boolean)??[],match:query.match})
  await requireKeys(db,store,[...filter.include,...filter.exclude])
  const condition=`(cardinality($2::text[])=0 OR CASE WHEN $3='all' THEN tags @> $2 ELSE tags && $2 END) AND NOT (tags && $4::text[])`
  const sql=`WITH scoped AS (${subjectSelect} WHERE s.store_id=$1) SELECT * FROM scoped WHERE ${condition}`
  const values=[store,filter.include,filter.match,filter.exclude]
  const {rows:[{total}]}=await db.query<{total:number}>(`SELECT count(*)::int AS total FROM (${sql}) filtered`,values)
  const {rows}=await db.query<SubjectRow>(sql+' ORDER BY updated_at DESC,id LIMIT 60 OFFSET $5',[...values,(query.page-1)*60])
  const subjects=rows.map(({applicant_key,display_name_box,user_key,...r})=>({...r,applicant_name:display_name_box?unseal(cfg,'recruitment-name:'+r.channel_id+':'+applicant_key,display_name_box):r.applicant_name}))
  const {rows:scenarios}=await db.query(`SELECT q.id,v.graph->>'name' AS name,q.published_version,c.label AS channel_label FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version JOIN channel c ON c.id=(v.graph->>'channel')::uuid
    WHERE q.store_id=$1 AND NOT q.stopped AND v.graph->>'purpose'='recruitment' AND v.graph->>'trigger'='tag_campaign' ORDER BY name`,[store])
  const {rows:campaigns}=await db.query(`SELECT c.id,c.title,c.criteria,c.recipients,c.stopped,c.created_at,
    count(DISTINCT e.id) FILTER(WHERE e.handled_at IS NULL)::int AS pending,
    count(DISTINCT n.id) FILTER(WHERE n.ended_at IS NULL)::int AS running,
    count(DISTINCT n.id) FILTER(WHERE n.ended_at IS NOT NULL)::int AS finished,
    count(DISTINCT d.id) FILTER(WHERE d.status='accepted')::int AS accepted
    FROM applicant_tag_campaign c LEFT JOIN applicant_event e ON e.campaign_id=c.id LEFT JOIN applicant_enrollment n ON n.event_id=e.id LEFT JOIN applicant_send d ON d.enrollment_id=n.id
    WHERE c.store_id=$1 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 30`,[store])
  return {...catalog,subjects,total,page:query.page,scenarios,campaigns}
}
export async function saveSubjectTags(db:DB,actor:Actor,store:string,id:string,data:z.infer<typeof subjectTagsInput>){
  await lockDispatch(db,actor.tenant_id);await requireTags(db,store);await requireKeys(db,store,data.tags)
  const {rows:[subject]}=await db.query<Subject>('SELECT * FROM applicant_tag_subject WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])
  if(!subject)throw missing();if(subject.revision!==data.revision)throw conflict()
  const before=await activeTags(db,id),at=new Date()
  for(const k of before)if(!data.tags.includes(k))await setAssignment(db,subject,k,false,at,null,true)
  let queued=false
  for(const k of data.tags)if(!before.includes(k)&&await setAssignment(db,subject,k,true,at,null,true))queued=true
  await audit(db,actor.tenant_id,store,actor.id,'recruitment.tags.change',id,null,{added:data.tags.filter(k=>!before.includes(k)),removed:before.filter(k=>!data.tags.includes(k))})
  return {saved:true,channel:subject.channel_id,queued}
}

type Campaign={id:string;scenario_id:string;scenario_version:number;criteria:Filters;stopped:boolean}
export async function tagCampaignForRun(db:DB,campaignId:string,identity:Pick<ApplicantIdentity,'channel_id'|'applicant_key'>){
  const {rows:[c]}=await db.query<Campaign>('SELECT id,scenario_id,scenario_version,criteria,stopped FROM applicant_tag_campaign WHERE id=$1 AND channel_id=$2',[campaignId,identity.channel_id])
  if(!c||c.stopped)return null
  const refs=[...new Set([...c.criteria.include,...c.criteria.exclude])]
  if((await db.query('SELECT 1 FROM applicant_tag WHERE active AND tag_key=ANY($1::text[])',[refs])).rowCount!==refs.length)return null
  return matches(await applicantTags(db,identity),c.criteria)?c:null
}
async function campaignPlan(db:DB,cfg:Config,actor:Actor,store:string,data:z.infer<typeof tagCampaignInput>){
  const tagSettings=await requireTags(db,store);await requireKeys(db,store,[...data.criteria.include,...data.criteria.exclude])
  if(!data.criteria.include.length)throw new Fault(422,'TAG_FILTER_REQUIRED','配信対象のタグを1つ以上選んでください。')
  const {rows:[scenario]}=await db.query<{id:string;channel_id:string;published_version:number;graph:Graph}>(`SELECT q.id,(v.graph->>'channel')::uuid AS channel_id,q.published_version,v.graph FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version
    WHERE q.id=$1 AND q.store_id=$2 AND NOT q.stopped AND v.graph->>'purpose'='recruitment' AND v.graph->>'trigger'='tag_campaign'`,[data.scenario,store])
  if(!scenario)throw new Fault(409,'TAG_SCENARIO_NOT_READY','公開済みの採用「タグ絞り込み配信」シナリオを選んでください。')
  const c=await channel(db,scenario.channel_id)
  const {rows:[s]}=await db.query(`SELECT s.auto_enabled,s.contract_active,s.eligible_at,s.stopped,t.stopped AS tenant_stopped FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[store])
  if(!cfg.external||!automationForStore(cfg,store)||!s.auto_enabled||!s.contract_active||!s.eligible_at||s.stopped||s.tenant_stopped||c.stopped||!channelReady(c))throw new Fault(409,'TAG_CAMPAIGN_NOT_READY','店舗の契約、自動配信、LINE接続を確認してください。')
  await syncSubjects(db,store)
  const {rows}=await db.query<SubjectRow>(`WITH scoped AS (${subjectSelect} WHERE s.store_id=$1 AND s.channel_id=$2) SELECT * FROM scoped
    WHERE (CASE WHEN $3='all' THEN tags @> $4::text[] ELSE tags && $4::text[] END) AND NOT (tags && $5::text[]) ORDER BY id LIMIT 501`,[store,c.id,data.criteria.match,data.criteria.include,data.criteria.exclude])
  if(rows.length>500)throw new Fault(422,'TAG_CAMPAIGN_LIMIT','一度に照合できるのは500人までです。タグで対象をさらに絞ってください。')
  // All consent, relationship, pending stop, and handoff checks are batched in
  // one query. The dispatch worker checks them again immediately before every send.
  const {rows:allowed}=await db.query<{id:string}>(`SELECT s.id FROM applicant_tag_subject s JOIN workflow_contact w ON w.channel_id=s.channel_id AND w.purpose='recruitment' AND w.subject=s.applicant_key
    WHERE s.id=ANY($1::uuid[]) AND w.notices
    AND NOT EXISTS(SELECT 1 FROM line_handoff h WHERE h.channel_id=w.channel_id AND h.user_key=w.user_key AND h.until_at>now())
    AND NOT EXISTS(SELECT 1 FROM inbox_thread i JOIN store st ON st.id=i.store_id WHERE i.channel_id=w.channel_id AND i.user_key=w.user_key AND i.purpose='recruitment' AND i.state='handling' AND st.inbox_enabled)
    AND NOT EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=w.channel_id AND e.user_key=w.user_key AND e.stop_signal IS NOT NULL AND e.processed_at IS NULL AND e.occurred_at>=w.notices_changed_at)
    AND (SELECT e.kind FROM webhook_event e WHERE e.channel_id=w.channel_id AND e.user_key=w.user_key AND e.occurred_at<=now() AND e.kind IN ('follow','refollow','unfollow') ORDER BY e.occurred_at DESC,(e.kind='unfollow') DESC LIMIT 1) IS DISTINCT FROM 'unfollow'
    AND NOT EXISTS(SELECT 1 FROM channel_relationship r WHERE r.channel_id=w.channel_id AND r.user_key=w.user_key AND NOT r.following)
    AND (EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=w.channel_id AND e.user_key=w.user_key AND e.occurred_at<=now() AND e.kind IN ('follow','refollow')) OR
      (EXISTS(SELECT 1 FROM channel_relationship r WHERE r.channel_id=w.channel_id AND r.user_key=w.user_key AND r.following) AND EXISTS(SELECT 1 FROM webhook_event e WHERE e.channel_id=w.channel_id AND e.user_key=w.user_key AND e.generation=$2 AND e.kind='message' AND e.occurred_at BETWEEN now()-interval '7 days' AND now())))`,[rows.map(r=>r.id),c.generation])
  const allowedIds=new Set(allowed.map(r=>r.id)),eligible=rows.filter(r=>allowedIds.has(r.id))
  const fingerprint=digest(JSON.stringify({scenario:scenario.id,version:scenario.published_version,generation:c.generation,tagsEpoch:tagSettings.recruitment_tags_enabled_at,scope:await deliveryScope(db,c.id),criteria:data.criteria,people:eligible.map(r=>r.id)}))
  return {scenario,c,eligible,matched:rows.length,fingerprint}
}
export async function previewTagCampaign(db:DB,cfg:Config,actor:Actor,store:string,data:z.infer<typeof tagCampaignInput>){
  await lockDispatch(db,actor.tenant_id)
  const plan=await campaignPlan(db,cfg,actor,store,data)
  return {eligible:plan.eligible.length,excluded:plan.matched-plan.eligible.length,fingerprint:plan.fingerprint,name:plan.scenario.graph.name,version:plan.scenario.published_version}
}
export async function queueTagCampaign(db:DB,cfg:Config,actor:Actor,store:string,key:string,data:z.infer<typeof tagCampaignConfirm>){
  return once(db,cfg,actor,'recruitment.tag_campaign.queue',key,{store,data},async()=>{
    await lockDispatch(db,actor.tenant_id)
    const plan=await campaignPlan(db,cfg,actor,store,data)
    if(!plan.eligible.length||plan.fingerprint!==data.fingerprint)throw new Fault(409,'TAG_CAMPAIGN_CHANGED','配信対象または公開版が変更されました。もう一度対象を確認してください。')
    const id=newId(),at=new Date()
    await db.query(`INSERT INTO applicant_tag_campaign(id,tenant_id,store_id,channel_id,scenario_id,scenario_version,title,criteria,recipients,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,actor.tenant_id,store,plan.c.id,plan.scenario.id,plan.scenario.published_version,plan.scenario.graph.name,data.criteria,plan.eligible.length,actor.id])
    for(const row of plan.eligible)await emitApplicantEvent(db,{tenant_id:actor.tenant_id,store_id:store,channel_id:plan.c.id,applicant_key:row.applicant_key},'tag-campaign:'+id+':'+row.id,'tag_campaign',at,undefined,{campaignId:id})
    await audit(db,actor.tenant_id,store,actor.id,'recruitment.tag_campaign.queue',id,null,{recipients:plan.eligible.length})
    return {id,queued:plan.eligible.length,channel:plan.c.id}
  })
}
export async function stopTagCampaign(db:DB,actor:Actor,store:string,id:string){
  await lockDispatch(db,actor.tenant_id)
  if(!(await db.query('UPDATE applicant_tag_campaign SET stopped=true WHERE id=$1 AND store_id=$2 RETURNING id',[id,store])).rowCount)throw missing()
  await db.query('UPDATE applicant_event SET handled_at=now() WHERE campaign_id=$1 AND handled_at IS NULL',[id])
  await db.query(`UPDATE applicant_enrollment SET ended_at=now(),end_reason='絞り込み配信停止' WHERE event_id IN (SELECT id FROM applicant_event WHERE campaign_id=$1) AND ended_at IS NULL`,[id])
  await db.query(`UPDATE applicant_send SET next_at='infinity',reason='絞り込み配信停止' WHERE status IN ('submitting','unknown') AND enrollment_id IN (SELECT n.id FROM applicant_enrollment n JOIN applicant_event e ON e.id=n.event_id WHERE e.campaign_id=$1)`,[id])
  await audit(db,actor.tenant_id,store,actor.id,'recruitment.tag_campaign.stop',id)
  return {stopped:true}
}
