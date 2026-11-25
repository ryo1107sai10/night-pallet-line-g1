SET LOCAL search_path TO night,pg_catalog;

-- Registered corporations may have a master for operational work only.
-- The supervisor's workspace remains separately authenticated.
ALTER TABLE tenant ADD COLUMN agency_operations_only boolean NOT NULL DEFAULT false;
