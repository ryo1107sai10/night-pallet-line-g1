SET LOCAL search_path TO night,pg_catalog;
-- A third independent agency master, preserving existing seats and pending invitations.
ALTER TABLE tenant_master ADD COLUMN third_staff_id uuid;
ALTER TABLE tenant_master ADD FOREIGN KEY (tenant_id,third_staff_id) REFERENCES staff(tenant_id,id);
ALTER TABLE tenant_master ADD CHECK (third_staff_id IS NULL OR (co_staff_id IS NOT NULL AND third_staff_id<>staff_id AND third_staff_id<>co_staff_id));
ALTER TABLE tenant_master ADD CHECK (pending_staff_id IS NULL OR pending_staff_id IS DISTINCT FROM third_staff_id);
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='tenant_master'::regclass AND contype='c'
    AND (pg_get_constraintdef(oid) LIKE '%pending_replace_id = co_staff_id%' OR pg_get_constraintdef(oid) LIKE '%co_staff_id IS NULL%pending_replace_id IS NULL%')
  LOOP EXECUTE format('ALTER TABLE tenant_master DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE tenant_master ADD CHECK (pending_replace_id IS NULL OR pending_replace_id=staff_id OR pending_replace_id=co_staff_id OR pending_replace_id=third_staff_id);
ALTER TABLE tenant_master ADD CHECK (pending_mode<>'add' OR (third_staff_id IS NULL AND pending_replace_id IS NULL));
DROP POLICY tenant_master_self_service ON tenant_master;
CREATE POLICY tenant_master_self_service ON tenant_master FOR UPDATE USING (
  tenant_id=scope_tenant() AND current_setting('night.agency_master',true) IN (staff_id::text,co_staff_id::text,third_staff_id::text)
) WITH CHECK (tenant_id=scope_tenant());
ALTER TABLE agency_master_pair ADD COLUMN former_tertiary uuid;
ALTER TABLE agency_master_pair ADD COLUMN third_staff_id uuid;
ALTER TABLE agency_master_pair ADD FOREIGN KEY (tenant_id,former_tertiary) REFERENCES staff(tenant_id,id);
ALTER TABLE agency_master_pair ADD FOREIGN KEY (tenant_id,third_staff_id) REFERENCES staff(tenant_id,id);
ALTER TABLE agency_master_pair ADD CHECK (first_staff_id IS DISTINCT FROM former_tertiary AND second_staff_id IS DISTINCT FROM former_tertiary);
ALTER TABLE agency_master_pair ADD CHECK (third_staff_id IS NULL OR (third_staff_id<>first_staff_id AND third_staff_id<>second_staff_id AND third_staff_id<>former_primary AND third_staff_id IS DISTINCT FROM former_secondary AND third_staff_id IS DISTINCT FROM former_tertiary));
