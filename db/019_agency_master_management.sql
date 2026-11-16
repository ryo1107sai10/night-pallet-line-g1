SET LOCAL search_path TO night,pg_catalog;

ALTER TABLE tenant_master ADD COLUMN pending_staff_id uuid;
ALTER TABLE tenant_master ADD FOREIGN KEY (tenant_id,pending_staff_id) REFERENCES staff (tenant_id,id);
ALTER TABLE tenant_master ADD CHECK (staff_id<>pending_staff_id);

DROP POLICY tenant_guard ON tenant_master;
CREATE POLICY tenant_master_read ON tenant_master FOR SELECT USING (tenant_id=scope_tenant());
CREATE POLICY tenant_master_owner ON tenant_master FOR ALL TO CURRENT_USER USING (tenant_id=scope_tenant());
CREATE POLICY tenant_master_supervisor ON tenant_master FOR UPDATE USING (
  tenant_id=scope_tenant() AND EXISTS (
    SELECT 1 FROM platform_master p WHERE p.agency_id=tenant_master.tenant_id
      AND p.staff_id::text=current_setting('night.platform_principal',true)
  )
);
