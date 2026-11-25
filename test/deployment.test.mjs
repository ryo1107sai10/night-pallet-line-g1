import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runtimeConfig, verifyTraffic } from '../deploy/runtime-config.mjs'

const current = { spec: { template: { spec: { containers: [{ env: [
  {name:'AUTO_SEND_ENABLED',value:'true'},
  {name:'GOOGLE_SHARED_CALENDAR_STORE',value:'store-one'},
  {name:'GOOGLE_SHARED_CALENDAR_ID',value:'private-calendar@example.test'},
  {name:'GOOGLE_SHARED_CALENDAR_ACCOUNT',value:'calendar@project.iam.gserviceaccount.com'},
  {name:'PUBLIC_BOOKING_CONNECTION',value:'connection-one'},
  {name:'MASTER_KEY',valueFrom:{secretKeyRef:{name:'night-master-key',key:'3'}}},
] }] } } } }

test('再公開でも配信設定と共有カレンダーと秘密情報の参照先を維持する', () => {
  const next = runtimeConfig(current,'https://example.test')
  assert.equal(next.environment.AUTO_SEND_ENABLED,'true')
  assert.equal(next.environment.GOOGLE_SHARED_CALENDAR_ID,'private-calendar@example.test')
  assert.equal(next.environment.PUBLIC_BOOKING_CONNECTION,'connection-one')
  assert.equal(next.environment.MASTER_KEY,undefined)
  assert.equal(next.bindings,'MASTER_KEY=night-master-key:3')
  assert.equal(runtimeConfig(current,'https://example.test','false').environment.AUTO_SEND_ENABLED,'false')
  assert.equal(runtimeConfig({},'https://example.test').environment.AUTO_SEND_ENABLED,'false')
  assert.throws(() => runtimeConfig(current,'https://example.test','yes'))
  const broken = structuredClone(current)
  broken.spec.template.spec.containers[0].env.splice(1,1)
  assert.throws(() => runtimeConfig(broken,'https://example.test'), /three shared calendar/)
})

test('新リビジョンへ100%切り替わっていない公開結果は失敗にする', () => {
  assert.doesNotThrow(() => verifyTraffic({status:{latestReadyRevisionName:'new',traffic:[
    {revisionName:'new',percent:100},{revisionName:'old',tag:'rollback',percent:0},
  ]}},'new'))
  for (const traffic of [[{revisionName:'old',percent:100}], [{revisionName:'new',percent:90},{revisionName:'old',percent:10}]]) {
    assert.throws(() => verifyTraffic({status:{latestReadyRevisionName:'new',traffic}},'new'))
  }
})

