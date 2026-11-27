import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createInvite } from './auth.js'
import {
  type Actor, type Config, type DB, Fault, audit, conflict, digest, email, missing, newId, once, revision, scope, text,
} from './core.js'
import { lockDispatch } from './dispatch-lock.js'
import { connectionProgress, channel, summary } from './line.js'
import { supervisedAgency } from './platform.js'
import { storeFeatures } from './store-features.js'

// 登録フロー再設計（設計書 §12）。
// 北村さん（/platform/）: 法人名・店舗名・エール担当メールだけで法人登録を一括実行し、
// 登録の進捗を承認なしで見渡せる。エール（/master/）: 承認ゲートなしで、店舗ごとに
// 「自分で決めて確定する」ステップ形式のセットアップを完結できる。

export const registrationInput = z.strictObject({
  legal_name: text(120), store_name: text(100), email,
})
type RegistrationInput = z.infer<typeof registrationInput>

// 初期設定テンプレート。値は既存のDB既定値・管理画面の既定値に一致させる:
// 店舗機能は基本4機能（タグ・来店予約・面談予約・Google照合）が有効で追加機能は無効、
// 面談受付時間は 18:00〜24:00（store の interview_open/close_minute 既定値）。
// 住所・営業区分・責任者は store の NOT NULL 制約のため仮値「未設定」を入れ、
// エール側セットアップのステップ1で実入力しないと確定できないようにする。
export const storeTemplate = {
  address: '未設定', business_type: '未設定', responsible: '未設定',
  timezone: 'Asia/Tokyo', cutoff: '06:00',
} as const
const profilePending = (value: string) => value === storeTemplate.address

function newSlug() {
  return 'corp-' + randomBytes(8).toString('hex')
}

