import type pg from 'pg'
import {z} from 'zod'
import {factorStep,gate,hashPassword,password,verifyPassword} from './auth.js'
import {type Config,Fault,audit,digest,email,missing,opaque,scope,slug,token,tx,unseal,uuid} from './core.js'

export const masterPasswordResetPath='/master/recovery/'
export const resetTarget=z.strictObject({tenant:slug,address:email})
const recoveryCredential=z.string().refine(value=>{
  const [tenant,raw,extra]=value.split('.')
  return extra===undefined&&uuid.safeParse(tenant).success&&opaque.safeParse(raw).success
})
export const resetCompletion=z.strictObject({recovery:recoveryCredential,password,code:z.string().regex(/^\d{6}$/)})
const invalid=()=>new Fault(400,'RECOVERY_UNAVAILABLE','再設定リンクまたは最新の認証コードを確認してください。リンクの期限・試行回数を超えた場合は再発行が必要です。')

// 発行のみを行う運用者用関数。メール送達前にパスワードやセッションを変更しない。
export async function prepareMasterPasswordReset(pool:pg.Pool,cfg:Config,input:z.infer<typeof resetTarget>){
  const data=resetTarget.parse(input)
  return tx(pool,async db=>{
    const {rows:[directory]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route WHERE slug=$1',[data.tenant])
    if(!directory)throw missing()
    const tenant=directory.tenant_id
    await scope(db,tenant,undefined,true)
    const {rows:[staff]}=await db.query<{id:string;email:string}>(`SELECT f.id,f.email FROM tenant_master m
      JOIN staff f ON (m.tenant_id,m.staff_id)=(f.tenant_id,f.id) JOIN tenant t ON t.id=m.tenant_id
      WHERE m.tenant_id=$1 AND f.email=$2 AND f.role='admin' AND NOT f.platform_actor AND NOT t.supervisor_only
        AND f.password_hash IS NOT NULL AND f.totp_secret IS NOT NULL AND f.disabled_at IS NULL
        AND (t.agency_operations_only OR EXISTS(SELECT 1 FROM platform_master p WHERE p.agency_id=t.id)) FOR UPDATE OF f`,[tenant,data.address])
    if(!staff)throw missing()
    const raw=token()
    const {rows:[row]}=await db.query<{expires_at:Date}>(`INSERT INTO master_password_reset(tenant_id,staff_id,token_hash,expires_at)
      VALUES($1,$2,$3,now()+interval '30 minutes') ON CONFLICT(tenant_id,staff_id) DO UPDATE
      SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,attempts=0 RETURNING expires_at`,[tenant,staff.id,digest(raw)])
    await audit(db,tenant,null,null,'auth.master_recovery.issued',staff.id,null,{expires_at:row.expires_at})
    return {email:staff.email,expires_at:row.expires_at,url:cfg.origin+masterPasswordResetPath+'#'+tenant+'.'+raw}
  })
}

export async function completeMasterPasswordReset(pool:pg.Pool,cfg:Config,data:z.infer<typeof resetCompletion>,ip:string){
  await gate(pool,cfg,'master-recovery-ip:'+ip,20)
  await gate(pool,cfg,'master-recovery-token:'+data.recovery,6)
  const [tenant,raw]=data.recovery.split('.'),hash=digest(raw)
  const result=await tx(pool,async db=>{
    await scope(db,tenant,undefined,true)
    const {rows:[staff]}=await db.query<{id:string;totp_secret:string;last_totp_step:string;password_hash:string}>(`SELECT f.id,f.totp_secret,f.last_totp_step,f.password_hash
      FROM master_password_reset r JOIN tenant_master m ON (m.tenant_id,m.staff_id)=(r.tenant_id,r.staff_id)
      JOIN staff f ON (f.tenant_id,f.id)=(r.tenant_id,r.staff_id) JOIN tenant t ON t.id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.token_hash=$2 AND r.expires_at>clock_timestamp() AND r.attempts<6
        AND f.role='admin' AND NOT f.platform_actor AND NOT t.supervisor_only AND f.password_hash IS NOT NULL
        AND f.disabled_at IS NULL AND (t.agency_operations_only OR EXISTS(SELECT 1 FROM platform_master p WHERE p.agency_id=t.id))
      FOR UPDATE OF f,r`,[tenant,hash])
    if(!staff)return false
    const step=factorStep(unseal(cfg,'totp:'+staff.id,staff.totp_secret),data.code)
    if(step===null||step<=Number(staff.last_totp_step)||await verifyPassword(data.password,staff.password_hash)){
      await db.query('UPDATE master_password_reset SET attempts=attempts+1 WHERE token_hash=$1',[hash])
      return false
    }
    if(!(await db.query('DELETE FROM master_password_reset WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING staff_id',[hash])).rowCount)return false
    await db.query('UPDATE staff SET password_hash=$2,last_totp_step=$3 WHERE id=$1',[staff.id,await hashPassword(data.password),step])
    const revoked=await db.query('DELETE FROM staff_session WHERE staff_id=$1',[staff.id])
    await audit(db,tenant,null,staff.id,'auth.master_recovery.completed',staff.id,null,{sessions_revoked:revoked.rowCount})
    return true
  })
  if(!result)throw invalid()
  return {completed:true}
}
