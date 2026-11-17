SET LOCAL search_path TO night,pg_catalog;

CREATE TABLE supervisor_handoff (
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  pending_secret text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,staff_id),
  FOREIGN KEY (tenant_id,staff_id) REFERENCES staff (tenant_id,id)
);
ALTER TABLE supervisor_handoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_handoff FORCE ROW LEVEL SECURITY;
CREATE POLICY supervisor_handoff_scope ON supervisor_handoff USING (tenant_id=scope_tenant());
