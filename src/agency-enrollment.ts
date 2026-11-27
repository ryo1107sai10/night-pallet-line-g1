import type pg from 'pg'
import QRCode from 'qrcode'
import {z} from 'zod'
import {gate,otp} from './auth.js'
import {type Config,Fault,digest,opaque,scope,tx,unseal} from './core.js'
export const agencyEnrollmentPath='/master/enrollment/'
export const agencyEnrollmentInput=z.strictObject({invite:opaque})
const invalid=()=>new Fault(400,'INVITE_UNAVAILABLE','招待リンクは無効または期限切れです。発行した管理者に連絡してください。')
export async function readAgencyEnrollment(pool:pg.Pool,cfg:Config,raw:string,ip:string){
  await gate(pool,cfg,'agency-enrollment-ip:'+ip,25)
  await gate(pool,cfg,'agency-enrollment-token:'+raw,10)
  return tx(pool,async db=>{
    const hash=digest(raw),{rows:[directory]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM invite_route WHERE token_hash=$1',[hash])
    if(!directory)throw invalid()
    await scope(db,directory.tenant_id)
    const {rows:[staff]}=await db.query<{id:string;email:string;totp_secret:string;slug:string;expires_at:Date;mfa_required:boolean}>(`SELECT f.id,f.email,f.totp_secret,t.slug,i.expires_at,f.mfa_required FROM invite i
      JOIN staff f ON (i.tenant_id,i.staff_id)=(f.tenant_id,f.id) JOIN tenant t ON t.id=f.tenant_id
      JOIN agency_master_pair p ON p.tenant_id=f.tenant_id AND f.id IN (p.first_staff_id,p.second_staff_id)
      WHERE i.token_hash=$1 AND i.expires_at>now() AND f.password_hash IS NULL AND f.disabled_at IS NULL
      AND f.mfa_required=p.mfa_required AND f.role='admin' AND f.agency_staff AND NOT f.platform_actor AND NOT t.supervisor_only`,[hash])
    if(!staff)throw invalid()
    if(!staff.mfa_required)return {login_id:staff.slug,email:staff.email,expires_at:staff.expires_at,mfa_required:false}
    const setup=unseal(cfg,'totp:'+staff.id,staff.totp_secret)
    return {login_id:staff.slug,email:staff.email,expires_at:staff.expires_at,mfa_required:true,setup_key:setup,qr:await QRCode.toDataURL(otp(setup,staff.email).toString(),{width:240,margin:2})}
  })
}
