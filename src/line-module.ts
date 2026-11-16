import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { type Actor, type Config, type DB, type LineModuleConfig, Fault,
  audit, digest, newId, opaque, text, token, userId } from './core.js'
import { lockDispatch } from './dispatch-lock.js'

const authorization = 'https://manager.line.biz/module/auth/v1'
export const moduleReturnPath = '/line-module/return'
export const moduleWebhookPath = '/api/v1/webhooks/line-module'
const scopes = ['message:send','message:receive']
const use = z.enum(['customer','recruitment','shared'])
export const moduleStart = z.strictObject({purpose:use})
export const moduleReturn = z.strictObject({
  state: z.string().regex(/^[a-f0-9]{96}$/), code: z.string().min(1).max(4096),
})
const botInfo = z.object({ userId:userId, displayName:text(100), basicId:z.string().regex(/^@[a-zA-Z0-9_-]{1,30}$/) })
type BotInfo = z.infer<typeof botInfo>

export const moduleConfigured = (cfg:Config) => cfg.external && !!cfg.lineModule
export function requireModule(cfg:Config) {
  if (!cfg.external || !cfg.lineModule) {
    throw new Fault(409,'LINE_MODULE_UNAVAILABLE','かんたん連携は準備中です。')
  }
  return cfg.lineModule
}
const linkExpired = () => new Fault(409,'LINE_MODULE_EXPIRED','連携手続きの有効期限が切れました。店舗の管理画面からやり直してください。')
const inaccessible = () => new Fault(502,'LINE_MODULE_API','LINEの応答を確認できません。時間をおいて再試行してください。',true)

export class LineModuleAPI {
  private cached?: { id:string; secret:string; expires:number; value:Promise<string> }

  constructor(private request:typeof fetch) {}

  private async call(url:string, options:RequestInit) {
    try {
      return await this.request(url,{...options,redirect:'error',signal:AbortSignal.timeout(6000)})
    } catch {
      throw inaccessible()
    }
  }

  async attach(cfg:Config, code:string, verifier:string) {
    const module = requireModule(cfg)
    const response = await this.call(authorization+'/token',{method:'POST',body:new URLSearchParams({
      grant_type:'authorization_code',client_id:module.id,client_secret:module.secret,
      redirect_uri:cfg.origin+moduleReturnPath,code,code_verifier:verifier,region:'JP',scope:scopes.join(' '),
    })})
    if (response.status===400 || response.status===403) {
      throw new Fault(409,'LINE_MODULE_REJECTED','LINE側で連携できませんでした。公式アカウントの管理権限を確認してやり直してください。')
    }
    if (!response.ok) throw inaccessible()
    const parsed = z.object({bot_id:userId,scope:z.string()}).safeParse(await response.json().catch(()=>null))
    if (!parsed.success) throw inaccessible()
    if (!scopes.every(scope=>parsed.data.scope.split(/\s+/).includes(scope))) {
      throw new Fault(409,'LINE_MODULE_SCOPE','LINEの連携画面でメッセージの送受信を許可してください。')
    }
    return parsed.data.bot_id
  }

  private async issue(module:LineModuleConfig, cache:NonNullable<LineModuleAPI['cached']>) {
    const response = await this.call('https://api.line.me/oauth2/v3/token',{method:'POST',body:new URLSearchParams({
      grant_type:'client_credentials',client_id:module.id,client_secret:module.secret,
    })})
    if (!response.ok) throw inaccessible()
    const result = z.object({access_token:z.string().regex(/^[\x21-\x7e]{15,4096}$/),expires_in:z.int().positive()})
      .safeParse(await response.json().catch(()=>null))
    if (!result.success) throw inaccessible()
    cache.expires = Date.now()+Math.max(0,result.data.expires_in-60)*1000
    return result.data.access_token
  }

  async headers(module:LineModuleConfig, bot:string):Promise<Record<string,string>> {
    if (this.cached?.id!==module.id || this.cached.secret!==module.secret || this.cached.expires<=Date.now()) {
      const cache = {id:module.id,secret:module.secret,expires:Infinity,value:Promise.resolve('')}
      cache.value = this.issue(module,cache).catch(error=>{
        if (this.cached===cache) this.cached=undefined
        throw error
      })
      this.cached = cache
    }
    return {Authorization:'Bearer '+await this.cached.value,[module.botHeader]:bot}
  }

  async bot(module:LineModuleConfig, bot:string) {
    const response = await this.call('https://api.line.me/v2/bot/info',{headers:await this.headers(module,bot)})
    if (!response.ok) throw inaccessible()
    const parsed = botInfo.safeParse(await response.json().catch(()=>null))
    if (!parsed.success || parsed.data.userId!==bot) throw inaccessible()
    return parsed.data
  }
}

type Pending = {
  verifier:string|null; purpose:z.infer<typeof use>; bot_user_id:string|null; connection_id:string|null;
}

