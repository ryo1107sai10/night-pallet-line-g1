SET LOCAL search_path TO night,pg_catalog;

-- Optional guided chat template; public forms and existing scenarios stay unchanged.
ALTER TABLE workflow_form ADD COLUMN chat_only boolean NOT NULL DEFAULT false;
ALTER TABLE webhook_event ADD COLUMN intake_phrase_box text;
ALTER TABLE interview_booking ADD COLUMN arrival_confirmed_revision integer;
ALTER TABLE interview_booking ADD COLUMN arrival_confirmed_at timestamptz;

CREATE TABLE recruitment_intake (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, channel_id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1, draft jsonb NOT NULL,
  live jsonb, live_revision integer, live_at timestamptz, form_id uuid REFERENCES workflow_form(id),
  CHECK ((live IS NULL) = (live_revision IS NULL)),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
CREATE TABLE recruitment_intake_run (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL, channel_id uuid NOT NULL,
  applicant_key text NOT NULL, generation integer NOT NULL, config_revision integer NOT NULL,
  stage text NOT NULL CHECK(stage IN ('invited','consent','name','station','age','complete','cancelled')),
  step integer NOT NULL DEFAULT 1, answers_box text, last_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, UNIQUE(channel_id,applicant_key),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
ALTER TABLE recruitment_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruitment_intake FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON recruitment_intake USING(tenant_id=scope_tenant() AND store_id=scope_store());
ALTER TABLE recruitment_intake_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruitment_intake_run FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON recruitment_intake_run USING(tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));

DO $$
DECLARE con text;
BEGIN
  SELECT conname INTO con FROM pg_constraint
    WHERE conrelid='night.service_delivery'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%''interview_confirm''%';
  EXECUTE format('ALTER TABLE service_delivery DROP CONSTRAINT %I',con);
END $$;
ALTER TABLE service_delivery ADD CHECK(kind IN ('interview_confirm','interview_reminder','interview_waitlist','chat_reply','interview_link','customer_link','intake_prompt','interview_reminder_3h'));
