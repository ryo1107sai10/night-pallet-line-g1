import { setTimeout as delay } from 'node:timers/promises'
import { assertAppRole, configFromEnvironment, poolFor } from './core.js'
import { LineAPI } from './line.js'
import { workOnce } from './jobs.js'

const cfg = configFromEnvironment()
const pool = poolFor(process.env.DATABASE_URL)
await assertAppRole(pool)
const api = new LineAPI()
let stopping = false
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { stopping = true })
while (!stopping) {
  try { await workOnce(pool,cfg,api) }
  catch (error) { console.error('worker iteration failed', error instanceof Error ? error.name : 'unknown') }
  await delay(1000)
}
await pool.end()
