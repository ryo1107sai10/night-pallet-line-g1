import type { DB } from './core.js'

export async function lockDispatch(db: DB, tenant: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,117))', [tenant])
}
