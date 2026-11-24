SET LOCAL search_path TO night,pg_catalog;

-- The current supervisor can manage masters of the agency and corporations
-- registered by that supervisor's organization. Unregistered tenants stay hidden.
DROP POLICY tenant_master_supervisor ON tenant_master;
CREATE POLICY tenant_master_supervisor ON tenant_master FOR UPDATE USING (
  tenant_id=scope_tenant() AND EXISTS (
    SELECT 1 FROM platform_master p
    WHERE p.staff_id::text=current_setting('night.platform_principal',true)
      AND (p.agency_id=tenant_master.tenant_id OR EXISTS (
        SELECT 1 FROM platform_registration r
        WHERE r.tenant_id=tenant_master.tenant_id AND r.supervisor_tenant_id=p.tenant_id
      ))
  )
);
