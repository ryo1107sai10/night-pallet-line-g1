import {type Actor,type Config,type DB,automationForStore,scope} from './core.js'
import {storeHealth} from './store-health.js'
import {channel,summary} from './line.js'
import {locationOf} from './automation.js'
import type {InterviewGoogle} from './interview-availability.js'

// Read-only snapshot for the beginner workspace. All data comes from the selected
// store's existing authorization and remains subject to store-scoped RLS.
export async function agencyJourney(db:DB,cfg:Config,google:InterviewGoogle,actor:Actor,store:string){
  const health=await storeHealth(db,cfg,google,actor,store)
  await scope(db,actor.tenant_id,store)
  const location=await locationOf(db,store)
  const {rows:[counts]}=await db.query<{drafts:number;published:number;tag_count:number;active_tags:number;automatic_tags:number;other_channels:number}>(`SELECT
    (SELECT count(*)::int FROM scenario WHERE store_id=$1 AND NOT is_template AND graph->>'purpose'='recruitment') +
      (SELECT count(*)::int FROM recruitment_intake WHERE store_id=$1) AS drafts,
    (SELECT count(*)::int FROM scenario q JOIN channel c ON c.id=q.channel_id WHERE q.store_id=$1 AND NOT q.is_template AND NOT q.stopped AND NOT c.stopped AND q.published_version IS NOT NULL AND q.graph->>'purpose'='recruitment') +
      (SELECT count(*)::int FROM recruitment_intake i JOIN channel c ON c.id=i.channel_id WHERE i.store_id=$1 AND i.live IS NOT NULL AND NOT c.stopped) AS published,
    (SELECT count(*)::int FROM applicant_tag WHERE store_id=$1) AS tag_count,
    (SELECT count(*)::int FROM applicant_tag WHERE store_id=$1 AND active) AS active_tags,
    (SELECT count(*)::int FROM applicant_tag WHERE store_id=$1 AND active AND cardinality(add_events)>0) AS automatic_tags,
    (SELECT count(*)::int FROM channel WHERE store_id=$1 AND purpose<>'recruitment') AS other_channels`,[store])
  const channels=[]
  for(const item of health.channels.filter(c=>c.purpose==='recruitment')){
    const c=await summary(db,cfg,await channel(db,item.id))
    channels.push({id:c.id,label:c.label,basic_id:c.basic_id,stopped:c.stopped,status:c.status,checks:c.checks})
  }
  const connected=channels.some(c=>!c.stopped&&c.status==='connected')
  const processEnabled=automationForStore(cfg,store,actor.tenant_id),blockers=[]
  if(!processEnabled)blockers.push({step:5,code:'server',message:'この店舗の自動配信処理がサーバーで許可されていません。管理窓口に連絡してください。'})
  if(!location.eligible_at)blockers.push({step:1,code:'eligibility',message:'店舗の許可・利用条件を確認して保存してください。'})
  if(!location.contract_active)blockers.push({step:5,code:'contract',message:'店舗の契約・LINE運用許可の確認を保存してください。'})
  if(!connected)blockers.push({step:1,code:'line',message:'公式LINEの送受信テストと端末への到着確認を完了してください。'})
  if(counts.other_channels)blockers.push({step:1,code:'purpose',message:'採用以外のLINEが登録されています。管理窓口で用途を確認してください。'})
  if(location.stopped||location.tenant_stopped)blockers.push({step:5,code:'stopped',message:'店舗または法人の配信停止設定が有効です。管理窓口に確認してください。'})
  return {health,channels,counts,connected,process_enabled:processEnabled,stopped:location.stopped||location.tenant_stopped,blockers}
}
