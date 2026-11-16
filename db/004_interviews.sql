SET search_path = night, pg_catalog;

CREATE TABLE interview_session (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  generation integer NOT NULL,
  applicant_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
CREATE INDEX interview_session_expiry ON interview_session(channel_id,expires_at);

CREATE TABLE interview_slot (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  method text NOT NULL CHECK (method IN ('onsite','online')),
  instructions text NOT NULL,
  published boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
CREATE INDEX interview_slot_schedule ON interview_slot(store_id,starts_at);

CREATE TABLE interview_booking (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  applicant_key text NOT NULL,
  slot_id uuid NOT NULL,
  applicant_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed','cancelled','completed')),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,channel_id,slot_id) REFERENCES interview_slot(tenant_id,store_id,channel_id,id)
);
CREATE UNIQUE INDEX confirmed_interview_occupancy ON interview_booking(slot_id) WHERE status='confirmed';
CREATE UNIQUE INDEX confirmed_interview_applicant ON interview_booking(channel_id,applicant_key)
  WHERE status='confirmed';
CREATE INDEX interview_booking_history ON interview_booking(channel_id,applicant_key,updated_at DESC);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['interview_session','interview_slot','interview_booking']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;
