import { readFile } from 'node:fs/promises'
import type pg from 'pg'
import { z } from 'zod'
import { configFromEnvironment, email, newId, poolFor, scope, slug, text, tx } from './core.js'
import { createInvite } from './auth.js'

export async function migrate(pool: pg.Pool, role: string) {
  if (!/^[a-z][a-z0-9_]{0,61}$/.test(role)) throw new Error('Invalid application role.')
  const versions = ['001_g1','002_scenarios']
  await tx(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('night.migrate'))")
    await db.query('CREATE SCHEMA IF NOT EXISTS night')
    await db.query('CREATE TABLE IF NOT EXISTS night.schema_migration(version text PRIMARY KEY)')
    for (const version of versions) {
      if ((await db.query('SELECT 1 FROM night.schema_migration WHERE version=$1',[version])).rowCount) continue
      await db.query(await readFile(new URL('../db/'+version+'.sql',import.meta.url),'utf8'))
      await db.query('INSERT INTO night.schema_migration VALUES($1)',[version])
    }
    await db.query(`GRANT USAGE ON SCHEMA night TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.staff,night.staff_session,night.invite,
      night.invite_route,night.auth_rate,night.operation,night.tester,night.test_send,night.channel_relationship,
      night.webhook_event,night.store_grant,night.channel,night.store TO ${role}`)
    await db.query(`GRANT SELECT ON night.tenant_route TO ${role}`)
    await db.query(`GRANT SELECT,UPDATE ON night.tenant TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.scenario TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.scenario_version TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.channel_route,night.audit TO ${role}`)
    await db.query(`GRANT USAGE ON SEQUENCE night.audit_id_seq TO ${role}`)
  })
}

export async function bootstrap(pool: pg.Pool, cfg: ReturnType<typeof configFromEnvironment>,
  data: { slug: string; name: string; email: string; billing_contact?: string }) {
  return tx(pool, async db => {
    const id = newId()
    await scope(db,id,undefined,true)
    const { rows: [registered] } = await db.query('SELECT tenant_id FROM tenant_route WHERE slug=$1',[data.slug])
    if (registered) {
      await scope(db,registered.tenant_id)
      const { rows: [first] } = await db.query(`SELECT 1 FROM staff WHERE tenant_id=$2 AND email=$1 AND role='admin'
        AND password_hash IS NULL AND disabled_at IS NULL`,[data.email,registered.tenant_id])
      if (!first) throw new Error('法人IDは既に使用されています。')
      return createInvite(db,cfg,registered.tenant_id,{email:data.email,role:'admin',stores:[]},null)
    }
    await db.query('INSERT INTO tenant(id,slug,legal_name,billing_contact) VALUES($1,$2,$3,$4)',
      [id,data.slug,data.name,data.billing_contact ?? data.email])
    await db.query('INSERT INTO tenant_route VALUES($1,$2)',[data.slug,id])
    return createInvite(db,cfg,id,{email:data.email,role:'admin',stores:[]},null)
  })
}

if (import.meta.main) {
  const migrationPool = poolFor(process.env.MIGRATION_DATABASE_URL)
  const url = process.env.DATABASE_URL
  try {
    await migrate(migrationPool, decodeURIComponent(new URL(url ?? '').username))
    const [tenant, name, address, billing] = process.argv.slice(2)
    if (tenant) {
      const data = z.object({ slug, name:text(120), email, billing_contact:email.optional() })
        .parse({slug:tenant,name,email:address,billing_contact:billing})
      console.log(JSON.stringify(await bootstrap(migrationPool,configFromEnvironment(),data),null,2))
    } else {
      console.log('PostgreSQL マイグレーション適用済み。')
    }
  } finally {
    await migrationPool.end()
  }
}
