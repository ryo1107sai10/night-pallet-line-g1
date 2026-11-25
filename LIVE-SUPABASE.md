# Night PRO LINE 低コスト本番データベース移行

## 構成

- Night PRO LINE専用のSupabase Pro組織、東京 (`ap-northeast-1`)、Micro 1プロジェクト、追加有償オプションなし。既存のNight Paletteのプロジェクトは変更しない。
- アプリ、LINE Webhook、即時配信用Cloud Tasks、Googleカレンダー、既存URLはCloud Runに残す。
- Cloud Schedulerから1分ごとに署名付きのHTTPリクエストで通知・ステップ・キャンペーン・カレンダー同期を実行する。Cloud Run Jobの最低1分課金をなくす。既存ワーカージョブは緊急時の復旧用であり、通常は起動しない。
- 現在の暗号化キーはSecret Managerで保持したまま、接続文字列だけを別のシークレットに切り替える。データベースの管理用パスワードをWebへ渡さない。

## 移行前確認

2026-11-25時点のCloud SQLはPostgreSQL 18、無料試用。Supabaseで使われるPostgreSQL 17への互換性をローカルPostgreSQL 17.12で検証済み。既存のCloud SQL SQLエクスポートで69テーブルを復元し、372行のCOPYテキストのSHA-256比較、アプリロールによる法人・店舗データの未認可参照が0行であることを確認した。アプリの自動テスト（認証、店舗分離、LINE連携、面談の重複防止、配信等）もPostgreSQL 17上で実行した。本番Supabaseへの移行確認とは区別する。

## 専用プロジェクトへのリハーサル

1. Pro契約を確認し、東京のMicroプロジェクトを作成。Data APIに `night` スキーマを公開しない。
2. DashboardのConnectからセッションプーラーの接続情報（ポート5432）を取得。TLS証明書検証を有効にし、管理者接続情報は非公開の方法で設定する。`sslmode=verify-full` を使用する。トランザクションプーラーは使用しない。
3. `npm run build` 後、`SUPABASE_ADMIN_DATABASE_URL` を非公開環境変数に設定し、`node deploy/supabase-roles.mjs <private-file>` を実行。`night_owner` と `night_app` を別々に生成する。ランタイムには `night_app` のみ渡す。
4. 既存Cloud SQLのGCS SQLエクスポートを、権限を絞った作業場所に取得する。`MIGRATION_DATABASE_URL`（owner）、`VALIDATION_DATABASE_URL`（検証用管理者）、`DATABASE_URL`（app）を出力せず設定し、`node deploy/restore-export.mjs <snapshot.sql.gz>` を実行する。PostgreSQL 17以降のpsqlを使用。Cloud SQL固有の `public` スキーマへのACLのみ除外し、全行、スキーマ、既存GRANT、RLSポリシー、シーケンスを復元する。既存 `night` スキーマが存在する場合は上書きしない。
5. `assertAppRole`、全テーブルの内容比較、マスター/エールの操作範囲、カレンダー空き枠、テスト配信を検証。テスト環境では実在する配信先へ送らない。

## 本番切替（リハーサル成功後）

- 短いメンテナンス時間を設け、HTTPと定期実行・Cloud Tasksの新規処理を停止し、処理中のリクエストが終了したことを確認する。旧DBへの書き込みがない状態で最終エクスポートを取得する。リハーサルと本番のスキーマを混ぜない。検証用スキーマを削除する場合は、元のCloud SQLとGCSバックアップが復元できることを確かめる。
- 最新エクスポートを新規スキーマへ復元して全行を照合する。アプリ接続URLを新しいSecret Managerシークレットに登録し、Cloud Runのリビジョンと緊急ワーカーの接続先を旧SQLインスタンスから新しいDBに更新する。
- 新リビジョンの専用タグURLで `/api/health` と読み取り操作を検証し、元のURLに100%のトラフィックを移す。Cloud Tasks、定期処理を再開。二重送信や予約重複がないことを確認する。稼働後の切戻しは新旧でデータ差が発生するため、単純なトラフィック変更ではなく差分を保全した上で判断する。
- 旧Cloud SQLは即時に削除せず、切替確認まで保持する。無料試用終了前に旧インスタンスと旧バックアップジョブを停止するかどうか判断する。Supabase Proの日次バックアップと復旧手順を確認し、既存のGCSにある旧バックアップは保存期限まで維持する。
- 実際のLINEから「面談予約」の専用リンク到達時間、確定通知、ステップ、Googleカレンダー予定と重複する予約の拒否、管理画面の反映を確認する。

## 月額の管理

Supabase Proは1プロジェクトMicroなら$25/月（現時点の見積）。Spend Capを有効にし、日次バックアップ、DB使用量、CPUと接続数を監視する。Cloud Runはリクエストベース課金、定期処理の実行時間をログから集計。LINE公式アカウントの契約料金を除き、利用量ベースで月額5,000〜7,000円程度を目標とする。無料枠は請求アカウントで共有されることがあり、予算通知は請求の強制停止とは異なる。
