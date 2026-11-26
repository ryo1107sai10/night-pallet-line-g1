import {GoogleAuth} from 'google-auth-library'
import {mkdir,open,readFile,writeFile,stat,mkdtemp,readdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {z} from 'zod'
import {audit,conflict,Fault,missing,newId,scope,seal,unseal,type Actor,type Config,type DB} from './core.js'
import {platformPrincipal} from './platform.js'
import {libraryCatalog,materialFor} from './piyomaru-library.js'

const maxVideo=64*1024*1024,maxPdf=8*1024*1024,chunkSize=4*1024*1024
const safeObject=/^updates\/[0-9a-f-]{36}(?:\.(?:mp4|pdf)|-p\d{1,2}\.jpg)$/
const badMetadata=(s:string)=>/LLM_\d+_[\w-]+|[A-Z2-7]{24,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{6}\b|\b[A-Za-z0-9_+=/-]{40,}\b/.test(s)
const clean=(min:number,max:number)=>z.string().trim().min(min).max(max).refine(s=>!badMetadata(s),'認証情報や個人情報を除いた教材説明を入力してください。')
export const materialDraftInput=z.strictObject({material:z.string().max(60),title:clean(1,120),description:clean(1,400),instructions:clean(0,1800),file:z.strictObject({bytes:z.int().positive().max(maxVideo),type:z.enum(['video/mp4','application/pdf'])}).optional()})
export const materialPublishInput=z.strictObject({material:z.string().max(60),revision:z.uuid().nullable(),confirmed:z.literal(true)})
type Revision={id:string;tenant_id:string;staff_id:string;material_id:string;title:string;description:string;instructions:string;object_name:string|null;pages:number|null;bytes:number|null;usable:boolean;state:'draft'|'published'|'archived';upload_box:string|null;upload_total:number|null;upload_received:number;upload_expires_at:Date|null;created_at:Date;published_at:Date|null}
const safeRevision=(r:Revision)=>({id:r.id,material_id:r.material_id,title:r.title,description:r.description,instructions:r.instructions,usable:r.usable,state:r.state,uploaded:!!r.object_name,bytes:r.bytes,pages:r.pages,received:r.upload_received,total:r.upload_total,created_at:r.created_at,published_at:r.published_at,expires_at:r.upload_expires_at})
const unavailable=()=>new Fault(503,'MEDIA_WRITE','教材の保存先を確認できませんでした。時間をおいて再試行してください。')
async function actor(db:DB,credential:string|undefined){const p=await platformPrincipal(db,credential);await scope(db,p.tenant_id,undefined,true);await db.query("SELECT set_config('night.piyomaru_actor',$1,true)",[p.id]);return p}
async function current(db:DB,p:Actor,material:string){return (await db.query<Revision>("SELECT * FROM piyomaru_material_revision WHERE tenant_id=$1 AND staff_id=$2 AND material_id=$3 AND state='published'",[p.tenant_id,p.id,material])).rows[0]}
async function byId(db:DB,p:Actor,id:string,lock=false){const {rows:[r]}=await db.query<Revision>('SELECT * FROM piyomaru_material_revision WHERE tenant_id=$1 AND staff_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[p.tenant_id,p.id,id]);if(!r)throw missing();return r}
export async function materialCatalogFor(db:DB,p:Actor){
  const {rows}=await db.query<Revision>("SELECT * FROM piyomaru_material_revision WHERE tenant_id=$1 AND staff_id=$2 AND state='published' AND usable",[p.tenant_id,p.id])
  return libraryCatalog.map(m=>{const r=rows.find(r=>r.material_id===m.id);return r?{...m,title:r.title,description:r.description,instructions:r.instructions,updated_at:r.published_at,revision:r.id,pages:r.object_name?r.pages??undefined:m.pages,duration:r.object_name?undefined:m.duration}:m})
}
export async function materialInstructions(db:DB,p:Actor,relevant:string[]){
  const {rows}=await db.query<{instructions:string;title:string}>("SELECT instructions,title FROM piyomaru_material_revision WHERE tenant_id=$1 AND staff_id=$2 AND state='published' AND material_id=ANY($3) AND instructions<>'' ORDER BY published_at DESC LIMIT 3",[p.tenant_id,p.id,relevant])
  return rows
}
export async function materialAsset(db:DB,credential:string|undefined,id:string,revision?:string){
  if(!materialFor(id))throw missing()
  const p=await actor(db,credential),r=revision?await byId(db,p,z.uuid().parse(revision)):await current(db,p,id)
  if(!r)return {object_name:null,pages:null}
  if(r.material_id!==id||!r.usable)throw missing()
  return {object_name:r.object_name,pages:r.pages}
}
export async function materialHistory(db:DB,credential:string|undefined,id:string){
  if(!materialFor(id))throw missing()
  const p=await actor(db,credential)
  const {rows}=await db.query<Revision>('SELECT * FROM piyomaru_material_revision WHERE tenant_id=$1 AND staff_id=$2 AND material_id=$3 ORDER BY created_at DESC LIMIT 30',[p.tenant_id,p.id,id])
  return rows.map(safeRevision)
}
const contentType=(name:string)=>name.endsWith('.mp4')?'video/mp4':name.endsWith('.pdf')?'application/pdf':'image/jpeg'
export function createMaterialStorage(){
 const directory=process.env.PIYOMARU_MEDIA_DIRECTORY,bucket=process.env.PIYOMARU_MEDIA_BUCKET
 const auth=bucket?new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}):null
 if(bucket&&!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))throw Error('Invalid media bucket.')
 const local=directory&&!bucket?resolve(directory):null
 const path=(name:string)=>{if(!safeObject.test(name)||!local)throw unavailable();return join(local,name)}
 async function token(){const t=await auth?.getAccessToken();if(!t)throw unavailable();return t}
 const uploadBase=()=> 'https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o'
 const downloadBase=(name:string)=>'https://storage.googleapis.com/download/storage/v1/b/'+bucket+'/o/'+encodeURIComponent(name)+'?alt=media'
 function sessionURL(ref:string){
   const u=new URL(ref)
   if(u.protocol!=='https:'||u.hostname!=='storage.googleapis.com'||u.port||u.username||u.password||u.pathname!='/upload/storage/v1/b/'+bucket+'/o'||!u.searchParams.has('upload_id'))throw unavailable()
   return u.href
 }
 return {
  async start(name:string,total:number){
    if(!safeObject.test(name)||(!local&&!bucket))throw unavailable()
    if(local){await mkdir(join(local,'updates'),{recursive:true});return 'local'}
    const r=await fetch(uploadBase()+'?uploadType=resumable&name='+encodeURIComponent(name)+'&ifGenerationMatch=0',{
     method:'POST',headers:{Authorization:'Bearer '+await token(),'Content-Type':'application/json','X-Upload-Content-Type':contentType(name),'X-Upload-Content-Length':String(total)},
     body:JSON.stringify({name,contentType:contentType(name),cacheControl:'private,no-store'}),redirect:'error',signal:AbortSignal.timeout(10000)})
    if(!r.ok||!r.headers.get('location'))throw unavailable()
    return sessionURL(r.headers.get('location')!)
  },
  async chunk(ref:string,name:string,total:number,offset:number,bytes:Buffer){
    if(!safeObject.test(name))throw unavailable()
    if(local){if(ref!=='local')throw unavailable()
      let size=0;try{size=(await stat(path(name))).size}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
      if(size===offset+bytes.length)return size // previous write committed, DB response was lost
      if(size!==offset)throw conflict()
      const file=await open(path(name),offset===0?'wx':'r+')
      try{const w=await file.write(bytes,0,bytes.length,offset);if(w.bytesWritten!==bytes.length)throw unavailable()}finally{await file.close()}
      return offset+bytes.length
    }
    const send=async(data:Buffer,range:string)=>fetch(sessionURL(ref),{method:'PUT',headers:{'Content-Length':String(data.length),'Content-Range':range,'Content-Type':contentType(name)},body:new Uint8Array(data),redirect:'manual',signal:AbortSignal.timeout(18000)})
    async function parse(r:Response){
      if(r.status===308){const m=/^bytes=0-(\d+)$/.exec(r.headers.get('Range')??'');return m?Number(m[1])+1:0}
      if(r.ok){const d=await r.json();if(d.name===name&&Number(d.size)===total)return total}
      throw unavailable()
    }
    try{return await parse(await send(bytes,'bytes '+offset+'-'+(offset+bytes.length-1)+'/'+total))}
    catch{try{return await parse(await send(Buffer.alloc(0),'bytes */'+total))}catch{throw unavailable()}}
  },
  async read(name:string){
    if(!safeObject.test(name))throw unavailable()
    if(local)return readFile(path(name))
    const r=await fetch(downloadBase(name),{headers:{Authorization:'Bearer '+await token()},redirect:'error',signal:AbortSignal.timeout(12000)})
    if(!r.ok)throw unavailable();return Buffer.from(await r.arrayBuffer())
  },
  async putPage(name:string,bytes:Buffer){
    if(!safeObject.test(name)||!name.endsWith('.jpg'))throw unavailable()
    if(local){try{await writeFile(path(name),bytes,{flag:'wx'})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}return}
    const url=uploadBase()+'?uploadType=media&name='+encodeURIComponent(name)+'&ifGenerationMatch=0'
    const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+await token(),'Content-Type':'image/jpeg'},body:new Uint8Array(bytes),redirect:'error',signal:AbortSignal.timeout(10000)})
    if(!r.ok&&r.status!==412)throw unavailable()
  },
 }
}
type Storage=ReturnType<typeof createMaterialStorage>
export async function renderPdf(storage:Storage,name:string){
 const folder=await mkdtemp(join(tmpdir(),'npl-pdf-teaching-'))
 try{
  const file=join(folder,'source.pdf'),prefix=join(folder,'page')
  const bytes=await storage.read(name)
  if(bytes.length>maxPdf||!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Fault(422,'PDF_INVALID','PDFファイルを確認してください。')
  await writeFile(file,bytes,{mode:0o600})
  try{await promisify(execFile)(process.env.PIYOMARU_PDF_RENDERER??'pdftoppm',['-f','1','-l','21','-jpeg','-r','110','-scale-to','1500',file,prefix],{timeout:12000,maxBuffer:64*1024})}
  catch{throw new Fault(422,'PDF_PREVIEW','PDFのページを表示できません。パスワードなしのPDFを選択してください。')}
  const pages=(await readdir(folder)).filter(f=>/^page-\d+\.jpg$/.test(f)).sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]))
  if(!pages.length||pages.length>20)throw new Fault(422,'PDF_PAGES','PDFは20ページ以内に分けて登録してください。')
  // Read-only preview is JPEG; no PDF script or external content is executed by the app.
  await Promise.all(pages.map(async(f,i)=>storage.putPage(name.replace(/\.pdf$/,'-p'+(i+1)+'.jpg'),await readFile(join(folder,f)))))
  return pages.length
 }finally{await rm(folder,{recursive:true,force:true})}
}
export async function createMaterialDraft(db:DB,cfg:Config,credential:string|undefined,input:z.infer<typeof materialDraftInput>,storage:Storage){
 const m=materialFor(input.material);if(!m)throw missing()
 const p=await actor(db,credential)
 const id=newId()
 const old=await current(db,p,m.id)
 let object=old?.object_name??null,bytes=old?.bytes??null,pages=old?.pages??null,ref:string|null=null
 if(input.file){
  if(input.file.type!==(m.type==='video'?'video/mp4':'application/pdf')||input.file.bytes>(m.type==='video'?maxVideo:maxPdf))throw new Fault(422,'MATERIAL_TYPE','動画はMP4（64MB以内）、資料はPDF（8MB・20ページ以内）を選択してください。')
  object='updates/'+id+(m.type==='video'?'.mp4':'.pdf');bytes=input.file.bytes;pages=null
  ref=seal(cfg,'piyomaru-upload:'+id,await storage.start(object,bytes))
 }
 const {rows:[row]}=await db.query<Revision>(`INSERT INTO piyomaru_material_revision(id,tenant_id,staff_id,material_id,title,description,instructions,object_name,bytes,pages,usable,upload_box,upload_total,upload_expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $12::text IS NULL THEN NULL ELSE now()+interval '1 hour' END) RETURNING *`,
 [id,p.tenant_id,p.id,m.id,input.title,input.description,input.instructions,object,bytes,pages,!input.file,ref,input.file?.bytes??null])
 await audit(db,p.tenant_id,null,p.id,'piyomaru.material.draft',id,null,{material:m.id,uploaded:!!input.file})
 return {...safeRevision(row),chunk_size:chunkSize}
}
export async function uploadMaterialChunk(db:DB,cfg:Config,credential:string|undefined,id:string,offset:number,bytes:Buffer,storage:Storage){
 const p=await actor(db,credential),r=await byId(db,p,id,true)
 if(r.state!=='draft'||!r.upload_total||!r.object_name||!r.upload_expires_at||+r.upload_expires_at<Date.now())throw new Fault(409,'UPLOAD_EXPIRED','アップロードをやり直してください。公開済みの教材は変更していません。')
 if(r.usable)return safeRevision(r)
 if(offset!==r.upload_received||!Number.isSafeInteger(offset))throw conflict()
 if(!Buffer.isBuffer(bytes)||bytes.length!==Math.min(chunkSize,r.upload_total-offset)||bytes.length<=0)throw new Fault(422,'UPLOAD_CHUNK','ファイルの送信位置を確認してください。')
 if(offset===0){
  const good=r.object_name.endsWith('.pdf')?bytes.subarray(0,5).equals(Buffer.from('%PDF-')):bytes.length>=12&&bytes.subarray(4,8).equals(Buffer.from('ftyp'))
  if(!good)throw new Fault(422,'MATERIAL_FORMAT','MP4またはPDFの正しいファイルを選択してください。')
 }
 const received=await storage.chunk(unseal(cfg,'piyomaru-upload:'+id,r.upload_box!),r.object_name,r.upload_total,offset,bytes)
 if(received!==offset+bytes.length)throw unavailable()
 let pages=null
 if(received===r.upload_total&&r.object_name.endsWith('.pdf'))pages=await renderPdf(storage,r.object_name)
 const {rows:[updated]}=await db.query<Revision>(`UPDATE piyomaru_material_revision SET upload_received=$2,usable=$3,pages=coalesce($4,pages),
  upload_box=CASE WHEN $3 THEN NULL ELSE upload_box END WHERE id=$1 RETURNING *`,[id,received,received===r.upload_total,pages])
 return safeRevision(updated)
}
export async function publishMaterial(db:DB,cfg:Config,credential:string|undefined,input:z.infer<typeof materialPublishInput>){
 if(!materialFor(input.material))throw missing()
 const p=await actor(db,credential)
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['piyo-material:'+p.id+':'+input.material])
 const target=input.revision?await byId(db,p,input.revision,true):null
 if(target&&(!target.usable||target.material_id!==input.material))throw new Fault(409,'MATERIAL_NOT_READY','ファイルの登録が完了した教材だけ公開できます。')
 await db.query("UPDATE piyomaru_material_revision SET state='archived' WHERE material_id=$1 AND state='published'",[input.material])
 if(target)await db.query("UPDATE piyomaru_material_revision SET state='published',published_at=now() WHERE id=$1",[target.id])
 await audit(db,p.tenant_id,null,p.id,'piyomaru.material.publish',target?.id??p.id,null,{material:input.material,builtin:!target})
 return {materials:await materialCatalogFor(db,p)}
}
