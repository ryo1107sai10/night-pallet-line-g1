SET search_path = night, pg_catalog;

ALTER TABLE store
  ADD COLUMN forms_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN recruitment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN sources_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE interview_booking ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE workflow_form (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  title text NOT NULL,
  description text NOT NULL,
  fields jsonb NOT NULL,
  published boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,store_id,channel_id,purpose,id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);

CREATE TABLE workflow_response (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL,
  form_id uuid NOT NULL,
  form_revision integer NOT NULL,
  subject text NOT NULL,
  answers_box text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id,subject,form_revision),
  FOREIGN KEY (tenant_id,store_id,channel_id,purpose,form_id)
    REFERENCES workflow_form (tenant_id,store_id,channel_id,purpose,id)
);
CREATE INDEX workflow_response_list ON workflow_response (store_id,purpose,submitted_at DESC);

CREATE TABLE recruitment_case (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  applicant_key text NOT NULL,
  stage text NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','interviewed','trial_scheduled','trial_done','hired','withdrawn')),
  trial_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  display_name_box text,
  interview_done_at timestamptz,
  hired_at timestamptz,
  trial_done_at timestamptz,
  UNIQUE (channel_id,applicant_key),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);

CREATE TABLE workflow_source (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id,store_id,channel_id,purpose,id),
  UNIQUE (channel_id,purpose,label),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);

CREATE TABLE workflow_attribution (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL,
  subject text NOT NULL,
  source_id uuid NOT NULL,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id,purpose,subject),
  FOREIGN KEY (tenant_id,store_id,channel_id,purpose,source_id)
    REFERENCES workflow_source (tenant_id,store_id,channel_id,purpose,id)
);
CREATE INDEX workflow_attribution_report ON workflow_attribution (store_id,purpose,source_id,attributed_at);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['workflow_form','workflow_response','recruitment_case','workflow_source','workflow_attribution']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;
