import { automationForStore, type Config, type DB } from './core.js'
import { channel, messagingReady } from './line.js'
import { storeFeatures } from './store-features.js'
import type { WorkflowSubject } from './forms.js'

export async function workflowChecks(db:DB,cfg:Config,store:string,use:WorkflowSubject['purpose'],googleConfigured:boolean) {
  const flags=await storeFeatures(db,store)
  const checks:{section:string;text:string}[]=[]
  const {rows:channels}=await db.query<{id:string}>(`SELECT id FROM channel WHERE purpose IN ($1,'shared')`,[use])
  let connected=0
  for(const row of channels){
    const connection=await channel(db,row.id)
    if(messagingReady(connection))connected++
  }
  const maySend=flags.inbox_enabled||flags.rich_menus_enabled||flags.sources_enabled||flags.recruitment_tags_enabled||
    (use==='customer'?flags.campaigns_enabled:flags.reminders_enabled||flags.waitlist_enabled)
  if(!channels.length)checks.push({section:'connection',text:'この用途の公式LINEが登録されていません。'})
  else if(maySend&&connected<channels.length)checks.push({section:'connection',text:(channels.length-connected)+'件の公式LINEが接続検収待ちです。'})
  if(maySend&&!automationForStore(cfg,store))checks.push({section:'connection',text:'LINE送信・メニュー切り替えには公開HTTPS環境と配信の有効化が必要です。'})
  const {rows:[status]}=await db.query<{forms:number;intake:number;failures:number;google_errors:number;write_granted:boolean}>(`SELECT
    (SELECT count(*)::int FROM workflow_form WHERE purpose=$1 AND published) AS forms,
    (SELECT count(*)::int FROM inbox_thread WHERE purpose='unclassified' AND state<>'resolved') AS intake,
    (SELECT count(*)::int FROM service_delivery WHERE purpose=$1 AND status IN ('failed','unknown')
      AND first_attempt_at>=now()-interval '7 days') AS failures,
    (SELECT count(*)::int FROM interview_google_sync WHERE status='failed') AS google_errors,
    EXISTS (SELECT 1 FROM interview_google_calendar WHERE store_id=$2 AND write_granted) AS write_granted`,[use,store])
  if(flags.forms_enabled&&!status.forms)checks.push({section:'forms',text:'公開中の回答フォームがありません。'})
  if(use==='customer'&&flags.inbox_enabled&&status.intake)checks.push({section:'intake',text:status.intake+'件の会話で用途の確認が必要です。'})
  if(maySend&&status.failures)checks.push({section:'delivery',text:'直近7日間に失敗または結果不明のLINE送信が'+status.failures+'件あります。'})
  if(use==='recruitment'&&flags.google_write_enabled){
    if(!flags.google_calendar_enabled||!googleConfigured||!status.write_granted){
      checks.push({section:'interviews',text:'Googleへの予定登録にはカレンダー照合をオンにし、書き込み権限を許可してください。'})
    }
    if(status.google_errors)checks.push({section:'interviews',text:status.google_errors+'件の面談でGoogleへの書き込みを確認できませんでした。'})
  }
  if(use==='recruitment'){
    const {rows:[ready]}=await db.query<{contract_active:boolean;eligible:boolean;auto_enabled:boolean;stopped:boolean;active_sources:number;configured_menus:number;tag_campaigns:number}>(`SELECT
      s.contract_active,s.eligible_at IS NOT NULL AS eligible,s.auto_enabled,(s.stopped OR t.stopped) AS stopped,
      (SELECT count(*)::int FROM workflow_source WHERE purpose='recruitment' AND active) AS active_sources,
      (SELECT count(*)::int FROM workflow_menu m JOIN channel c ON c.id=m.channel_id AND c.generation=m.generation
        WHERE m.purpose='recruitment' AND (m.base_menu IS NOT NULL OR m.booked_menu IS NOT NULL OR jsonb_array_length(m.tag_rules)>0)) AS configured_menus,
      (SELECT count(*)::int FROM scenario q JOIN scenario_version v ON v.scenario_id=q.id AND v.version=q.published_version
        WHERE NOT q.stopped AND v.graph->>'purpose'='recruitment' AND v.graph->>'trigger'='tag_campaign') AS tag_campaigns
      FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[store])
    if(!ready.contract_active||!ready.eligible||!ready.auto_enabled||ready.stopped)
      checks.push({section:'contract',text:'契約または自動配信開始の確認が未完了です。設定・テストはできますが、通常の自動配信は開始されません。'})
    if(flags.sources_enabled&&!ready.active_sources)checks.push({section:'sources',text:'有効な流入経路がありません。店舗の求人経路を登録してQRと専用リンクを発行できます。'})
    if(flags.rich_menus_enabled&&!ready.configured_menus)checks.push({section:'rich-menus',text:'切り替え対象のリッチメニューが未設定です。通常・予約済み・採用タグ別のメニューを登録できます。'})
    if(flags.recruitment_enabled&&flags.recruitment_tags_enabled&&!ready.tag_campaigns)checks.push({section:'studio',text:'絞り込み配信用に公開された採用ステップがありません。必要に応じてタグ絞り込み配信のテンプレートを作成してください。'})
  }
  return checks
}
