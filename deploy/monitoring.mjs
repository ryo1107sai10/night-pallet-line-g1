// Installs narrowly scoped Night PRO LINE monitoring in an existing GCP project.
// Uses the signed-in operator only; never reads the application's secrets.
// Usage: node deploy/monitoring.mjs <project> <uptime-check-id> <notification-channel-id>
import {execFileSync} from 'node:child_process'
const [project,checkId,channelId]=process.argv.slice(2)
if(!/^[a-z][a-z0-9-]{4,29}$/.test(project??'')||!/^[-_a-zA-Z0-9]+$/.test(checkId??'')||!/^\d+$/.test(channelId??''))throw Error('Specify project, uptime check ID and approved notification channel ID.')
const channel='projects/'+project+'/notificationChannels/'+channelId
const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
const base='https://monitoring.googleapis.com/v3/projects/'+project
async function api(path,body,method=body?'POST':'GET'){
  const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  const data=await res.json()
  if(!res.ok)throw Error('Monitoring API '+res.status+': '+(data.error?.message??'request failed'))
  return data
}
const services='resource.type="cloud_run_revision" AND resource.label.service_name="night-pro-line"'
const metric=(name)=>'metric.type="'+name+'" AND '+services
const logMetric=(name)=>metric('logging.googleapis.com/user/'+name)
const sum=(period='300s')=>[{alignmentPeriod:period,perSeriesAligner:'ALIGN_SUM',crossSeriesReducer:'REDUCE_SUM'}]
const threshold=(filter,thresholdValue,aggregations,duration='0s')=>({conditionThreshold:{filter,comparison:'COMPARISON_GT',thresholdValue,duration,aggregations,trigger:{count:1}}})
const definitions=[
  {name:'Web and database unavailable',doc:'本番URL /api/health の正常応答が複数拠点で失われています。Cloud RunとSupabaseの状況を確認してください。',
    condition:threshold('resource.type="uptime_url" AND metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id="'+checkId+'"',1,
      [{alignmentPeriod:'600s',perSeriesAligner:'ALIGN_NEXT_OLDER',crossSeriesReducer:'REDUCE_COUNT_FALSE',groupByFields:['resource.label.host']}],'300s')},
  {name:'Scheduled work heartbeat missing',doc:'通常1分ごとに完了する定期処理の成功記録が5分以上途絶えています。Cloud Scheduler、Cloud Run、データベースを確認してください。',
    condition:{conditionAbsent:{filter:logMetric('npl_scheduled_work_completed'),duration:'300s',aggregations:sum('60s'),trigger:{count:1}}}},
  {name:'Cloud Run repeated 5xx',doc:'5分間にサーバーエラーが3件以上検出されました。Cloud Runログの日時・リクエストIDを確認してください。',
    condition:threshold(metric('run.googleapis.com/request_count')+' AND metric.label.response_code_class="5xx"',2,sum())},
  {name:'Immediate dispatch backlog',doc:'即時配信キューの滞留が5分以上増えています。Cloud Tasksと配信履歴を確認してください。',
    condition:threshold('resource.type="cloud_tasks_queue" AND metric.type="cloudtasks.googleapis.com/queue/depth" AND resource.label.queue_id="night-pro-line-immediate"',30,
      [{alignmentPeriod:'60s',perSeriesAligner:'ALIGN_MAX'}],'300s')},
  {name:'LINE API or enqueue failure',doc:'LINEの認証・通数確認・通信または即時処理登録に障害が検出されました。店舗別の接続状態・配信履歴とCloud Runログを照合し、結果不明の配信をむやみに再送しないでください。',
    condition:threshold(logMetric('npl_line_integration_failure'),0,sum())},
  {name:'Google Calendar failure',doc:'Googleカレンダーの空き時間照合または同期で障害が検出されました。面談枠と接続状態を確認してください。空き時間照合のエラーを無視して予約を受け付けないでください。',
    condition:threshold(logMetric('npl_google_integration_failure'),0,sum())},
]
const target=await api('/notificationChannels/'+channelId)
if(target.type!=='email'||target.enabled===false)throw Error('Approved email notification channel is not enabled.')
const current=(await api('/alertPolicies')).alertPolicies??[]
for(const def of definitions){
  const name='Night PRO LINE - '+def.name
  const existing=current.find(x=>x.displayName===name&&x.userLabels?.application==='night-pro-line')
  const policy={displayName:name,userLabels:{application:'night-pro-line'},documentation:{content:def.doc,mimeType:'text/markdown'},
    enabled:true,combiner:'OR',conditions:[{displayName:def.name,...def.condition}],
    notificationChannels:[channel],alertStrategy:{autoClose:'1800s',notificationPrompts:['OPENED']}}
  if(existing){
    // Re-run is read-only for an existing matching policy; do not overwrite
    // conditions or destinations an operator might have deliberately changed.
    console.log('EXISTS',name,existing.name.split('/').at(-1))
  }else{
    const created=await api('/alertPolicies',policy)
    console.log('CREATED',name,created.name.split('/').at(-1))
  }
}
