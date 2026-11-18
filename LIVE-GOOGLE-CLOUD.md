# Google Cloudで1店舗を検証

検証専用プロジェクトに、東京のCloud RunとCloud SQL for PostgreSQLを使用します。管理画面、LINEトークから開く応募フォーム・面談予約、Googleの認可は同じHTTPSの公開先を使います。

## 管理者が用意するもの

1. プロジェクトに利用するGoogle Cloudの請求先を設定します。Cloud SQLの30日間無料試用を利用できる場合は、同じプロジェクト・東京リージョンでPostgreSQLを作成します。Cloud Runなどは利用量に応じた料金が発生する場合があります。[プロジェクトの請求先](https://cloud.google.com/billing/docs/how-to/modify-project) · [Cloud SQLの無料試用](https://docs.cloud.google.com/sql/docs/postgres/free-trial-instance)
2. 検証用の店舗名、管理者のメールアドレス、採用用LINE公式アカウントの `@ID`、スマートフォンで試すLINE利用者を用意します。LINE公式アカウントでMessaging APIを有効にします。本人確認はトークン方式のため、LINEログインやLIFFは不要です。公式アカウントは稼働中のWebhookと分離した検証用アカウントを使います。
3. テスト予定を書き込めるGoogleカレンダーを用意します。Google CloudのOAuthクライアントをウェブアプリケーションとして作成し、公開先の `/interview/google-return.html` を承認済みリダイレクトURIに設定します。外部アプリのテストユーザーに、カレンダーへアクセスできるGoogleアカウントを追加します。[Google OAuth設定](https://developers.google.com/identity/protocols/oauth2/web-server)

LINEのチャネルシークレットとアクセストークンは公開後の管理画面に入力します。DBの資格情報とGoogleのOAuthクライアントシークレットは、Google Cloud Secret Managerに保存します。

## 初回の配置

1. プロジェクト内で `sqladmin.googleapis.com` と `secretmanager.googleapis.com` を有効にし、東京リージョンで検証用PostgreSQLインスタンスに `night` データベースを作成します。ローカルのCloud SQL Auth Proxyを使ってDBに接続します。初期化には `night` の所有者または管理者接続が必要です。[Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy)
2. Node.js 24で `npm ci` と `npm run build` を実行します。ローカルの初期化コマンドに `PILOT_ADMIN_DATABASE_URL`、`MIGRATION_DATABASE_URL`（`night_owner`）、`DATABASE_URL`（`night_app`）を渡します。すべてAuth Proxy経由の同じ `night` DBを指定し、各ロールに異なるパスワードを使用します。`PUBLIC_ORIGIN` は `https://night-pro-line-<PROJECT_NUMBER>.asia-northeast1.run.app`、`MASTER_KEY` は `openssl rand -base64 32` で生成した値です。
3. `node dist/pilot-db.js pilot "検証法人" <管理者メール> <非公開の招待ファイル>` を実行します。2つのDBロールが作成され、マイグレーションと管理者の招待が準備されます。招待の内容は権限を絞ったファイルに保存されます。既存環境のマイグレーションのみの場合は `npm run setup` を使用します。
4. Secret Managerにアプリ用の `night-master-key` と `night-db-url` を登録します。クラウド用のDB接続先は `postgresql://night_app:<URLエンコードしたパスワード>@localhost/night?host=/cloudsql/<INSTANCE_CONNECTION_NAME>` です。Google連携用に `night-google-client-id` と `night-google-client-secret` も登録できます。[Cloud RunのCloud SQL接続](https://cloud.google.com/sql/docs/postgres/connect-run)
5. `docker buildx build --platform linux/amd64 --load --tag night-pro-line:pilot .` で公開用イメージを作ります。`bash deploy/cloud-run.sh <PROJECT_ID> <INSTANCE_ID> night-pro-line:pilot` を実行すると、Webサービスと必要時に実行する非公開のワーカージョブが配置されます。`/api/health` がデータベースに接続できることを確認します。[Cloud Runの公開URL](https://cloud.google.com/run/docs/triggering/https-request)

ワーカーは `gcloud run jobs execute night-pro-line-worker --project <PROJECT_ID> --region asia-northeast1 --wait` で処理を1回実行できます。今回の応募・対面予約・Googleの予定照合はWeb側で処理します。最初は自動LINE送信を無効にし、検証対象の配信機能を試すときに公開環境とワーカーの設定を進めます。

## 1店舗で実機検証

1. 管理画面に管理者招待で入り、検証用店舗と採用用公式アカウントを登録する。管理画面に出るURLで、Webhookを設定する。
2. 「店舗で使う機能」で回答フォーム・応募選考・面談予約・Google照合を有効にする。「店舗業務」で採用フォームを公開する。
3. 「面談枠の管理」でGoogleカレンダーの空き状況を参照できることを確認し、Googleに「予定あり」で入れた時間と、空いている時間に対面枠を公開する。
4. 検証用公式アカウントのリッチメニュー（postback）から届く専用URLでスマートフォンから採用フォームを開き、本人確認、回答送信、対面枠の確定を行う。重複枠が予約できず、空き枠の予約と応募回答が店舗側に表示されることを確認する。
5. 別の空き枠を選んだままGoogleに予定を追加し、確定時に拒否されることも確認する。

[実機検証の詳細と後片付け](LIVE-INTERVIEW.md)
