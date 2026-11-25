import { readFile } from 'node:fs/promises'
import type pg from 'pg'
import { z } from 'zod'
import { audit, conflict, Fault, forbidden, keyed, missing, once, scope, seal, text, tx, unseal, uuid, type Actor, type Config, type DB, type Route } from './core.js'
import { automaticRelationshipReady, channel, channelCredentials, channelReady, evidence, testDeliveryConfirmed, userKey, type Channel, type LineAPI } from './line.js'
import type { WorkflowSubject } from './forms.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature,storeFeatures } from './store-features.js'
import { applicantTags, applyApplicantTagRules } from './applicant-tags.js'

const richMenuId=z.string().regex(/^richmenu-[0-9a-f]{32}$/i)
const tagRule=z.strictObject({tag:text(80),menu:richMenuId})
const tagRules=z.array(tagRule).max(10).refine(rules=>new Set(rules.map(rule=>rule.tag)).size===rules.length)
export const menuInput=z.strictObject({channel:uuid,revision:z.int().nonnegative(),base_menu:richMenuId.nullable(),booked_menu:richMenuId.nullable(),tag_rules:tagRules.optional()})
type MenuInput=z.infer<typeof menuInput>
const contactContext=(channelId:string,purpose:string,subject:string)=>['workflow-contact',channelId,purpose,subject].join(':')

export function contactAddress(cfg:Config,row:{channel_id:string;purpose:string;subject:string;recipient_box:string}){
  return unseal(cfg,contactContext(row.channel_id,row.purpose,row.subject),row.recipient_box)
}

export async function rememberContact(db:DB,cfg:Config,c:Channel,user:string,identity:WorkflowSubject){
  const features=await storeFeatures(db,c.store_id)
  if(!features.rich_menus_enabled&&!features.reminders_enabled&&!features.waitlist_enabled
    &&!features.token_interviews_enabled&&!features.token_customers_enabled&&!(identity.purpose==='recruitment'&&features.recruitment_enabled&&features.recruitment_tags_enabled))return
  const contact=seal(cfg,contactContext(c.id,identity.purpose,identity.subject),user)
  const {rows:[prior]}=await db.query(`SELECT 1 FROM workflow_contact WHERE channel_id=$1 AND purpose=$2 AND subject=$3`,[c.id,identity.purpose,identity.subject])
  await db.query(`INSERT INTO workflow_contact (tenant_id,store_id,channel_id,purpose,subject,user_key,recipient_box,last_seen_at,menu_due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),CASE WHEN $8 THEN now() END)
    ON CONFLICT(channel_id,purpose,subject) DO UPDATE SET last_seen_at=excluded.last_seen_at,
      recipient_box=excluded.recipient_box,menu_due_at=excluded.menu_due_at`,
  [c.tenant_id,c.store_id,c.id,identity.purpose,identity.subject,userKey(cfg,c,user),contact,features.rich_menus_enabled])
  if(!prior&&c.purpose==='shared'&&identity.purpose==='recruitment'){
    const follow=await db.query(`SELECT 1 FROM webhook_event WHERE channel_id=$1 AND user_key=$2 AND kind IN ('follow','refollow') LIMIT 1`,[c.id,userKey(cfg,c,user)])
    if(follow.rowCount)await applyApplicantTagRules(db,{...identity,applicant_key:identity.subject},'follow')
  }
}

export async function refreshMenu(db:DB,identity:WorkflowSubject){
  await db.query(`UPDATE workflow_contact w SET menu_due_at=now()
    WHERE w.channel_id=$1 AND w.purpose=$2 AND w.subject=$3
      AND EXISTS (SELECT 1 FROM store WHERE id=w.store_id AND rich_menus_enabled)`,
  [identity.channel_id,identity.purpose,identity.subject])
}

export async function listMenus(db:DB,store:string,use:WorkflowSubject['purpose']){
  await requireFeature(db,store,'rich_menus_enabled')
  const settings=await storeFeatures(db,store)
  const tagsEnabled=use==='recruitment'&&settings.recruitment_enabled&&settings.recruitment_tags_enabled
  const {rows:entries}=await db.query(`SELECT c.id,c.label,m.base_menu,m.booked_menu,coalesce(m.tag_rules,'[]'::jsonb) AS tag_rules,
    coalesce(m.revision,0) AS revision,m.generation=c.generation AS verified,
    (SELECT count(*)::int FROM workflow_contact w WHERE w.channel_id=c.id AND w.purpose=$1 AND w.menu_status='切替済') AS linked
    FROM channel c LEFT JOIN workflow_menu m ON m.channel_id=c.id AND m.purpose=$1
    WHERE c.purpose IN ($1,'shared') ORDER BY c.label,c.id`,[use])
  const tags=tagsEnabled?(await db.query(`SELECT tag_key,label,active FROM applicant_tag WHERE store_id=$1 ORDER BY category,label,tag_key`,[store])).rows:[]
  return entries.map(entry=>({...entry,tags_enabled:tagsEnabled,tags}))
}

