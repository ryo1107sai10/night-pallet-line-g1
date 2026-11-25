import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { createApp } from '../dist/app.js'
import { coalesceScheduledWork, scheduledWorkPath } from '../dist/scheduled-work.js'

test('定期処理の同時実行をまとめ、失敗後は次回実行できる', async () => {
  let count=0, release
  const run=coalesceScheduledWork(async()=>{
    count++
    await new Promise(resolve=>{release=resolve})
    if(count===1)throw new Error('temporary')
  })
  const first=run(), retry=run()
  assert.equal(first,retry)
  await Promise.resolve()
  assert.equal(count,1)
  release()
  await assert.rejects(first,/temporary/)
  const next=run()
  await Promise.resolve()
  assert.equal(count,2)
  release()
  await next
})

test('定期処理のHTTP入口は正しい呼び出し元だけを許可する',async()=>{
  let runs=0, rejected=false
  const cfg={origin:'https://example.test',master:randomBytes(32),external:true}
  const scheduled={verify:async header=>header==='Bearer scheduled-test',run:async()=>{runs++;if(rejected)throw new Error('temporary')}}
  const server=createApp({},cfg,undefined,undefined,undefined,scheduled).listen(0,'127.0.0.1')
  await once(server,'listening')
  try {
    const url=`http://127.0.0.1:${server.address().port}${scheduledWorkPath}`
    const call=authorization=>fetch(url,{method:'POST',headers:authorization?{Authorization:authorization}:{}})
    assert.equal((await call()).status,403)
    assert.equal((await call('Bearer line-task')).status,403)
    assert.equal(runs,0)
    assert.equal((await call('Bearer scheduled-test')).status,204)
    assert.equal(runs,1)
    rejected=true
    assert.equal((await call('Bearer scheduled-test')).status,503)
    assert.equal(runs,2)
  } finally { await new Promise(resolve=>server.close(resolve)) }
})
