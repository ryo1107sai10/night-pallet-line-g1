SET search_path = night, pg_catalog;

-- フェーズ3（LIFFなし全機能化）: 顧客向けトークン基盤の店舗フラグ
ALTER TABLE store ADD COLUMN token_customers_enabled boolean NOT NULL DEFAULT false;

-- 用途非依存のリンク基盤。面談は interview_link_token（022）のまま移行せず、
-- こちらは顧客用途の本人確認リンクから使い始める。生トークンは保存せず digest のみ。
-- subject は用途ごとの本人キー（顧客用途では customer.id）。
-- source_id は流入分析（workflow_source）を発行時点で紐づけるためのもの（項目4）。
CREATE TABLE link_token (
  id uuid NOT NULL UNIQUE,
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  generation integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  user_key text NOT NULL,
  subject text NOT NULL,
  source_id uuid,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,purpose,source_id)
    REFERENCES workflow_source(tenant_id,store_id,channel_id,purpose,id)
);
CREATE INDEX link_token_subject
  ON link_token(channel_id,purpose,subject) WHERE revoked_at IS NULL;
CREATE INDEX link_token_expiry ON link_token(channel_id,expires_at);

ALTER TABLE link_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_token FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON link_token
  USING (tenant_id=scope_tenant() AND store_id=scope_store());

-- 流入分析の移行（項目4）: 面談リンクにも発行時点で流入元を紐づけられるようにする
ALTER TABLE interview_link_token
  ADD COLUMN source_id uuid REFERENCES workflow_source(id);

-- Webhook: postback で認識した流入元IDを保存する（検証済みのものだけを保存する）
ALTER TABLE webhook_event
  ADD COLUMN source_id uuid REFERENCES workflow_source(id);

-- Webhook の action に顧客リンクを追加（022と同じ動的解除方式）
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid='webhook_event'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%''interview_link''%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE webhook_event DROP CONSTRAINT %I',cname);
  END IF;
END $$;
ALTER TABLE webhook_event
  ADD CONSTRAINT webhook_event_action_check CHECK (action IN ('interview_link','customer_link'));

-- 配信種別に顧客リンク追加
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
  CHECK (kind IN ('interview_confirm','interview_reminder','interview_waitlist','chat_reply','interview_link','customer_link'));
