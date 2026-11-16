SET LOCAL search_path TO night,pg_catalog;

CREATE TABLE platform_master (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  FOREIGN KEY (tenant_id,staff_id) REFERENCES staff (tenant_id,id)
);

ALTER TABLE staff ADD COLUMN platform_actor boolean NOT NULL DEFAULT false;
ALTER TABLE staff ADD CONSTRAINT platform_actor_not_login
  CHECK (NOT platform_actor OR (role='admin' AND password_hash IS NULL AND disabled_at IS NULL));
CREATE UNIQUE INDEX one_platform_actor_per_tenant ON staff (tenant_id) WHERE platform_actor;

ALTER TABLE staff_session ADD COLUMN session_kind text NOT NULL DEFAULT 'staff'
  CHECK (session_kind IN ('staff','platform'));
