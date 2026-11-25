import {createHash} from 'node:crypto'
import sharp from 'sharp'
import {audit,Fault,missing,newId,scope,tx,type Config,type Actor,type DB} from './core.js'
import type pg from 'pg'

export const imageInputLimit=4*1024*1024
const quota=30*1024*1024
function url(cfg:Config,id:string){return cfg.origin+'/line-media/'+id+'.jpg'}
function fail(){return new Fault(422,'INVALID_IMAGE','JPEGまたはPNG画像を選択してください。4MB以下、1600万画素以下に対応しています。')}
export async function sanitizeStudioImage(input:Buffer){
  if(!Buffer.isBuffer(input)||!input.length||input.length>imageInputLimit)throw fail()
  const jpeg=input.length>=3&&input[0]===0xff&&input[1]===0xd8&&input[2]===0xff
  const png=input.length>=8&&input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if(!jpeg&&!png)throw fail()
  try{
    const image=sharp(input,{limitInputPixels:16000000,failOn:'warning',sequentialRead:true})
    const m=await image.metadata()
    if((jpeg&&m.format!=='jpeg')||(png&&m.format!=='png')||!m.width||!m.height||m.width*m.height>16000000||(m.pages??1)>1)throw fail()
    const {data,info}=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:79,mozjpeg:true}).toBuffer({resolveWithObject:true})
    if(data.length>800000)throw fail()
    return {data,width:info.width,height:info.height,hash:createHash('sha256').update(data).digest('hex')}
  }catch{throw fail()}
}
export async function uploadStudioImage(db:DB,cfg:Config,actor:Actor,storeId:string,body:Buffer){
  const image=await sanitizeStudioImage(body)
  // Serialize quota and content deduplication only within the selected store.
  if(!(await db.query('SELECT id FROM store WHERE id=$1 FOR UPDATE',[storeId])).rowCount)throw missing()
  const {rows:[existing]}=await db.query('SELECT id,bytes,width,height,created_at FROM studio_media WHERE store_id=$1 AND sha256=$2',[storeId,image.hash])
  if(existing)return {...existing,url:url(cfg,existing.id)}
  const {rows:[usage]}=await db.query('SELECT coalesce(sum(bytes),0)::int AS bytes FROM studio_media WHERE store_id=$1',[storeId])
  if(usage.bytes+image.data.length>quota)throw new Fault(409,'MEDIA_QUOTA','店舗の画像容量30MBに達しました。既存画像または公開画像URLを使用してください。')
  const id=newId()
  const {rows:[row]}=await db.query('INSERT INTO studio_media(id,tenant_id,store_id,sha256,content,bytes,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,bytes,width,height,created_at',[id,actor.tenant_id,storeId,image.hash,image.data,image.data.length,image.width,image.height])
  await db.query('INSERT INTO studio_media_route(id,tenant_id,store_id) VALUES($1,$2,$3)',[id,actor.tenant_id,storeId])
  await audit(db,actor.tenant_id,storeId,actor.id,'studio.media.upload',id,null,{bytes:image.data.length})
  return {...row,url:url(cfg,id)}
}
export async function listStudioImages(db:DB,cfg:Config,storeId:string){
  const {rows}=await db.query('SELECT id,bytes,width,height,created_at FROM studio_media WHERE store_id=$1 ORDER BY created_at DESC,id LIMIT 100',[storeId])
  return rows.map(row=>({...row,url:url(cfg,row.id)}))
}
export async function publicStudioImage(pool:pg.Pool,id:string){
  return tx(pool,async db=>{
    const {rows:[r]}=await db.query('SELECT tenant_id,store_id FROM studio_media_route WHERE id=$1',[id])
    if(!r)throw missing()
    await scope(db,r.tenant_id,r.store_id)
    const {rows:[image]}=await db.query<{content:Buffer}>('SELECT content FROM studio_media WHERE id=$1 AND store_id=$2',[id,r.store_id])
    if(!image)throw missing()
    return image.content
  })
}
