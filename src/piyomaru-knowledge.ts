// Versioned, verified project procedures, not model-training data or personal data.
export const knowledge=Object.freeze({
  store:{title:'店舗の登録',keywords:['店舗','法人','管理会社','登録','新規','導入'],body:'北村さんは監督画面から、監督対象の管理会社を選び、その会社に契約店舗を登録します。ピヨ丸の導入代行では店舗名・所在地・営業区分・責任者・面談受付時間を確認し、店舗と採用機能の準備をします。既存店の変更は事前に確認します。'},
  line:{title:'公式LINEの開設・連携',keywords:['line','ライン','公式','Webhook','messaging','トークン','チャネル','接続','返信','応答'],body:'LINE Official Account Manager https://manager.line.biz/ で公式LINEを作り、設定のMessaging APIを有効にします。LINE Developers https://developers.line.biz/console/ で該当チャネルを開き、チャネルID・シークレット・アクセストークンをNight PRO LINEの安全な接続欄に入力。Webhook URLを設定して利用をオン、検証を行い、応答の重複を止めます。未開設の場合の本人認証・規約同意は管理権限者が行います。接続の一般LINEテストまで確認します。AIチャットに認証情報を貼らないでください。'},
  calendar:{title:'Googleカレンダー連携',keywords:['google','カレンダー','空き','重複'],body:'店舗の面談枠の管理 → Googleカレンダー連携へ進み、対象のカレンダーを選択します。既存の連携方式に応じ本人の認可、または専用サービスアカウントへの空き時間の共有が必要です。店舗別に照合し、取得できない枠は受付を保留します。会場の予定と重なる枠が取れないことをテストします。'},
  draft:{title:'ステップ配信と面談基本型',keywords:['ステップ','テンプレ','文面','タグ','応募','質問','シナリオ','リマインド','3時間','ok'],body:'シナリオスタジオの「面談までの基本の型」ではLINEトークで応募意思確認、名前、最寄駅、年齢、予約案内、確定カード、前日・3時間前リマインドとOK確認を設定できます。匿名の標準文面を店舗単位の下書きとして作り、プレビューで確認してから公開する方式です。公開中の友だち追加・フォーム配信は重複を避けます。タグのテンプレートも利用できます。'},
  slots:{title:'面談枠の準備',keywords:['面談枠','受付','予約枠','予約','時間','30分','対面'],body:'面談枠の管理で30分単位の対面枠を選び、店舗別の受付時間・会場・休止時間を設定します。標準は18時から24時。Googleカレンダーと重なっていない枠だけを公開します。申込者の個人情報はAIの知識に保存しません。'},
  publish:{title:'テストと公開',keywords:['テスト','検証','公開','配信','有効','通知','契約'],body:'公開前に店舗の契約・適格性、公式LINEの一般利用者との送受信、Googleカレンダー接続、今後の公開枠、配信状態を確認します。導入代行は下書き・実際の設定状況の照合を進め、公開だけは管理者が確認して確定します。実際に受信していない通知を成功とは扱いません。'},
  handoff:{title:'店長対応と引き継ぎ',keywords:['店長','引き継','手動','エール','マスター','権限'],body:'店長はNight PRO LINEではなくLINE公式アカウントのアプリから一時的に手動返信できます。エールは店長への引き継ぎで自動配信を止め、終了すると通常運用に戻ります。北村さんは全体監督、エールの2名は同等の店舗管理権限で個人別認証です。ピヨ丸のAI機能は北村さんの監督者アカウント専用です。'},
  security:{title:'本人認証・安全な運用',keywords:['認証','パスワード','ログイン','秘密','セキュリティ','認証アプリ','設定キー'],body:'本人のパスワード、認証アプリの6桁コード、LINEトークン、APIキーはAIチャットには入力しません。必要な情報は公式のログイン画面、またはNight PRO LINEの専用秘密情報設定欄に入力します。北村さん自身の認証が必要な箇所は代行しません。店舗と管理会社の分離を維持します。'},
  budget:{title:'Museと利用料金',keywords:['muse','ai','費用','料金','予算','課金','ピヨ丸','学習','記憶'],body:'ピヨ丸は通常の案内に内蔵知識を使い、Muse接続後は質問に低コストのMuse Emberを使用します。難しい質問にはMuse Sparkを選べます。通常運用のLINE配信にはAIを呼び出しません。AI利用支出の上限はピヨ丸設定で確認できます。成功した業務手順の種類と実績を保存し、個人情報・認証情報は学習データに含めません。API料金は推定値で、Meta側の請求とは別です。'},
})
export type Topic=keyof typeof knowledge
export function selectKnowledge(q:string,limit=3):Topic[]{
  const query=q.toLowerCase()
  const ranked=(Object.keys(knowledge) as Topic[]).map(topic=>({topic,score:knowledge[topic].keywords.reduce((sum,k)=>sum+(query.includes(k.toLowerCase())?k.length:0),0)}))
    .filter(item=>item.score>0).sort((a,b)=>b.score-a.score)
  return ranked.slice(0,limit).map(item=>item.topic)
}
