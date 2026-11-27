import { authenticate, createInvite } from './auth.js'
import { type Actor, type Config, type DB, Fault, audit, conflict, forbidden, missing, newId, once, scope } from './core.js'

import { lockDispatch } from './dispatch-lock.js'

export const platformWorkspace = '/platform/tenants'

export async function supervisedAgency(db:DB,principal:Actor) {
  const {rows:[assignment]}=await db.query<{agency_id:string;display_name:string;organization:string}>(`
    SELECT m.agency_id,m.display_name,t.legal_name AS organization
    FROM platform_master m JOIN tenant t ON t.id=m.tenant_id
    WHERE (m.tenant_id,m.staff_id)=($1,$2) AND m.agency_id IS NOT NULL AND t.supervisor_only`,
  [principal.tenant_id,principal.id])
  if (!assignment) throw missing()
  return assignment
}

export async function platformSession(db:DB,credential:string|undefined) {
  const principal=await authenticate(db,credential,'platform')
  const {display_name,organization}=await supervisedAgency(db,principal)
  return {actor:{id:principal.id,email:principal.email,role:'platform',display_name,organization}}
}

export async function platformPrincipal(db:DB,credential:string|undefined) {
  const principal=await authenticate(db,credential,'platform')
  await supervisedAgency(db,principal)
  return principal
}

export async function platformTenants(db:DB,credential:string|undefined) {
  const principal=await authenticate(db,credential,'platform')
  const targets=await supervisedTenantIds(db,principal)
  const result=[]
  for(const id of targets){
    await scope(db,id,undefined,true)
    const {rows:[tenant]}=await db.query(`SELECT id,slug,legal_name,stopped,
      (SELECT count(*)::int FROM store WHERE tenant_id=tenant.id) AS stores
      FROM tenant WHERE id=$1 AND NOT supervisor_only`,[id])
    if(tenant)result.push(tenant)
  }
  await scope(db,principal.tenant_id,undefined,true)
  return result
}

export async function supervisedTenantIds(db:DB,principal:Actor) {
  await scope(db,principal.tenant_id,undefined,true)
  const {agency_id}=await supervisedAgency(db,principal)
  const {rows}=await db.query<{tenant_id:string}>(`SELECT tenant_id FROM platform_registration
    WHERE supervisor_tenant_id=$1 ORDER BY created_at,tenant_id`,[principal.tenant_id])
  return [...new Set([agency_id,...rows.map(row=>row.tenant_id)])]
}

async function enterAgencyScope(db:DB,credential:string|undefined,tenant:string) {
  const principal=await authenticate(db,credential,'platform')
  if (!(await supervisedTenantIds(db,principal)).includes(tenant)) throw missing()
  await scope(db,tenant,undefined,true)
  return principal
}

async function scopedActor(db:DB,principal:Actor,tenant:string):Promise<Actor> {
  const {rows:[actor]}=await db.query<{id:string}>(`SELECT id FROM staff WHERE tenant_id=$1 AND platform_actor`,[tenant])
  if (!actor) throw missing()
  await db.query("SELECT set_config('night.platform_principal',$1,true)",[principal.id])
  return {id:actor.id,tenant_id:tenant,role:'admin',email:principal.email,platform:true}
}

export async function authenticatePlatformWorkspace(db:DB,credential:string|undefined,tenant:string) {
  return scopedActor(db,await enterAgencyScope(db,credential,tenant),tenant)
}

export async function enterPlatformTenant(db:DB,credential:string|undefined,tenant:string) {
  const principal=await enterAgencyScope(db,credential,tenant)
  // Keep tenant foreign keys and store policies in force for supervisor operations.
  await db.query(`INSERT INTO staff (id,tenant_id,email,role,totp_secret,platform_actor)
    VALUES($1,$2,$3,'admin','',true)
    ON CONFLICT (tenant_id) WHERE platform_actor DO NOTHING`,[newId(),tenant,'platform+'+tenant+'@internal.invalid'])
  const actor=await scopedActor(db,principal,tenant)
  await audit(db,tenant,null,actor.id,'platform.tenant_opened',tenant)
  return {url:platformWorkspace+'/'+tenant+'/master/'}
}

