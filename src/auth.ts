import { scrypt, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { Secret, TOTP } from 'otpauth'
import { z } from 'zod'
import {
  type Config, type DB, type Actor, Fault, audit, conflict, digest, email, forbidden, keyed,
  missing, newId, opaque, scope, seal, slug, token, tx, unauthenticated, unseal, uuid,
} from './core.js'

const sessionHours = 8
const factor = z.string().regex(/^\d{6}$/)
export const password = z.string().min(12).max(128)
const loginPassword = z.string().min(1).max(128)
export const memberRole = z.enum(['admin', 'manager', 'sales', 'recruiter', 'reporter'])
const loginSchema = z.strictObject({ tenant: slug, email, password: loginPassword, code: factor })
const acceptSchema = z.strictObject({ invite: opaque, password, code: factor })
type StaffRow = Actor & {
  disabled_at: Date | null; password_hash: string | null; totp_secret: string; last_totp_step: string
}

function derive(pass: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(pass, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 },
      (error, value) => error ? reject(error) : resolve(value))
  })
}

async function hashPassword(pass: string) {
  const salt = token()
  return salt + ':' + (await derive(pass, salt)).toString('hex')
}

async function verifyPassword(pass: string, hash?: string | null) {
  const [salt, hex] = hash?.split(':') ?? ['unregistered-account', '00'.repeat(64)]
  const actual = await derive(pass, salt)
  return timingSafeEqual(actual, Buffer.from(hex, 'hex')) && !!hash
}

function otp(secret: string, label = '') {
  return new TOTP({ issuer: 'NIGHT pallet LINE', label, secret: Secret.fromBase32(secret) })
}

function consumeFactor(cfg: Config, staff: StaffRow, value: string) {
  const secret = unseal(cfg, 'totp:' + staff.id, staff.totp_secret)
  const now = Date.now()
  const delta = otp(secret).validate({ token: value, timestamp: now, window: 1 })
  const step = Math.floor(now / 30000) + (delta ?? 0)
  return delta !== null && step > Number(staff.last_totp_step) ? step : null
}

async function rate(db: DB, key: string, limit: number) {
  const { rows: [row] } = await db.query(`INSERT INTO auth_rate (rate_key,bucket,attempts)
    VALUES ($1,date_trunc('minute',now()),1)
    ON CONFLICT (rate_key) DO UPDATE SET bucket=excluded.bucket,
      attempts=CASE WHEN auth_rate.bucket=excluded.bucket THEN auth_rate.attempts+1 ELSE 1 END
    RETURNING attempts`, [key])
  return row.attempts <= limit
}

export async function gate(pool: pg.Pool, cfg: Config, key: string, limit: number) {
  if (!(await tx(pool, db => rate(db, keyed(cfg, key), limit)))) {
    throw new Fault(429, 'RATE_LIMIT', '少し時間をおいてから再試行してください。', true)
  }
}

export function sessionCookie(cfg: Config, value = '') {
  const duration = value ? sessionHours * 3600 : 0
  return `night_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duration}` +
    (cfg.origin.startsWith('https:') ? '; Secure' : '')
}

export async function login(pool: pg.Pool, cfg: Config, input: unknown, ip: string) {
  const data = loginSchema.parse(input)
  await gate(pool, cfg, 'login-ip:' + ip, 40)
  await gate(pool, cfg, 'login-account:' + data.tenant + ':' + data.email, 8)
  const result = await tx(pool, async db => {
    const { rows: [directory] } = await db.query('SELECT tenant_id FROM tenant_route WHERE slug=$1', [data.tenant])
    if (directory) await scope(db, directory.tenant_id)
    const { rows: [staff] } = await db.query<StaffRow>(
      'SELECT * FROM staff WHERE email=$1 FOR UPDATE', [data.email])
    const passOk = await verifyPassword(data.password, staff?.password_hash)
    if (!staff || staff.disabled_at || !passOk) return null
    const step = consumeFactor(cfg, staff, data.code)
    if (step === null) return null
    const raw = token()
    await db.query('UPDATE staff SET last_totp_step=$2 WHERE id=$1', [staff.id, step])
    await db.query(`INSERT INTO staff_session VALUES ($1,$2,$3,now()+ interval '8 hours')`,
      [digest(raw), staff.tenant_id, staff.id])
    await db.query('SELECT set_config(\'night.all_stores\', \'yes\', true)')
    await audit(db, staff.tenant_id, null, staff.id, 'staff.login', staff.id)
    return staff.tenant_id + '.' + raw
  })
  if (!result) throw new Fault(401, 'INVALID_LOGIN', '法人ID・メール・パスワード・認証コードを確認してください。')
  return result
}

export async function authenticate(db: DB, credential: string | undefined) {
  const [tenantId, raw, extra] = (credential ?? '').split('.')
  if (extra !== undefined || !uuid.safeParse(tenantId).success || !opaque.safeParse(raw).success) {
    throw unauthenticated()
  }
  await scope(db, tenantId)
  const { rows: [actor] } = await db.query<Actor>(`SELECT f.id,f.tenant_id,f.role,f.email
    FROM staff_session s JOIN staff f ON (s.tenant_id,s.staff_id)=(f.tenant_id,f.id)
    WHERE s.token_hash=$1 AND s.expires_at>now() AND f.disabled_at IS NULL AND f.password_hash IS NOT NULL FOR SHARE OF f`,
    [digest(raw)])
  if (!actor) throw unauthenticated()
  return actor
}

export async function logout(db: DB, credential: string) {
  await db.query('DELETE FROM staff_session WHERE token_hash=$1', [digest(credential.split('.')[1])])
}

