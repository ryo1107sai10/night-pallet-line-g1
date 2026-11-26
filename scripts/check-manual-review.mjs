// A release builds and publishes its manual regardless of whether text changed.
// Requiring review of user-facing behavior prevents silently issuing stale instructions.
import {execFileSync} from 'node:child_process'
const base=process.argv[2]
if(!base||/^0+$/.test(base)){console.log('Initial build: manual source validation still runs.');process.exit(0)}
const paths=execFileSync('git',['diff','--name-only',base,'HEAD'],{encoding:'utf8'}).trim().split('\n')
const affected=paths.some(p=>/^public\/.*\.(?:html|mjs)$/.test(p)||/^src\/(?:auth|agency|platform|piyomaru|interview|store-health|scenario|recruitment|line|workflows)/.test(p))
if(affected&&!paths.some(p=>p==='docs/manual/operation-manual.json'||p==='docs/manual/review.md')){
  console.error('操作に関連する変更があります。docs/manual/operation-manual.json の手順を更新するか、変更不要の理由を docs/manual/review.md に記録してください。');process.exit(1)
}
console.log('Manual review checked.')