export async function createRegistration(db: DB, cfg: Config, principal: Actor,
  input: RegistrationInput, key: string) {
  await scope(db, principal.tenant_id, undefined, true)
  const agency = await supervisedAgency(db, principal)
  return once(db, cfg, principal, 'platform.registration', key, input, async () => {
    const tenantId = newId()
    const storeId = newId()
    await db.query("SELECT set_config('night.platform_principal',$1,true)", [principal.id])
    await scope(db, tenantId, undefined, true)
    try {
      let slug = newSlug()
      for (let attempt = 0; ; attempt++) {
        const taken = await db.query('SELECT 1 FROM tenant_route WHERE lower(slug)=lower($1)', [slug])
        if (!taken.rowCount) break
        if (attempt >= 4) throw conflict()
        slug = newSlug()
      }
      await db.query('INSERT INTO tenant(id,slug,legal_name,billing_contact,supervisor_only) VALUES($1,$2,$3,$4,false)',
        [tenantId, slug, input.legal_name, input.email])
      await db.query('INSERT INTO tenant_route VALUES($1,$2)', [slug, tenantId])
      await db.query(`INSERT INTO store(id,tenant_id,name,address,business_type,responsible,timezone,cutoff)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [storeId, tenantId, input.store_name, storeTemplate.address, storeTemplate.business_type,
          storeTemplate.responsible, storeTemplate.timezone, storeTemplate.cutoff])
      await db.query(`INSERT INTO platform_registration(tenant_id,supervisor_tenant_id,store_id,created_by)
        VALUES($1,$2,$3,$4)`, [tenantId, principal.tenant_id, storeId, principal.id])
      const invite = await createInvite(db, cfg, tenantId, { email: input.email, role: 'admin', stores: [] }, null)
      await db.query('INSERT INTO tenant_master (tenant_id,staff_id) VALUES ($1,$2)', [tenantId, invite.id])
      await audit(db, tenantId, storeId, null, 'platform.registration', tenantId, null,
        { legal_name: input.legal_name, store_name: input.store_name, agency_id: agency.agency_id })
      await audit(db, tenantId, storeId, null, 'registration.template_applied', storeId, null,
        { features: '基本4機能が有効・追加機能は無効（DB既定値）', interview_hours: '18:00-24:00',
          timezone: storeTemplate.timezone, cutoff: storeTemplate.cutoff })
      return {
        tenant: { id: tenantId, slug, legal_name: input.legal_name },
        store: { id: storeId, name: input.store_name },
        invite: { id: invite.id, invite_code: invite.invite_code, setup_key: invite.setup_key,
          setup_uri: invite.setup_uri, expires_at: invite.expires_at },
        urls: {
          master: cfg.origin + '/master/',
          webhook_format: cfg.origin + '/api/v1/webhooks/line/（接続を登録すると発行されます）',
        },
      }
    } finally {
      await scope(db, principal.tenant_id, undefined, true)
    }
  })
}

type ProgressStore = {
  id: string; name: string; line_stage: string; connections: number; verified: number;
  setup: { confirmed: number; total: number; completed: boolean }
}

type ProfileValues = { name: string; address: string; business_type: string; responsible: string;
  timezone: string; cutoff: string }
const profileDigest = (p: ProfileValues) =>
  digest(JSON.stringify([p.name, p.address, p.business_type, p.responsible, p.timezone, p.cutoff]))
const featuresDigest = (features: Record<string, unknown>) => digest(JSON.stringify(
  Object.keys(features).filter(key => key !== 'revision' && key !== 'recruitment_tags_enabled').sort().map(key => [key, !!features[key]])))
const hoursDigest = (start: number, end: number) => digest(JSON.stringify([start, end]))

async function tenantProgress(db: DB, tenantId: string) {
  await scope(db, tenantId, undefined, true)
  const { rows: [tenant] } = await db.query<{ slug: string; legal_name: string }>(
    'SELECT slug,legal_name FROM tenant WHERE id=$1', [tenantId])
  if (!tenant) throw missing()
  const { rows: [master] } = await db.query<{ email: string; activated: boolean; invite_expires_at: Date | null; co_email:string|null }>(`
    SELECT f.email, f.password_hash IS NOT NULL AS activated, i.expires_at AS invite_expires_at,co.email AS co_email
    FROM tenant_master m JOIN staff f ON (m.tenant_id,m.staff_id)=(f.tenant_id,f.id)
    LEFT JOIN staff co ON (m.tenant_id,m.co_staff_id)=(co.tenant_id,co.id)
    LEFT JOIN invite i ON (i.tenant_id,i.staff_id)=(f.tenant_id,f.id) WHERE m.tenant_id=$1`, [tenantId])
  const { rows: stores } = await db.query<{ id: string; name: string; address: string; business_type: string;
    responsible: string; timezone: string; cutoff: string; hours_start: number; hours_end: number }>(`
    SELECT id,name,address,business_type,responsible,timezone,to_char(cutoff,'HH24:MI') AS cutoff,
      interview_open_minute AS hours_start,interview_close_minute AS hours_end
    FROM store ORDER BY name,id`)
  const { rows: entries } = await db.query<{ store_id: string; mode: string; invitation_received_at: Date | null }>(
    'SELECT store_id,mode,invitation_received_at FROM line_onboarding')
  const connections = await connectionProgress(db)
  const { rows: setups } = await db.query<{ store_id: string; completed_at: Date | null;
    profile_confirmed_at: Date | null; profile_digest: string | null;
    features_confirmed_at: Date | null; features_digest: string | null;
    hours_confirmed_at: Date | null; hours_digest: string | null }>(
    'SELECT * FROM store_setup')
  const byStore = new Map<string, typeof connections>()
  for (const item of connections) {
    const items = byStore.get(item.store_id) ?? []
    items.push(item)
    byStore.set(item.store_id, items)
  }
  const byEntry = new Map(entries.map(entry => [entry.store_id, entry]))
  const bySetup = new Map(setups.map(row => [row.store_id, row]))
  const list: ProgressStore[] = []
  for (const store of stores) {
    const items = byStore.get(store.id) ?? []
    const verified = items.filter(item => item.verified).length
    const entry = byEntry.get(store.id)
    let lineStage = 'unknown'
    if (entry?.mode === 'invite') {
      lineStage = entry.invitation_received_at && +entry.invitation_received_at + 86400000 > Date.now()
        ? 'received' : 'waiting'
    } else if (entry?.mode === 'create') lineStage = 'uncreated'
    else if (items.length && items.every(item => item.verified)) lineStage = 'verified'
    else if (items.length || entry?.mode === 'managed') lineStage = 'setting'
    const setup = bySetup.get(store.id)
    const confirmed = [
      !!setup?.profile_confirmed_at && setup.profile_digest === profileDigest(store),
      !!setup?.features_confirmed_at && setup.features_digest === featuresDigest(await storeFeatures(db, store.id)),
      !!setup?.hours_confirmed_at && setup.hours_digest === hoursDigest(store.hours_start, store.hours_end),
      lineStage === 'verified',
    ].filter(Boolean).length
    list.push({ id: store.id, name: store.name, line_stage: lineStage,
      connections: items.length, verified,
      setup: { confirmed, total: 4, completed: !!setup?.completed_at } })
  }
  const stage = !master?.activated ? 'master_pending'
    : list.every(store => store.line_stage === 'verified') && list.length ? 'verified'
    : list.some(store => store.line_stage !== 'unknown') ? 'setting' : 'registered'
  return { tenant: { id: tenantId, ...tenant },
    master: master ? { email: master.email, activated: master.activated,
      invite_expires_at: master.invite_expires_at,co_email:master.co_email } : null,
    stage, stores: list }
}

export async function registrationProgress(db: DB, principal: Actor) {
  await scope(db, principal.tenant_id, undefined, true)
  const agency = await supervisedAgency(db, principal)
  const { rows: registered } = await db.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM platform_registration ORDER BY created_at')
  const targets = [...new Set([agency.agency_id, ...registered.map(row => row.tenant_id)])]
  const result = []
  for (const tenantId of targets) result.push(await tenantProgress(db, tenantId))
  await scope(db, principal.tenant_id, undefined, true)
  return result
}

// CLI `npm run setup -- --master <法人ID> <メール>` の画面化。対象は監督中の管理会社と
// ウィザードで作成した法人に限る。CLI 側の designateMaster は従来どおり併存する。
export async function designateRegistrationMaster(db: DB, principal: Actor, tenantId: string, address: string) {
  await scope(db, principal.tenant_id, undefined, true)
  const agency = await supervisedAgency(db, principal)
  const { rows: registered } = await db.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM platform_registration')
  if (tenantId !== agency.agency_id && !registered.some(row => row.tenant_id === tenantId)) throw missing()
  await db.query("SELECT set_config('night.platform_principal',$1,true)", [principal.id])
  await scope(db, tenantId, undefined, true)
  await db.query('SELECT id FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])
  const { rows: [staff] } = await db.query<{ id: string }>(`SELECT id FROM staff WHERE tenant_id=$1 AND email=$2
    AND role='admin' AND NOT platform_actor AND password_hash IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,
    [tenantId, address])
  if (!staff) throw new Fault(404, 'MASTER_NOT_ACTIVE', '有効な法人管理者アカウントを指定してください。')
  const result = await db.query(`INSERT INTO tenant_master(tenant_id,staff_id) VALUES($1,$2)
    ON CONFLICT (tenant_id) DO UPDATE SET staff_id=excluded.staff_id,pending_staff_id=NULL,
      pending_mode='replace',pending_replace_id=NULL
    WHERE tenant_master.staff_id<>excluded.staff_id AND tenant_master.co_staff_id IS DISTINCT FROM excluded.staff_id
    RETURNING staff_id`, [tenantId, staff.id])
  if (result.rowCount) {
    await db.query(`DELETE FROM staff_session s USING staff f WHERE s.staff_id=f.id
      AND s.tenant_id=$1 AND f.tenant_id=s.tenant_id AND f.role='admin'
      AND NOT EXISTS (SELECT 1 FROM tenant_master m WHERE m.tenant_id=f.tenant_id AND f.id IN (m.staff_id,m.co_staff_id))
      AND s.session_kind='staff'`, [tenantId])
    await audit(db, tenantId, null, null, 'master.designated', staff.id)
  }
  return { designated: true, changed: !!result.rowCount, email: address }
}

// ---- エール側: 店舗セットアップウィザード ----

const autoCheckKeys = ['token_verified', 'webhook_verified', 'tester_verified', 'receive_verified', 'send_accepted'] as const
const manualCheckKeys = ['ownership_verified', 'provider_verified', 'redelivery_enabled', 'auto_reply_checked',
  'non_developer', 'delivery_confirmed'] as const

type SetupRow = {
  profile_confirmed_at: Date | null; profile_digest: string | null;
  features_confirmed_at: Date | null; features_digest: string | null;
  hours_confirmed_at: Date | null; hours_digest: string | null;
  completed_at: Date | null; revision: number;
}

export async function storeSetupState(db: DB, cfg: Config, store: string) {
  const { rows: [info] } = await db.query<{
    name: string; address: string; business_type: string; responsible: string; timezone: string;
    cutoff: string; revision: number; hours_start: number; hours_end: number; hours_revision: number;
  }>(`SELECT name,address,business_type,responsible,to_char(cutoff,'HH24:MI') AS cutoff,revision,timezone,
    interview_open_minute AS hours_start,interview_close_minute AS hours_end,
    interview_hours_revision AS hours_revision FROM store WHERE id=$1`, [store])
  if (!info) throw missing()
  const { rows: [setup] } = await db.query<SetupRow>('SELECT * FROM store_setup WHERE store_id=$1', [store])
  const features = await storeFeatures(db, store)
  const { rows: channelRows } = await db.query<{ id: string }>(
    'SELECT id FROM channel WHERE store_id=$1 ORDER BY label', [store])
  const connections = []
  for (const row of channelRows) {
    const item = await summary(db, cfg, await channel(db, row.id))
    const pick = (keys: readonly string[]) => Object.fromEntries(keys.map(key =>
      [key, !!(item.checks as Record<string, boolean | undefined>)[key]]))
    connections.push({ id: item.id, label: item.label, purpose: item.purpose, status: item.status,
      webhook_url: item.webhook_url,
      auto: pick(autoCheckKeys), manual: pick(manualCheckKeys) })
  }
  const { rows: [onboarding] } = await db.query<{ mode: string }>(
    'SELECT mode FROM line_onboarding WHERE store_id=$1', [store])
  const profileComplete = ![info.address, info.business_type, info.responsible].some(profilePending)
  const confirmed = {
    profile: !!setup?.profile_confirmed_at && setup.profile_digest === profileDigest(info),
    features: !!setup?.features_confirmed_at && setup.features_digest === featuresDigest(features),
    hours: !!setup?.hours_confirmed_at && setup.hours_digest === hoursDigest(info.hours_start, info.hours_end),
    line: connections.some(item => item.status === 'connected'),
  }
  return {
    revision: setup?.revision ?? 1,
    completed_at: setup?.completed_at ?? null,
    steps: confirmed,
    profile: { name: info.name, address: info.address, business_type: info.business_type,
      responsible: info.responsible, timezone: info.timezone, cutoff: info.cutoff,
      store_revision: info.revision, complete: profileComplete,
      confirmed_at: confirmed.profile ? setup!.profile_confirmed_at : null },
    features: { ...features, confirmed_at: confirmed.features ? setup!.features_confirmed_at : null },
    hours: { start: info.hours_start, end: info.hours_end, revision: info.hours_revision,
      confirmed_at: confirmed.hours ? setup!.hours_confirmed_at : null },
    line: { mode: onboarding?.mode ?? null, connections },
  }
}

export const setupConfirmInput = z.strictObject({
  step: z.enum(['profile', 'features', 'hours']), revision,
})
export const setupRevisionInput = z.strictObject({ revision })

export async function confirmStoreSetup(db: DB, cfg: Config, actor: Actor, store: string,
  input: z.infer<typeof setupConfirmInput>) {
  requireSetupAdmin(actor)
  await lockDispatch(db, actor.tenant_id)
  const { rows: [info] } = await db.query<{ name: string; revision: number;
    address: string; business_type: string; responsible: string; timezone: string; cutoff: string;
    hours_start: number; hours_end: number }>(`
    SELECT name,revision,address,business_type,responsible,timezone,to_char(cutoff,'HH24:MI') AS cutoff,
      interview_open_minute AS hours_start,interview_close_minute AS hours_end
    FROM store WHERE id=$1 FOR UPDATE`, [store])
  if (!info) throw missing()
  let confirmedDigest: string
  if (input.step === 'profile') {
    if ([info.address, info.business_type, info.responsible].some(profilePending)) {
      throw new Fault(409, 'SETUP_PROFILE_INCOMPLETE', '所在地・営業区分・責任者を入力してから確定してください。')
    }
    confirmedDigest = profileDigest(info)
  } else if (input.step === 'features') {
    confirmedDigest = featuresDigest(await storeFeatures(db, store))
  } else {
    confirmedDigest = hoursDigest(info.hours_start, info.hours_end)
  }
  const column = input.step + '_confirmed_at'
  const digestColumn = input.step + '_digest'
  const { rows: [current] } = await db.query<{ revision: number }>(
    'SELECT revision FROM store_setup WHERE store_id=$1 FOR UPDATE', [store])
  if ((current?.revision ?? 1) !== input.revision) throw conflict()
  if (current) {
    await db.query(`UPDATE store_setup SET ${column}=now(),${digestColumn}=$2,completed_at=NULL,
      revision=revision+1,updated_at=now() WHERE store_id=$1`, [store, confirmedDigest])
  } else {
    await db.query(`INSERT INTO store_setup(tenant_id,store_id,${column},${digestColumn},revision)
      VALUES($1,$2,now(),$3,2)`, [actor.tenant_id, store, confirmedDigest])
  }
  await audit(db, actor.tenant_id, store, actor.id, 'store.setup_confirm', store, null, { step: input.step })
  return { confirmed: input.step }
}

export async function completeStoreSetup(db: DB, cfg: Config, actor: Actor, store: string,
  input: z.infer<typeof setupRevisionInput>) {
  requireSetupAdmin(actor)
  await lockDispatch(db, actor.tenant_id)
  const state = await storeSetupState(db, cfg, store)
  const missingSteps = (['profile', 'features', 'hours', 'line'] as const).filter(step => !state.steps[step])
  if (missingSteps.length) {
    const labels = { profile: '店舗情報', features: '使う機能', hours: '面談の受付時間', line: 'LINE接続' }
    throw new Fault(409, 'SETUP_INCOMPLETE',
      '未完了のステップがあります: ' + missingSteps.map(step => labels[step]).join('、'))
  }
  if (state.revision !== input.revision) throw conflict()
  const { rows: [current] } = await db.query<{ revision: number }>(
    'SELECT revision FROM store_setup WHERE store_id=$1 FOR UPDATE', [store])
  if ((current?.revision ?? 1) !== input.revision) throw conflict()
  if (current) {
    await db.query(`UPDATE store_setup SET completed_at=now(),revision=revision+1,updated_at=now()
      WHERE store_id=$1`, [store])
  } else {
    await db.query(`INSERT INTO store_setup(tenant_id,store_id,completed_at,revision) VALUES($1,$2,now(),2)`,
      [actor.tenant_id, store])
  }
  await audit(db, actor.tenant_id, store, actor.id, 'store.setup_complete', store)
  return { completed: true }
}

export async function reopenStoreSetup(db: DB, actor: Actor, store: string,
  input: z.infer<typeof setupRevisionInput>) {
  requireSetupAdmin(actor)
  await lockDispatch(db, actor.tenant_id)
  const { rows: [current] } = await db.query<{ revision: number }>(
    'SELECT revision FROM store_setup WHERE store_id=$1 FOR UPDATE', [store])
  if ((current?.revision ?? 1) !== input.revision) throw conflict()
  if (current) {
    await db.query(`UPDATE store_setup SET completed_at=NULL,revision=revision+1,updated_at=now()
      WHERE store_id=$1`, [store])
  }
  await audit(db, actor.tenant_id, store, actor.id, 'store.setup_reopen', store)
  return { reopened: true }
}

function requireSetupAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new Fault(403, 'FORBIDDEN', 'この操作を実行できる権限がありません。')
}