export async function storeAccess(db: DB, actor: Actor, storeId: string, manage = false) {
  if (manage && !['admin', 'manager'].includes(actor.role)) throw forbidden()
  await scope(db, actor.tenant_id, storeId)
  const result = await db.query(`SELECT s.id FROM store s WHERE s.id=$1 AND ($2='admin' OR EXISTS
    (SELECT 1 FROM store_grant g WHERE g.store_id=s.id AND g.staff_id=$3))`,
    [storeId, actor.role, actor.id])
  if (!result.rowCount) throw missing()
}

export async function storeList(db: DB, actor: Actor) {
  await scope(db, actor.tenant_id, undefined, true)
  const { rows } = await db.query(`SELECT s.id,s.name,s.address,s.business_type,s.responsible,s.timezone,
      to_char(s.cutoff,'HH24:MI') AS cutoff,s.eligible_at,s.eligibility_reference,s.stopped,s.revision
    FROM store s WHERE $1='admin' OR EXISTS
      (SELECT 1 FROM store_grant WHERE store_id=s.id AND staff_id=$2) ORDER BY s.name,s.id`,
    [actor.role, actor.id])
  if (!['admin','manager'].includes(actor.role)) return rows.map(({ id, name, timezone, cutoff }) => ({ id, name, timezone, cutoff }))
  return rows
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw forbidden()
}

export async function createInvite(db: DB, cfg: Config, tenant: string,
  data: { email: string; role: string; stores: string[] }, actorId: string | null) {
  await scope(db, tenant, undefined, true)
  const { rows: [existing] } = await db.query<{ id: string; disabled_at: Date | null; password_hash: string | null }>(
    'SELECT id,disabled_at,password_hash FROM staff WHERE tenant_id=$1 AND email=$2 FOR UPDATE', [tenant,data.email])
  if (existing && (existing.disabled_at || existing.password_hash)) throw conflict()
  const id = existing?.id ?? newId()
  const raw = token()
  const secret = new Secret({ size: 20 }).base32
  const stores = await db.query('SELECT id FROM store WHERE id=ANY($1::uuid[])', [data.stores])
  if (stores.rowCount !== data.stores.length) throw missing()
  const encrypted = seal(cfg, 'totp:' + id, secret)
  if (existing) {
    await db.query('DELETE FROM invite WHERE staff_id=$1', [id])
    await db.query('DELETE FROM store_grant WHERE staff_id=$1', [id])
    await db.query('UPDATE staff SET role=$2,totp_secret=$3 WHERE id=$1', [id, data.role, encrypted])
  } else {
    const staff = await db.query(`INSERT INTO staff(id,tenant_id,email,role,totp_secret)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,email) DO NOTHING RETURNING id`,
      [id, tenant, data.email, data.role, encrypted])
    if (!staff.rowCount) throw conflict()
  }
  await db.query(`INSERT INTO store_grant(tenant_id,staff_id,store_id)
    SELECT $1,$2,unnest($3::uuid[])`, [tenant, id, data.stores])
  const invite = await db.query(`INSERT INTO invite VALUES($1,$2,$3,now()+interval '24 hours')
    RETURNING expires_at`, [digest(raw), tenant, id])
  await db.query('INSERT INTO invite_route VALUES($1,$2)', [digest(raw), tenant])
  await audit(db, tenant, null, actorId, existing ? 'staff.reinvite' : 'staff.invite', id, null, { role: data.role, stores: data.stores })
  return { id, invite_code: raw, setup_key: secret, setup_uri: otp(secret, data.email).toString(),
    expires_at: invite.rows[0].expires_at }
}

export async function accept(pool: pg.Pool, cfg: Config, input: unknown, ip: string) {
  const data = acceptSchema.parse(input)
  await gate(pool, cfg, 'invite-ip:' + ip, 25)
  await gate(pool, cfg, 'invite-code:' + data.invite, 8)
  const invalid = () => new Fault(400, 'INVALID_INVITE', '招待の有効期限と認証コードを確認してください。')
  return tx(pool, async db => {
    const hash = digest(data.invite)
    const directory = await db.query('SELECT tenant_id FROM invite_route WHERE token_hash=$1', [hash])
    if (!directory.rowCount) throw invalid()
    const tenant = directory.rows[0].tenant_id
    await scope(db, tenant, undefined, true)
    const { rows: [staff] } = await db.query<StaffRow>(`SELECT f.* FROM invite i JOIN staff f
      ON (i.tenant_id,i.staff_id)=(f.tenant_id,f.id)
      WHERE i.token_hash=$1 AND i.expires_at>now() AND f.disabled_at IS NULL
        AND f.password_hash IS NULL FOR UPDATE OF f`, [hash])
    if (!staff) throw invalid()
    const step = consumeFactor(cfg, staff, data.code)
    if (step === null) throw invalid()
    await db.query('UPDATE staff SET password_hash=$2,last_totp_step=$3 WHERE id=$1',
      [staff.id, await hashPassword(data.password), step])
    await db.query('DELETE FROM invite WHERE token_hash=$1', [hash])
    await audit(db, tenant, null, staff.id, 'staff.activate', staff.id)
    return { activated: true }
  })
}

export async function disableStaff(db: DB, actor: Actor, id: string, reason: string) {
  requireAdmin(actor)
  if (id === actor.id) throw forbidden()
  await scope(db, actor.tenant_id, undefined, true)
  const updated = await db.query('UPDATE staff SET disabled_at=now() WHERE id=$1 AND disabled_at IS NULL RETURNING id', [id])
  if (!updated.rowCount) throw missing()
  await db.query('DELETE FROM staff_session WHERE staff_id=$1', [id])
  await db.query('DELETE FROM invite WHERE staff_id=$1', [id])
  await audit(db, actor.tenant_id, null, actor.id, 'staff.disable', id, reason)
}
