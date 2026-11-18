import type pg from 'pg'
import { z } from 'zod'
import {
  audit, digest, Fault, keyed, missing, newId, opaque, route, scope, token, tx,
  type Config, type DB,
} from './core.js'
import { channel, userKey, type Channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature } from './store-features.js'
import type { WorkflowSubject } from './forms.js'
import { rememberContact } from './rich-menus.js'
import { queueService } from './service-delivery.js'

// D2: トークン有効期限は3時間。D3: 引換後のセッション有効期限は2時間。
export const LINK_TOKEN_TTL_SECONDS = 3 * 3600
export const LINK_SESSION_TTL_SECONDS = 2 * 3600

export const redeemInput = z.strictObject({ token: opaque })

const linkInvalid = () => new Fault(401, 'LINK_INVALID',
  'この予約URLは無効です。LINEのトーク画面メニューから再度「面談予約」をタップしてください。')
const linkUsed = () => new Fault(410, 'LINK_USED',
  'この予約URLはすでに予約が完了しています。予約の確認・変更は、LINEにお送りした確定通知のURLから行えます。')
const linkExpired = () => new Fault(410, 'LINK_EXPIRED',
  'この予約URLは有効期限が切れています。LINEのトーク画面メニューから再度「面談予約」をタップしてください。')

export const interviewLinkUrl = (cfg: Config, connection: string, raw: string) =>
  cfg.origin + '/reserve/' + connection + '?t=' + raw

const subjectFor = (c: Channel, applicantKey: string): WorkflowSubject => ({
  tenant_id: c.tenant_id, store_id: c.store_id, channel_id: c.id, purpose: 'recruitment', subject: applicantKey,
})

type CreatedLink = { id: string; raw: string; url: string; expires: Date }

// 未使用リンクは応募者ごとに常に1本だけ生かす（再発行で旧リンクを失効させる）。
async function createLinkToken(db: DB, cfg: Config, c: Channel, identity: {
  user_key: string; applicant_key: string; booking_id?: string
}): Promise<CreatedLink> {
  await db.query(`UPDATE interview_link_token SET revoked_at=now()
    WHERE channel_id=$1 AND applicant_key=$2 AND used_at IS NULL AND revoked_at IS NULL`,
    [c.id, identity.applicant_key])
  const raw = token()
  const id = newId()
  const expires = new Date(Date.now() + LINK_TOKEN_TTL_SECONDS * 1000)
  await db.query(`INSERT INTO interview_link_token
    (id,token_hash,tenant_id,store_id,channel_id,generation,user_key,applicant_key,booking_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, digest(raw), c.tenant_id, c.store_id, c.id, c.generation, identity.user_key,
      identity.applicant_key, identity.booking_id ?? null, expires])
  return { id, raw, url: interviewLinkUrl(cfg, c.id, raw), expires }
}

// フローA: リッチメニューの postback を受けたワーカーから呼ぶ。呼び出し側のトランザクション内で実行する。
export async function issueInterviewLink(db: DB, cfg: Config, c: Channel, user: string) {
  const applicantKey = keyed(cfg, 'interview:' + c.id + ':' + user)
  const subject = subjectFor(c, applicantKey)
  await rememberContact(db, cfg, c, user, subject)
  const link = await createLinkToken(db, cfg, c, { user_key: userKey(cfg, c, user), applicant_key: applicantKey })
  const body = '面談予約のご案内です。下記のURLからご希望の日時をお選びください（有効期限: 発行から3時間）。\n' + link.url
  await queueService(db, cfg, subject, {
    kind: 'interview_link', object: link.id, revision: 1, due: new Date(), expiry: link.expires, body,
  })
  await audit(db, c.tenant_id, c.store_id, null, 'interview_link.issue', link.id, null, { channel_id: c.id })
  return link
}

// D4: 予約確定時に、変更・取消用の新しいリンクを発行してURLだけ返す（送信は確定通知に同梱）。
export async function issueManageInterviewLink(db: DB, cfg: Config, identity: WorkflowSubject, bookingId: string) {
  const { rows: [contact] } = await db.query<{ user_key: string }>(
    'SELECT user_key FROM workflow_contact WHERE channel_id=$1 AND purpose=$2 AND subject=$3',
    [identity.channel_id, identity.purpose, identity.subject])
  if (!contact) return undefined
  const c = await channel(db, identity.channel_id)
  const link = await createLinkToken(db, cfg, c, {
    user_key: contact.user_key, applicant_key: identity.subject, booking_id: bookingId,
  })
  await audit(db, identity.tenant_id, identity.store_id, null, 'interview_link.issue_manage', link.id, null,
    { channel_id: identity.channel_id, booking_id: bookingId })
  return link.url
}

// フローB: リンクの引換。検証して interview_session(audience='token') を発行し、Cookie文字列を返す。
export async function redeemInterviewLink(pool: pg.Pool, cfg: Config, connection: string, input: unknown) {
  const parsed = redeemInput.safeParse(input)
  if (!parsed.success) throw linkInvalid()
  const raw = parsed.data.token
  const cookie = await tx(pool, async db => {
    const target = await route(db, connection)
    await scope(db, target.tenant_id, target.store_id)
    await lockDispatch(db, target.tenant_id)
    const c = await channel(db, target.id)
    if (c.purpose === 'customer') throw missing()
    await requireFeature(db, c.store_id, 'interviews_enabled')
    await requireFeature(db, c.store_id, 'token_interviews_enabled')
    if (c.stopped) throw linkInvalid()
    const { rows: [row] } = await db.query<{
      id: string; generation: number; applicant_key: string; expires_at: Date;
      used_at: Date | null; revoked_at: Date | null
    }>('SELECT * FROM interview_link_token WHERE token_hash=$1 AND channel_id=$2', [digest(raw), c.id])
    if (!row || row.revoked_at) throw linkInvalid()
    if (row.used_at) throw linkUsed()
    if (+row.expires_at <= Date.now()) throw linkExpired()
    if (row.generation !== c.generation) throw linkInvalid()
    const session = token()
    await db.query(`INSERT INTO interview_session
      (token_hash,tenant_id,store_id,channel_id,generation,applicant_key,expires_at,audience,link_token_hash)
      VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second','token',$8)`,
      [digest(session), c.tenant_id, c.store_id, c.id, c.generation, row.applicant_key,
        LINK_SESSION_TTL_SECONDS, digest(raw)])
    await db.query('UPDATE interview_link_token SET redeemed_at=now() WHERE token_hash=$1', [digest(raw)])
    await db.query('DELETE FROM interview_session WHERE channel_id=$1 AND expires_at<=now()', [c.id])
    await audit(db, c.tenant_id, c.store_id, null, 'interview_link.redeem', row.id, null, { channel_id: c.id })
    const secure = cfg.external ? '; Secure' : ''
    return `night_interview=${c.id}.${session}; Path=/api/v1/interview/; HttpOnly; SameSite=Strict; Max-Age=${LINK_SESSION_TTL_SECONDS}${secure}`
  })
  return cookie
}
