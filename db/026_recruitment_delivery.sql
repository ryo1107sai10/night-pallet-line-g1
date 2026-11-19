SET search_path = night, pg_catalog;

-- 採用シナリオの実配信。応募者は customer 行を持たず workflow_contact（purpose='recruitment'）と
-- applicant_key で表されるため、顧客用の delivery_event / enrollment / automatic_send / delivery_note は
-- 流用せず、同じ形で主体だけを applicant_key に替えた専用テーブルを用意する（003 と同型）。
CREATE TABLE applicant_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  applicant_key text NOT NULL,
  origin_key text NOT NULL,
  scope_version text NOT NULL,
  kind text NOT NULL,
  booking_id uuid,
  booking_revision integer,
  happened_at timestamptz NOT NULL,
  handled_at timestamptz,
  UNIQUE (channel_id,origin_key),
  UNIQUE (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,booking_id) REFERENCES interview_booking(tenant_id,store_id,channel_id,id)
);
CREATE INDEX next_applicant_event ON applicant_event(channel_id,happened_at) WHERE handled_at IS NULL;

CREATE TABLE applicant_enrollment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  version integer NOT NULL,
  event_id uuid NOT NULL,
  applicant_key text NOT NULL,
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
  FOREIGN KEY (tenant_id,store_id,event_id) REFERENCES applicant_event(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,booking_id) REFERENCES interview_booking(tenant_id,store_id,channel_id,id)
);
CREATE INDEX next_applicant_enrollment ON applicant_enrollment(channel_id,due_at) WHERE ended_at IS NULL;

CREATE TABLE applicant_send (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  applicant_key text NOT NULL,
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
  FOREIGN KEY (tenant_id,store_id,enrollment_id) REFERENCES applicant_enrollment(tenant_id,store_id,id)
);
CREATE INDEX retry_applicant_send ON applicant_send(channel_id,next_at)
  WHERE status IN ('unknown','submitting');
CREATE INDEX monthly_applicant_send ON applicant_send(store_id,first_attempt_at);

CREATE TABLE applicant_note (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  kind text NOT NULL,
  node_id text,
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,enrollment_id) REFERENCES applicant_enrollment(tenant_id,store_id,id)
);
CREATE INDEX applicant_note_scope ON applicant_note(store_id,id DESC);

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['applicant_event','applicant_enrollment','applicant_send','applicant_note']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING
      (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()))',target);
  END LOOP;
END $$;