export async function beginModuleLink(db:DB,cfg:Config,actor:Actor,store:string,session:string,purpose:z.infer<typeof use>) {
  const {id} = requireModule(cfg)
  const state = store.replaceAll('-','')+randomBytes(32).toString('hex')
  const verifier = token()
  await db.query(`DELETE FROM line_module_session WHERE staff_id=$1 AND expires_at<=now()`,[actor.id])
  await db.query(`INSERT INTO line_module_session
    (state_hash,tenant_id,store_id,staff_id,session_hash,purpose,module_channel_id,verifier,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '15 minutes')`,
  [digest(state),actor.tenant_id,store,actor.id,digest(session),purpose,id,verifier])
  const params = new URLSearchParams({response_type:'code',client_id:id,redirect_uri:cfg.origin+moduleReturnPath,
    scope:scopes.join(' '),state,region:'JP',code_challenge:createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method:'S256'})
  return {url:authorization+'/authorize?'+params.toString().replaceAll('+','%20')}
}

export async function pendingModuleLink(db:DB,cfg:Config,actor:Actor,store:string,session:string,state:string) {
  if (!state.startsWith(store.replaceAll('-',''))) throw linkExpired()
  const {rows:[pending]}=await db.query<Pending>(`SELECT verifier,purpose,bot_user_id,connection_id FROM line_module_session
    WHERE state_hash=$1 AND staff_id=$2 AND session_hash=$3 AND module_channel_id=$4 AND expires_at>now() FOR UPDATE`,
  [digest(state),actor.id,digest(session),requireModule(cfg).id])
  if (!pending) throw linkExpired()
  return pending
}

export async function rememberModuleBot(db:DB,api:LineModuleAPI,cfg:Config,actor:Actor,store:string,session:string,
  data:z.infer<typeof moduleReturn>) {
  const pending=await pendingModuleLink(db,cfg,actor,store,session,data.state)
  if (pending.bot_user_id) return pending
  const verifier=opaque.safeParse(pending.verifier)
  if (!verifier.success) throw linkExpired()
  const bot=await api.attach(cfg,data.code,verifier.data)
  await db.query('UPDATE line_module_session SET bot_user_id=$2,verifier=NULL WHERE state_hash=$1',[digest(data.state),bot])
  return {...pending,bot_user_id:bot}
}

export async function finishModuleLink(db:DB,cfg:Config,actor:Actor,store:string,session:string,state:string,bot:BotInfo) {
  const pending=await pendingModuleLink(db,cfg,actor,store,session,state)
  if (pending.connection_id) return {id:pending.connection_id}
  if (pending.bot_user_id!==bot.userId) throw linkExpired()
  const {id:moduleId}=requireModule(cfg)
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['line-module:'+bot.userId])
  await lockDispatch(db,actor.tenant_id)
  const {rows:[existing]}=await db.query<{id:string;tenant_id:string;store_id:string}>(
    'SELECT id,tenant_id,store_id FROM channel_route WHERE module_channel_id=$1 AND module_bot_id=$2',[moduleId,bot.userId])
  if (existing && (existing.tenant_id!==actor.tenant_id || existing.store_id!==store)) throw accountInUse()
  const id = existing?.id ?? newId()
  if (existing) {
    await db.query(`UPDATE channel SET label=$2,basic_id=$3,module_status='attached',module_status_at=now(),
      checks='{"ownership_verified":true,"token_verified":true}',generation=generation+1,revision=revision+1
      WHERE id=$1 AND module_status='detached'`,[id,bot.displayName,bot.basicId])
  } else {
    const {rows:[owner]}=await db.query('SELECT legal_name FROM tenant WHERE id=$1',[actor.tenant_id])
    await db.query(`INSERT INTO channel_route(id,tenant_id,store_id,module_channel_id,module_bot_id) VALUES($1,$2,$3,$4,$5)`,
      [id,actor.tenant_id,store,moduleId,bot.userId])
    const result=await db.query(`INSERT INTO channel(id,tenant_id,store_id,label,purpose,owner_name,bot_user_id,
      basic_id,management_authority,checks,module_status,module_status_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'LINE公式アカウント管理者による連携の許可',
        '{"ownership_verified":true,"token_verified":true}','attached',now())
      ON CONFLICT(bot_user_id) DO NOTHING`,
    [id,actor.tenant_id,store,bot.displayName,pending.purpose,owner.legal_name,bot.userId,bot.basicId])
    if (!result.rowCount) throw accountInUse()
  }
  await db.query('UPDATE line_module_session SET connection_id=$2 WHERE state_hash=$1',[digest(state),id])
  await audit(db,actor.tenant_id,store,actor.id,'line.module_attach',id)
  return {id}
}

function accountInUse() {
  return new Fault(409,'LINE_MODULE_ACCOUNT_IN_USE','この公式LINEはすでに登録されています。元の接続を管理画面で確認してください。')
}
