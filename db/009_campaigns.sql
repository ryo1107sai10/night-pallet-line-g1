SET search_path = night, pg_catalog;

ALTER TABLE store ADD COLUMN campaigns_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE campaign (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  title text NOT NULL,
  body_box text NOT NULL,
  criteria jsonb NOT NULL,
  exclusions jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz NOT NULL,
  generation integer NOT NULL,
  scope_version text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','stopped')),
  approved_by uuid,
  approved_at timestamptz,
  UNIQUE (tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES staff (tenant_id,id),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES staff (tenant_id,id)
);
CREATE INDEX campaign_recent ON campaign(store_id,created_at DESC);

CREATE TABLE campaign_delivery (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitting','accepted','cancelled','failed','unknown')),
  attempt integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL,
  first_attempt_at timestamptz,
  accepted_at timestamptz,
  line_request_id text,
  reason text,
  UNIQUE (campaign_id,customer_id),
  FOREIGN KEY (tenant_id,store_id,channel_id,campaign_id) REFERENCES campaign (tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,customer_id) REFERENCES customer (tenant_id,store_id,channel_id,id)
);
CREATE INDEX campaign_due ON campaign_delivery(channel_id,next_at,id)
  WHERE status IN ('queued','submitting','unknown');
CREATE INDEX campaign_spend ON campaign_delivery(store_id,first_attempt_at);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['campaign','campaign_delivery']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;

ALTER POLICY store_scope ON campaign USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));
ALTER POLICY store_scope ON campaign_delivery USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));