export function requireSupervisor(actor:Actor) {
  if(!actor.platform)throw forbidden()
}

// Both designated masters have the same operational and membership management rights.
// The supervisor may administer only a supervised tenant via its scoped workspace.
async function requireAgencyMasterAccess(db:DB,actor:Actor) {
  if(actor.platform)return
  if(!actor.agency)throw forbidden()
  const {rows:[binding]}=await db.query(`SELECT 1 FROM tenant_master m
    JOIN staff f ON m.tenant_id=f.tenant_id AND f.id IN (m.staff_id,m.co_staff_id,m.third_staff_id)
    WHERE m.tenant_id=$1 AND f.id=$2
      AND f.role='admin' AND NOT f.platform_actor AND f.disabled_at IS NULL`,
    [actor.tenant_id,actor.id])
  if(!binding)throw forbidden()
  // RLS also checks membership of the actor against the current row.
  await db.query("SELECT set_config('night.agency_master',$1,true)",[actor.id])
}

async function readAgencyMaster(db:DB,actor:Actor) {
  await scope(db,actor.tenant_id,undefined,true)
  const {rows:[state]}=await db.query(`SELECT current.id AS current_id,current.email AS current_email,
    current.password_hash IS NOT NULL AND current.disabled_at IS NULL AS current_active,
    co.id AS co_id,co.email AS co_email,co.password_hash IS NOT NULL AND co.disabled_at IS NULL AS co_active,
    third.id AS third_id,third.email AS third_email,third.password_hash IS NOT NULL AND third.disabled_at IS NULL AS third_active,next.id AS pending_id,
    next.email AS pending_email,next.password_hash IS NOT NULL AS pending_active,i.expires_at,
    m.pending_mode,target.id AS pending_replace_id,target.email AS pending_replace_email
    FROM tenant_master m JOIN staff current ON (m.tenant_id,m.staff_id)=(current.tenant_id,current.id)
    LEFT JOIN staff co ON (m.tenant_id,m.co_staff_id)=(co.tenant_id,co.id)
    LEFT JOIN staff third ON (m.tenant_id,m.third_staff_id)=(third.tenant_id,third.id)
    LEFT JOIN staff next ON (m.tenant_id,m.pending_staff_id)=(next.tenant_id,next.id) AND next.disabled_at IS NULL
    LEFT JOIN invite i ON (i.tenant_id,i.staff_id)=(next.tenant_id,next.id)
    LEFT JOIN staff target ON m.pending_staff_id IS NOT NULL AND m.pending_mode='replace'
      AND target.tenant_id=m.tenant_id AND target.id=coalesce(m.pending_replace_id,m.staff_id)
    WHERE m.tenant_id=$1`,[actor.tenant_id])
  if(!state)throw missing()
  return {...state,pair:await readPair(db,actor),master_limit:3,masters:[{id:state.current_id,email:state.current_email,active:state.current_active},
    ...(state.co_id?[{id:state.co_id,email:state.co_email,active:state.co_active}]:[]),
    ...(state.third_id?[{id:state.third_id,email:state.third_email,active:state.third_active}]:[])]}
}

export async function agencyMasterDetails(db:DB,actor:Actor) {
  await requireAgencyMasterAccess(db,actor)
  return readAgencyMaster(db,actor)
}

type MasterChange = {mode:'add'|'replace';replace_id?:string}
type MasterBinding = {staff_id:string;co_staff_id:string|null;third_staff_id:string|null;pending_staff_id:string|null;
  pending_mode:'add'|'replace';pending_replace_id:string|null}
