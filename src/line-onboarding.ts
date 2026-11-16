import { z } from 'zod'
import { type Actor, type Config, type DB, Fault, audit, conflict, digest, missing, opaque, scope, seal, token, unseal, uuid } from './core.js'
import { connectionProgress } from './line.js'

const modes = z.enum(['create','managed','invite'])
type Mode = z.infer<typeof modes>
type Onboarding = {
  tenant_id:string; store_id:string; mode:Mode; revision:number; guide_box:string|null;
  guide_expires_at:Date|null; invitation_box:string|null; invitation_received_at:Date|null;
  connection_id:string|null
}
const revision = z.int().nonnegative()
export const onboardingChange = z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('set-mode'),mode:modes,revision}),
  z.strictObject({action:z.literal('issue-guide'),revision}),
  z.strictObject({action:z.literal('confirm-access'),connection:uuid.nullable(),revision}),
])
const invitationLink = z.string().trim().regex(/^https:\/\/manager\.line\.biz\/invitation\/[A-Za-z0-9_-]{12,160}\/?$/)
export const guideLookup = z.strictObject({token:opaque})
export const guideSubmission = guideLookup.extend({invitation:invitationLink})
export const guidePath = '/line-setup/invite'

const guideContext = (store:string) => 'line-onboarding-guide:'+store
const invitationContext = (store:string) => 'line-onboarding-invitation:'+store

const invitationActive = (entry:Onboarding) =>
  !!entry.invitation_received_at && +entry.invitation_received_at+86400000>Date.now()

function stage(entry:Onboarding|undefined, connections:{verified:boolean}[]) {
  if (entry?.mode==='invite') return invitationActive(entry) ? 'received' : 'waiting'
  if (entry?.mode==='create') return 'uncreated'
  if (connections.length && connections.every(item=>item.verified)) return 'verified'
  if (connections.length || entry?.mode==='managed') return 'setting'
  return 'unknown'
}

export async function listOnboarding(db:DB,actor:Actor) {
  await scope(db,actor.tenant_id,undefined,true)
  const {rows:stores}=await db.query<{id:string;name:string}>('SELECT id,name FROM store ORDER BY name,id')
  const {rows:entries}=await db.query<Onboarding>('SELECT store_id,mode,invitation_received_at FROM line_onboarding')
  const connections=await connectionProgress(db)
  const byStore = new Map<string,typeof connections>()
  for (const item of connections) {
    const items=byStore.get(item.store_id) ?? []
    items.push(item)
    byStore.set(item.store_id,items)
  }
  const byEntry = new Map(entries.map(entry=>[entry.store_id,entry]))
  return stores.map(store=>{
    const items=byStore.get(store.id) ?? []
    return {...store,stage:stage(byEntry.get(store.id),items),connections:items.length,
      verified:items.filter(item=>item.verified).length,
      next_connection:(items.find(item=>!item.verified) ?? items[0])?.id ?? null}
  })
}

async function getEntry(db:DB,store:string) {
  const {rows:[entry]}=await db.query<Onboarding>('SELECT * FROM line_onboarding WHERE store_id=$1',[store])
  return entry
}

export async function onboardingDetails(db:DB,cfg:Config,store:string) {
  const entry=await getEntry(db,store)
  if (!entry) return {mode:null,revision:0,guide:null,invitation:null}
  const active=entry.guide_box && entry.guide_expires_at && +entry.guide_expires_at>Date.now()
  const guide=active ? {
    url:cfg.origin+guidePath+'#'+unseal(cfg,guideContext(store),entry.guide_box!),
    expires_at:entry.guide_expires_at,
  } : null
  const invitation=entry.invitation_box && invitationActive(entry)
    ? unseal(cfg,invitationContext(store),entry.invitation_box) : null
  return {mode:entry.mode,revision:entry.revision,guide,invitation,invitation_received_at:entry.invitation_received_at}
}

