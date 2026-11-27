// Reusable, anonymized copy. No example applicant data, store name, or old link.
export const intakeTemplate=Object.freeze({
  greeting:'初めまして！{{store}}です。\nこちらのアカウントでは、体験入店や求人についてのお問い合わせに対応しています。\n\n⚠️ まだ応募は完了していません。\n✅ 応募する方は下の「応募する」を押してください。',
  name:'「お名前」を入力してください。',
  station:'「最寄駅」を入力してください。',
  age:'「ご年齢」を入力してください。\n（数字のみで入力をお願いします。）',
  thanks:'{{name}}さま\nご回答いただきありがとうございます。\n\n面談の日程を組ませていただきたく、下記の予約カレンダーより希望日程を選んでください。\n\n▼▼▼予約カレンダー▼▼▼',
  confirm:'ご予約いただきありがとうございます。\n予約日時：{{booking}}（対面）',
  reminder:'予約時刻の【3時間前】になりましたのでお知らせします。\n\n予約日時：{{booking}}（対面）\n\n予約の詳細確認、日程変更、キャンセルは下のボタンから行えます。\n確認できましたらOKをお願いします！',
  faqUrl:'',mapUrl:'',reminder3h:true,
})
// Older drafts and published settings have no unblock override. They inherit
// the main flow automatically, rather than becoming a second scenario.
export function unblockSettings(settings){
  const base=Object.fromEntries(['greeting','name','station','age','thanks'].map(key=>[key,settings[key]]))
  const custom=settings.unblock
  if(!custom||custom.mode!=='custom')return {...base,mode:custom?.mode==='off'?'off':'same'}
  return {...base,...custom,mode:'custom'}
}
export const consentPrompt='応募に必要な情報（氏名・最寄駅・年齢）を、店舗の採用・面談調整のために管理します。\n内容をご確認の上、応募方法を選んでください。\nLINEで確定通知・リマインドを希望しない場合も応募できます。\n途中で「応募取消」と送ると中止できます。'
export const intakeVariable=(body,values)=>body.replace(/\{\{(store|name|booking)\}\}/g,(_,key)=>values[key]??'')
export function normalizeAnswer(stage,raw){
  const value=String(raw??'').trim()
  if(stage==='age'){const age=value.normalize('NFKC');return /^\d{1,3}$/.test(age)&&Number(age)>=1&&Number(age)<=120?String(Number(age)):null}
  return ['name','station'].includes(stage)&&value.length>0&&value.length<=80&&!/[\x00-\x1f\x7f]/.test(value)?value:null
}