test('公開手順は新画面を先に検査し、同じ設定とイメージをワーカーへ渡してから切り替える', async () => {
  const dir = await mkdtemp(join(tmpdir(),'night-deployment-'))
  try {
    const stub = `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {basename} from 'node:path';
const cmd=basename(process.argv[1]),args=process.argv.slice(2),root=process.env.NIGHT_TEST_DIR;
appendFileSync(root+'/calls',JSON.stringify({cmd,args})+'\\n');
const value=k=>args[args.indexOf(k)+1];
if(cmd==='docker'){
 if(args.includes('inspect')) console.log(args.includes('{{.Os}}/{{.Architecture}}')?'linux/amd64':'sha256:build-one');
 else if(args[0]==='context')console.log('unix:///tmp/night-test-docker.sock');
 else if(args.includes('login'))process.stdin.resume();
}else if(cmd==='curl'){
 if(process.env.NIGHT_FAIL_HEALTH==='true')process.exit(22);
 console.log(JSON.stringify({status:'ok'}));
}else if(args[0]==='billing')console.log('True');
else if(args[0]==='projects'&&args[1]==='describe')console.log('123');
else if(args[0]==='sql')console.log('sample-project:asia-northeast1:sample-db');
else if(args[0]==='auth')console.log('TEST-ONLY-CREDENTIAL');
else if(args[0]==='run'&&args[1]==='services'&&args[2]==='list')console.log('night-pro-line');
else if(args[0]==='run'&&args[1]==='deploy'){
 writeFileSync(root+'/tag',value('--tag')); console.log('night-pro-line-new');
 writeFileSync(root+'/web-env',readFileSync(value('--env-vars-file')));
}else if(args[0]==='run'&&args[1]==='revisions')console.log('registry/app@sha256:resolved');
else if(args[0]==='run'&&args[1]==='jobs'){
 writeFileSync(root+'/worker-env',readFileSync(value('--env-vars-file')));
}else if(args[0]==='run'&&args[1]==='services'&&args[2]==='update-traffic')writeFileSync(root+'/live','yes');
else if(args[0]==='run'&&args[1]==='services'&&args[2]==='describe'){
 const staged=existsSync(root+'/tag'),live=existsSync(root+'/live');
 console.log(JSON.stringify({...JSON.parse(readFileSync(root+'/current','utf8')),status:{
 latestReadyRevisionName:staged?'night-pro-line-new':'night-pro-line-old',traffic:live?
 [{revisionName:'night-pro-line-new',percent:100}]:[
 {revisionName:'night-pro-line-old',percent:100},...(staged?[{revisionName:'night-pro-line-new',tag:readFileSync(root+'/tag','utf8'),url:'https://staged.example.test'}]:[])]}}));
}
`
    for (const command of ['gcloud','docker','curl']) await writeFile(join(dir,command),stub,{mode:0o700})
    await writeFile(join(dir,'current'),JSON.stringify(current))
    const env = {...process.env,PATH:dir+':'+process.env.PATH,NIGHT_TEST_DIR:dir}
    delete env.AUTO_SEND_ENABLED
    let result = spawnSync('bash',['deploy/cloud-run.sh','sample-project','sample-db','app:local'],
      {cwd:resolve('.'),env,encoding:'utf8'})
    assert.equal(result.status,0,result.stderr)
    assert.equal(await readFile(join(dir,'web-env'),'utf8'),await readFile(join(dir,'worker-env'),'utf8'))
    const calls=(await readFile(join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse)
    const health=calls.findIndex(c=>c.cmd==='curl'&&c.args.includes('https://staged.example.test/api/health'))
    const worker=calls.findIndex(c=>c.cmd==='gcloud'&&c.args.includes('jobs'))
    const traffic=calls.findIndex(c=>c.cmd==='gcloud'&&c.args.includes('update-traffic'))
    assert.ok(health<worker&&worker<traffic)
    assert.ok(calls[worker].args.includes('registry/app@sha256:resolved'))
    await rm(join(dir,'calls'));await rm(join(dir,'live'));await rm(join(dir,'tag'))
    result=spawnSync('bash',['deploy/cloud-run.sh','sample-project','sample-db','app:local'],
      {cwd:resolve('.'),env:{...env,NIGHT_FAIL_HEALTH:'true'},encoding:'utf8'})
    assert.notEqual(result.status,0)
    assert.ok(!(await readFile(join(dir,'calls'),'utf8')).includes('update-traffic'))
    await rm(join(dir,'calls'));await rm(join(dir,'tag'))
    const external=structuredClone(current)
    external.spec.template.spec.containers[0].env.push({name:'DATABASE_URL',valueFrom:{secretKeyRef:{name:'night-supabase-app-url',key:'1'}}})
    await writeFile(join(dir,'current'),JSON.stringify(external))
    result=spawnSync('bash',['deploy/cloud-run.sh','sample-project','external-postgres','app:local'],{cwd:resolve('.'),env,encoding:'utf8'})
    assert.equal(result.status,0,result.stderr)
    const supabaseCalls=(await readFile(join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse)
    const releases=supabaseCalls.filter(c=>c.cmd==='gcloud'&&c.args[0]==='run'&&(c.args[1]==='deploy'||c.args[1]==='jobs'))
    assert.equal(releases.length,2)
    for(const call of releases){
      assert.ok(call.args.includes('--clear-cloudsql-instances'))
      assert.ok(call.args.some(arg=>arg.includes('DATABASE_URL=night-supabase-app-url:1')&&arg.includes('/secrets/supabase-ca.crt=night-supabase-ca:latest')))
    }
    assert.ok(!supabaseCalls.some(c=>c.cmd==='gcloud'&&c.args[0]==='sql'))
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('定期実行の新規作成と更新を区別し、専用アカウントで1分ごとにジョブだけを実行する',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'night-scheduler-'))
  try{
    await writeFile(join(dir,'gcloud'),`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),root=process.env.NIGHT_TEST_DIR;
appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
if(args[0]==='scheduler'&&args[2]==='list'&&process.env.NIGHT_EXISTING==='true')console.log('projects/sample/locations/asia-northeast1/jobs/night-pro-line-notices');
if(args[0]==='scheduler'&&args[2]==='update'&&args.some(a=>a.startsWith('--headers=')))process.exit(2);
`,{mode:0o700})
    for(const existing of ['false','true']){
      const result=spawnSync('bash',['deploy/schedule-worker.sh','sample-project','1'],
        {env:{...process.env,PATH:dir+':'+process.env.PATH,NIGHT_TEST_DIR:dir,NIGHT_EXISTING:existing},encoding:'utf8'})
      assert.equal(result.status,0,result.stderr)
      const calls=(await readFile(join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse)
      const setup=calls.find(c=>c[0]==='scheduler'&&['create','update'].includes(c[2]))
      assert.equal(setup[2],existing==='true'?'update':'create')
      assert.ok(setup.includes('--schedule=*/1 * * * *'))
      assert.ok(setup.includes('--http-method=POST'))
      assert.ok(setup.includes('--oauth-service-account-email=night-schedule-invoker@sample-project.iam.gserviceaccount.com'))
      assert.ok(setup.includes('--uri=https://run.googleapis.com/v2/projects/sample-project/locations/asia-northeast1/jobs/night-pro-line-worker:run'))
      await rm(join(dir,'calls'))
    }
  }finally{await rm(dir,{recursive:true,force:true})}
})
