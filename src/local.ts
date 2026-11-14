import { randomBytes } from 'node:crypto'
import { mkdir,readFile,writeFile,access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import EmbeddedPostgres from 'embedded-postgres'
import { createApp } from './app.js'
import { assertAppRole, configFromEnvironment, poolFor, tx } from './core.js'
import { bootstrap, migrate } from './setup.js'
import { workOnce } from './jobs.js'
import { LineAPI } from './line.js'

const dir = resolve('.local')
await mkdir(dir,{mode:0o700,recursive:true})
const configFile = resolve(dir,'secrets.json')
let local
try { local = JSON.parse(await readFile(configFile,'utf8')) }
catch(error) {
  if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error
  local = {
    master:randomBytes(32).toString('base64'), dbOwner:randomBytes(24).toString('hex'),
    dbApp:randomBytes(24).toString('hex'),
  }
  await writeFile(configFile,JSON.stringify(local),{mode:0o600,flag:'wx'})
}
const dbPort = Number(process.env.LOCAL_DB_PORT ?? 55432)
const port = Number(process.env.LOCAL_WEB_PORT ?? 3000)
if (![dbPort,port].every(value=>Number.isInteger(value) && value>1024 && value<65536)) {
  throw new Error('Set valid local web and database ports.')
}
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:' + port
process.env.MASTER_KEY = local.master
const cfg = configFromEnvironment()
const databaseDir = resolve(dir,'postgres')
const pg = new EmbeddedPostgres({databaseDir, port:dbPort, user:'night_owner',password:local.dbOwner,
  authMethod:'scram-sha-256',persistent:true,initdbFlags:['--locale=C','--encoding=UTF8'],
  postgresFlags:['-h','127.0.0.1','-c','unix_socket_directories='],onLog:()=>undefined,
})
try { await access(resolve(databaseDir,'PG_VERSION')) }
catch { await pg.initialise() }
await pg.start()
const migrationDb = poolFor(`postgresql://night_owner:${local.dbOwner}@127.0.0.1:${dbPort}/postgres`)
const appDb = poolFor(`postgresql://night_app:${local.dbApp}@127.0.0.1:${dbPort}/postgres`)
try {
  await tx(migrationDb,async db=>{
    if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname='night_app'")).rowCount) {
      if (!/^[0-9a-f]{48}$/.test(local.dbApp)) throw new Error('Invalid local database password.')
      await db.query(`CREATE ROLE night_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${local.dbApp}'`)
    }
  })
  await migrate(migrationDb,'night_app')
  const tenant = await migrationDb.query("SELECT 1 FROM tenant_route WHERE slug='demo'")
  if (!tenant.rowCount || process.argv.includes('--renew-invite')) {
    const invite = await bootstrap(migrationDb,cfg,{slug:'demo',name:'検証用法人',email:'admin@example.test'})
    const destination = resolve(dir,'first-invite.json')
    await writeFile(destination,JSON.stringify(invite,null,2),{mode:0o600})
    console.log('初回招待を .local/first-invite.json に保存しました。法人IDは demo、メールは admin@example.test です。')
  }
  await assertAppRole(appDb)
  const engine = new LineAPI()
  let stop!: () => void
  const stopped = new Promise<void>(resolveStop=>{ stop=resolveStop })
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,stop)
  const server = createApp(appDb,cfg,engine).listen(port,'127.0.0.1')
  server.on('error',error=>{ console.error(error.message); stop() })
  server.on('listening',()=>console.log('管理画面  ' + cfg.origin))
  let finished = false
  const worker = (async ()=>{
    while (!finished) {
      try { await workOnce(appDb,cfg,engine) } catch { console.error('worker iteration failed') }
      await delay(1000)
    }
  })()
  await stopped
  finished = true
  await new Promise<void>(resolveClose=>server.close(()=>resolveClose()))
  await worker
} finally {
  await Promise.all([migrationDb.end(),appDb.end()])
  await pg.stop()
}
