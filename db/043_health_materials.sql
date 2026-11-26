SET LOCAL search_path TO night,pg_catalog;
CREATE TABLE store_health_check (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL, fingerprint text NOT NULL,
 line_status text NOT NULL CHECK(line_status IN ('ok','issue','not_set','partial')),
 calendar_status text NOT NULL CHECK(calendar_status IN ('ok','issue','not_set','off')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES store(tenant_id,id)
);
CREATE TABLE store_acceptance (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL, fingerprint text NOT NULL,
 checked_by uuid NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES store(tenant_id,id),
 FOREIGN KEY(tenant_id,checked_by) REFERENCES staff(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['store_health_check','store_acceptance'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scope_guard ON %I USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()))',t);
 END LOOP;
END $$;

CREATE TABLE piyomaru_material_revision (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,staff_id uuid NOT NULL,material_id text NOT NULL,
 title text NOT NULL,description text NOT NULL,instructions text NOT NULL DEFAULT '',
 object_name text,bytes integer CHECK(bytes BETWEEN 1 AND 67108864),pages integer CHECK(pages BETWEEN 1 AND 20),
 usable boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','archived')),
 upload_box text,upload_total integer CHECK(upload_total BETWEEN 1 AND 67108864),upload_received integer NOT NULL DEFAULT 0 CHECK(upload_received>=0),
 upload_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
CREATE UNIQUE INDEX piyomaru_one_material_public ON piyomaru_material_revision(tenant_id,staff_id,material_id) WHERE state='published';
CREATE INDEX piyomaru_material_history ON piyomaru_material_revision(tenant_id,staff_id,material_id,created_at DESC);
ALTER TABLE piyomaru_material_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE piyomaru_material_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY supervisor_scope ON piyomaru_material_revision USING (
 tenant_id=scope_tenant() AND staff_id::text=current_setting('night.piyomaru_actor',true)
 AND EXISTS(SELECT 1 FROM platform_master m WHERE m.tenant_id=piyomaru_material_revision.tenant_id AND m.staff_id=piyomaru_material_revision.staff_id AND m.agency_id IS NOT NULL));
