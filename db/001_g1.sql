CREATE SCHEMA IF NOT EXISTS night;
SET search_path = night, pg_catalog;

CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  legal_name text NOT NULL,
  billing_contact text,
  stopped boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1
);

CREATE TABLE staff (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','sales','recruiter','reporter')),
  disabled_at timestamptz,
  password_hash text,
  totp_secret text NOT NULL,
  last_totp_step bigint NOT NULL DEFAULT -1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE staff_session (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id)
);
CREATE INDEX staff_session_staff ON staff_session (tenant_id, staff_id);

CREATE TABLE invite (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id)
);
CREATE UNIQUE INDEX one_invite_per_staff ON invite (tenant_id, staff_id);

CREATE TABLE auth_rate (
  rate_key text PRIMARY KEY,
  bucket timestamptz NOT NULL,
  attempts integer NOT NULL
);

CREATE TABLE store (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant,
  name text NOT NULL,
  address text NOT NULL,
  business_type text NOT NULL,
  responsible text NOT NULL,
  timezone text NOT NULL,
  cutoff time NOT NULL,
  eligibility_reference text,
  eligible_at timestamptz,
  stopped boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);

CREATE TABLE store_grant (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, staff_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id)
);

-- This directory exposes routing keys only to the backend, before request authentication.
CREATE TABLE channel_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  messaging_id text UNIQUE NOT NULL,
  UNIQUE (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id)
);

CREATE TABLE channel (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  label text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment','shared')),
  owner_name text NOT NULL,
  provider_id text NOT NULL,
  login_id text NOT NULL,
  liff_id text NOT NULL,
  bot_user_id text NOT NULL UNIQUE,
  account_type text NOT NULL CHECK (account_type IN ('unverified','verified','premium')),
  existing_webhook text,
  existing_tools text,
  management_authority text NOT NULL,
  credentials text NOT NULL,
  checks jsonb NOT NULL DEFAULT '{}',
  stopped boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  generation integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, id) REFERENCES channel_route (tenant_id, store_id, id)
);

CREATE TABLE webhook_event (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  event_id text NOT NULL,
  generation integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  kind text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment','unclassified')),
  user_key text,
  PRIMARY KEY (channel_id, event_id),
  FOREIGN KEY (tenant_id, store_id, channel_id) REFERENCES channel (tenant_id, store_id, id)
);
CREATE INDEX webhook_pending ON webhook_event (channel_id, received_at) WHERE processed_at IS NULL;

CREATE TABLE channel_relationship (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  user_key text NOT NULL,
  event_at timestamptz NOT NULL,
  following boolean NOT NULL,
  PRIMARY KEY (channel_id, user_key),
  FOREIGN KEY (tenant_id, store_id, channel_id) REFERENCES channel (tenant_id, store_id, id)
);

CREATE TABLE tester (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  generation integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  code_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  user_key text,
  recipient text,
  FOREIGN KEY (tenant_id, store_id, channel_id) REFERENCES channel (tenant_id, store_id, id)
);
CREATE INDEX tester_identity ON tester (channel_id, generation, purpose, user_key)
  WHERE user_key IS NOT NULL;

CREATE TABLE test_send (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  tester_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation_key text NOT NULL,
  generation integer NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','submitting','accepted','failed','unknown','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  line_request_id text,
  UNIQUE (channel_id, actor_id, operation_key),
  FOREIGN KEY (tenant_id, store_id, channel_id) REFERENCES channel (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES staff (tenant_id, id)
);
ALTER TABLE tester ADD UNIQUE (tenant_id, store_id, channel_id, id);
ALTER TABLE test_send ADD FOREIGN KEY (tenant_id, store_id, channel_id, tester_id)
  REFERENCES tester (tenant_id, store_id, channel_id, id);
CREATE INDEX test_send_pending ON test_send (channel_id, next_at)
  WHERE status IN ('queued', 'submitting', 'unknown');

CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant,
  store_id uuid,
  actor_id uuid,
  operation text NOT NULL,
  object_id uuid,
  reason text,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES staff (tenant_id, id)
);
CREATE INDEX audit_scope ON audit (tenant_id, store_id, id DESC);

CREATE TABLE operation (
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  operation_key text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, operation, operation_key),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES staff (tenant_id, id)
);

CREATE FUNCTION scope_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('night.tenant', true), '')::uuid $$;
CREATE FUNCTION scope_store() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('night.store', true), '')::uuid $$;
CREATE FUNCTION scope_all_stores() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('night.all_stores', true) = 'yes', false) $$;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenant USING (id = scope_tenant());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['staff','staff_session','invite','operation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING (tenant_id = scope_tenant())', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['store_grant','channel','webhook_event','channel_relationship','tester','test_send','audit']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING
      (tenant_id = scope_tenant() AND (scope_all_stores() OR store_id = scope_store()))', table_name);
  END LOOP;
END $$;

ALTER TABLE store ENABLE ROW LEVEL SECURITY;
ALTER TABLE store FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON store USING
  (tenant_id = scope_tenant() AND (scope_all_stores() OR id = scope_store()));

-- Minimal login directory, independent of tenant records/payments.
CREATE TABLE tenant_route (
  slug text PRIMARY KEY,
  tenant_id uuid UNIQUE NOT NULL REFERENCES tenant
);
CREATE TABLE invite_route (
  token_hash text PRIMARY KEY REFERENCES invite ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant
);
