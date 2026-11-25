# Night PRO LINE 低コスト本番データベース移行

## 構成

- Night PRO LINE専用のSupabase Free組織、東京 (`ap-northeast-1`)、Nano 1プロジェクト、追加有償オプションなし。利用者の指示によりNight Paletteのデモだけを一時停止し、無料枠を確保する。本番Night Paletteには手を加えない。
- アプリ、LINE Webhook、即時配信用Cloud Tasks、Googleカレンダー、既存URLはCloud Runに残す。
- Cloud Schedulerから1分ごとに署名付きのHTTPリクエストで通知・ステップ・キャンペーン・カレンダー同期を実行する。Cloud Run Jobの最低1分課金をなくす。既存ワーカージョブは緊急時の復旧用であり、通常は起動しない。
- 現在の暗号化キーはSecret Managerで保持したまま、接続文字列だけを別のシークレットに切り替える。データベースの管理用パスワードをWebへ渡さない。

## 移行前確認

2026-11-25時点のCloud SQLはPostgreSQL 18、無料試用。Supabaseで使われるPostgreSQL 17への互換性をローカルPostgreSQL 17.12で検証済み。既存のCloud SQL SQLエクスポートで69テーブルを復元し、372行のCOPYテキストのSHA-256比較、アプリロールによる法人・店舗データの未認可参照が0行であることを確認した。アプリの自動テスト（認証、店舗分離、LINE連携、面談の重複防止、配信等）もPostgreSQL 17上で実行した。本番Supabaseへの移行確認とは区別する。

## 専用プロジェクトへのリハーサル

1. Freeの空き枠で東京のNanoプロジェクトを作成。Data APIは有効にしない。
2. DashboardのConnectからセッションプーラーの接続情報（ポート5432）を取得。Dashboardが提供するCA証明書を取得し、TLS検証を必須にする。接続URLは `sslmode=verify-full&sslrootcert=...` を使用する。トランザクションプーラーは使用しない。Cloud Runは `/secrets/supabase-ca.crt` にCA証明書をマウントする。
3. `npm run build` 後、`SUPABASE_ADMIN_DATABASE_URL` を非公開環境変数に設定し、`node deploy/supabase-roles.mjs <private-file>` を実行。`night_owner` と `night_app` を別々に生成する。ランタイムには `night_app` のみ渡す。
4. 既存Cloud SQLのGCS SQLエクスポートを、権限を絞った作業場所に取得する。`MIGRATION_DATABASE_URL`（owner）、`VALIDATION_DATABASE_URL`（検証用管理者）、`DATABASE_URL`（app）を出力せず設定し、`node deploy/restore-export.mjs <snapshot.sql.gz>` を実行する。PostgreSQL 17以降のpsqlを使用。Cloud SQL固有の `public` スキーマへのACLのみ除外し、全行、スキーマ、既存GRANT、RLSポリシー、シーケンスを復元する。既存 `night` スキーマが存在する場合は上書きしない。
5. `assertAppRole`、全テーブルの内容比較、マスター/エールの操作範囲、カレンダー空き枠、テスト配信を検証。テスト環境では実在する配信先へ送らない。

## 本番切替（リハーサル成功後）

- 短いメンテナンス時間を設け、HTTPと定期実行・Cloud Tasksの新規処理を停止し、処理中のリクエストが終了したことを確認する。旧DBへの書き込みがない状態で最終エクスポートを取得する。リハーサルと本番のスキーマを混ぜない。検証用スキーマを削除する場合は、元のCloud SQLとGCSバックアップが復元できることを確かめる。
- 最新エクスポートを新規スキーマへ復元して全行を照合する。アプリ接続URLを新しいSecret Managerシークレットに登録し、Cloud Runのリビジョンと緊急ワーカーの接続先を旧SQLインスタンスから新しいDBに更新する。
- 新リビジョンの専用タグURLで `/api/health` と読み取り操作を検証し、元のURLに100%のトラフィックを移す。Cloud Tasks、定期処理を再開。二重送信や予約重複がないことを確認する。稼働後の切戻しは新旧でデータ差が発生するため、単純なトラフィック変更ではなく差分を保全した上で判断する。
- 旧Cloud SQLは即時に削除せず、切替確認まで保持する。無料試用を有償化しない。切替完了後、旧専用バックアップの定期実行を止める。FreeプランではSupabase標準の自動バックアップはない。ユーザーの費用方針に従い、追加の有料バックアップを契約せず、既存のGCSにある移行前データは保存期限まで維持する。
- 実際のLINEから「面談予約」の専用リンク到達時間、確定通知、ステップ、Googleカレンダー予定と重複する予約の拒否、管理画面の反映を確認する。

## 月額の管理

Supabase Freeは500MB・共有CPU・500MB RAM・一定期間の低活動による一時停止の制約がある。DB使用量、CPUと接続数を監視する。必要な自動配信は1分間隔のまま継続し、停止を防ぐためだけのアクセスは作らない。利用量または可用性要件が無料枠を超える場合はProへの移行を検討する。Cloud Runの月額2,500円予算通知は停止上限ではない。LINE公式アカウント料金は別途。

切替完了後の再公開は `bash deploy/cloud-run.sh <PROJECT_ID> external-postgres <local-image>` を使う。アプリ用DB接続とCAを保持し、Cloud SQLの接続設定を再追加しない。
