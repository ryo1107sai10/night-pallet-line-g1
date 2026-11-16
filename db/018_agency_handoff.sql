SET LOCAL search_path TO night,pg_catalog;

ALTER TABLE tenant ADD COLUMN supervisor_only boolean NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN agency_staff boolean NOT NULL DEFAULT false;
ALTER TABLE platform_master ADD COLUMN agency_id uuid REFERENCES tenant (id);
ALTER TABLE platform_master ADD COLUMN display_name text;
ALTER TABLE platform_master ADD CONSTRAINT platform_agency_binding CHECK (
  (agency_id IS NULL AND display_name IS NULL) OR
  (agency_id IS NOT NULL AND agency_id<>tenant_id AND length(trim(display_name))>0 AND display_name IS NOT NULL)
);

CREATE TABLE line_handoff (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  user_key text NOT NULL,
  until_at timestamptz NOT NULL,
  PRIMARY KEY (channel_id,user_key),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);
ALTER TABLE line_handoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_handoff FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON line_handoff USING (tenant_id=scope_tenant() AND store_id=scope_store());
