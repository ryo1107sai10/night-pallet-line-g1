SET search_path = night, pg_catalog;

ALTER TABLE webhook_event ADD COLUMN recipient_box text, ADD COLUMN stop_signal text;
ALTER TABLE store ADD COLUMN auto_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN monthly_limit integer NOT NULL DEFAULT 100 CHECK (monthly_limit BETWEEN 1 AND 1000000),
  ADD COLUMN contract_active boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_enabled_at timestamptz,
  ADD COLUMN delivery_version bigint NOT NULL DEFAULT 0;
ALTER TABLE tenant ADD COLUMN delivery_version bigint NOT NULL DEFAULT 0;
ALTER TABLE channel ADD COLUMN delivery_version bigint NOT NULL DEFAULT 0;
ALTER TABLE scenario ADD COLUMN delivery_floor timestamptz NOT NULL DEFAULT '-infinity';


CREATE TABLE customer (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  user_key text NOT NULL,
  line_address text NOT NULL,
  display_name text,
  memo text NOT NULL DEFAULT '',
  assigned_to uuid,
  verified_20_at timestamptz,
  tags text[] NOT NULL DEFAULT '{}',
  active_chat boolean NOT NULL DEFAULT false,
  service_consent boolean NOT NULL DEFAULT false,
  marketing_consent boolean NOT NULL DEFAULT false,
  all_stop boolean NOT NULL DEFAULT false,
  marketing_stop boolean NOT NULL DEFAULT true,
  last_reply_at timestamptz,
  verified_at timestamptz,
  preference_at timestamptz NOT NULL DEFAULT '-infinity',
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id,user_key),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,assigned_to) REFERENCES staff(tenant_id,id)
);

CREATE TABLE preference_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  actor_id uuid,
  source text NOT NULL,
  policy_version text NOT NULL,
  service_consent boolean NOT NULL,
  marketing_consent boolean NOT NULL,
  all_stop boolean NOT NULL,
  marketing_stop boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,store_id,customer_id) REFERENCES customer(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);

CREATE TABLE booking_slot (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  label text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  published boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,starts_at),
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id)
);

CREATE TABLE visit_booking (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  party integer NOT NULL CHECK (party BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('pending','confirmed','cancelled','visited','no_show')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  business_date date NOT NULL,
  change_pending boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id) REFERENCES customer(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,slot_id) REFERENCES booking_slot(tenant_id,store_id,id)
);
CREATE INDEX visit_booking_slot ON visit_booking(slot_id,status);
CREATE UNIQUE INDEX one_active_booking_per_slot ON visit_booking(customer_id,slot_id)
  WHERE status IN ('pending','confirmed');

CREATE TABLE delivery_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  origin_key text NOT NULL,
  scope_version text NOT NULL,
  kind text NOT NULL,
  booking_id uuid,
  booking_revision integer,
  happened_at timestamptz NOT NULL,
  handled_at timestamptz,
  UNIQUE (channel_id,origin_key),
  UNIQUE (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,customer_id) REFERENCES customer(tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,booking_id) REFERENCES visit_booking(tenant_id,store_id,id)
);
CREATE INDEX next_delivery_event ON delivery_event(channel_id,happened_at) WHERE handled_at IS NULL;

CREATE TABLE enrollment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  version integer NOT NULL,
  event_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid,
  booking_revision integer,
  node_id text,
  due_at timestamptz NOT NULL,
  wait_node text,
  ended_at timestamptz,
  end_reason text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id,event_id),
  UNIQUE (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,scenario_id) REFERENCES scenario(tenant_id,store_id,id),
  FOREIGN KEY (scenario_id,version) REFERENCES scenario_version(scenario_id,version),
  FOREIGN KEY (tenant_id,store_id,channel_id,customer_id) REFERENCES customer(tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,event_id) REFERENCES delivery_event(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,booking_id) REFERENCES visit_booking(tenant_id,store_id,id)
);
CREATE INDEX next_enrollment ON enrollment(channel_id,due_at) WHERE ended_at IS NULL;

CREATE TABLE automatic_send (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  node_id text NOT NULL,
  body_box text,
  accepted_at timestamptz,
  category text NOT NULL CHECK (category IN ('service','marketing')),
  generation integer NOT NULL,
  status text NOT NULL CHECK (status IN ('submitting','accepted','failed','unknown','cancelled')),
  reason text,
  attempt integer NOT NULL DEFAULT 1,
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_at timestamptz NOT NULL,
  line_request_id text,
  UNIQUE (enrollment_id,node_id),
  FOREIGN KEY (tenant_id,store_id,enrollment_id) REFERENCES enrollment(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,customer_id) REFERENCES customer(tenant_id,store_id,channel_id,id)
);
CREATE INDEX retry_automatic_send ON automatic_send(channel_id,next_at)
  WHERE status IN ('unknown','submitting');
CREATE INDEX monthly_automatic_send ON automatic_send(store_id,first_attempt_at);
CREATE INDEX customer_automatic_send ON automatic_send(customer_id,first_attempt_at);

CREATE TABLE delivery_note (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  kind text NOT NULL,
  node_id text,
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,enrollment_id) REFERENCES enrollment(tenant_id,store_id,id)
);
CREATE INDEX delivery_note_scope ON delivery_note(store_id,id DESC);

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['customer','preference_event','booking_slot','visit_booking',
    'delivery_event','enrollment','automatic_send','delivery_note']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING
      (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()))',target);
  END LOOP;
END $$;

CREATE TABLE customer_session (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  generation integer NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,store_id,channel_id,customer_id) REFERENCES customer(tenant_id,store_id,channel_id,id)
);
ALTER TABLE customer_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_session FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_guard ON customer_session USING (tenant_id=scope_tenant() AND store_id=scope_store());
