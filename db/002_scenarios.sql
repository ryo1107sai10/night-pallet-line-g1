SET search_path = night, pg_catalog;

CREATE TABLE scenario (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  created_by uuid NOT NULL,
  graph jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','tested','approved')),
  published_version integer,
  stopped boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, channel_id) REFERENCES channel (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id)
);

CREATE TABLE scenario_version (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  version integer NOT NULL,
  graph jsonb NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, version),
  FOREIGN KEY (tenant_id, store_id, scenario_id) REFERENCES scenario (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES staff (tenant_id, id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['scenario','scenario_version']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY scope_guard ON %I USING
      (tenant_id = scope_tenant() AND (scope_all_stores() OR store_id = scope_store()))', table_name);
  END LOOP;
END $$;


ALTER TABLE test_send ADD COLUMN scenario_id uuid, ADD COLUMN scenario_revision integer, ADD COLUMN test_body text;
ALTER TABLE test_send ADD CONSTRAINT scenario_test_scope FOREIGN KEY (tenant_id, store_id, scenario_id)
  REFERENCES scenario (tenant_id, store_id, id);
ALTER TABLE test_send ADD CONSTRAINT scenario_test_body CHECK (
  (scenario_id IS NULL AND scenario_revision IS NULL AND test_body IS NULL)
  OR (scenario_id IS NOT NULL AND scenario_revision IS NOT NULL AND test_body IS NOT NULL)
);
