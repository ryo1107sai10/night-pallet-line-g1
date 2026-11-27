SET LOCAL search_path TO night,pg_catalog;
-- A pair of independent enrollment invitations. Neither candidate can log in until
-- the existing master (or supervised manager) explicitly confirms both seats.
CREATE TABLE agency_master_pair (
  tenant_id uuid PRIMARY KEY REFERENCES tenant,
  id uuid UNIQUE NOT NULL,
  former_primary uuid NOT NULL,
  former_secondary uuid,
  first_staff_id uuid NOT NULL,
  second_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,former_primary) REFERENCES staff(tenant_id,id),
  FOREIGN KEY (tenant_id,former_secondary) REFERENCES staff(tenant_id,id),
  FOREIGN KEY (tenant_id,first_staff_id) REFERENCES staff(tenant_id,id),
  FOREIGN KEY (tenant_id,second_staff_id) REFERENCES staff(tenant_id,id),
  CHECK (first_staff_id<>second_staff_id AND first_staff_id<>former_primary AND second_staff_id<>former_primary
    AND first_staff_id IS DISTINCT FROM former_secondary AND second_staff_id IS DISTINCT FROM former_secondary)
);
ALTER TABLE agency_master_pair ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_master_pair FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_master_pair_scope ON agency_master_pair USING (tenant_id=scope_tenant()) WITH CHECK (tenant_id=scope_tenant());
