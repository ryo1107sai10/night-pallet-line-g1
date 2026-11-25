import { z } from 'zod'
import { audit, conflict, Fault, missing, newId, once, purpose, revision, seal, text, unseal, uuid,
  type Actor, type Config, type DB } from './core.js'
import { channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'
import { emitApplicantEvent } from './applicant-events.js'
import { applyApplicantTagRules, type tagEvents } from './applicant-tags.js'

export type WorkflowSubject = {tenant_id:string;store_id:string;channel_id:string;purpose:z.infer<typeof purpose>;subject:string}
const fieldKey=z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
const field=z.strictObject({key:fieldKey,label:text(100),kind:z.enum(['text','long','choice','checkbox']),
  required:z.boolean(),options:z.array(text(80)).max(12).default([]),applicant_name:z.boolean().optional()})
  .refine(item=>item.kind==='choice'?item.options.length>=2&&item.options.length===new Set(item.options).size:!item.options.length)
const fields=z.array(field).min(1).max(12).refine(items=>new Set(items.map(item=>item.key)).size===items.length&&
  items.filter(item=>item.applicant_name).length<=1&&items.every(item=>!item.applicant_name||item.kind==='text'))
export const formInput=z.strictObject({id:uuid.optional(),channel:uuid,revision:z.int().min(0),title:text(100),
  description:z.string().trim().max(1000),fields,published:z.boolean()})
  .refine(input=>input.revision===0?!input.id:!!input.id)
export const formResponse=z.strictObject({form:uuid,revision,answers:z.record(fieldKey,z.string().trim().max(1000))})
export const formQuery=z.strictObject({form:uuid.optional()})
type Form={id:string;channel_id:string;title:string;description:string;fields:z.infer<typeof fields>;published:boolean;revision:number}

export async function listForms(db:DB,store:string,use:WorkflowSubject['purpose']) {
  await requireFeature(db,store,'forms_enabled')
  const {rows:channels}=await db.query(`SELECT id,label FROM channel
    WHERE purpose=$1 OR purpose='shared' ORDER BY label,id`,[use])
  const {rows:forms}=await db.query<Form>(`SELECT id,channel_id,title,description,fields,published,revision
    FROM workflow_form WHERE purpose=$1 ORDER BY created_at,id`,[use])
  return {channels,forms}
}

export async function saveForm(db:DB,cfg:Config,actor:Actor,store:string,use:WorkflowSubject['purpose'],key:string,data:z.infer<typeof formInput>) {
  return once(db,cfg,actor,'form.save',key,{store,use,data},()=>writeForm(db,actor,store,use,data))
}

async function writeForm(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'],data:z.infer<typeof formInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'forms_enabled')
  const connection=await channel(db,data.channel)
  if(connection.store_id!==store||connection.purpose!==use&&connection.purpose!=='shared')throw missing()
  const values=[JSON.stringify(data.fields),data.title,data.description,data.published,data.channel,use]
  const result=data.revision===0
    ? await db.query(`INSERT INTO workflow_form (fields,title,description,published,channel_id,purpose,id,tenant_id,store_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,revision`,
      [...values,newId(),actor.tenant_id,store])
    : await db.query(`UPDATE workflow_form SET fields=$1,title=$2,description=$3,published=$4,revision=revision+1
      WHERE channel_id=$5 AND purpose=$6 AND revision=$7 AND id=$8 RETURNING id,revision`,[...values,data.revision,data.id])
  const [saved]=result.rows
  if(!saved)throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'form.save',saved.id,null,{purpose:use,published:data.published})
  return saved
}

async function liveForm(db:DB,identity:WorkflowSubject,id?:string) {
  const {rows:[form]}=await db.query<Form>(`SELECT id,channel_id,title,description,fields,published,revision
    FROM workflow_form WHERE channel_id=$1 AND purpose=$2 AND published AND ($3::uuid IS NULL OR id=$3)
    ORDER BY created_at,id LIMIT 1`,[identity.channel_id,identity.purpose,id??null])
  return form
}

export async function formFor(db:DB,identity:WorkflowSubject,id?:string) {
  if(!(await storeFeatures(db,identity.store_id)).forms_enabled)return null
  const form=await liveForm(db,identity,id)
  if(!form)return null
  const {rowCount}=await db.query(`SELECT 1 FROM workflow_response WHERE form_id=$1 AND subject=$2 AND form_revision=$3`,
    [form.id,identity.subject,form.revision])
  return {...form,submitted:!!rowCount}
}