const masterIds=(state:MasterBinding)=>[state.staff_id,state.co_staff_id,state.third_staff_id].filter((id):id is string=>id!==null)
async function lockedMasterBinding(db:DB,actor:Actor) {
  const {rows:[state]}=await db.query<MasterBinding>(`SELECT staff_id,co_staff_id,third_staff_id,pending_staff_id,pending_mode,pending_replace_id
    FROM tenant_master WHERE tenant_id=$1 FOR UPDATE`,[actor.tenant_id])
  if(!state)throw missing()
  if(!actor.platform&&!masterIds(state).includes(actor.id))throw forbidden()
  return state
}
const pairConflict=()=>new Fault(409,'MASTER_PAIR_PENDING','複数名への引き継ぎ招待が進行中です。先に完了または取り消してください。')
async function noPair(db:DB,actor:Actor){if((await db.query('SELECT 1 FROM agency_master_pair WHERE tenant_id=$1',[actor.tenant_id])).rowCount)throw pairConflict()}
const fullMasters=()=>new Fault(409,'MASTER_LIMIT','マスターは3名までです。交代するマスターを選ぶか、兼任を解除してください。')

export async function inviteAgencyMaster(db:DB,cfg:Config,actor:Actor,address:string,key:string,change:MasterChange={mode:'replace'}) {
  await requireAgencyMasterAccess(db,actor)
  await scope(db,actor.tenant_id,undefined,true)
  return once(db,cfg,actor,'agency.master_invite',key,{email:address,...change},async()=>{
    await lockDispatch(db,actor.tenant_id)
    const state=await lockedMasterBinding(db,actor)
    await noPair(db,actor)
    if(change.mode==='add'&&state.third_staff_id)throw fullMasters()
    const replaceId=change.mode==='replace'?(change.replace_id??state.staff_id):null
    if(change.mode==='add'&&change.replace_id||replaceId&&!masterIds(state).includes(replaceId))throw conflict()
    const {rows:[existing]}=await db.query<{id:string;password_hash:string|null;disabled_at:Date|null;platform_actor:boolean;agency_staff:boolean;role:string}>(
      `SELECT id,password_hash,disabled_at,platform_actor,agency_staff,role FROM staff WHERE tenant_id=$1 AND email=$2 FOR UPDATE`,[actor.tenant_id,address])
    if(existing&&masterIds(state).includes(existing.id))throw new Fault(409,'MASTER_EXISTS','このアカウントは既にマスターです。')
    // An existing activated agency staff member keeps their own password/MFA. They
    // become a master only after the explicit final approval, then log in again.
    const invite=existing?.password_hash&&!existing.disabled_at&&!existing.platform_actor&&existing.agency_staff&&existing.role!=='admin'
      ? {id:existing.id,existing_active:true as const}
      : await createInvite(db,cfg,actor.tenant_id,{email:address,role:'admin',stores:[]},actor.id)
    // A null replace target is reserved for the legacy single-master workflow.
    // New explicit invitations carry the exact seat to be replaced.
    const changed=await db.query('UPDATE tenant_master SET pending_staff_id=$2,pending_mode=$3,pending_replace_id=$4 WHERE tenant_id=$1',
      [actor.tenant_id,invite.id,change.mode,change.replace_id??null])
    if(!changed.rowCount)throw forbidden()
    await audit(db,actor.tenant_id,null,actor.id,'agency.master_invite',invite.id,null,{mode:change.mode,replaces:replaceId})
    return invite
  })
}

