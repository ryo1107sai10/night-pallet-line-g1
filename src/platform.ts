import { authenticate } from './auth.js'
import { type Actor, type DB, audit, missing, newId, scope } from './core.js'

export const platformWorkspace = '/platform/tenants'

export async function platformTenants(db:DB,credential:string|undefined) {
  await authenticate(db,credential,'platform')
  const {rows}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route ORDER BY slug')
  const tenants=[]
  for (const {tenant_id} of rows) {
    await scope(db,tenant_id,undefined,true)
    const {rows:[tenant]}=await db.query(`SELECT id,slug,legal_name,stopped,
      (SELECT count(*)::int FROM store WHERE tenant_id=tenant.id) AS stores FROM tenant WHERE id=$1`,[tenant_id])
    if (tenant) tenants.push(tenant)
  }
  return tenants
}

async function scopedActor(db:DB,principal:Actor,tenant:string):Promise<Actor> {
  await scope(db,tenant,undefined,true)
  const {rows:[actor]}=await db.query<{id:string}>(`SELECT id FROM staff WHERE tenant_id=$1 AND platform_actor`,[tenant])
  if (!actor) throw missing()
  await db.query("SELECT set_config('night.platform_principal',$1,true)",[principal.id])
  return {id:actor.id,tenant_id:tenant,role:'admin',email:principal.email,platform:true}
}

export async function authenticatePlatformWorkspace(db:DB,credential:string|undefined,tenant:string) {
  return scopedActor(db,await authenticate(db,credential,'platform'),tenant)
}

export async function enterPlatformTenant(db:DB,credential:string|undefined,tenant:string) {
  const principal=await authenticate(db,credential,'platform')
  await scope(db,tenant,undefined,true)
  if (!(await db.query('SELECT 1 FROM tenant WHERE id=$1',[tenant])).rowCount) throw missing()
  // Keep tenant foreign keys and store policies in force for platform operations.
  await db.query(`INSERT INTO staff (id,tenant_id,email,role,totp_secret,platform_actor)
    VALUES($1,$2,$3,'admin','',true)
    ON CONFLICT (tenant_id) WHERE platform_actor DO NOTHING`,[newId(),tenant,'platform+'+tenant+'@internal.invalid'])
  const actor=await scopedActor(db,principal,tenant)
  await audit(db,tenant,null,actor.id,'platform.tenant_opened',tenant)
  return {url:platformWorkspace+'/'+tenant+'/master/'}
}
