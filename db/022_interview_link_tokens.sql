SET search_path = night, pg_catalog;

-- LIFFなし面談予約（固有トークン方式）: 店舗機能フラグ
ALTER TABLE store ADD COLUMN token_interviews_enabled boolean NOT NULL DEFAULT false;

-- 予約リンク用トークン。生トークンは保存せず digest（SHA-256）のみを保持する。
-- id は service_delivery の object_id として使うための UUID。
-- booking_id は確定通知に同梱する変更・取消用トークン（D4）でだけ設定する。
CREATE TABLE interview_link_token (
  id uuid NOT NULL UNIQUE,
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  generation integer NOT NULL,
  user_key text NOT NULL,
  applicant_key text NOT NULL,
  booking_id uuid REFERENCES interview_booking(id),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
CREATE INDEX interview_link_token_applicant
  ON interview_link_token(channel_id,applicant_key) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX interview_link_token_expiry ON interview_link_token(channel_id,expires_at);

ALTER TABLE interview_link_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_link_token FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON interview_link_token
  USING (tenant_id=scope_tenant() AND store_id=scope_store());

-- セッションに由来トークンを持たせ、audience='token' を許可する
ALTER TABLE interview_session
  ADD COLUMN link_token_hash text REFERENCES interview_link_token(token_hash);
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid='interview_session'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%''guest''%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE interview_session DROP CONSTRAINT %I',cname);
  END IF;
END $$;
ALTER TABLE interview_session
  ADD CONSTRAINT interview_session_audience_check CHECK (audience IN ('line','guest','token'));

-- Webhook の postback で認識した action だけを保存する（生データは保存しない）
ALTER TABLE webhook_event ADD COLUMN action text
  CHECK (action IN ('interview_link'));

-- 配信種別に予約リンク追加
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid='service_delivery'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%''interview_confirm''%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_delivery DROP CONSTRAINT %I',cname);
  END IF;
END $$;
ALTER TABLE service_delivery
  ADD CONSTRAINT service_delivery_kind_check
  CHECK (kind IN ('interview_confirm','interview_reminder','interview_waitlist','chat_reply','interview_link'));