export async function promoteAgencyMaster(db:DB,actor:Actor,pending:string,expected?:MasterChange) {
  await requireAgencyMasterAccess(db,actor)
  await scope(db,actor.tenant_id,undefined,true)
  await lockDispatch(db,actor.tenant_id)
  const state=await lockedMasterBinding(db,actor)
  await noPair(db,actor)
  if(state.pending_staff_id!==pending)throw conflict()
  const replaces=state.pending_mode==='replace'?(state.pending_replace_id??state.staff_id):null
  // A second operator may have replaced the pending invitation while this page
  // was open. Never let a confirmation for "add" become a handover (or switch
  // the target seat). Keep the original implicit replacement API compatible.
  if(expected){
    if(expected.mode!==state.pending_mode||(expected.replace_id??null)!==replaces)throw conflict()
  }else if(state.pending_mode!=='replace'||state.pending_replace_id!==null)throw conflict()
  if(state.pending_mode==='add'&&state.third_staff_id)throw fullMasters()
  const {rows:[candidate]}=await db.query<{role:string}>(`SELECT role FROM staff WHERE id=$1 AND tenant_id=$2
    AND (role='admin' OR agency_staff) AND NOT platform_actor AND password_hash IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,[pending,actor.tenant_id])
  if(!candidate)throw new Fault(409,'MASTER_NOT_ACTIVE','新しいマスター本人が招待を有効化してから確定してください。')
  if(replaces&&!masterIds(state).includes(replaces))throw conflict()
  const ids=state.pending_mode==='add'?[...masterIds(state),pending]:masterIds(state).map(id=>id===replaces?pending:id)
  const changed=await db.query(`UPDATE tenant_master SET staff_id=$2,co_staff_id=$3,third_staff_id=$4,
    pending_staff_id=NULL,pending_mode='replace',pending_replace_id=NULL WHERE tenant_id=$1`,[actor.tenant_id,ids[0],ids[1]??null,ids[2]??null])
  if(!changed.rowCount)throw forbidden()
  if(candidate.role!=='admin')await db.query("UPDATE staff SET role='admin' WHERE id=$1 AND tenant_id=$2",[pending,actor.tenant_id])
  // Re-authenticate the new master with their own MFA, revoke only the replaced
  // account, and never terminate the other continuing master's session.
  await db.query("DELETE FROM staff_session WHERE staff_id=ANY($1::uuid[]) AND session_kind='staff'",[[pending,...(replaces?[replaces]:[])]])
  if(replaces)await db.query('DELETE FROM master_password_reset WHERE staff_id=$1 AND tenant_id=$2',[replaces,actor.tenant_id])
  await audit(db,actor.tenant_id,null,actor.id,state.pending_mode==='add'?'agency.master_add':'agency.master_promote',pending,null,{previous_staff_id:replaces})
  return readAgencyMaster(db,actor)
}

export async function removeAgencyMaster(db:DB,actor:Actor,target:string) {
  await requireAgencyMasterAccess(db,actor)
  await scope(db,actor.tenant_id,undefined,true)
  await lockDispatch(db,actor.tenant_id)
  const state=await lockedMasterBinding(db,actor)
  await noPair(db,actor)
  if(!masterIds(state).includes(target))throw missing()
  if(!state.co_staff_id)throw new Fault(409,'MASTER_REQUIRED','最後のマスターは解除できません。先に後任を追加してください。')
  const remaining=masterIds(state).filter(id=>id!==target)
  const changed=await db.query(`UPDATE tenant_master SET staff_id=$2,co_staff_id=$3,third_staff_id=$4,pending_staff_id=NULL,
    pending_mode='replace',pending_replace_id=NULL WHERE tenant_id=$1`,[actor.tenant_id,remaining[0],remaining[1]??null,remaining[2]??null])
  if(!changed.rowCount)throw forbidden()
  await db.query("DELETE FROM staff_session WHERE staff_id=$1 AND tenant_id=$2 AND session_kind='staff'",[target,actor.tenant_id])
  await db.query('DELETE FROM master_password_reset WHERE staff_id=$1 AND tenant_id=$2',[target,actor.tenant_id])
  await audit(db,actor.tenant_id,null,actor.id,'agency.master_remove',target,null,{remaining_staff_id:remaining[0]})
  return readAgencyMaster(db,actor)
}


type PairState={id:string;mfa_required:boolean;former_primary:string;former_secondary:string|null;former_tertiary:string|null;first_staff_id:string;second_staff_id:string;third_staff_id:string|null}
async function readPair(db:DB,actor:Actor){
  const {rows:[pair]}=await db.query<PairState>('SELECT id,former_primary,former_secondary,former_tertiary,first_staff_id,second_staff_id,third_staff_id,mfa_required FROM agency_master_pair WHERE tenant_id=$1',[actor.tenant_id])
  if(!pair)return null
  const candidates=[pair.first_staff_id,pair.second_staff_id,...(pair.third_staff_id?[pair.third_staff_id]:[])]
  const {rows}=await db.query<{id:string;email:string;active:boolean;expires_at:Date|null}>(`SELECT f.id,f.email,f.password_hash IS NOT NULL AND f.disabled_at IS NULL AS active,i.expires_at
    FROM staff f LEFT JOIN invite i ON (f.tenant_id,f.id)=(i.tenant_id,i.staff_id) WHERE f.tenant_id=$1 AND f.id=ANY($2::uuid[])`,[actor.tenant_id,candidates])
  return {id:pair.id,mfa_required:pair.mfa_required,candidates:candidates.map(id=>rows.find(r=>r.id===id)!),former:[pair.former_primary,...(pair.former_secondary?[pair.former_secondary]:[]),...(pair.former_tertiary?[pair.former_tertiary]:[])]}
}
const pairExpired=()=>new Fault(409,'MASTER_PAIR_NOT_READY','全員が本人による登録を終えてから引き継ぎを確定してください。')
export async function inviteAgencyPair(db:DB,cfg:Config,actor:Actor,addresses:string[],key:string,mfaRequired=true){
  await requireAgencyMasterAccess(db,actor);await scope(db,actor.tenant_id,undefined,true)
  if(addresses.length<2||addresses.length>3||new Set(addresses).size!==addresses.length)throw new Fault(400,'MASTER_PAIR_EMAIL','担当者それぞれ異なるメールアドレスを入力してください。')
  return once(db,cfg,actor,'agency.master_pair_invite',key,{addresses,mfa_required:mfaRequired},async()=>{
    await lockDispatch(db,actor.tenant_id);const state=await lockedMasterBinding(db,actor)
    if(state.pending_staff_id)throw new Fault(409,'MASTER_SINGLE_PENDING','1名分の引き継ぎが進行中です。先にその手続きを完了してください。')
    const pending=await readPair(db,actor)
    if(pending&&(pending.mfa_required!==mfaRequired||pending.candidates.length!==addresses.length||!pending.candidates.every((c,i)=>c?.email===addresses[i])||pending.former.join()!==masterIds(state).join()))throw pairConflict()
    const parts=[]
    for(let i=0;i<addresses.length;i++){
      const address=addresses[i],current=pending?.candidates[i]
      if(current?.active){parts.push({id:current.id,email:address,active:true});continue}
      const {rows:[existing]}=await db.query<{id:string;role:string;agency_staff:boolean;platform_actor:boolean;disabled_at:Date|null;password_hash:string|null;mfa_required:boolean}>('SELECT id,role,agency_staff,platform_actor,disabled_at,password_hash,mfa_required FROM staff WHERE tenant_id=$1 AND email=$2 FOR UPDATE',[actor.tenant_id,address])
      if(existing?.password_hash&&!existing.disabled_at&&!existing.platform_actor&&existing.agency_staff&&existing.role==='admin'&&existing.mfa_required===mfaRequired&&!masterIds(state).includes(existing.id)){parts.push({id:existing.id,email:address,active:true});continue}
      const invite=await createInvite(db,cfg,actor.tenant_id,{email:address,role:'admin',stores:[],mfaRequired},actor.id)
      parts.push({id:invite.id,email:address,active:false,expires_at:invite.expires_at,url:cfg.origin+'/master/enrollment/#'+invite.invite_code})
    }
    const id=pending?.id??newId()
    if(!pending)await db.query(`INSERT INTO agency_master_pair(tenant_id,id,former_primary,former_secondary,former_tertiary,first_staff_id,second_staff_id,third_staff_id,mfa_required)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[actor.tenant_id,id,state.staff_id,state.co_staff_id,state.third_staff_id,parts[0].id,parts[1].id,parts[2]?.id??null,mfaRequired])
    await audit(db,actor.tenant_id,null,actor.id,'agency.master_pair_invite',id,null,{candidate_ids:parts.map(p=>p.id)})
    return {id,mfa_required:mfaRequired,candidates:parts}
  })
}
// Extend a pending two-person handoff without rotating either existing invitation.
export async function extendAgencyPair(db:DB,cfg:Config,actor:Actor,id:string,address:string,key:string){
  await requireAgencyMasterAccess(db,actor);await scope(db,actor.tenant_id,undefined,true)
  return once(db,cfg,actor,'agency.master_pair_extend',key,{id,address},async()=>{
    await lockDispatch(db,actor.tenant_id);const state=await lockedMasterBinding(db,actor),pair=await readPair(db,actor)
    if(!pair||pair.id!==id||state.pending_staff_id||pair.former.join()!==masterIds(state).join())throw conflict()
    if(pair.candidates.length>=3)throw fullMasters()
    if(pair.candidates.some(c=>c.email===address))throw new Fault(409,'MASTER_EXISTS','このメールアドレスは招待済みです。')
    const {rows:[existing]}=await db.query<{id:string}>('SELECT id FROM staff WHERE tenant_id=$1 AND email=$2',[actor.tenant_id,address])
    if(existing&&masterIds(state).includes(existing.id))throw new Fault(409,'MASTER_EXISTS','このアカウントは既にマスターです。')
    const invite=await createInvite(db,cfg,actor.tenant_id,{email:address,role:'admin',stores:[],mfaRequired:pair.mfa_required},actor.id)
    await db.query('UPDATE agency_master_pair SET third_staff_id=$3 WHERE tenant_id=$1 AND id=$2',[actor.tenant_id,id,invite.id])
    await audit(db,actor.tenant_id,null,actor.id,'agency.master_pair_extend',id,null,{candidate_id:invite.id})
    return {id,mfa_required:pair.mfa_required,candidates:[{id:invite.id,email:address,active:false,expires_at:invite.expires_at,url:cfg.origin+'/master/enrollment/#'+invite.invite_code}]}
  })
}
export async function confirmAgencyPair(db:DB,actor:Actor,id:string){
  await requireAgencyMasterAccess(db,actor);await scope(db,actor.tenant_id,undefined,true)
  await lockDispatch(db,actor.tenant_id);const state=await lockedMasterBinding(db,actor),pair=await readPair(db,actor)
  if(!pair||pair.id!==id||state.pending_staff_id||pair.former.join()!==masterIds(state).join())throw conflict()
  const ids=pair.candidates.map(c=>c.id)
  const {rows}=await db.query(`SELECT id FROM staff WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND role='admin' AND agency_staff AND NOT platform_actor
    AND password_hash IS NOT NULL AND disabled_at IS NULL AND mfa_required=$3 FOR UPDATE`,[actor.tenant_id,ids,pair.mfa_required])
  if(rows.length!==ids.length)throw pairExpired()
  if(!(await db.query('UPDATE tenant_master SET staff_id=$2,co_staff_id=$3,third_staff_id=$4 WHERE tenant_id=$1',[actor.tenant_id,ids[0],ids[1],ids[2]??null])).rowCount)throw forbidden()
  await db.query(`DELETE FROM staff_session WHERE tenant_id=$1 AND staff_id=ANY($2::uuid[]) AND session_kind='staff'`,[actor.tenant_id,[...pair.former,...ids]])
  await db.query('DELETE FROM master_password_reset WHERE tenant_id=$1 AND staff_id=ANY($2::uuid[])',[actor.tenant_id,pair.former])
  await db.query('DELETE FROM agency_master_pair WHERE tenant_id=$1 AND id=$2',[actor.tenant_id,id])
  await audit(db,actor.tenant_id,null,actor.id,'agency.master_pair_confirm',id,null,{candidate_ids:ids,previous_staff_ids:pair.former})
  return {completed:true}
}
export async function cancelAgencyPair(db:DB,actor:Actor,id:string){
  await requireAgencyMasterAccess(db,actor);await scope(db,actor.tenant_id,undefined,true)
  await lockDispatch(db,actor.tenant_id);await lockedMasterBinding(db,actor);const pair=await readPair(db,actor)
  if(!pair||pair.id!==id)throw conflict()
  // Activated candidates have no master authority. A cancellation preserves their
  // identity for a possible future handoff instead of sharing or resetting credentials.
  await db.query('DELETE FROM invite WHERE tenant_id=$1 AND staff_id=ANY($2::uuid[])',[actor.tenant_id,pair.candidates.map(c=>c.id)])
  await db.query('DELETE FROM agency_master_pair WHERE tenant_id=$1 AND id=$2',[actor.tenant_id,id])
  await audit(db,actor.tenant_id,null,actor.id,'agency.master_pair_cancel',id)
  return {cancelled:true}
}
