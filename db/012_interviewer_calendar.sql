SET search_path = night, pg_catalog;

ALTER TABLE store
  ADD COLUMN interviewers_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN google_write_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE interview_host (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  calendar_id text,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (store_id,name),
  FOREIGN KEY (tenant_id,store_id) REFERENCES store (tenant_id,id)
);
CREATE UNIQUE INDEX interview_host_calendar ON interview_host(store_id,calendar_id) WHERE calendar_id IS NOT NULL;
ALTER TABLE interview_slot ADD COLUMN host_id uuid,
  ADD FOREIGN KEY (tenant_id,store_id,host_id) REFERENCES interview_host (tenant_id,store_id,id);
ALTER TABLE interview_booking ADD UNIQUE (tenant_id,store_id,channel_id,id);
ALTER TABLE interview_google_calendar ADD COLUMN write_granted boolean NOT NULL DEFAULT false;
ALTER TABLE interview_google_session ADD COLUMN write_requested boolean NOT NULL DEFAULT false;

CREATE TABLE interview_google_sync (
  booking_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  revision integer NOT NULL,
  calendars text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','synced','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  FOREIGN KEY (tenant_id,store_id,channel_id,booking_id) REFERENCES interview_booking (tenant_id,store_id,channel_id,id)
);
CREATE INDEX interview_google_sync_due ON interview_google_sync(channel_id,next_at) WHERE status='queued';
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['interview_host','interview_google_sync']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;
