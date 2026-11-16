import { type DB } from './core.js'

export async function handoffUntil(db:DB,channel:string,userKey:string) {
  const {rows:[handoff]}=await db.query<{until_at:Date}>(`SELECT until_at FROM line_handoff
    WHERE channel_id=$1 AND user_key=$2 AND until_at>now()`,[channel,userKey])
  return handoff?.until_at??null
}
