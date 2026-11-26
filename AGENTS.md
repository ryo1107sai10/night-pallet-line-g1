# Night PRO LINE

- 操作方法や画面ボタン、権限、LINE/Google/面談/配信の動作が変わる場合は、同じ変更で `docs/manual/operation-manual.json` の該当ページを修正し、`ui_labels` も現行画面に合わせること。操作手順に影響しない変更の場合は `docs/manual/review.md` に確認理由を追記すること。
- リリースの Docker ビルドでは `scripts/build-operation-manual.py` が、公開版のソースから PDF・全ページプレビューと版情報を生成する。生成物は Git や public/ に入れず、認証済みの北村さん用教材として配布する。個人情報、認証キー、トークン、招待コード、実応募者データを原稿に含めないこと。
- 既存の媒体・教材の履歴や手動管理には影響を与えない。テストを実行してから公開すること。
