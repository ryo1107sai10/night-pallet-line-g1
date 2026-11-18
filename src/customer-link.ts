import type pg from 'pg'
import { z } from 'zod'
import {
  audit, digest, Fault, missing, opaque, route, scope, token, tx,
  type Config, type DB,
} from './core.js'
import { channel, userKey, type Channel } from './line.js'
import { lockDispatch } from './dispatch-lock.js'
import { requireFeature, storeFeatures } from './store-features.js'
import { locationOf } from './automation.js'
import type { WorkflowSubject } from './forms.js'
import { customerById, ensureCustomer } from './customer.js'
import { rememberContact } from './rich-menus.js'
import { queueService } from './service-delivery.js'
import { recordSource } from './sources.js'
import { createLinkToken, findLinkToken } from './link-token.js'

// 顧客リンクのセッションは、面談トークンと同じ2時間（決定D3の考え方を顧客用途にも適用）。
// LIFF経路の customer_session は30分のまま変えない。
export const CUSTOMER_LINK_SESSION_TTL_SECONDS = 2 * 3600

export const customerLinkUrl = (cfg: Config, connection: string, raw: string) =>
  cfg.origin + '/account/' + connection + '?t=' + raw

const linkInvalid = () => new Fault(401, 'LINK_INVALID',
  'このURLは無効です。LINEのトーク画面メニューから再度「来店予約・設定」をタップしてください。')
const linkExpired = () => new Fault(410, 'LINK_EXPIRED',
  'このURLは有効期限が切れています。LINEのトーク画面メニューから再度「来店予約・設定」をタップしてください。')

// 発行ガード: postback 経路の共通判定。顧客専用OA・友だち状態・機能フラグ・停止状態・
// 世代一致をすべて満たす場合のみ true（兼用OAは面談の D5 と同じく対象外から始める）。
export async function customerLinkEligible(db: DB, c: Channel, generation: number, userKeyValue: string) {
  if (c.purpose !== 'customer' || c.stopped || generation !== c.generation) return false
  const features = await storeFeatures(db, c.store_id)
  if (!features.token_customers_enabled) return false
  const { rows: [rel] } = await db.query<{ following: boolean }>(
    'SELECT following FROM channel_relationship WHERE channel_id=$1 AND user_key=$2', [c.id, userKeyValue])
  if (!rel?.following) return false
  const { rows: [latest] } = await db.query<{ kind: string }>(`SELECT kind FROM webhook_event
    WHERE channel_id=$1 AND user_key=$2 AND kind IN ('follow','refollow','unfollow')
    ORDER BY occurred_at DESC,(kind='unfollow') DESC LIMIT 1`, [c.id, userKeyValue])
  if (latest?.kind === 'unfollow') return false
  const location = await locationOf(db, c.store_id)
  if (location.stopped || location.tenant_stopped) return false
  return true
}

// フロー: リッチメニューの postback を受けたワーカーから呼ぶ。呼び出し側のトランザクション内で実行する。
// 顧客レコードを確定させ、宛先を登録してから、リンクURL入りの Push を配信キューへ積む。
export async function issueCustomerLink(db: DB, cfg: Config, c: Channel, user: string, sourceId?: string) {
  const customer = await ensureCustomer(db, cfg, c, user, false, userKey(cfg, c, user))
  const identity: WorkflowSubject = {
    tenant_id: c.tenant_id, store_id: c.store_id, channel_id: c.id, purpose: 'customer', subject: customer.id,
  }
  await rememberContact(db, cfg, c, user, identity)
  const link = await createLinkToken(db, c, {
    purpose: 'customer', subject: customer.id, user_key: userKey(cfg, c, user), source_id: sourceId,
  })
  const url = customerLinkUrl(cfg, c.id, link.raw)
  const body = '来店予約・配信設定のご案内です。下記のURLから、予約の確認・変更と配信設定を行えます（有効期限: 発行から3時間）。\n' + url
  await queueService(db, cfg, identity, {
    kind: 'customer_link', object: link.id, revision: 1, due: new Date(), expiry: link.expires, body,
  })
  await audit(db, c.tenant_id, c.store_id, null, 'customer_link.issue', link.id, null, { channel_id: c.id })
  return { ...link, url }
}

// 引換: トークンを検証し、既存の customer_session を発行して Cookie 値（channelId.raw）を返す。
// 面談リンクと違い、引換では消費しない（リンクは期限内なら再引換でき、再発行で旧リンクが失効する）。
// セッション発行後の来店予約・配信設定・フォームは、LIFF経路と同じ API がそのまま使える。
export async function redeemCustomerLink(pool: pg.Pool, cfg: Config, connection: string, input: unknown) {
  const parsed = z.strictObject({ token: opaque }).safeParse(input)
  if (!parsed.success) throw linkInvalid()
  const raw = parsed.data.token
  return tx(pool, async db => {
    const target = await route(db, connection)
    await scope(db, target.tenant_id, target.store_id)
    await lockDispatch(db, target.tenant_id)
    const c = await channel(db, target.id)
    if (c.purpose !== 'customer') throw missing()
    await requireFeature(db, c.store_id, 'token_customers_enabled')
    if (c.stopped) throw linkInvalid()
    const row = await findLinkToken(db, c.id, raw)
    if (!row || row.purpose !== 'customer' || row.revoked_at) throw linkInvalid()
    if (+row.expires_at <= Date.now()) throw linkExpired()
    if (row.generation !== c.generation) throw linkInvalid()
    const customer = await customerById(db, row.subject)
    if (customer.channel_id !== c.id) throw linkInvalid()
    // LIFF経路の openCustomerSession と同じく、本人確認済みとして扱い、流入元の帰属を記録する。
    await db.query('UPDATE customer SET verified_at=coalesce(verified_at,now()) WHERE id=$1', [customer.id])
    const identity: WorkflowSubject = {
      tenant_id: c.tenant_id, store_id: c.store_id, channel_id: c.id, purpose: 'customer', subject: customer.id,
    }
    await recordSource(db, identity, row.source_id ?? undefined)
    const session = token()
    await db.query(`INSERT INTO customer_session(token_hash,tenant_id,store_id,channel_id,customer_id,generation,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second')`,
      [digest(session), c.tenant_id, c.store_id, c.id, customer.id, c.generation, CUSTOMER_LINK_SESSION_TTL_SECONDS])
    await db.query('UPDATE link_token SET redeemed_at=now() WHERE token_hash=$1', [digest(raw)])
    await db.query('DELETE FROM customer_session WHERE expires_at<now() AND channel_id=$1', [c.id])
    await audit(db, c.tenant_id, c.store_id, null, 'customer_link.redeem', row.id, null, { channel_id: c.id })
    return c.id + '.' + session
  })
}
