import type {Request,Response} from 'express'
import {GoogleAuth} from 'google-auth-library'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {resolve} from 'node:path'
import {Fault,missing} from './core.js'
import type {Topic} from './piyomaru-knowledge.js'

export type Material = {
  id:string; type:'video'|'pdf'; title:string; description:string; duration?:string;
  chapter?:number; pages?:number; topics:Topic[]; keywords:string[]; filename:string
}
// Catalog entries are reviewed training assets, not user uploads or applicant data.
// Versioned object names let us refresh the manuals without changing public URLs.
export const materialVersion='2026-11-26'
const materials:readonly Material[]=[
  {id:'beginner-full',type:'video',title:'初心者向け 完全実践マニュアル',description:'全9章を通しで見る。公式LINE開設から応募・対面面談までを日本語音声で解説します。',duration:'28:10',topics:[],keywords:['初心者','全体','最初','全編','通し'],filename:'beginner-full.mp4'},
  {id:'chapter-01',type:'video',chapter:1,title:'準備とログイン',description:'必要なアカウント、認証、管理会社・店舗ごとの役割。',duration:'1:27',topics:['security','handoff'],keywords:['ログイン','認証','招待','権限','初回'],filename:'chapter-01.mp4'},
  {id:'chapter-02',type:'video',chapter:2,title:'公式LINEの新規開設',description:'作成フォーム、管理組織、申し込み完了まで。',duration:'2:26',topics:['line'],keywords:['line','ライン','開設','公式','新規'],filename:'chapter-02.mp4'},
  {id:'chapter-03',type:'video',chapter:3,title:'店舗登録・LINE連携',description:'店舗セットアップ、Messaging API、専用接続欄、Webhook、送受信確認。',duration:'5:54',topics:['store','line'],keywords:['店舗','登録','line','ライン','連携','webhook','トークン','シークレット','チャネル'],filename:'chapter-03.mp4'},
  {id:'chapter-04',type:'video',chapter:4,title:'Googleカレンダー連携',description:'店舗専用カレンダーの作成、空き時間の共有、ID取得と登録。アプリの照合操作は練習環境で収録しています。',duration:'4:03',topics:['calendar'],keywords:['google','カレンダー','連携','重複','共有','空き'],filename:'chapter-04.mp4'},
  {id:'chapter-05',type:'video',chapter:5,title:'面談枠・空き判定',description:'受付時間、対面枠、管理者の受付停止、重複枠の確認。',duration:'2:42',topics:['slots','calendar'],keywords:['面談','予約','30分','受付','空き','重複','対面'],filename:'chapter-05.mp4'},
  {id:'chapter-06',type:'video',chapter:6,title:'応募フォームと配信設定',description:'採用自動配信の設定、応募フォームの作成と公開。',duration:'1:33',topics:['draft','store'],keywords:['応募','フォーム','回答','採用','配信'],filename:'chapter-06.mp4'},
  {id:'chapter-07',type:'video',chapter:7,title:'ステップ配信の作成・公開',description:'シナリオの下書き、タグ別テンプレート、テスト、公開前確認。',duration:'3:32',topics:['draft','publish'],keywords:['ステップ','シナリオ','タグ','配信','テンプレート','公開','テスト'],filename:'chapter-07.mp4'},
  {id:'chapter-08',type:'video',chapter:8,title:'実機で応募・予約・通知',description:'一般LINEの応募、対面面談、確定通知、管理画面への反映。',duration:'4:15',topics:['publish','slots'],keywords:['実機','応募','予約','確認','通知','送受信'],filename:'chapter-08.mp4'},
  {id:'chapter-09',type:'video',chapter:9,title:'運用とトラブル解決',description:'日々の確認、店長への引き継ぎ、問題が起きた場合の見直し。',duration:'2:18',topics:['handoff','security'],keywords:['運用','引き継ぎ','店長','障害','エラー','トラブル'],filename:'chapter-09.mp4'},
  {id:'live-recording',type:'video',title:'実機操作録画：公式LINE開設から面談予約完了まで',description:'録画専用公式LINEで実際に接続・配信・応募・対面予約を行った記録（Google連携は別の章）。',duration:'5:54',topics:[],keywords:['実機','実際','録画','全体','連携','面談'],filename:'live-recording.mp4'},
  {id:'supervisor-guide',type:'pdf',pages:5,title:'北村さん向け 監督・初期設定ガイド',description:'監督者権限、ログイン、引き継ぎ、管理会社の監督、店舗とLINEの初期設定。',topics:['security','handoff','store','line'],keywords:['北村','監督','マスター','ログイン','権限','初期設定','引き継ぎ'],filename:'supervisor-guide.pdf'},
  {id:'agency-guide',type:'pdf',pages:7,title:'エール向け 店舗運用ガイド',description:'店舗管理、LINE、Googleカレンダー、採用タグ、ステップ配信、日々の運用。',topics:['line','calendar','draft','slots','publish','handoff','store'],keywords:['エール','店舗','運用','タグ','配信','予約','カレンダー','連携'],filename:'agency-guide.pdf'},
  {id:'store-guide',type:'pdf',pages:2,title:'店舗向け LINE対応・面談運用ガイド',description:'LINEの管理権限を渡す方法、店長の手動返信、面談・引き継ぎ。',topics:['handoff'],keywords:['店舗','店長','返信','手動','引き継ぎ','面談'],filename:'store-guide.pdf'},
]
export const libraryCatalog=materials.map(({filename,...m})=>({...m,url:'/platform/piyomaru/material/'+m.id}))
export const materialFor=(id:string)=>materials.find(m=>m.id===id)
export function suggestedMaterials(topics:Topic[]){
  const matches=materials.filter(m=>m.type==='video'&&m.topics.some(t=>topics.includes(t)))
  const first=topics[0]
  return matches.sort((a,b)=>Number(b.topics.includes(first))-Number(a.topics.includes(first))).slice(0,3).map(m=>m.id)
}
export function createPiyomaruMediaSource(){
  const directory=process.env.PIYOMARU_MEDIA_DIRECTORY
  const bucket=process.env.PIYOMARU_MEDIA_BUCKET
  if(bucket&&!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))throw Error('Invalid Piyomaru media bucket.')
  const auth=bucket?new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}):undefined
  return async(req:Request,res:Response,asset?:{object_name:string|null;pages?:number|null})=>{
    const material=materials.find(m=>m.id===req.params.material)
    if(!material)throw missing()
    let filename=material.filename,type=material.type==='video'?'video/mp4':'application/pdf',objectName=asset?.object_name??null
    if(asset?.object_name&&!/^updates\/[0-9a-f-]{36}\.(mp4|pdf)$/.test(asset.object_name))throw missing()
    if(req.params.page!==undefined){
      const page=Number(req.params.page)
      const pages=objectName?asset?.pages:material.pages
      if(material.type!=='pdf'||!/^\d{1,2}$/.test(String(req.params.page))||!Number.isInteger(page)||page<1||page>(pages??0))throw missing()
      filename=material.id+'-p'+page+'.jpg';type='image/jpeg'
      if(objectName)objectName=objectName.replace(/\.pdf$/,'-p'+page+'.jpg')
    }
    const range=req.get('Range')
    if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw new Fault(416,'MEDIA_RANGE','動画の再生位置を指定し直してください。')
    const disposition=type==='application/pdf'&&req.query.download==='1'?'attachment':'inline'
    res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Content-Type':type,
      'Content-Disposition':disposition+'; filename="'+filename+'"','Accept-Ranges':'bytes'})
    if(directory&&!bucket){
      // Only test/development fixtures supplied by the operator; filenames come from the catalog.
      await new Promise<void>((done,reject)=>res.sendFile(objectName??filename,{root:resolve(directory),cacheControl:false,lastModified:false},error=>error?reject(error):done()))
      return
    }
    if(!bucket||!auth)throw new Fault(503,'MEDIA_UNAVAILABLE','教材の準備中です。')
    const abort=new AbortController()
    const disconnect=()=>abort.abort()
    res.once('close',disconnect)
    const timer=setTimeout(disconnect,12000)
    try{
      const accessToken=await auth.getAccessToken()
      if(!accessToken)throw Error('Missing storage access')
      const object=encodeURIComponent(objectName??materialVersion+'/'+filename)
      const upstream=await fetch('https://storage.googleapis.com/download/storage/v1/b/'+bucket+'/o/'+object+'?alt=media',{
        headers:{Authorization:'Bearer '+accessToken,...(range?{Range:range}:{})},redirect:'error',signal:abort.signal,
      })
      clearTimeout(timer)
      if(upstream.status===416){res.status(416);const cr=upstream.headers.get('content-range');if(cr)res.set('Content-Range',cr);res.end();return}
      if((upstream.status!==200&&upstream.status!==206)||!upstream.body)throw Error('Media unavailable')
      for(const name of ['Content-Length','Content-Range']){
        const value=upstream.headers.get(name);if(value)res.set(name,value)
      }
      res.status(upstream.status)
      // Stream instead of loading the full recording into server memory.
      if(req.method==='HEAD'){await upstream.body.cancel();res.end();return}
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]),res)
    }catch{
      if(res.headersSent){res.destroy();return}
      res.removeHeader('Content-Disposition');res.removeHeader('Content-Length');res.removeHeader('Content-Range');res.removeHeader('Content-Type')
      throw new Fault(503,'MEDIA_UNAVAILABLE','教材を読み込めませんでした。もう一度お試しください。')
    }finally{clearTimeout(timer);res.off('close',disconnect)}
  }
}
