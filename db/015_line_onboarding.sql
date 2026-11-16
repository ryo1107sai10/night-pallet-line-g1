SET LOCAL search_path TO night,pg_catalog;

CREATE TABLE line_onboarding (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('create','managed','invite')),
  revision integer NOT NULL DEFAULT 1,
  guide_box text,
  guide_hash text,
  guide_expires_at timestamptz,
  invitation_box text,
  invitation_received_at timestamptz,
  connection_id uuid,
  PRIMARY KEY (tenant_id,store_id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES store (tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,connection_id) REFERENCES channel (tenant_id,store_id,id)
);

ALTER TABLE line_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_onboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON line_onboarding
  USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));

-- Resolve a secret guide link before establishing tenant scope.
CREATE TABLE line_onboarding_route (
  guide_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  UNIQUE (tenant_id,store_id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES line_onboarding (tenant_id,store_id) ON DELETE CASCADE
);