export async function changeOnboarding(db:DB,cfg:Config,actor:Actor,store:string,data:z.infer<typeof onboardingChange>) {
  await db.query('SELECT id FROM store WHERE id=$1 FOR UPDATE',[store])
  const {rows:[entry]}=await db.query<Onboarding>('SELECT * FROM line_onboarding WHERE store_id=$1 FOR UPDATE',[store])
  if ((entry?.revision ?? 0)!==data.revision) throw conflict()
  if (data.action==='set-mode') {
    if (entry?.mode===data.mode) return onboardingDetails(db,cfg,store)
    await db.query('DELETE FROM line_onboarding_route WHERE store_id=$1',[store])
    await db.query(`INSERT INTO line_onboarding (tenant_id,store_id,mode) VALUES($1,$2,$3)
      ON CONFLICT (tenant_id,store_id) DO UPDATE SET mode=excluded.mode,revision=line_onboarding.revision+1,
        guide_box=NULL,guide_hash=NULL,guide_expires_at=NULL,invitation_box=NULL,invitation_received_at=NULL,connection_id=NULL`,
    [actor.tenant_id,store,data.mode])
  } else if (data.action==='issue-guide') {
    if (entry?.mode!=='invite') throw conflict()
    const raw=token()
    const hash=digest(raw)
    await db.query('DELETE FROM line_onboarding_route WHERE store_id=$1',[store])
    await db.query(`UPDATE line_onboarding SET guide_box=$2,guide_hash=$3,guide_expires_at=now()+interval '7 days',
      invitation_box=NULL,invitation_received_at=NULL,connection_id=NULL,revision=revision+1 WHERE store_id=$1`,
    [store,seal(cfg,guideContext(store),raw),hash])
    await db.query('INSERT INTO line_onboarding_route (guide_hash,tenant_id,store_id) VALUES($1,$2,$3)',
      [hash,actor.tenant_id,store])
  } else {
    if (entry?.mode!=='invite') throw conflict()
    if (data.connection && !(await db.query('SELECT 1 FROM channel WHERE store_id=$1 AND id=$2',[store,data.connection])).rowCount) throw missing()
    await db.query(`UPDATE line_onboarding SET mode='managed',invitation_box=NULL,
      invitation_received_at=NULL,connection_id=$2,revision=revision+1 WHERE store_id=$1`,[store,data.connection])
  }
  await audit(db,actor.tenant_id,store,actor.id,'line.onboarding.'+data.action,store)
  return onboardingDetails(db,cfg,store)
}

export async function markOnboardingRegistered(db:DB,store:string,connection:string) {
  await db.query(`UPDATE line_onboarding SET mode='managed',connection_id=$2,revision=revision+1
    WHERE store_id=$1 AND mode IN ('create','managed')`,[store,connection])
}

async function authorizeGuide(db:DB,raw:string,lock:boolean) {
  const hash=digest(raw)
  const {rows:[route]}=await db.query<{tenant_id:string;store_id:string}>(
    'SELECT tenant_id,store_id FROM line_onboarding_route WHERE guide_hash=$1',[hash])
  if (route) {
    await scope(db,route.tenant_id,route.store_id)
    const {rows:[entry]}=await db.query<Onboarding>(`SELECT * FROM line_onboarding WHERE guide_hash=$1 AND store_id=$2 AND guide_expires_at>now()`+
      (lock?' FOR UPDATE':''),[hash,route.store_id])
    if (entry) return entry
  }
  throw new Fault(404,'LINE_GUIDE_UNAVAILABLE','案内リンクが見つかりません。管理会社に新しいリンクを依頼してください。')
}

async function guideInfo(db:DB,entry:Onboarding) {
  const {rows:[display]}=await db.query<{store:string;company:string}>(`SELECT s.name AS store,t.legal_name AS company
    FROM store s JOIN tenant t ON t.id=s.tenant_id WHERE s.id=$1`,[entry.store_id])
  if (entry.mode==='invite') return {...display,status:invitationActive(entry) ? 'received' : 'waiting'}
  const connections=entry.connection_id ? await connectionProgress(db,entry.connection_id) : []
  return {...display,status:connections[0]?.verified ? 'verified' : 'setting'}
}

export async function readGuide(db:DB,raw:string) {
  return guideInfo(db,await authorizeGuide(db,raw,false))
}

export async function submitGuide(db:DB,cfg:Config,raw:string,invitation:string) {
  const entry=await authorizeGuide(db,raw,true)
  if (entry.mode==='invite' && !invitationActive(entry)) {
    const {rows:[updated]}=await db.query<Onboarding>(`UPDATE line_onboarding SET invitation_box=$2,
      invitation_received_at=now(),revision=revision+1 WHERE store_id=$1 RETURNING *`,
    [entry.store_id,seal(cfg,invitationContext(entry.store_id),invitation)])
    await audit(db,entry.tenant_id,entry.store_id,null,'line.onboarding.invitation_received',entry.store_id)
    return guideInfo(db,updated)
  }
  return guideInfo(db,entry)
}
