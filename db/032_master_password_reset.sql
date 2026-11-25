SET LOCAL search_path TO night,pg_catalog;

-- 復旧リンクは運用者（DB所有者）が現マスターの登録メール宛にだけ発行する。
-- 通常のアプリロールはリンクを発行・更新できず、照合と消費のみできる。
CREATE TABLE master_password_reset (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  PRIMARY KEY (tenant_id,staff_id),
  FOREIGN KEY (tenant_id,staff_id) REFERENCES staff (tenant_id,id)
);
ALTER TABLE master_password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_password_reset FORCE ROW LEVEL SECURITY;
CREATE POLICY master_password_reset_scope ON master_password_reset USING (tenant_id=scope_tenant());
