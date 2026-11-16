SET LOCAL search_path TO night,pg_catalog;

CREATE TABLE tenant_master (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  staff_id uuid NOT NULL,
  FOREIGN KEY (tenant_id,staff_id) REFERENCES staff (tenant_id,id)
);

ALTER TABLE tenant_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_master FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenant_master USING (tenant_id=scope_tenant());
