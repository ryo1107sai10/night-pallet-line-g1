SET search_path = night, pg_catalog;

-- LIFF撤去: 本人確認はトークン方式に一本化したため、LINEログイン/LIFF用の列を削除する。
-- 過去マイグレーション（001/014）の定義は履歴として改変せず、ここで落とす。
ALTER TABLE channel DROP COLUMN login_id;
ALTER TABLE channel DROP COLUMN liff_id;
