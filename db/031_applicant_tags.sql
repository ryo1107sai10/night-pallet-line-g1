SET LOCAL search_path TO night,pg_catalog;
ALTER TABLE store ADD COLUMN recruitment_tags_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN recruitment_tags_enabled_at timestamptz;
CREATE TABLE applicant_tag (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, tag_key text NOT NULL,
  label text NOT NULL, category text NOT NULL, add_events text[] NOT NULL DEFAULT '{}',
  remove_events text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (store_id,tag_key), UNIQUE (tenant_id,store_id,tag_key),
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id)
);
CREATE UNIQUE INDEX applicant_tag_label ON applicant_tag(store_id,lower(label)) WHERE active;
CREATE TABLE applicant_tag_subject (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL, channel_id uuid NOT NULL,
  applicant_key text NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id,applicant_key), UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id)
);
CREATE INDEX applicant_tag_subject_store ON applicant_tag_subject(store_id,updated_at DESC,id);
CREATE TABLE applicant_tag_assignment (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, subject_id uuid NOT NULL, tag_key text NOT NULL,
  active boolean NOT NULL, changed_at timestamptz NOT NULL, expires_at timestamptz,
  PRIMARY KEY(subject_id,tag_key),
  FOREIGN KEY (tenant_id,store_id,subject_id) REFERENCES applicant_tag_subject(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,tag_key) REFERENCES applicant_tag(tenant_id,store_id,tag_key)
);
CREATE INDEX applicant_tag_assignment_filter ON applicant_tag_assignment(store_id,tag_key,subject_id) WHERE active;
CREATE TABLE applicant_tag_campaign (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL, channel_id uuid NOT NULL,
  scenario_id uuid NOT NULL, scenario_version integer NOT NULL, title text NOT NULL, criteria jsonb NOT NULL,
  recipients integer NOT NULL, stopped boolean NOT NULL DEFAULT false, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,scenario_id) REFERENCES scenario(tenant_id,store_id,id),
  FOREIGN KEY (scenario_id,scenario_version) REFERENCES scenario_version(scenario_id,version),
  FOREIGN KEY (tenant_id,created_by) REFERENCES staff(tenant_id,id)
);
ALTER TABLE applicant_event ADD COLUMN tag_key text, ADD COLUMN campaign_id uuid,
  ADD FOREIGN KEY(tenant_id,store_id,campaign_id) REFERENCES applicant_tag_campaign(tenant_id,store_id,id);
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['applicant_tag','applicant_tag_subject','applicant_tag_assignment','applicant_tag_campaign'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()))',target);
  END LOOP;
END $$;
