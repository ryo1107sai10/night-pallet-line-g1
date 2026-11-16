import { setTimeout as delay } from 'node:timers/promises'
import { assertAppRole, configFromEnvironment, poolFor } from './core.js'
import { LineAPI } from './line.js'
import { workOnce } from './jobs.js'
import { googleFromEnvironment } from './interview-availability.js'

const cfg = configFromEnvironment()
const pool = poolFor(process.env.DATABASE_URL)
const api = new LineAPI()
const google=googleFromEnvironment(cfg)
let stopping = false
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { stopping = true })
try {
  await assertAppRole(pool)
  if (process.argv.includes('--once')) {
    await workOnce(pool,cfg,api,google)
  } else while (!stopping) {
    try { await workOnce(pool,cfg,api,google) }
    catch (error) { console.error('worker iteration failed', error instanceof Error ? error.name : 'unknown') }
    await delay(1000)
  }
} finally {
  await pool.end()
}
