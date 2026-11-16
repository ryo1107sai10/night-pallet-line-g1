import { open, unlink } from 'node:fs/promises'
import { configFromEnvironment, email, poolFor, slug, text, tx, assertAppRole } from './core.js'
import { bootstrap, migrate } from './setup.js'

const pilotRoles = { owner: 'night_owner', app: 'night_app' }

function connection(variable: string, role?: string) {
  const url = process.env[variable]
  if (!url) throw new Error(variable + ' is required.')
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.pathname !== '/night' || parsed.searchParams.has('host') ||
      (role && decodeURIComponent(parsed.username) !== role)) {
    throw new Error(variable + ' must connect to the dedicated night database' + (role ? ' as ' + role : '') + '.')
  }
  return { url, password: decodeURIComponent(parsed.password), address: parsed.hostname + ':' + parsed.port }
}

async function provisionRoles(adminUrl: string, ownerPassword: string, appPassword: string) {
  const admin = poolFor(adminUrl)
  try {
    await tx(admin, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('night.pilot_roles'))")
      for (const [role, password] of [[pilotRoles.owner, ownerPassword], [pilotRoles.app, appPassword]]) {
        const { rows: [current] } = await db.query(
          'SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1', [role])
        if (!current) {
          const { rows: [format] } = await db.query(
            "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql",
            [role, password])
          await db.query(format.sql)
        } else if (!current.rolcanlogin || current.rolsuper || current.rolbypassrls || current.rolcreatedb || current.rolcreaterole) {
          throw new Error('Existing database role has unexpected privileges: ' + role)
        }
      }
      const { rows: [membership] } = await db.query("SELECT pg_has_role('night_app','night_owner','MEMBER') AS present")
      if (membership.present) throw new Error('The runtime role must be separate from the migration role.')
      await db.query('GRANT CONNECT,CREATE ON DATABASE night TO night_owner')
      await db.query('GRANT CONNECT ON DATABASE night TO night_app')
    })
  } finally { await admin.end() }
}

async function main() {
  const [tenant, name, address, inviteFile] = process.argv.slice(2)
  if (!tenant || !name || !address || !inviteFile) {
    throw new Error('Usage: node dist/pilot-db.js <tenant> <name> <administrator-email> <private-invite-file>')
  }
  const operator = { slug:slug.parse(tenant), name:text(120).parse(name), email:email.parse(address) }
  const admin = connection('PILOT_ADMIN_DATABASE_URL')
  const owner = connection('MIGRATION_DATABASE_URL', pilotRoles.owner)
  const app = connection('DATABASE_URL', pilotRoles.app)
  if (admin.address !== owner.address || owner.address !== app.address) {
    throw new Error('All database connections must target the same dedicated PostgreSQL server.')
  }
  if (!admin.password || owner.password.length < 24 || app.password.length < 24 ||
      new Set([admin.password, owner.password, app.password]).size !== 3) {
    throw new Error('Use a different password for each role, and at least 24 characters for the new roles.')
  }
  const cfg = configFromEnvironment()
  const file = await open(inviteFile, 'wx', 0o600)
  let written = false
  try {
    await provisionRoles(admin.url, owner.password, app.password)
    const migration = poolFor(owner.url)
    const runtime = poolFor(app.url)
    try {
      await migrate(migration, pilotRoles.app)
      await assertAppRole(runtime)
      const invite = await bootstrap(migration, cfg, operator)
      await file.writeFile(JSON.stringify(invite, null, 2) + '\n')
      written = true
    } finally { await Promise.all([migration.end(), runtime.end()]) }
    console.log('Database schema and a private administrator invitation are ready.')
  } finally {
    await file.close()
    if (!written) await unlink(inviteFile)
  }
}

await main().catch(error => {
  const code = typeof error === 'object' && error && 'code' in error ? ' (' + String(error.code) + ')' : ''
  const message = error instanceof Error && !code ? error.message : 'Database setup failed' + code
  console.error(message)
  process.exitCode = 1
})
