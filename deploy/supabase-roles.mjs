// Create two narrowly scoped roles on a NEW Night PRO LINE Supabase project.
// The project administrator URL is expected to use the Session pooler.
// Do not reuse a project belonging to another application.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { poolFor, tx } from '../dist/core.js'

export async function createSupabaseRoles(adminAddress,output){
  if(!adminAddress||!output)throw new Error('Supply a dedicated Supabase admin URL and private output path.')
  const adminUrl=new URL(adminAddress)
  const role=decodeURIComponent(adminUrl.username)
  const match=/^postgres\.([a-z]{20})$/.exec(role)
  if(!match||!adminUrl.hostname.endsWith('.pooler.supabase.com')||
    (adminUrl.port&&adminUrl.port!=='5432')||adminUrl.pathname!=='/postgres'||
    adminUrl.searchParams.get('sslmode')!=='verify-full'||!adminUrl.password){
    throw new Error('Use the new project Session pooler (port 5432), postgres.<project-ref>, with TLS verification.')
  }
  const passwords={night_owner:randomBytes(32).toString('base64url'),night_app:randomBytes(32).toString('base64url')}
  const urls=Object.fromEntries(Object.entries(passwords).map(([name,password])=>{
    const url=new URL(adminUrl);url.username=name+'.'+match[1];url.password=password
    return [name,url.href]
  }))
  const admin=poolFor(adminUrl.href)
  try{
    await tx(admin,async db=>{
      const {rows:[state]}=await db.query(`SELECT current_user AS role,current_database() AS database,
        to_regnamespace('night') IS NOT NULL AS existing,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('night_owner','night_app')) AS roles`)
      if(state.role!=='postgres'||state.database!=='postgres'||state.existing||state.roles)throw new Error('Destination is not a fresh dedicated project.')
      for(const [name,password] of Object.entries(passwords)){
        const {rows:[stmt]}=await db.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",[name,password])
        await db.query(stmt.sql)
      }
      await db.query('GRANT CONNECT,CREATE ON DATABASE postgres TO night_owner')
      await db.query('GRANT CONNECT ON DATABASE postgres TO night_app')
      await db.query('GRANT night_owner TO postgres')
      // No new permissions on public/auth/storage schemas or Supabase HTTP API.
      await db.query("ALTER ROLE night_owner SET search_path=night,pg_catalog; ALTER ROLE night_app SET search_path=night,pg_catalog")
      writeFileSync(output,JSON.stringify({MIGRATION_DATABASE_URL:urls.night_owner,DATABASE_URL:urls.night_app},null,2),{mode:0o600,flag:'wx'})
    })
    console.log('Separate database roles created; URLs saved to the private file.')
  }finally{await admin.end()}
}

if(import.meta.main){
  try{await createSupabaseRoles(process.env.SUPABASE_ADMIN_DATABASE_URL,process.argv[2])}
  catch(error){console.error(error instanceof Error&&'code' in error?'Database role setup failed: '+error.code:error.message);process.exitCode=1}
}
