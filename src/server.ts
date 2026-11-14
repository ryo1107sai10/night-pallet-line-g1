import { createApp } from './app.js'
import { assertAppRole, configFromEnvironment, poolFor } from './core.js'

const cfg = configFromEnvironment()
const pool = poolFor(process.env.DATABASE_URL)
await assertAppRole(pool)
const host = process.env.BIND_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? new URL(cfg.origin).port) || 3000
const server = createApp(pool,cfg).listen(port,host,()=>console.log('Night PRO LINE ' + cfg.origin))
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.on(signal,()=>server.close(()=>void pool.end()))
}
