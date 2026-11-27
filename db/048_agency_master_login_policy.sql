SET LOCAL search_path TO night,pg_catalog;
-- An explicit tenant-level choice for the designated agency masters only.
-- All other tenants, non-master staff and supervisors retain their existing policy.
ALTER TABLE tenant ADD COLUMN agency_master_password_only boolean NOT NULL DEFAULT false;
ALTER TABLE tenant ADD CHECK (NOT agency_master_password_only OR (agency_operations_only AND NOT supervisor_only));
