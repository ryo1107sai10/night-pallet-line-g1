import { z } from 'zod'
import { type Actor, type DB, Fault, audit, scope, text } from './core.js'
import { platformPrincipal } from './platform.js'

const catalog={
  line:{title:'公式LINEをつなぐ',steps:{
    select_store:['master','#workspace-store','店舗を選ぶ','公式LINEを紐づける店舗を選んでください。'],
    connect:['master','#quick-line','LINE設定ナビから必要な情報を取得','「公式LINE連携 · 設定ナビ」のボタンで公式LINEとLINE Developersの設定ページを開きます。チャネルID・シークレット・アクセストークンを取得し、案内に沿ってこの画面へ貼り付けて登録してください。'],
    check_connection:['master','#supervisor-line','Webhookと送受信を確認する','登録後は店舗専用のWebhook URLをコピーし、LINE側のMessaging API設定で検証・利用・再送を設定してください。ここでトークンとWebhookを照合し、送受信テストを行います。'],
  }},
  master:{title:'エールのマスターを管理する',steps:{
    current_master:['master','#supervisor-team','現在のマスターを見る','「エールのマスター管理」で現在の担当者を確認します。'],
    invite:['master','#supervisor-invite','新しいマスターを招待する','「新しいマスターを招待」を開き、候補者のメールアドレスを入力して招待を発行します。招待情報は本人に安全な方法で渡してください。'],
    transfer:['master','#supervisor-team','有効化を確認して引き継ぐ','候補者が招待を有効にしたら表示を更新します。「マスターを切り替える」を押すと、前任者のマスター権限が終了します。'],
  }},
  scenario:{title:'ステップ配信を作る',steps:{
    open_studio:['master','#manage-studio','シナリオ画面を開く','対象の店舗を選び、「ステップ配信を組む」を押してください。'],
    create:['studio','#new','新規シナリオを作る','「新規シナリオ」を押すと、配信フローが開きます。'],
    edit:['studio','#workspace','フローを編集して保存する','開始条件を選び、経路の＋ボタンからメッセージ・待機・分岐を追加します。自動保存と取り消しは編集操作バーで確認できます。'],
    publish:['studio','#inspector','テストして公開する','「テスト」で配信の順序、LINEプレビューと複数条件を確認します。「公開管理」から承認、差分の確認、公開へ進みます。'],
  }},
  calendar:{title:'Googleカレンダーと面談予約をつなぐ',steps:{
    open_interviews:['master','#manage-interviews','面談枠の管理を開く','対象の店舗を選んで「面談枠の管理」を押してください。'],
    calendar:['interview','#google-calendar','Googleカレンダーを選ぶ','未連携ならカレンダーIDを入力して「Googleで連携する」を押し、Googleで許可します。連携済みの場合は、表示されているカレンダーを確認してください。'],
    hours:['interview','#interview-hours','受付時間を設定する','受付開始と終了を選び、「受付時間を保存する」を押してください。'],
    new_slot:['interview','#new-slot, #slot-help:not(:empty)','対面面談の枠を登録する','面談日、開始時刻、会場案内を入力します。登録フォームの代わりに案内が表示されている場合は、案内の内容を確認してください。'],
  }},
} as const

type TourId = keyof typeof catalog
type Copy = { title?: string; steps: Record<string, { caption?: string; body?: string }> }
type Published = { tour:TourId; revision:number; content:Copy; published_at:Date }

export const tourId = z.custom<TourId>(value => typeof value==='string' && Object.hasOwn(catalog,value))
export const tourInput = z.strictObject({
  revision: z.number().int().min(0).max(2147483646),
  title: text(80),
  steps: z.array(z.strictObject({id:text(48),caption:text(100),body:text(500)})).min(1).max(30),
})

async function authorize(db:DB,credential:string|undefined) {
  const principal=await platformPrincipal(db,credential)
  await scope(db,principal.tenant_id)
  await db.query("SELECT set_config('night.platform_principal',$1,true)",[principal.id])
  return principal
}

function view(id:TourId, published?:Published) {
  const definition=catalog[id]
  return {
    title:published?.content.title??definition.title,
    revision:published?.revision??0,
    published_at:published?.published_at??null,
    steps:Object.entries(definition.steps).map(([id,[page,target,caption,body]])=>({
      id,page,target,
      caption:published?.content.steps[id]?.caption??caption,
      body:published?.content.steps[id]?.body??body,
    })),
  }
}

export async function readTours(db:DB,credential:string|undefined) {
  const actor=await authorize(db,credential)
  const {rows}=await db.query<Published>(`SELECT DISTINCT ON (tour) tour,revision,content,published_at
    FROM tour_revision WHERE tenant_id=$1 ORDER BY tour,revision DESC`,[actor.tenant_id])
  return Object.fromEntries((Object.keys(catalog) as TourId[]).map(id=>[id,view(id,rows.find(row=>row.tour===id))]))
}

export async function publishTour(db:DB,credential:string|undefined,id:TourId,input:z.infer<typeof tourInput>) {
  const actor:Actor=await authorize(db,credential)
  const definition=catalog[id]
  const steps=new Map(input.steps.map(step=>[step.id,step]))
  if(steps.size!==input.steps.length||steps.size!==Object.keys(definition.steps).length){
    throw new Fault(400,'TOUR_STEPS_CHANGED','操作手順を再読み込みしてから編集してください。')
  }
  const content:Copy={steps:{}}
  if(input.title!==definition.title)content.title=input.title
  for(const [key,[,,caption,body]] of Object.entries(definition.steps)){
    const change=steps.get(key)
    if(!change)throw new Fault(400,'TOUR_STEPS_CHANGED','操作手順を再読み込みしてから編集してください。')
    if(change.caption!==caption||change.body!==body)content.steps[key]={
      ...(change.caption!==caption?{caption:change.caption}:{}),
      ...(change.body!==body?{body:change.body}:{}),
    }
  }
  const {rows:[published]}=await db.query<Published>(`INSERT INTO tour_revision (tenant_id,tour,revision,content,published_by)
    SELECT $1,$2,$3::int+1,$4,$5
    WHERE COALESCE((SELECT max(revision) FROM tour_revision WHERE tenant_id=$1 AND tour=$2),0)=$3::int
    ON CONFLICT DO NOTHING RETURNING tour,revision,content,published_at`,
  [actor.tenant_id,id,input.revision,content,actor.id])
  if(!published)throw new Fault(409,'TOUR_UPDATED','ほかの画面で新版が公開されました。編集内容を控え、最新版を読み込んでからお試しください。')
  await scope(db,actor.tenant_id,undefined,true)
  await audit(db,actor.tenant_id,null,actor.id,'tour.publish',actor.id,null,{tour:id,revision:published.revision})
  return view(id,published)
}