async function validateTagRules(db:DB,store:string,use:WorkflowSubject['purpose'],rules:MenuInput['tag_rules']){
  if(!rules?.length)return
  const settings=await storeFeatures(db,store)
  if(use!=='recruitment'||!settings.recruitment_enabled||!settings.recruitment_tags_enabled)
    throw new Fault(422,'MENU_TAGS_DISABLED','採用タグを有効にしてからタグ別メニューを保存してください。')
  const {rowCount}=await db.query('SELECT 1 FROM applicant_tag WHERE store_id=$1 AND active AND tag_key=ANY($2::text[])',[store,rules.map(rule=>rule.tag)])
  if(rowCount!==rules.length)throw new Fault(422,'MENU_TAG_UNKNOWN','この店舗の有効な採用タグを選択してください。')
}

export async function validateMenus(db:DB,cfg:Config,api:LineAPI,store:string,use:WorkflowSubject['purpose'],data:MenuInput){
  await requireFeature(db,store,'rich_menus_enabled')
  const c=await channel(db,data.channel)
  if(c.store_id!==store||!['shared',use].includes(c.purpose))throw missing()
  if(!cfg.external||!c.checks.token_verified)throw new Fault(409,'MENU_NOT_READY','公開HTTPS環境で公式LINEのトークンを照合してください。')
  await validateTagRules(db,store,use,data.tag_rules)
  const persisted=data.tag_rules===undefined&&data.revision>0
    ? (await db.query<{tag_rules:z.infer<typeof tagRules>}>(`SELECT tag_rules FROM workflow_menu WHERE channel_id=$1 AND purpose=$2 AND revision=$3`,[c.id,use,data.revision])).rows[0]?.tag_rules:undefined
  const menus=[...new Set([data.base_menu,data.booked_menu,...(data.tag_rules??persisted??[]).map(rule=>rule.menu)].filter(id=>id!==null))]
  if(menus.length){
    const verified=await Promise.all(menus.map(id=>api.richMenuExists(channelCredentials(cfg,c),id)))
    if(verified.includes(false))throw new Fault(422,'MENU_NOT_FOUND','指定したリッチメニューをこの公式LINEで確認できません。')
  }
  return c.generation
}

export async function saveMenus(db:DB,actor:Actor,store:string,use:WorkflowSubject['purpose'],data:MenuInput,generation:number){
  await lockDispatch(db,actor.tenant_id)
  await requireFeature(db,store,'rich_menus_enabled')
  const c=await channel(db,data.channel)
  if(c.generation!==generation)throw conflict()
  await validateTagRules(db,store,use,data.tag_rules)
  const rules=data.tag_rules===undefined?null:JSON.stringify(data.tag_rules)
  const result=data.revision===0
    ? await db.query(`INSERT INTO workflow_menu (base_menu,booked_menu,generation,channel_id,purpose,tenant_id,store_id,tag_rules)
      VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8::jsonb,'[]'::jsonb)) ON CONFLICT(channel_id,purpose) DO NOTHING RETURNING revision`,
      [data.base_menu,data.booked_menu,generation,c.id,use,actor.tenant_id,store,rules])
    : await db.query(`UPDATE workflow_menu SET base_menu=$1,booked_menu=$2,generation=$3,revision=revision+1,tag_rules=coalesce($7::jsonb,tag_rules)
      WHERE channel_id=$4 AND purpose=$5 AND revision=$6 RETURNING revision`,[data.base_menu,data.booked_menu,generation,c.id,use,data.revision,rules])
  if(!result.rowCount)throw conflict()
  await db.query('UPDATE workflow_contact SET menu_due_at=now() WHERE channel_id=$1 AND purpose=$2',[c.id,use])
  await audit(db,actor.tenant_id,store,actor.id,'line.rich_menu.save',c.id,null,{purpose:use})
  return result.rows[0]
}

type Contact={channel_id:string;subject:string;purpose:WorkflowSubject['purpose'];recipient_box:string;user_key:string;
  base_menu:string|null;booked_menu:string|null;generation:number;tag_rules:z.infer<typeof tagRules>}
