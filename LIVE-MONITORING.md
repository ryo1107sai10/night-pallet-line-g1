# Night PRO LINE 障害監視（2026-11-25）

監視対象は既存の本番 Cloud Run / Supabase / Cloud Tasks / Cloud Scheduler とLINE・Google連携。通知先は利用者が指定した管理窓口。別の有料監視サービスを契約しない。

| 監視 | 判定 |
| --- | --- |
| Web・DB | 5分おき、シンガポール・米国・欧州の3地域から公開HTTPSの `/api/health` を確認。複数地域で異常になった状態が続くと通知 |
| 定期処理 | 1分ごとの `scheduled_work_completed` 成功記録が5分間途絶えた場合 |
| サーバー | 5分間のCloud Run HTTP 5xxが3件以上 |
| 即時処理 | Cloud Tasksキューの滞留30件超が5分継続 |
| LINE | LINE操作の認証エラー・429・5xx・通信失敗／即時処理の登録失敗 |
| Google Calendar | 空き時間照合の障害／予定同期の再試行終了 |

本番の稼働監視は実際に3地域すべての正常値と定期処理成功の時系列を取得した。通知発生には評価・収集の遅延がある。LINEの通常の宛先別400エラーは店舗の配信履歴で確認し、認証・外部連携障害の通知とは分ける。送信先、メッセージ本文、トークン、カレンダーIDは監視用ログに出さない。

- [Cloud Monitoringの監視・通知ルール](https://console.cloud.google.com/monitoring/alerting/policies?project=night-pro-line-pilot-20261116)
- [Cloud Run ログ](https://console.cloud.google.com/run?project=night-pro-line-pilot-20261116)
- [Cloud Tasks ログ・キュー](https://console.cloud.google.com/cloudtasks?project=night-pro-line-pilot-20261116)

復旧時は、本番サイトへの接続、定期処理、対象店舗の配信履歴・接続チェック・カレンダー状態を照合する。送信結果不明を無条件で再送しない。Googleの照合ができない場合は空き枠として扱わない。以前指示された追加バックアップ契約なしの方針は変えていない。

[Google Cloud Observability料金](https://cloud.google.com/products/observability/pricing) によれば、監視チェックはプロジェクト月100万回の無償枠があり、今回の5分・3地域は約2.6万回/月。標準的な監視ポリシーの計測料金は2027年9月1日以降の予定（2026-11-25参照）。監視リクエストによるアプリ側の使用量・ログは既存の無料枠と請求を確認する。

再現用のポリシー定義は `deploy/monitoring.mjs`。同じ識別子の既存ポリシーは更新せず、他のプロジェクトや用途のルールは変更しない。
