import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import pg, { type PoolClient } from 'pg'
import { z } from 'zod'

export const uuid = z.uuid()
export const purpose = z.enum(['customer', 'recruitment'])
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/)
export const email = z.email().max(254).transform(value => value.toLowerCase())
export const text = (max: number) => z.string().trim().min(1).max(max)
export const revision = z.int().positive()
export const looseId = z.string().regex(/^[0-9]{5,20}$/)
export const userId = z.string().regex(/^U[0-9a-f]{32}$/i)
export const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export type DB = PoolClient
export type Actor = { id: string; tenant_id: string; role: string; email: string; platform?: boolean; agency?: boolean }
export type LineModuleConfig = { id: string; secret: string; botHeader: string }
export type Config = { origin: string; master: Buffer; external: boolean; automation?: boolean; automationStore?: string; lineModule?: LineModuleConfig; publicBookingConnection?: string }
export const automationForStore=(cfg:Config,store:string)=>
  cfg.external&&cfg.automation===true&&(!cfg.automationStore||cfg.automationStore===store)

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message)
  }
}

export const missing = () => new Fault(404, 'NOT_FOUND', '対象が見つかりません。')
export const conflict = () => new Fault(409, 'CONFLICT', '状態が変わりました。再読み込みして確認してください。')
export const forbidden = () => new Fault(403, 'FORBIDDEN', 'この操作を実行できる権限がありません。')
export const unauthenticated = () => new Fault(401, 'UNAUTHENTICATED', 'ログインしてください。')
export const json = (value: unknown) => JSON.stringify(value)
export const token = () => randomBytes(32).toString('base64url')
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const keyed = (cfg: Config, value: string) =>
  createHmac('sha256', cfg.master).update(value).digest('hex')

export function configFromEnvironment(): Config {
  const parsed = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('PUBLIC_ORIGIN must use HTTPS except on loopback.')
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_ORIGIN must be a bare origin.')
  }
  const master = Buffer.from(process.env.MASTER_KEY ?? '', 'base64')
  if (master.length !== 32) throw new Error('MASTER_KEY must contain 32 bytes in base64.')
  const module = z.object({
    id: looseId,
    secret: z.string().regex(/^[0-9a-f]{32}$/i),
    botHeader: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,79}$/)
      .refine(value => !['authorization','host','cookie','content-type','content-length','x-line-retry-key'].includes(value.toLowerCase())),
  }).safeParse({id:process.env.LINE_MODULE_CHANNEL_ID,secret:process.env.LINE_MODULE_CHANNEL_SECRET,
    botHeader:process.env.LINE_MODULE_BOT_HEADER})
  const booking=process.env.PUBLIC_BOOKING_CONNECTION
  const publicBookingConnection=booking ? uuid.parse(booking) : undefined
  return { origin: parsed.origin, master, publicBookingConnection, external: parsed.protocol === 'https:' && !loopback,
    automation: process.env.AUTO_SEND_ENABLED === 'true',
    automationStore: process.env.AUTO_SEND_STORE ? uuid.parse(process.env.AUTO_SEND_STORE) : undefined,
    lineModule:module.success?module.data:undefined }
}

export function seal(cfg: Config, context: string, value: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cfg.master, nonce)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')
}

export function unseal(cfg: Config, context: string, value: string) {
  const data = Buffer.from(value, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', cfg.master, data.subarray(0, 12))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}

export function poolFor(url: string | undefined) {
  if (!url) throw new Error('Database URL is required.')
  const pool = new pg.Pool({
    connectionString: url,
    // Session-mode proxies may not forward PostgreSQL startup options. Await
    // initialization on every new connection before it is used by the pool.
    onConnect: async client => {
      await client.query("SET search_path=night,pg_catalog; SET timezone='UTC'; SET statement_timeout=8000")
    },
    connectionTimeoutMillis: 5000,
  })
  // プールが idle クライアントのエラーを 'error' イベントとして再発火したとき、
  // 受け手が無いと EventEmitter が throw してプロセスが落ちる（DB再起動時の
  // 57P01 等）。既定の受け手を付け、記録だけしてプロセスは生かす。
  pool.on('error', error => {
    console.error('database pool error', error.message)
  })
  return pool
}

export async function assertAppRole(pool: pg.Pool) {
  const { rows } = await pool.query(`SELECT r.rolsuper OR r.rolbypassrls
    OR pg_has_role(current_user, c.relowner, 'MEMBER') AS privileged
    FROM pg_roles r JOIN pg_class c ON c.oid = to_regclass('night.tenant')
    WHERE r.rolname = current_user`)
  if (rows.length !== 1 || rows[0].privileged) throw new Error('Use a migrated database and a non-owner application role.')
}

export async function tx<T>(pool: pg.Pool, run: (db: DB) => Promise<T>) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const result = await run(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    db.release()
  }
}

export async function scope(db: DB, tenant: string, store?: string, allStores = false) {
  await db.query(`SELECT set_config('night.tenant', $1, true),
    set_config('night.store', $2, true), set_config('night.all_stores', $3, true)`,
    [tenant, store ?? '', allStores ? 'yes' : 'no'])
}

export type Route = { id: string; tenant_id: string; store_id: string; messaging_id: string | null;
  module_channel_id: string | null; module_bot_id: string | null }
export async function route(db: DB, channelId: string): Promise<Route> {
  const result = await db.query<Route>('SELECT * FROM channel_route WHERE id=$1', [channelId])
  if (!result.rows[0]) throw missing()
  return result.rows[0]
}

export async function audit(db: DB, tenant: string, store: string | null, actor: string | null,
  operation: string, object: string, reason: string | null = null, details: object = {}) {
  await db.query(`INSERT INTO audit (tenant_id,store_id,actor_id,operation,object_id,reason,details)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb ||
      CASE WHEN nullif(current_setting('night.platform_principal',true),'') IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('platform_staff_id',current_setting('night.platform_principal',true)) END)`,
  [tenant,store,actor,operation,object,reason,details])
}

export async function once<T>(db: DB, cfg: Config, actor: Actor, operation: string,
  key: string, input: unknown, action: () => Promise<T>) {
  const identity = [actor.tenant_id, actor.id, operation, key]
  const fingerprint = keyed(cfg, json(input))
  const inserted = await db.query(`INSERT INTO operation
    (tenant_id,actor_id,operation,operation_key,fingerprint,result) VALUES($1,$2,$3,$4,$5,'null')
    ON CONFLICT DO NOTHING RETURNING operation_key`, [...identity, fingerprint])
  if (!inserted.rowCount) {
    const { rows: [existing] } = await db.query(`SELECT fingerprint,result FROM operation
      WHERE (tenant_id,actor_id,operation,operation_key)=($1,$2,$3,$4)`, identity)
    if (existing.fingerprint !== fingerprint) throw conflict()
    return JSON.parse(unseal(cfg, json(identity), existing.result)) as T
  }
  const result = await action()
  const encrypted = seal(cfg, json(identity), json(result))
  await db.query(`UPDATE operation SET result=$5
    WHERE (tenant_id,actor_id,operation,operation_key)=($1,$2,$3,$4)`, [...identity, json(encrypted)])
  return result
}

export const newId = randomUUID