export const menuTemplateInput=z.strictObject({variant:z.enum(['normal','booked'])})
export const menuTestInput=z.strictObject({tester:uuid})
async function recruitmentMenuChannel(db:DB,cfg:Config,actor:Actor,store:string,id:string){
  if(!['admin','manager'].includes(actor.role))throw forbidden()
  await requireFeature(db,store,'rich_menus_enabled')
  const c=await channel(db,id)
  if(c.store_id!==store||c.purpose!=='recruitment'||c.module_channel_id)throw missing()
  const {rows:[state]}=await db.query(`SELECT s.stopped OR t.stopped AS stopped FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[store])
  if(!cfg.external||!c.checks.token_verified||!c.checks.ownership_verified||!c.checks.provider_verified||c.stopped||state.stopped)
    throw new Fault(409,'MENU_NOT_READY','公式LINEの接続と停止状態を確認してください。')
  return c
}
export async function createMenuTemplate(db:DB,cfg:Config,api:LineAPI,actor:Actor,store:string,id:string,key:string,variant:'normal'|'booked'){
  await lockDispatch(db,actor.tenant_id)
  const c=await recruitmentMenuChannel(db,cfg,actor,store,id)
  return once(db,cfg,actor,'line.rich_menu.template',key,{channel:id,generation:c.generation,variant},async()=>{
    const png=await readFile(new URL('../public/rich-menu/'+variant+'.png',import.meta.url))
    const menu=await api.makeRecruitmentMenu(channelCredentials(cfg,c),variant,png)
    await audit(db,actor.tenant_id,store,actor.id,'line.rich_menu.template',c.id,null,{variant,menu})
    return {menu}
  })
}
const verifiedTester=`t.channel_id=$1 AND t.generation=$2 AND t.purpose='recruitment' AND t.verified_at IS NOT NULL AND t.expires_at>now()
  AND EXISTS (SELECT 1 FROM webhook_event e WHERE e.channel_id=t.channel_id AND e.user_key=t.user_key AND e.generation=t.generation
    AND e.kind IN ('message','follow') AND e.received_at BETWEEN t.verified_at AND t.expires_at AND e.occurred_at BETWEEN t.verified_at AND t.expires_at)`
async function menuTestChannel(db:DB,cfg:Config,actor:Actor,store:string,id:string){
  const c=await recruitmentMenuChannel(db,cfg,actor,store,id)
  if(!testDeliveryConfirmed(c)||!(await evidence(db,c)).send_accepted)throw new Fault(409,'MENU_TEST_NOT_READY','先にLINE接続テストと端末到着を確認してください。')
  return c
}
export async function menuTesters(db:DB,cfg:Config,actor:Actor,store:string,id:string){
  const c=await menuTestChannel(db,cfg,actor,store,id)
  return (await db.query(`SELECT t.id,t.verified_at,t.expires_at FROM tester t WHERE ${verifiedTester} ORDER BY t.verified_at DESC LIMIT 20`,[c.id,c.generation])).rows
}
export async function testRichMenu(db:DB,cfg:Config,api:LineAPI,actor:Actor,store:string,id:string,tester:string){
  await lockDispatch(db,actor.tenant_id)
  const c=await menuTestChannel(db,cfg,actor,store,id)
  const {rows:[proof]}=await db.query<{code_hash:string;recipient:string;user_key:string}>(`SELECT t.code_hash,t.recipient,t.user_key FROM tester t WHERE ${verifiedTester} AND t.id=$3`,[c.id,c.generation,tester])
  if(!proof||!await automaticRelationshipReady(db,c,proof.user_key))throw new Fault(409,'MENU_TESTER_REQUIRED','この公式LINEで本人確認済みの有効なテスターを選んでください。')
  const {rows:[m]}=await db.query<Pick<Contact,'base_menu'|'booked_menu'|'tag_rules'>>(`SELECT base_menu,booked_menu,tag_rules FROM workflow_menu WHERE channel_id=$1 AND purpose='recruitment' AND generation=$2`,[id,c.generation])
  if(!m)throw new Fault(409,'MENU_TEST_CONFIG_REQUIRED','切り替え設定を保存してからテストしてください。')
  const user=unseal(cfg,'tester:'+proof.code_hash,proof.recipient)
  const subject=keyed(cfg,'interview:'+id+':'+user)
  const desired=await desiredMenu(db,{...m,channel_id:id,subject,purpose:'recruitment'},await storeFeatures(db,store))
  const credentials=channelCredentials(cfg,c)
  const result=await api.bindRichMenu(credentials,user,desired.menu)
  if(!result.ok)throw new Fault(502,'MENU_TEST_FAILED','LINEでテスト用の切り替えができませんでした。')
  const linked=await api.userRichMenu(credentials,user)
  if(linked!==desired.menu)throw new Fault(409,'MENU_TEST_MISMATCH','LINEの表示メニューが一致しません。テスターが友だち追加済みか確認してください。')
  await audit(db,actor.tenant_id,store,actor.id,'line.rich_menu.test',c.id,null,{tester,menu:linked})
  return {linked,matched:desired.matched,booked:desired.booked}
}

async function desiredMenu(db:DB,w:Pick<Contact,'channel_id'|'subject'|'purpose'|'base_menu'|'booked_menu'|'tag_rules'>,features:Awaited<ReturnType<typeof storeFeatures>>){
    const {rows:[booked]}=await (w.purpose==='customer'
      ? db.query(`SELECT s.starts_at FROM visit_booking b JOIN booking_slot s ON s.id=b.slot_id
        WHERE b.customer_id=$1 AND b.status='confirmed' AND s.starts_at>now() ORDER BY s.starts_at LIMIT 1`,[w.subject])
      : db.query(`SELECT s.starts_at FROM interview_booking b JOIN interview_slot s ON s.id=b.slot_id
        WHERE b.channel_id=$1 AND b.applicant_key=$2 AND b.status='confirmed' AND s.starts_at>now() ORDER BY s.starts_at LIMIT 1`,[w.channel_id,w.subject]))
    let menu=booked?w.booked_menu??w.base_menu:w.base_menu
    let next=booked?.starts_at??null
    let matched:string|null=null
    if(w.purpose==='recruitment'&&features.recruitment_enabled&&features.recruitment_tags_enabled&&w.tag_rules.length){
      const tags=await applicantTags(db,{channel_id:w.channel_id,applicant_key:w.subject})
      const rule=w.tag_rules.find(rule=>tags.includes(rule.tag))
      if(rule){menu=rule.menu;matched=rule.tag}
      const {rows:[expiry]}=await db.query<{at:Date|null}>(`SELECT min(a.expires_at) AS at FROM applicant_tag_assignment a
        JOIN applicant_tag_subject s ON s.id=a.subject_id JOIN applicant_tag t ON t.tenant_id=a.tenant_id AND t.store_id=a.store_id AND t.tag_key=a.tag_key
        WHERE s.channel_id=$1 AND s.applicant_key=$2 AND a.active AND t.active AND a.expires_at>now()
          AND a.tag_key=ANY($3::text[])`,[w.channel_id,w.subject,w.tag_rules.map(rule=>rule.tag)])
      if(expiry.at&&(!next||+expiry.at<+next))next=expiry.at
    }
    return {menu,next,matched,booked:!!booked}
}
export async function updateRichMenu(pool:pg.Pool,cfg:Config,api:LineAPI,r:Route){
  if(!cfg.external||!cfg.automation)return
  await tx(pool,async db=>{
    await scope(db,r.tenant_id,r.store_id)
    await lockDispatch(db,r.tenant_id)
    const features=await storeFeatures(db,r.store_id)
    if(!features.rich_menus_enabled)return
    const c=await channel(db,r.id)
    const {rows:[state]}=await db.query(`SELECT s.stopped OR t.stopped AS stopped
      FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[r.store_id])
    if(c.stopped||state.stopped||!channelReady(c))return
    const {rows:[w]}=await db.query<Contact>(`SELECT w.*,m.base_menu,m.booked_menu,m.generation,m.tag_rules FROM workflow_contact w
      JOIN workflow_menu m ON m.channel_id=w.channel_id AND m.purpose=w.purpose AND m.generation=$2
      WHERE w.channel_id=$1 AND w.menu_due_at<=now()
        AND NOT EXISTS (SELECT 1 FROM workflow_contact newer WHERE newer.channel_id=w.channel_id
          AND newer.user_key=w.user_key AND newer.last_seen_at>w.last_seen_at)
      ORDER BY w.menu_due_at LIMIT 1 FOR UPDATE OF w`,[r.id,c.generation])
    if(!w)return
    const {menu,next}=await desiredMenu(db,w,features)
    const result=await api.bindRichMenu(channelCredentials(cfg,c),contactAddress(cfg,w),menu)
      .catch(()=>({ok:false,retry:true}))
    await db.query(`UPDATE workflow_contact SET menu_status=$4,
      menu_due_at=CASE WHEN $5 THEN now()+interval '5 minutes' ELSE $6 END WHERE channel_id=$1 AND purpose=$2 AND subject=$3`,
    [r.id,w.purpose,w.subject,result.ok?'切替済':result.retry?'再試行待ち':'LINEで切り替えできませんでした',result.retry,
      result.ok?next:null])
  })
}
