import type pg from 'pg'
import QRCode from 'qrcode'
import { Secret } from 'otpauth'
import { z } from 'zod'
import { factorStep, gate, hashPassword, otp, password, verifyPassword } from './auth.js'
import { type Config, type DB, Fault, audit, conflict, digest, missing, opaque, scope, seal, token, tx, unseal, uuid } from './core.js'

export const supervisorHandoffPath='/platform/handoff/'
const credential=z.string().refine(value=>{
  const [tenant,raw,extra]=value.split('.')
  return extra===undefined&&uuid.safeParse(tenant).success&&opaque.safeParse(raw).success
})
export const handoffSetup=z.strictObject({handoff:credential})
export const handoffCompletion=handoffSetup.extend({password,code:z.string().regex(/^\d{6}$/)})

export async function prepareSupervisorHandoff(pool:pg.Pool,cfg:Config,input:{tenant:string;address:string;nextSlug?:string}) {
  return tx(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('night.platform_master'))")
    const {rows:[tenant]}=await db.query<{tenant_id:string;slug:string}>('SELECT tenant_id,slug FROM tenant_route WHERE lower(slug)=lower($1)',[input.tenant])
    if(!tenant)throw missing()
    await scope(db,tenant.tenant_id,undefined,true)
    const {rows:[staff]}=await db.query<{id:string}>(`SELECT f.id FROM platform_master m
      JOIN staff f ON (m.tenant_id,m.staff_id)=(f.tenant_id,f.id)
      JOIN tenant t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND f.email=$2 AND m.agency_id IS NOT NULL
        AND t.supervisor_only AND f.password_hash IS NOT NULL AND f.disabled_at IS NULL
      FOR UPDATE OF f`,[tenant.tenant_id,input.address])
    if(!staff)throw missing()
    const loginId=input.nextSlug??tenant.slug
    if(loginId!==tenant.slug){
      await db.query('UPDATE tenant_route SET slug=$2 WHERE tenant_id=$1',[tenant.tenant_id,loginId])
      await db.query('UPDATE tenant SET slug=$2 WHERE id=$1',[tenant.tenant_id,loginId])
    }
    const raw=token(), secret=new Secret({size:20}).base32
    const {rows:[handoff]}=await db.query<{expires_at:Date}>(`INSERT INTO supervisor_handoff
      (tenant_id,staff_id,token_hash,pending_secret,expires_at) VALUES ($1,$2,$3,$4,now()+interval '24 hours')
      ON CONFLICT (tenant_id,staff_id) DO UPDATE SET token_hash=excluded.token_hash,
        pending_secret=excluded.pending_secret,expires_at=excluded.expires_at RETURNING expires_at`,
    [tenant.tenant_id,staff.id,digest(raw),seal(cfg,'totp:'+staff.id,secret)])
    await audit(db,tenant.tenant_id,null,null,'platform.handoff.issued',staff.id,null,{login_id_changed:loginId!==tenant.slug})
    return {login_id:loginId,expires_at:handoff.expires_at,url:cfg.origin+supervisorHandoffPath+'#'+tenant.tenant_id+'.'+raw}
  })
}

const unavailable=()=>new Fault(400,'HANDOFF_EXPIRED','引き継ぎリンクの有効期限を確認してください。設定済みの場合はログイン画面へ進んでください。')

async function authorize(db:DB,handoff:string,lock=false) {
  const [tenant,raw]=handoff.split('.')
  const hash=digest(raw)
  await scope(db,tenant,undefined,true)
  const {rows:[staff]}=await db.query<{id:string;email:string;slug:string;password_hash:string;pending_secret:string;expires_at:Date}>(
    `SELECT f.id,f.email,t.slug,f.password_hash,h.pending_secret,h.expires_at FROM supervisor_handoff h
       JOIN platform_master m ON (m.tenant_id,m.staff_id)=(h.tenant_id,h.staff_id)
       JOIN staff f ON (f.tenant_id,f.id)=(h.tenant_id,h.staff_id)
       JOIN tenant t ON t.id=h.tenant_id
       WHERE h.token_hash=$1 AND h.expires_at>now() AND m.agency_id IS NOT NULL AND t.supervisor_only
         AND f.password_hash IS NOT NULL AND f.disabled_at IS NULL
       ${lock?'FOR UPDATE OF f':''}`,[hash])
  if(!staff)throw unavailable()
  return {tenant,hash,staff}
}

export async function readSupervisorHandoff(pool:pg.Pool,cfg:Config,handoff:string,ip:string) {
  await gate(pool,cfg,'platform-handoff-setup:'+ip,30)
  const {staff}=await tx(pool,db=>authorize(db,handoff))
  const secret=unseal(cfg,'totp:'+staff.id,staff.pending_secret)
  return {login_id:staff.slug,email:staff.email,expires_at:staff.expires_at,setup_key:secret,
    qr:await QRCode.toDataURL(otp(secret,staff.email).toString(),{width:264,margin:2})}
}

export async function completeSupervisorHandoff(pool:pg.Pool,cfg:Config,data:z.infer<typeof handoffCompletion>,ip:string) {
  await gate(pool,cfg,'platform-handoff-complete:'+ip,20)
  await gate(pool,cfg,'platform-handoff-token:'+data.handoff,6)
  return tx(pool,async db=>{
    const {tenant,hash,staff}=await authorize(db,data.handoff,true)
    const removed=await db.query(`DELETE FROM supervisor_handoff WHERE token_hash=$1 AND staff_id=$2
      AND expires_at>clock_timestamp() RETURNING pending_secret`,[hash,staff.id])
    const enc=removed.rows[0]?.pending_secret
    if(!enc)throw unavailable()
    const step=factorStep(unseal(cfg,'totp:'+staff.id,enc),data.code)
    if(step===null)throw new Fault(400,'HANDOFF_CODE','新しく登録した認証アプリの最新の6桁を入力してください。')
    if(await verifyPassword(data.password,staff.password_hash)){
      throw new Fault(400,'HANDOFF_PASSWORD','北村さんご本人が、以前と異なるパスワードを設定してください。')
    }
    const changed=await db.query(`UPDATE staff SET totp_secret=$2,password_hash=$3,last_totp_step=$4 WHERE id=$1`,
      [staff.id,enc,await hashPassword(data.password),step])
    if(!changed.rowCount)throw conflict()
    const revoked=await db.query('DELETE FROM staff_session WHERE staff_id=$1',[staff.id])
    await audit(db,tenant,null,staff.id,'platform.handoff.completed',staff.id,null,{sessions_revoked:revoked.rowCount})
    return {completed:true}
  })
}
