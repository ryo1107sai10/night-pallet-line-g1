import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'

test('リリース時に操作原稿と現行UIの文言を照合し、全ページを自動生成する',()=>{
  const source=JSON.parse(readFileSync('docs/manual/operation-manual.json','utf8'))
  assert.equal(source.sections.reduce((a,s)=>a+s.count,0),source.pages.length)
  assert.ok(source.pages.length>=18)
  assert.ok(source.pages.some(p=>p.title.includes('ピヨ丸')))
  assert.doesNotMatch(JSON.stringify(source),/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)
  for(const [file,labels] of Object.entries(source.ui_labels)){
    assert.ok(file.startsWith('public/'));const code=readFileSync(file,'utf8')
    for(const label of labels)assert.ok(code.includes(label),`操作原稿の文言を更新: ${file}: ${label}`)
  }
  const docker=readFileSync('Dockerfile','utf8')
  assert.match(docker,/python3 scripts\/build-operation-manual\.py/)
  assert.match(docker,/COPY --chown=node:node --from=build \/app\/manual-generated \.\/manual-generated/)
  assert.match(docker,/NPL_REQUIRE_RELEASE_MANUAL=1/)
})
