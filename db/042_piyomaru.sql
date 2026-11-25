SET LOCAL search_path TO night,pg_catalog;

-- Isolated to the authenticated platform supervisor. Never visible to agency staff.
CREATE TABLE piyomaru_settings (
  tenant_id uuid NOT NULL, staff_id uuid NOT NULL,
  api_key_box text, verified_at timestamptz, monthly_limit_microusd integer NOT NULL DEFAULT 3000000
    CHECK(monthly_limit_microusd BETWEEN 100000 AND 20000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,staff_id), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE piyomaru_usage (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, staff_id uuid NOT NULL,
  request_key text NOT NULL, model text NOT NULL CHECK(model IN ('muse-ember-1.0','muse-spark-1.3')),
  status text NOT NULL CHECK(status IN ('reserved','accepted','rejected','unknown')),
  microusd integer NOT NULL CHECK(microusd>=0), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,staff_id,request_key), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
CREATE INDEX piyomaru_usage_month ON piyomaru_usage(tenant_id,staff_id,created_at);
CREATE TABLE piyomaru_job (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, staff_id uuid NOT NULL,
  target_tenant uuid NOT NULL REFERENCES tenant(id), target_store uuid NOT NULL,
  display_name text NOT NULL, settings_box text NOT NULL, connection_id uuid, cancelled boolean NOT NULL DEFAULT false,
  verified_by_user_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id),
  FOREIGN KEY(target_tenant,target_store) REFERENCES store(tenant_id,id)
);
CREATE TABLE piyomaru_proof (
  tenant_id uuid NOT NULL, staff_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES piyomaru_job(id),
  topic text NOT NULL CHECK(topic IN ('store','line','calendar','draft','slots','publish')),
  verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,topic),
  FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE piyomaru_note (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, staff_id uuid NOT NULL,
  topic text NOT NULL CHECK(topic IN ('store','line','calendar','draft','slots','publish','handoff','security','budget')),
  note_box text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE piyomaru_knowledge (
  tenant_id uuid NOT NULL, staff_id uuid NOT NULL, topic text NOT NULL
    CHECK(topic IN ('store','line','calendar','draft','slots','publish','handoff','security','budget')),
  verified_count integer NOT NULL DEFAULT 0, verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,staff_id,topic), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['piyomaru_settings','piyomaru_usage','piyomaru_job','piyomaru_proof','piyomaru_note','piyomaru_knowledge']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY supervisor_scope ON %I USING
      (tenant_id=scope_tenant() AND staff_id::text=current_setting(''night.piyomaru_actor'',true)
      AND EXISTS(SELECT 1 FROM platform_master m WHERE m.tenant_id=%I.tenant_id AND m.staff_id=%I.staff_id AND m.agency_id IS NOT NULL))',
      tab,tab,tab);
  END LOOP;
END $$;
