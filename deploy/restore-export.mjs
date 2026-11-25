// Restore a trusted Cloud SQL SQL export into a NEW PostgreSQL database schema.
// Never import over an existing night schema. Credentials are supplied only as
// environment variables, and row values are never printed.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { poolFor, assertAppRole } from '../dist/core.js'

const localHosts=new Set(['localhost','127.0.0.1','[::1]'])
const hashRows=rows=>createHash('sha256').update(rows.sort().join('\n')).digest('hex')

export function prepareExport(data){
  const lines=data.replace(/\r\n/g,'\n').split('\n')
  const dump=[],tables=[]
  let copy,schemas=0
  for(const line of lines){
    if(copy){
      dump.push(line)
      if(line==='\\.'){
        tables.push({table:copy.table,columns:copy.columns,count:copy.rows.length,sha256:hashRows(copy.rows)})
        copy=undefined
      }else copy.rows.push(line)
      continue
    }
    if(line==='GRANT ALL ON SCHEMA public TO cloudsqlsuperuser;')continue
    if(/^CREATE SCHEMA\b/.test(line)){
      if(line!=='CREATE SCHEMA night;')throw new Error('Unexpected schema in Cloud SQL export.')
      schemas++
    }
    if(line.startsWith('COPY ')){
      const match=/^COPY night\.([a-z_][a-z0-9_]*) \(([a-z0-9_, ]+)\) FROM stdin;$/.exec(line)
      if(!match)throw new Error('Unexpected COPY statement in Cloud SQL export.')
      copy={table:match[1],columns:match[2],rows:[]}
    }
    dump.push(line)
  }
  if(copy||schemas!==1||!tables.some(t=>t.table==='schema_migration')||new Set(tables.map(t=>t.table)).size!==tables.length){
    throw new Error('Incomplete or invalid Night PRO LINE export.')
  }
  return {sql:dump.join('\n'),tables}
}

function psqlEnv(url){
  const parsed=new URL(url)
  const local=localHosts.has(parsed.hostname)
  if(!local&&parsed.searchParams.get('sslmode')!=='verify-full')throw new Error('Remote database must verify its TLS certificate.')
  return {...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port||'5432',PGOPTIONS:'',
    PGDATABASE:decodeURIComponent(parsed.pathname.slice(1)),PGUSER:decodeURIComponent(parsed.username),
    PGPASSWORD:decodeURIComponent(parsed.password),PGSSLMODE:local?'disable':'verify-full',
    ...(local?{}:{PGSSLROOTCERT:parsed.searchParams.get('sslrootcert')||'system'}),PGTZ:'UTC',PGCONNECT_TIMEOUT:'10'}
}

function command(url,sql,extra=[]){
  const result=spawnSync(process.env.NIGHT_PSQL||'psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1',...extra,'-f','-'],{
    input:sql,encoding:'utf8',env:psqlEnv(url),maxBuffer:256*1024*1024,timeout:240000})
  if(result.status!==0||result.error){
    // PostgreSQL diagnostics can contain row values. Keep them in a private file.
    const log=process.env.NIGHT_RESTORE_ERROR_LOG
    if(log)writeFileSync(log,result.stderr||String(result.error||'psql failed'),{mode:0o600})
    throw new Error('PostgreSQL command did not complete successfully.'+(log?' See private diagnostic file.':''))
  }
  return result.stdout
}

export async function restoreExport(file,ownerUrl,adminUrl,appUrl){
  if(!ownerUrl||!adminUrl||!appUrl)throw new Error('Supply owner, validation and application connection URLs.')
  const prepared=prepareExport(gunzipSync(readFileSync(file)).toString('utf8'))
  const owner=poolFor(ownerUrl),admin=poolFor(adminUrl),app=poolFor(appUrl)
  try{
    const {rows:[privileges]}=await owner.query(`SELECT current_user AS role,to_regnamespace('night') IS NOT NULL AS existing,
      pg_has_role('night_app','night_owner','MEMBER') AS app_is_owner`)
    if(privileges.role!=='night_owner'||privileges.existing||privileges.app_is_owner)throw new Error('Destination must be a fresh schema with separate roles.')
    // Check the admin can independently validate rows protected by FORCE RLS.
    const {rows:[validation]}=await admin.query('SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname=current_user')
    if(!validation.allowed)throw new Error('Validation role cannot verify all restored rows.')
    command(ownerUrl,prepared.sql,['--single-transaction'])
    await assertAppRole(app)
    // Compare every table with the export, not just a few fixture records.
    // COPY uses the same canonical text format as pg_dump; row order is irrelevant.
    const marker='night_verify_'+randomBytes(12).toString('hex')
    const sql=prepared.tables.map(t=>`\\echo ${marker}:${t.table}\nCOPY night.${t.table} (${t.columns}) TO STDOUT;`).join('\n')+'\n'
    const verified=new Map()
    let current
    for(const line of command(adminUrl,sql).replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n')){
      if(line.startsWith(marker+':')){
        current=[];verified.set(line.slice(marker.length+1),current)
      }else if(current)current.push(line)
    }
    for(const t of prepared.tables){
      const rows=verified.get(t.table)
      if(!rows||rows.length!==t.count||hashRows(rows)!==t.sha256)throw new Error('Restored data differs in '+t.table)
    }
    // Verify the schema and that an unscoped app role cannot see business rows.
    const {rows:[roles]}=await app.query(`SELECT current_user AS role,
      (SELECT count(*) FROM night.tenant)::int AS unscoped_tenants,
      (SELECT count(*) FROM night.store)::int AS unscoped_stores`)
    if(roles.role!=='night_app'||roles.unscoped_tenants!==0||roles.unscoped_stores!==0)throw new Error('Runtime data isolation check failed.')
    console.log(JSON.stringify({status:'verified',tables:prepared.tables.length,rows:prepared.tables.reduce((n,t)=>n+t.count,0),role:'night_app',unscoped_tenants:0,unscoped_stores:0}))
  }finally{
    await Promise.allSettled([owner.end(),admin.end(),app.end()])
  }
}

if(import.meta.main){
  try{await restoreExport(process.argv[2],process.env.MIGRATION_DATABASE_URL,process.env.VALIDATION_DATABASE_URL,process.env.DATABASE_URL)}
  catch(error){console.error(error instanceof Error?error.message:'Restore failed');process.exitCode=1}
}
