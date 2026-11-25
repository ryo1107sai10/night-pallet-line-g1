SET LOCAL search_path TO night,pg_catalog;

-- Two individually authenticated masters may operate the same management company.
-- Retain the primary binding for existing supervisor/registration workflows.
ALTER TABLE tenant_master ADD COLUMN co_staff_id uuid;
ALTER TABLE tenant_master ADD COLUMN pending_mode text NOT NULL DEFAULT 'replace'
  CHECK (pending_mode IN ('add','replace'));
ALTER TABLE tenant_master ADD COLUMN pending_replace_id uuid;
ALTER TABLE tenant_master ADD FOREIGN KEY (tenant_id,co_staff_id) REFERENCES staff (tenant_id,id);
ALTER TABLE tenant_master ADD FOREIGN KEY (tenant_id,pending_replace_id) REFERENCES staff (tenant_id,id);
ALTER TABLE tenant_master ADD CHECK (co_staff_id IS NULL OR co_staff_id<>staff_id);
ALTER TABLE tenant_master ADD CHECK (pending_staff_id IS NULL OR pending_staff_id IS DISTINCT FROM co_staff_id);
ALTER TABLE tenant_master ADD CHECK (pending_replace_id IS NULL OR pending_replace_id=staff_id OR pending_replace_id=co_staff_id);
ALTER TABLE tenant_master ADD CHECK (pending_mode<>'add' OR (co_staff_id IS NULL AND pending_replace_id IS NULL));

-- Only a verified active master of the same tenant may alter its membership.
DROP POLICY tenant_master_self_service ON tenant_master;
CREATE POLICY tenant_master_self_service ON tenant_master FOR UPDATE USING (
  tenant_id=scope_tenant() AND current_setting('night.agency_master',true) IN (staff_id::text,co_staff_id::text)
) WITH CHECK (tenant_id=scope_tenant());
