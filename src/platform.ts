import { authenticate } from './auth.js'
import { type Actor, type DB, audit, missing, newId, scope } from './core.js'

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
