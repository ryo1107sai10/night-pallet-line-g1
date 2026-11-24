import type { Request } from 'express'
import { forbidden, type Actor } from './core.js'

const interviews='/stores/:store/interviews'
const scenarios='/stores/:store/scenarios'
const workflow='/stores/:store/workflows/:purpose'
const includesRoute=(base:string,route:string)=>route===base||route.startsWith(base+'/')

export function checkAgencyAccess(actor:Actor,req:Request) {
  if(!actor.agency)return
  const route:string=req.route.path
  const reads=req.method==='GET'||req.method==='HEAD'
  if(route==='/session' || reads&&(route==='/dashboard'||route==='/stores/:store/connections'))return
  // マスター交代の3ルートは到達だけ許可する。実施権限（監督者か自法人の現マスターか）は
  // platform.ts の requireAgencyMasterAccess が判定し、マスターでない代理店スタッフは403になる。
  if(route==='/agency-master'||route==='/agency-master/invite'||route==='/agency-master/promote')return
  if(includesRoute(interviews,route)||includesRoute(scenarios,route))return
  if(req.params.purpose?.toString().toLowerCase()==='recruitment'){
    if(reads&&['settings','delivery'].some(page=>route===workflow+'/'+page))return
    if(route===workflow+'/delivery/:delivery/retry')return
    if(includesRoute(workflow+'/inbox',route))return
  }
  throw forbidden()
}
