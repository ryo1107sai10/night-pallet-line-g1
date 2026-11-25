import {z} from 'zod'
import {intakeTemplate,consentPrompt,intakeVariable,normalizeAnswer,type IntakeSettings} from '../public/studio/interview-intake-template.mjs'
import {publicHttps} from '../public/studio/message-format.mjs'
import {audit,automationForStore,conflict,Fault,forbidden,keyed,missing,newId,seal,unseal,uuid,type Actor,type Config,type DB} from './core.js'
import {channel,channelReady,type Channel} from './line.js'
import {locationOf} from './automation.js'
import {lockDispatch} from './dispatch-lock.js'
import {storeFeatures} from './store-features.js'
import {rememberContact} from './rich-menus.js'
import {submitForm,type WorkflowSubject} from './forms.js'
import {issueInterviewLinkToken} from './interview-link.js'
import {queueService} from './service-delivery.js'
import {handoffUntil} from './line-handoff.js'

const content=(variables:string[])=>z.string().trim().min(1).max(850).refine(s=>{
  const rest=s.replace(/\{\{(store|name|booking)\}\}/g,(marker,key)=>variables.includes(key)?'':marker)
  return !rest.includes('{{')&&!rest.includes('}}')
},'使用できない差し込み項目があります。')
const url=z.string().trim().max(2000).refine(s=>!s||publicHttps(s),'公開HTTPS URLを指定してください。')
const settings=z.strictObject({
  greeting:content(['store']),name:content([]),station:content([]),age:content([]),
  thanks:content(['store','name']),confirm:content(['store','booking']).refine(s=>s.includes('{{booking}}'),'予約日時を入れてください。'),reminder:content(['store','booking']).refine(s=>s.includes('{{booking}}'),'予約日時を入れてください。'),
  faqUrl:url,mapUrl:url,reminder3h:z.boolean(),
})
export const intakeSaveInput=z.strictObject({channel:uuid,revision:z.int().min(0),settings})
export const intakeActionInput=z.strictObject({channel:uuid,revision:z.int().min(1),action:z.enum(['publish','stop'])})
type Intake={tenant_id:string;store_id:string;channel_id:string;revision:number;draft:IntakeSettings;live:IntakeSettings|null;live_revision:number|null;live_at:Date|null;form_id:string|null}
type Run={id:string;channel_id:string;applicant_key:string;generation:number;config_revision:number;stage:string;step:number;answers_box:string|null;last_at:Date;expires_at:Date}
type Event={event_id:string;generation:number;user_key:string|null;recipient_box:string|null;kind:string;occurred_at:Date;stop_signal:string|null;action:string|null;intake_phrase_box:string|null}
const day=86400000
const keywords=['応募する','通知ありで応募','通知なしで応募','応募取消','面談確認OK']
export const intakeStart='応募する'
export const intakeAck='面談確認OK'
const actorCheck=(actor:Actor)=>{if(!['admin','manager'].includes(actor.role))throw forbidden()}
async function record(db:DB,c:Channel){return (await db.query<Intake>('SELECT * FROM recruitment_intake WHERE channel_id=$1',[c.id])).rows[0]}
async function forStore(db:DB,store:string,id:string){
  const c=await channel(db,id)
  // A shared customer/recruitment account cannot infer that a new friend is applying for work.
  if(c.store_id!==store||c.purpose!=='recruitment')throw missing()
  return c
}
export async function intakeView(db:DB,actor:Actor,store:string,id:string){
  actorCheck(actor);const c=await forStore(db,store,id),row=await record(db,c)
  return {revision:row?.revision??0,draft:row?.draft??intakeTemplate,live_revision:row?.live_revision??null,
    active:!!row?.live, readiness:await intakeReadiness(db,c)}
}
async function intakeReadiness(db:DB,c:Channel){
  const f=await storeFeatures(db,c.store_id),loc=await locationOf(db,c.store_id),problems:string[]=[]
  if(!channelReady(c))problems.push('LINEの接続・送受信テストを完了してください。')
  if(!f.recruitment_enabled||!f.forms_enabled||!f.interviews_enabled||!f.token_interviews_enabled||!f.reminders_enabled)
    problems.push('応募・回答フォーム・LINEからの面談予約・面談通知を有効にしてください。')
  if(!loc.contract_active||!loc.eligible_at||!loc.auto_enabled||!loc.auto_enabled_at||loc.stopped||loc.tenant_stopped||c.stopped)problems.push('店舗の自動配信・契約確認・停止設定をご確認ください。')
  // Do not silently replace or duplicate an already published onboarding scenario.
  const {rowCount}=await db.query(`SELECT 1 FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version
    WHERE v.graph->>'channel'=$1 AND NOT q.stopped AND v.graph->>'purpose'='recruitment' AND v.graph->>'trigger' IN ('follow','form') LIMIT 1`,[c.id])
  if(rowCount)problems.push('公開中の友だち追加・フォーム回答シナリオがあります。重複しないよう確認してから停止してください。')
  return problems
}
export async function saveIntake(db:DB,actor:Actor,store:string,input:z.infer<typeof intakeSaveInput>){
  actorCheck(actor);await lockDispatch(db,actor.tenant_id);const c=await forStore(db,store,input.channel)
  const values=[c.tenant_id,c.store_id,c.id,JSON.stringify(input.settings),input.revision]
  const result=input.revision===0?await db.query(`INSERT INTO recruitment_intake (tenant_id,store_id,channel_id,draft)
    VALUES($1,$2,$3,$4) ON CONFLICT(channel_id) DO NOTHING RETURNING revision`,values.slice(0,4)):
    await db.query('UPDATE recruitment_intake SET draft=$4,revision=revision+1 WHERE tenant_id=$1 AND store_id=$2 AND channel_id=$3 AND revision=$5 RETURNING revision',values)
  if(!result.rowCount)throw conflict()
  await audit(db,actor.tenant_id,store,actor.id,'intake.draft',c.id)
  return intakeView(db,actor,store,c.id)
}
export async function changeIntake(db:DB,cfg:Config,actor:Actor,store:string,input:z.infer<typeof intakeActionInput>){
  actorCheck(actor);await lockDispatch(db,actor.tenant_id);const c=await forStore(db,store,input.channel),row=await record(db,c)
  if(!row||row.revision!==input.revision)throw conflict()
  if(input.action==='publish'){
    if(!automationForStore(cfg,c.store_id,c.tenant_id))throw new Fault(409,'INTAKE_NOT_READY','この店舗の実配信は無効です。')
    const issues=await intakeReadiness(db,c)
    if(issues.length)throw new Fault(409,'INTAKE_NOT_READY',issues[0])
    const formId=row.form_id??newId()
    const fields=[{key:'name',label:'名前',kind:'text',required:true,options:[],applicant_name:true},
      {key:'station',label:'最寄駅',kind:'text',required:true,options:[]},{key:'age',label:'年齢',kind:'text',required:true,options:[]}]
    if(!row.form_id)await db.query(`INSERT INTO workflow_form(id,tenant_id,store_id,channel_id,purpose,title,description,fields,published,chat_only)
      VALUES($1,$2,$3,$4,'recruitment','採用面談・LINEトーク型','LINEで入力した応募情報です。',$5,true,true)`,
    [formId,c.tenant_id,c.store_id,c.id,JSON.stringify(fields)])
    await db.query(`UPDATE recruitment_intake SET live=draft,live_revision=revision,live_at=now(),form_id=$2,revision=revision+1 WHERE channel_id=$1`,[c.id,formId])
  }else await db.query('UPDATE recruitment_intake SET live=NULL,live_revision=NULL,live_at=NULL,revision=revision+1 WHERE channel_id=$1',[c.id])
  await db.query("UPDATE recruitment_intake_run SET stage='cancelled',answers_box=NULL WHERE channel_id=$1 AND stage NOT IN ('complete','cancelled')",[c.id])
  await db.query(`UPDATE service_delivery SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,next_at='infinity',reason='面談テンプレートが変更されました'
    WHERE channel_id=$1 AND kind IN ('intake_prompt','interview_reminder_3h') AND status IN ('queued','submitting','unknown')`,[c.id])
  await audit(db,actor.tenant_id,store,actor.id,'intake.'+input.action,c.id)
  return intakeView(db,actor,store,c.id)
}
export async function activeIntake(db:DB,c:Channel){
  if(c.purpose!=='recruitment')return undefined
  const row=await record(db,c)
  return row?.live?row as Intake&{live:IntakeSettings;live_revision:number;live_at:Date;form_id:string}:undefined
}
// The signed webhook keeps text only for this opt-in conversation or exact commands.
export async function intakePhrase(db:DB,cfg:Config,c:Channel,eventId:string,userKey:string,phrase:string|null,when:number){
  if(!phrase||phrase.length>200||c.purpose!=='recruitment'||Date.now()-when>10*60000)return null
  const row=await activeIntake(db,c)
  if(!row||+row.live_at>when)return null
  if(!keywords.includes(phrase)){
    const {rowCount}=await db.query(`SELECT 1 FROM recruitment_intake_run r JOIN workflow_contact w
      ON w.channel_id=r.channel_id AND w.purpose='recruitment' AND w.subject=r.applicant_key
      WHERE r.channel_id=$1 AND w.user_key=$2 AND r.config_revision=$3
        AND r.stage IN ('name','station','age') AND r.expires_at>now()`,[c.id,userKey,row.live_revision])
    if(!rowCount)return null
  }
  return seal(cfg,'intake-event:'+c.id+':'+eventId,phrase)
}
export async function intakeDispatchReady(db:DB,c:Channel,cfg:Config,userKey:string){
  const f=await storeFeatures(db,c.store_id),loc=await locationOf(db,c.store_id)
  if(!automationForStore(cfg,c.store_id,c.tenant_id)||!channelReady(c)||c.stopped||loc.stopped||loc.tenant_stopped||!loc.contract_active||!loc.eligible_at||!loc.auto_enabled||
    !f.recruitment_enabled||!f.forms_enabled||!f.interviews_enabled||!f.token_interviews_enabled||!f.reminders_enabled)return false
  if(await handoffUntil(db,c.id,userKey))return false
  const {rowCount}=await db.query("SELECT 1 FROM inbox_thread i JOIN store s ON s.id=i.store_id WHERE i.channel_id=$1 AND i.user_key=$2 AND i.purpose='recruitment' AND i.state='handling' AND s.inbox_enabled",[c.id,userKey])
  return !rowCount
}
export async function processIntake(db:DB,cfg:Config,c:Channel,event:Event){
  if(c.purpose!=='recruitment'||!event.user_key||c.generation!==event.generation)return
  // Stop/delete pending answers regardless of whether the template is still active.
  if(event.kind==='unfollow'||event.stop_signal==='all'){
    await db.query(`UPDATE recruitment_intake_run r SET stage='cancelled',answers_box=NULL FROM workflow_contact w
      WHERE r.channel_id=$1 AND w.channel_id=r.channel_id AND w.subject=r.applicant_key AND w.purpose='recruitment' AND w.user_key=$2
      AND r.last_at<=$3 AND r.stage NOT IN ('complete','cancelled')`,[c.id,event.user_key,event.occurred_at]);return
  }
  const row=await activeIntake(db,c)
  if(!row||+row.live_at>+event.occurred_at||Date.now()-+event.occurred_at>10*60000||
    !event.recipient_box||event.action||!['follow','message'].includes(event.kind))return
  const phrase=event.kind==='message'&&event.intake_phrase_box?unseal(cfg,'intake-event:'+c.id+':'+event.event_id,event.intake_phrase_box):null
  if(event.kind==='message'&&!phrase)return
  const user=unseal(cfg,'webhook:'+c.id+':'+event.event_id,event.recipient_box)
  const subject=keyed(cfg,'interview:'+c.id+':'+user)
  const identity:WorkflowSubject={tenant_id:c.tenant_id,store_id:c.store_id,channel_id:c.id,purpose:'recruitment',subject}
  if(phrase===intakeAck){
    // Only a current, already accepted 3h reminder may be confirmed. No personal data echoed.
    await db.query(`UPDATE interview_booking b SET arrival_confirmed_revision=b.revision,arrival_confirmed_at=now()
      FROM interview_slot s WHERE b.slot_id=s.id AND b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed'
      AND s.starts_at>now() AND EXISTS(SELECT 1 FROM service_delivery d WHERE d.channel_id=b.channel_id AND d.subject=b.applicant_key
        AND d.object_id=b.id AND d.object_revision=b.revision AND d.kind='interview_reminder_3h' AND d.status='accepted' AND d.first_attempt_at<=$3)`,
    [c.id,subject,event.occurred_at]);return
  }
  if(!await intakeDispatchReady(db,c,cfg,event.user_key))return
  const location=await locationOf(db,c.store_id)
  if(!location.auto_enabled_at||+event.occurred_at<+location.auto_enabled_at)return
  let run=(await db.query<Run>('SELECT * FROM recruitment_intake_run WHERE channel_id=$1 AND applicant_key=$2',[c.id,subject])).rows[0]
  if(run&&+event.occurred_at<=+run.last_at)return
  if(phrase==='応募取消'){
    if(run)await db.query("UPDATE recruitment_intake_run SET stage='cancelled',answers_box=NULL,last_at=$2 WHERE id=$1",[run.id,event.occurred_at])
    return
  }
  if(event.kind==='follow'||phrase===intakeStart){
    if(event.kind==='follow'&&run)return // one greeting, no re-entry on redelivery
    await rememberContact(db,cfg,c,user,identity)
    const id=newId(),stage=event.kind==='follow'?'invited':'consent'
    const {rows:[fresh]}=await db.query<Run>(`INSERT INTO recruitment_intake_run (id,tenant_id,store_id,channel_id,applicant_key,generation,config_revision,stage,last_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '24 hours')
      ON CONFLICT(channel_id,applicant_key) DO UPDATE SET id=excluded.id,generation=excluded.generation,config_revision=excluded.config_revision,
      stage=excluded.stage,last_at=excluded.last_at,expires_at=excluded.expires_at,step=1,answers_box=NULL RETURNING *`,
    [id,c.tenant_id,c.store_id,c.id,subject,c.generation,row.live_revision,stage,event.occurred_at])
    run=fresh
    await prompt(db,cfg,identity,run,stage==='invited'?intakeVariable(row.live.greeting,{store:(await locationOf(db,c.store_id)).name}):consentPrompt)
    return
  }
  if(!run||run.generation!==c.generation||run.config_revision!==row.live_revision||+run.expires_at<=Date.now()||['complete','cancelled','invited'].includes(run.stage))return
  const {rowCount}=await db.query(`SELECT 1 FROM service_delivery WHERE channel_id=$1 AND subject=$2 AND kind='intake_prompt'
    AND object_id=$3 AND object_revision=$4 AND status='accepted' AND first_attempt_at<=$5`,[c.id,subject,run.id,run.step,event.occurred_at])
  if(!rowCount)return
  const answers=run.answers_box?JSON.parse(unseal(cfg,'intake-run:'+run.id,run.answers_box)) as Record<string,string>:{}
  let stage=run.stage,body:string
  if(stage==='consent'){
    if(!['通知ありで応募','通知なしで応募'].includes(phrase!))return
    const {rowCount:submitted}=await db.query('SELECT 1 FROM workflow_response WHERE channel_id=$1 AND form_id=$2 AND subject=$3',[c.id,row.form_id,subject])
    await db.query('UPDATE workflow_contact SET notices=$3,notices_changed_at=clock_timestamp() WHERE channel_id=$1 AND purpose=\'recruitment\' AND subject=$2',
      [c.id,subject,phrase==='通知ありで応募'])
    if(submitted){
      const link=await issueInterviewLinkToken(db,cfg,c,user)
      stage='complete';body='応募情報は回答済みです。面談のご確認はこちらからお願いします。\n'+link.url
    }else{stage='name';body=row.live.name}
  }else{
    if(phrase&&keywords.includes(phrase))return
    const answer=normalizeAnswer(stage,phrase)
    if(!answer){body=stage==='age'?'年齢は数字のみで入力してください。例：25':'80文字以内で回答してください。'}
    else{
      answers[stage]=answer
      if(stage==='name'){stage='station';body=row.live.station}
      else if(stage==='station'){stage='age';body=row.live.age}
      else{
        const {rows:[form]}=await db.query<{revision:number}>('SELECT revision FROM workflow_form WHERE id=$1 AND chat_only AND published',[row.form_id])
        if(!form)return
        await submitForm(db,cfg,identity,{form:row.form_id,revision:form.revision,answers},true)
        const link=await issueInterviewLinkToken(db,cfg,c,user)
        body=intakeVariable(row.live.thanks,{name:answers.name,store:(await locationOf(db,c.store_id)).name})+'\n'+link.url
        stage='complete'
      }
    }
  }
  const {rows:[updated]}=await db.query<Run>(`UPDATE recruitment_intake_run SET stage=$2,step=step+1,answers_box=$3,last_at=$4
    WHERE id=$1 RETURNING *`,[run.id,stage,stage==='complete'?null:seal(cfg,'intake-run:'+run.id,JSON.stringify(answers)),event.occurred_at])
  await prompt(db,cfg,identity,updated,body)
}
async function prompt(db:DB,cfg:Config,identity:WorkflowSubject,run:Run,body:string){
  await queueService(db,cfg,identity,{kind:'intake_prompt',object:run.id,revision:run.step,due:new Date(),expiry:new Date(Math.min(+run.expires_at,Date.now()+10*60000)),body})
}
export async function intakePromptLive(db:DB,cfg:Config,c:Channel,userKey:string,job:{subject:string;object_id:string;object_revision:number}){
  const row=await activeIntake(db,c)
  if(!row||!await intakeDispatchReady(db,c,cfg,userKey))return undefined
  return (await db.query<Run>(`SELECT * FROM recruitment_intake_run WHERE channel_id=$1 AND applicant_key=$2 AND id=$3
    AND step=$4 AND generation=$5 AND config_revision=$6 AND stage<>'cancelled' AND expires_at>now()`,
  [c.id,job.subject,job.object_id,job.object_revision,c.generation,row.live_revision])).rows[0]
}
