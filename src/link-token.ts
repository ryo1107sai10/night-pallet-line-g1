import { digest, newId, token, type DB } from './core.js'
import type { Channel } from './line.js'

// 用途非依存のリンク基盤（db/023）の共通部品。
// 面談は interview_link_token（db/022）のまま移行せず、こちらは顧客用途から使い始める。
// 生トークンは保存せず digest（SHA-256）のみ。有効期限は面談リンクと同じ3時間（決定D2に合わせる）。
export const LINK_TOKEN_TTL_SECONDS = 3 * 3600
export type LinkPurpose = 'customer' | 'recruitment'
export type LinkTokenRow = {
  id: string; generation: number; purpose: LinkPurpose; user_key: string; subject: string;
  source_id: string | null; expires_at: Date; redeemed_at: Date | null;
  used_at: Date | null; revoked_at: Date | null
}

// 未使用リンクは本人ごとに常に1本だけ生かす（再発行で旧リンクを失効させる）。
export async function createLinkToken(db: DB, c: Channel, input: {
  purpose: LinkPurpose; subject: string; user_key: string; source_id?: string
}) {
  await db.query(`UPDATE link_token SET revoked_at=now()
    WHERE channel_id=$1 AND purpose=$2 AND subject=$3 AND used_at IS NULL AND revoked_at IS NULL`,
    [c.id, input.purpose, input.subject])
  const raw = token()
  const id = newId()
  const expires = new Date(Date.now() + LINK_TOKEN_TTL_SECONDS * 1000)
  await db.query(`INSERT INTO link_token
    (id,token_hash,tenant_id,store_id,channel_id,generation,purpose,user_key,subject,source_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, digest(raw), c.tenant_id, c.store_id, c.id, c.generation, input.purpose,
      input.user_key, input.subject, input.source_id ?? null, expires])
  return { id, raw, expires }
}

export async function findLinkToken(db: DB, channelId: string, raw: string) {
  const { rows: [row] } = await db.query<LinkTokenRow>(
    'SELECT * FROM link_token WHERE token_hash=$1 AND channel_id=$2', [digest(raw), channelId])
  return row
}
