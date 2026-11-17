import { authenticate, createInvite } from './auth.js'
import { type Actor, type Config, type DB, Fault, audit, conflict, forbidden, missing, newId, once, scope } from './core.js'

import { lockDispatch } from './dispatch-lock.js'

export const platformWorkspace = '/platform/tenants'

async function supervisedAgency(db:DB,principal:Actor) {
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
  const {agency_id}=await supervisedAgency(db,principal)
  await scope(db,agency_id,undefined,true)
  const {rows}=await db.query(`SELECT id,slug,legal_name,stopped,
    (SELECT count(*)::int FROM store WHERE tenant_id=tenant.id) AS stores
    FROM tenant WHERE id=$1 AND NOT supervisor_only`,[agency_id])
  return rows
}

async function enterAgencyScope(db:DB,credential:string|undefined,tenant:string) {
  const principal=await authenticate(db,credential,'platform')
  if ((await supervisedAgency(db,principal)).agency_id!==tenant) throw missing()
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

function requireSupervisor(actor:Actor) {
  if(!actor.platform)throw forbidden()
}

export async function agencyMasterDetails(db:DB,actor:Actor) {
  requireSupervisor(actor)
  await scope(db,actor.tenant_id,undefined,true)
  const {rows:[state]}=await db.query(`SELECT current.email AS current_email, next.id AS pending_id,
    next.email AS pending_email,next.password_hash IS NOT NULL AS pending_active,i.expires_at
    FROM tenant_master m JOIN staff current ON (m.tenant_id,m.staff_id)=(current.tenant_id,current.id)
    LEFT JOIN staff next ON (m.tenant_id,m.pending_staff_id)=(next.tenant_id,next.id) AND next.disabled_at IS NULL
    LEFT JOIN invite i ON (i.tenant_id,i.staff_id)=(next.tenant_id,next.id)
    WHERE m.tenant_id=$1`,[actor.tenant_id])
  if(!state)throw missing()
  return state
}

export async function inviteAgencyMaster(db:DB,cfg:Config,actor:Actor,address:string,key:string) {
  requireSupervisor(actor)
  await scope(db,actor.tenant_id,undefined,true)
  return once(db,cfg,actor,'agency.master_invite',key,{email:address},async()=>{
    await lockDispatch(db,actor.tenant_id)
    const {rows:[state]}=await db.query(`SELECT pending_staff_id FROM tenant_master WHERE tenant_id=$1 FOR UPDATE`,[actor.tenant_id])
    if(!state)throw missing()
    const invite=await createInvite(db,cfg,actor.tenant_id,{email:address,role:'admin',stores:[]},actor.id)
    const changed=await db.query('UPDATE tenant_master SET pending_staff_id=$2 WHERE tenant_id=$1',[actor.tenant_id,invite.id])
    if(!changed.rowCount)throw forbidden()
    await audit(db,actor.tenant_id,null,actor.id,'agency.master_invite',invite.id)
    return invite
  })
}

export async function promoteAgencyMaster(db:DB,actor:Actor,pending:string) {
  requireSupervisor(actor)
  await scope(db,actor.tenant_id,undefined,true)
  await lockDispatch(db,actor.tenant_id)
  const {rows:[state]}=await db.query<{staff_id:string;pending_staff_id:string|null}>(
    'SELECT staff_id,pending_staff_id FROM tenant_master WHERE tenant_id=$1 FOR UPDATE',[actor.tenant_id])
  if(!state||state.pending_staff_id!==pending)throw conflict()
  const candidate=await db.query(`SELECT 1 FROM staff WHERE id=$1 AND role='admin' AND NOT platform_actor
    AND password_hash IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,[pending])
  if(!candidate.rowCount)throw new Fault(409,'MASTER_NOT_ACTIVE','新しいマスターが招待を有効化してから切り替えてください。')
  const changed=await db.query('UPDATE tenant_master SET staff_id=$2,pending_staff_id=NULL WHERE tenant_id=$1',[actor.tenant_id,pending])
  if(!changed.rowCount)throw forbidden()
  await db.query("DELETE FROM staff_session WHERE staff_id=$1 AND session_kind='staff'",[state.staff_id])
  await audit(db,actor.tenant_id,null,actor.id,'agency.master_promote',pending,null,{previous_staff_id:state.staff_id})
  return agencyMasterDetails(db,actor)
}
