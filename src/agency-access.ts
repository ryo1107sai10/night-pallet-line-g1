import type { Request } from 'express'
import { forbidden, type Actor } from './core.js'

const interviews='/stores/:store/interviews'
const scenarios='/stores/:store/scenarios'
const workflow='/stores/:store/workflows/:purpose'
const connections='/stores/:store/connections'
const connection=connections+'/:connection'
const includesRoute=(base:string,route:string)=>route===base||route.startsWith(base+'/')

export function checkAgencyAccess(actor:Actor,req:Request) {
  if(!actor.agency)return
  const route:string=req.route.path
  const reads=req.method==='GET'||req.method==='HEAD'
  if(route==='/session' || reads&&(route==='/dashboard'||route==='/stores/:store/connections'))return
  // 現マスターに採用LINEの手動初回連携を委任する。管理画面の閲覧権限だけでなく
  // 各APIも明示的に許可し、既存トークンの交換・配信停止・モジュール連携は委任しない。
  // authenticate() は admin の場合、現法人マスターとの一致を毎回確認する。
  if(actor.role==='admin'){
    if(reads&&route==='/store-health')return
    if(req.method==='POST'&&['/stores/:store/health/probe','/stores/:store/health/acceptance'].includes(route))return
    // 現代理店マスターは、自法人の店舗登録と利用適格性の確認を行える。
    // 店舗へのアクセスは各ハンドラーの storeAccess / RLS を引き続き適用する。
    if(req.method==='POST'&&route==='/stores')return
    if(req.method==='PATCH'&&route==='/stores/:store/eligibility')return
    if(req.method==='POST'&&route===connections)return
    if(req.method==='PATCH'&&route===connection+'/console')return
    if(reads&&route===connection+'/tests')return
    if(req.method==='POST'&&['/check-token','/check-webhook','/tests','/tests/:tester/send'].some(suffix=>route===connection+suffix))return
  }
  // マスター交代の3ルートは到達だけ許可する。実施権限（監督者か自法人の現マスターか）は
  // platform.ts の requireAgencyMasterAccess が判定し、マスターでない代理店スタッフは403になる。
  if(route==='/agency-master'||route==='/agency-master/invite'||route==='/agency-master/promote'||route==='/agency-master/remove'||['/agency-master/pair/invite','/agency-master/pair/extend','/agency-master/pair/confirm','/agency-master/pair/cancel'].includes(route))return
  if(includesRoute(interviews,route)||includesRoute(scenarios,route))return
  if(includesRoute('/stores/:store/intake',route)&&['admin','manager'].includes(actor.role))return
  if(['admin','manager'].includes(actor.role)&&includesRoute('/stores/:store/recruitment',route))return
  if(['admin','manager'].includes(actor.role)&&includesRoute('/stores/:store/recruitment-intake',route))return
  if(req.params.purpose?.toString().toLowerCase()==='recruitment'){
    if(reads&&['settings','delivery'].some(page=>route===workflow+'/'+page))return
    if(actor.role==='admin'&&req.method==='PATCH'&&route===workflow+'/settings/acquisition')return
    // 採用応募フォームはエールのマスターと店舗担当マネージャーが管理する。
    // workflowAccess の店舗割当と storeFeatures の有効化判定は引き続き適用する。
    if(['admin','manager'].includes(actor.role)){
      if(includesRoute(workflow+'/tags',route))return
      if(route===workflow+'/checks'&&reads)return
      if(includesRoute(workflow+'/sources',route))return
      if(route===workflow+'/rich-menus'&&(reads||req.method==='PUT'))return
      if(route===workflow+'/rich-menus/:connection/testers'&&reads)return
      if(req.method==='POST'&&['templates','test'].some(action=>route===workflow+'/rich-menus/:connection/'+action))return
      if(route===workflow+'/forms'&&(reads||req.method==='PUT'))return
      if(route===workflow+'/responses'&&reads)return
    }
    if(route===workflow+'/delivery/:delivery/retry')return
    if(includesRoute(workflow+'/inbox',route))return
  }
  throw forbidden()
}
