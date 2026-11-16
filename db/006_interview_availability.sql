SET search_path = night, pg_catalog;

CREATE TABLE interview_block (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  note text NOT NULL,
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id)
);
CREATE INDEX interview_block_range ON interview_block(store_id,starts_at,ends_at);

CREATE TABLE interview_google_calendar (
  store_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  calendar_id text NOT NULL,
  refresh_box text NOT NULL,
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id)
);
CREATE TABLE interview_google_session (
  store_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  state_hash text NOT NULL,
  calendar_id text NOT NULL,
  verifier text NOT NULL,
  used boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['interview_block','interview_google_calendar','interview_google_session']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;
