import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { GoogleAuth } from 'google-auth-library'
import { z } from 'zod'

const identifier=z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)
const operation=z.object({name:z.string().min(1),status:z.enum(['PENDING','RUNNING','DONE']),
  error:z.object({errors:z.array(z.object({code:z.string().optional()}))}).optional()})

// Export through the Cloud SQL API. The database grants and application secrets
// are never loaded into the backup job's process.
const project=identifier.parse(process.env.BACKUP_PROJECT)
const instance=identifier.parse(process.env.BACKUP_INSTANCE)
const bucket=identifier.parse(process.env.BACKUP_BUCKET)
const database=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(process.env.BACKUP_DATABASE)
const instant=new Date()
const now=instant.toISOString()
const weekly=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',weekday:'short'}).format(instant)==='Sun'
const object=database+'/'+(weekly?'weekly':'daily')+'/'+now.slice(0,10)+'/'+now.replace(/[:.]/g,'-')+'-'+randomUUID()+'.sql.gz'
const root='https://sqladmin.googleapis.com/sql/v1beta4/projects/'+project
const client=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient()

try{
  const submitted=await client.request({url:root+'/instances/'+instance+'/export',method:'POST',
    data:{exportContext:{fileType:'SQL',uri:'gs://'+bucket+'/'+object,databases:[database]}},
    signal:AbortSignal.timeout(20000),retry:false})
  let current=operation.parse(submitted.data)
  const deadline=Date.now()+12*60000
  while(current.status!=='DONE'){
    if(Date.now()>deadline)throw new Error('Backup operation timed out')
    await delay(5000)
    current=operation.parse((await client.request({url:root+'/operations/'+encodeURIComponent(current.name),
      signal:AbortSignal.timeout(20000)})).data)
  }
  if(current.error?.errors.length)throw new Error('Cloud SQL export failed')
  console.log(JSON.stringify({status:'backup_completed',object}))
}catch{
  console.error('Cloud SQL logical backup did not complete')
  process.exitCode=1
}