export async function ensureRecruitmentCase(db:DB,identity:WorkflowSubject) {
  if(!(await storeFeatures(db,identity.store_id)).recruitment_enabled)return
  await db.query(`INSERT INTO recruitment_case (id,tenant_id,store_id,channel_id,applicant_key)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id,applicant_key) DO NOTHING`,
  [newId(),identity.tenant_id,identity.store_id,identity.channel_id,identity.subject])
}

export async function submitForm(db:DB,cfg:Config,identity:WorkflowSubject,data:z.infer<typeof formResponse>) {
  await lockDispatch(db,identity.tenant_id)
  await requireFeature(db,identity.store_id,'forms_enabled')
  const form=await liveForm(db,identity,data.form)
  if(!form||form.id!==data.form)throw missing()
  if(form.revision!==data.revision)throw conflict()
  const invalid=()=>new Fault(422,'FORM_ANSWER','必須項目と回答の形式をご確認ください。')
  if(Object.keys(data.answers).some(key=>!form.fields.some(field=>field.key===key)))throw invalid()
  const answers=form.fields.map(field=>{
    const value=Object.hasOwn(data.answers,field.key)?data.answers[field.key]:''
    if(field.required&&!value||field.kind==='text'&&value.length>200||
      field.kind==='choice'&&value&&!field.options.includes(value)||field.kind==='checkbox'&&value&&value!=='yes')throw invalid()
    return {label:field.label,value:field.kind==='checkbox'&&value?'はい':value}
  })
  const id=newId()
  const sealed=seal(cfg,'form-response:'+id,JSON.stringify({title:form.title,answers}))
  const {rowCount}=await db.query(`INSERT INTO workflow_response
    (id,tenant_id,store_id,channel_id,purpose,form_id,form_revision,subject,answers_box)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(form_id,subject,form_revision) DO NOTHING`,
  [id,identity.tenant_id,identity.store_id,identity.channel_id,identity.purpose,form.id,form.revision,identity.subject,sealed])
  let queued=false
  if(identity.purpose==='recruitment'&&rowCount){
    await ensureRecruitmentCase(db,identity)
    const name=form.fields.find(field=>field.applicant_name)
    const display=name&&Object.hasOwn(data.answers,name.key)?data.answers[name.key].slice(0,80):''
    if(display)await db.query(`UPDATE recruitment_case SET display_name_box=$3 WHERE channel_id=$1 AND applicant_key=$2`,
      [identity.channel_id,identity.subject,seal(cfg,'recruitment-name:'+identity.channel_id+':'+identity.subject,display)])
    const tagIdentity={...identity,applicant_key:identity.subject}
    queued=await applyApplicantTagRules(db,tagIdentity,'form')
    if(!(await db.query(`SELECT 1 FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id WHERE b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed' AND s.starts_at>now()`,[identity.channel_id,identity.subject])).rowCount)
      queued=await applyApplicantTagRules(db,tagIdentity,'form_unbooked')||queued
    // A submitted form may start a recruitment flow only when the applicant had
    // explicitly enabled LINE notices at submission. The dispatch worker checks
    // the current consent again, so a subsequent opt-out also prevents sending.
    const {rowCount:consented}=await db.query(`SELECT 1 FROM workflow_contact WHERE channel_id=$1
      AND purpose='recruitment' AND subject=$2 AND notices`,[identity.channel_id,identity.subject])
    if(consented)queued=await emitApplicantEvent(db,{...identity,applicant_key:identity.subject},
      'form:'+id,'form')||queued
  }
  if(rowCount)await audit(db,identity.tenant_id,identity.store_id,null,'form.submit',id,null,{purpose:identity.purpose})
  return {submitted:true,queued}
}

export async function responses(db:DB,cfg:Config,store:string,use:WorkflowSubject['purpose']) {
  await requireFeature(db,store,'forms_enabled')
  const {rows}=await db.query<{id:string;answers_box:string;submitted_at:Date;label:string;case_id:string|null}>(`
    SELECT r.id,r.answers_box,r.submitted_at,c.label,k.id AS case_id FROM workflow_response r
    JOIN channel c ON c.id=r.channel_id
    LEFT JOIN recruitment_case k ON r.purpose='recruitment' AND k.channel_id=r.channel_id AND k.applicant_key=r.subject
    WHERE r.purpose=$1 ORDER BY r.submitted_at DESC,r.id LIMIT 100`,[use])
  return rows.map(({answers_box,...row})=>({...row,...JSON.parse(unseal(cfg,'form-response:'+row.id,answers_box)) as {title:string;answers:unknown}}))
}

