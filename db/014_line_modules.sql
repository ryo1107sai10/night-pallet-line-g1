SET LOCAL search_path TO night,pg_catalog;

ALTER TABLE channel_route ALTER COLUMN messaging_id DROP NOT NULL;
ALTER TABLE channel_route ADD COLUMN module_channel_id text, ADD COLUMN module_bot_id text;
ALTER TABLE channel_route ADD CONSTRAINT line_route_kind CHECK (
  (messaging_id IS NOT NULL AND module_channel_id IS NULL AND module_bot_id IS NULL)
  OR (messaging_id IS NULL AND module_channel_id IS NOT NULL AND module_bot_id IS NOT NULL)
);
CREATE UNIQUE INDEX line_module_destination ON channel_route (module_channel_id,module_bot_id)
  WHERE module_channel_id IS NOT NULL;

ALTER TABLE channel ALTER COLUMN credentials DROP NOT NULL,
  ALTER COLUMN login_id DROP NOT NULL, ALTER COLUMN liff_id DROP NOT NULL,
  ALTER COLUMN provider_id DROP NOT NULL, ALTER COLUMN account_type DROP NOT NULL,
  ADD COLUMN basic_id text, ADD COLUMN module_status_at timestamptz,
  ADD COLUMN module_status text CHECK (module_status IN ('attached','active','standby','detached','suspended'));

CREATE TABLE line_module_session (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  session_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment','shared')),
  module_channel_id text NOT NULL,
  verifier text,
  expires_at timestamptz NOT NULL,
  bot_user_id text,
  connection_id uuid,
  FOREIGN KEY (tenant_id,store_id) REFERENCES store (tenant_id,id),
  FOREIGN KEY (tenant_id,staff_id) REFERENCES staff (tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,connection_id) REFERENCES channel (tenant_id,store_id,id)
);
CREATE INDEX line_module_session_expiry ON line_module_session (tenant_id,store_id,staff_id,expires_at);
ALTER TABLE line_module_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_module_session FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON line_module_session USING (tenant_id=scope_tenant() AND store_id=scope_store());
