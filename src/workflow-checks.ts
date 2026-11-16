import type { Config, DB } from './core.js'
import { channel, channelReady } from './line.js'
import { storeFeatures } from './store-features.js'
import type { WorkflowSubject } from './forms.js'

export async function workflowChecks(db:DB,cfg:Config,store:string,use:WorkflowSubject['purpose'],googleConfigured:boolean) {
  const flags=await storeFeatures(db,store)
  const checks:{section:string;text:string}[]=[]
  const {rows:channels}=await db.query<{id:string}>(`SELECT id FROM channel WHERE purpose IN ($1,'shared')`,[use])
  let connected=0
  for(const row of channels)if(channelReady(await channel(db,row.id)))connected++
  const maySend=flags.inbox_enabled||flags.rich_menus_enabled||
    (use==='customer'?flags.campaigns_enabled:flags.reminders_enabled||flags.waitlist_enabled)
  if(!channels.length)checks.push({section:'connection',text:'この用途の公式LINEが登録されていません。'})
  else if(maySend&&connected<channels.length)checks.push({section:'connection',text:(channels.length-connected)+'件の公式LINEが接続検収待ちです。'})
  if(maySend&&(!cfg.external||!cfg.automation))checks.push({section:'connection',text:'LINE送信・メニュー切り替えには公開HTTPS環境と配信の有効化が必要です。'})
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
  return checks
}
