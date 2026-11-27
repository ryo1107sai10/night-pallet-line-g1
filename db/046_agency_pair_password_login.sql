SET LOCAL search_path TO night,pg_catalog;
-- Other staff and the supervising account retain mandatory TOTP. Only accounts
-- specifically issued through the authorized two-master handover may omit it.
ALTER TABLE staff ADD COLUMN mfa_required boolean NOT NULL DEFAULT true;
ALTER TABLE staff ADD CHECK (mfa_required OR (role='admin' AND agency_staff AND NOT platform_actor));
ALTER TABLE agency_master_pair ADD COLUMN mfa_required boolean NOT NULL DEFAULT true;