const stages=['applied','interviewed','trial_scheduled','trial_done','hired','withdrawn'] as const
type Stage=typeof stages[number]
export const caseInput=z.strictObject({revision,stage:z.enum(stages),trial_at:z.iso.datetime({offset:true}).nullable()})
const moves:Record<Stage,Stage[]> = {
  applied:['interviewed','withdrawn'],interviewed:['trial_scheduled','hired','withdrawn'],
  trial_scheduled:['interviewed','trial_scheduled','trial_done','withdrawn'],trial_done:['hired','withdrawn'],
  hired:[],withdrawn:[],
}

export async function listRecruitment(db:DB,cfg:Config,store:string) {
  await requireFeature(db,store,'recruitment_enabled')
  const {rows}=await db.query<{display_name_box:string|null;applicant_name:string|null;channel_id:string;applicant_key:string}>(`
    SELECT r.id,r.stage,r.trial_at,r.revision,r.created_at,c.label,r.channel_id,r.applicant_key,r.display_name_box,
    book.applicant_name,book.starts_at AS interview_at,book.status AS interview_status,
    entry.title AS source
    FROM recruitment_case r JOIN channel c ON c.id=r.channel_id
    LEFT JOIN LATERAL (SELECT b.applicant_name,s.starts_at,b.status FROM interview_booking b
      JOIN interview_slot s ON s.id=b.slot_id WHERE b.channel_id=r.channel_id AND b.applicant_key=r.applicant_key
      ORDER BY b.updated_at DESC LIMIT 1) book ON true
    LEFT JOIN workflow_attribution a ON a.channel_id=r.channel_id AND a.purpose='recruitment' AND a.subject=r.applicant_key
    LEFT JOIN LATERAL (SELECT label AS title FROM workflow_source WHERE id=a.source_id) entry ON true
    ORDER BY r.updated_at DESC,r.id LIMIT 150`)
  return rows.map(({display_name_box,channel_id,applicant_key,...row})=>({...row,applicant_name:display_name_box
    ?unseal(cfg,'recruitment-name:'+channel_id+':'+applicant_key,display_name_box):row.applicant_name}))
}

export async function updateCase(db:DB,actor:Actor,store:string,id:string,data:z.infer<typeof caseInput>) {
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'recruitment_enabled')
  const {rows:[previous]}=await db.query<{revision:number;stage:Stage;trial_at:Date|null;tenant_id:string;store_id:string;channel_id:string;applicant_key:string}>(`
    SELECT revision,stage,trial_at,tenant_id,store_id,channel_id,applicant_key FROM recruitment_case WHERE id=$1 FOR UPDATE`,[id])
  if(!previous)throw missing()
  if(previous.revision!==data.revision||!moves[previous.stage].includes(data.stage))throw conflict()
  if(data.stage==='trial_scheduled'&&(!data.trial_at||Date.parse(data.trial_at)<=Date.now())) {
    throw new Fault(422,'TRIAL_TIME','体入予定には未来の日時を指定してください。')
  }
  const {rows:[saved]}=await db.query(`UPDATE recruitment_case SET stage=$2,revision=revision+1,updated_at=now(),
    trial_at=CASE WHEN $2='trial_scheduled' THEN $3 WHEN $2='interviewed' THEN NULL ELSE trial_at END,
    interview_done_at=CASE WHEN $2='interviewed' THEN coalesce(interview_done_at,now()) ELSE interview_done_at END,
    trial_done_at=CASE WHEN $2='trial_done' THEN now() ELSE trial_done_at END,
    hired_at=CASE WHEN $2='hired' THEN now() ELSE hired_at END
    WHERE id=$1 RETURNING id,revision,stage,trial_at`,[id,data.stage,data.trial_at])
  const queued=data.stage!=='applied'&&await applyApplicantTagRules(db,previous,('stage_'+data.stage) as keyof typeof tagEvents)
  await audit(db,actor.tenant_id,store,actor.id,'recruitment.stage',id,null,{from:previous.stage,to:data.stage})
  return {saved,queued,channel:previous.channel_id}
}
