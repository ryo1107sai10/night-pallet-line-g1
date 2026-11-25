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
    JOIN staff f ON m.tenant_id=f.tenant_id AND f.id IN (m.staff_id,m.co_staff_id)
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
    co.id AS co_id,co.email AS co_email,co.password_hash IS NOT NULL AND co.disabled_at IS NULL AS co_active,next.id AS pending_id,
    next.email AS pending_email,next.password_hash IS NOT NULL AS pending_active,i.expires_at,
    m.pending_mode,target.id AS pending_replace_id,target.email AS pending_replace_email
    FROM tenant_master m JOIN staff current ON (m.tenant_id,m.staff_id)=(current.tenant_id,current.id)
    LEFT JOIN staff co ON (m.tenant_id,m.co_staff_id)=(co.tenant_id,co.id)
    LEFT JOIN staff next ON (m.tenant_id,m.pending_staff_id)=(next.tenant_id,next.id) AND next.disabled_at IS NULL
    LEFT JOIN invite i ON (i.tenant_id,i.staff_id)=(next.tenant_id,next.id)
    LEFT JOIN staff target ON m.pending_staff_id IS NOT NULL AND m.pending_mode='replace'
      AND target.tenant_id=m.tenant_id AND target.id=coalesce(m.pending_replace_id,m.staff_id)
    WHERE m.tenant_id=$1`,[actor.tenant_id])
  if(!state)throw missing()
  return {...state,master_limit:2,masters:[{id:state.current_id,email:state.current_email,active:state.current_active},
    ...(state.co_id?[{id:state.co_id,email:state.co_email,active:state.co_active}]:[])]}
}

export async function agencyMasterDetails(db:DB,actor:Actor) {
  await requireAgencyMasterAccess(db,actor)
  return readAgencyMaster(db,actor)
}

type MasterChange = {mode:'add'|'replace';replace_id?:string}
type MasterBinding = {staff_id:string;co_staff_id:string|null;pending_staff_id:string|null;
  pending_mode:'add'|'replace';pending_replace_id:string|null}
async function lockedMasterBinding(db:DB,actor:Actor) {
  const {rows:[state]}=await db.query<MasterBinding>(`SELECT staff_id,co_staff_id,pending_staff_id,pending_mode,pending_replace_id
    FROM tenant_master WHERE tenant_id=$1 FOR UPDATE`,[actor.tenant_id])
  if(!state)throw missing()
  if(!actor.platform&&![state.staff_id,state.co_staff_id].includes(actor.id))throw forbidden()
  return state
}
const fullMasters=()=>new Fault(409,'MASTER_LIMIT','マスターは2名までです。交代するマスターを選ぶか、兼任を解除してください。')

export async function inviteAgencyMaster(db:DB,cfg:Config,actor:Actor,address:string,key:string,change:MasterChange={mode:'replace'}) {
  await requireAgencyMasterAccess(db,actor)
  await scope(db,actor.tenant_id,undefined,true)
  return once(db,cfg,actor,'agency.master_invite',key,{email:address,...change},async()=>{
    await lockDispatch(db,actor.tenant_id)
    const state=await lockedMasterBinding(db,actor)
    if(change.mode==='add'&&state.co_staff_id)throw fullMasters()
    const replaceId=change.mode==='replace'?(change.replace_id??state.staff_id):null
    if(change.mode==='add'&&change.replace_id||replaceId&&![state.staff_id,state.co_staff_id].includes(replaceId))throw conflict()
    const {rows:[existing]}=await db.query<{id:string;password_hash:string|null;disabled_at:Date|null;platform_actor:boolean;agency_staff:boolean;role:string}>(
      `SELECT id,password_hash,disabled_at,platform_actor,agency_staff,role FROM staff WHERE tenant_id=$1 AND email=$2 FOR UPDATE`,[actor.tenant_id,address])
    if(existing&&[state.staff_id,state.co_staff_id].includes(existing.id))throw new Fault(409,'MASTER_EXISTS','このアカウントは既にマスターです。')
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
  if(state.pending_staff_id!==pending)throw conflict()
  const replaces=state.pending_mode==='replace'?(state.pending_replace_id??state.staff_id):null
  // A second operator may have replaced the pending invitation while this page
  // was open. Never let a confirmation for "add" become a handover (or switch
  // the target seat). Keep the original implicit replacement API compatible.
  if(expected){
    if(expected.mode!==state.pending_mode||(expected.replace_id??null)!==replaces)throw conflict()
  }else if(state.pending_mode!=='replace'||state.pending_replace_id!==null)throw conflict()
  if(state.pending_mode==='add'&&state.co_staff_id)throw fullMasters()
  const {rows:[candidate]}=await db.query<{role:string}>(`SELECT role FROM staff WHERE id=$1 AND tenant_id=$2
    AND (role='admin' OR agency_staff) AND NOT platform_actor AND password_hash IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,[pending,actor.tenant_id])
  if(!candidate)throw new Fault(409,'MASTER_NOT_ACTIVE','新しいマスター本人が招待を有効化してから確定してください。')
  if(replaces&&![state.staff_id,state.co_staff_id].includes(replaces))throw conflict()
  const primary=replaces===state.staff_id?pending:state.staff_id
  const secondary=state.pending_mode==='add'||replaces===state.co_staff_id?pending:state.co_staff_id
  const changed=await db.query(`UPDATE tenant_master SET staff_id=$2,co_staff_id=$3,
    pending_staff_id=NULL,pending_mode='replace',pending_replace_id=NULL WHERE tenant_id=$1`,[actor.tenant_id,primary,secondary])
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
  if(![state.staff_id,state.co_staff_id].includes(target))throw missing()
  if(!state.co_staff_id)throw new Fault(409,'MASTER_REQUIRED','最後のマスターは解除できません。先に後任を追加してください。')
  const remaining=target===state.staff_id?state.co_staff_id:state.staff_id
  const changed=await db.query(`UPDATE tenant_master SET staff_id=$2,co_staff_id=NULL,pending_staff_id=NULL,
    pending_mode='replace',pending_replace_id=NULL WHERE tenant_id=$1`,[actor.tenant_id,remaining])
  if(!changed.rowCount)throw forbidden()
  await db.query("DELETE FROM staff_session WHERE staff_id=$1 AND tenant_id=$2 AND session_kind='staff'",[target,actor.tenant_id])
  await db.query('DELETE FROM master_password_reset WHERE staff_id=$1 AND tenant_id=$2',[target,actor.tenant_id])
  await audit(db,actor.tenant_id,null,actor.id,'agency.master_remove',target,null,{remaining_staff_id:remaining})
  return readAgencyMaster(db,actor)
}
