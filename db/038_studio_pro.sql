SET search_path = night, pg_catalog;
ALTER TABLE test_send ADD COLUMN test_rich_box text;
CREATE UNIQUE INDEX studio_visit_customer ON delivery_note(enrollment_id,node_id) WHERE kind='studio_visit';
CREATE UNIQUE INDEX studio_visit_applicant ON applicant_note(enrollment_id,node_id) WHERE kind='studio_visit';
CREATE INDEX studio_metrics_customer ON enrollment(scenario_id,version,starts_at);
CREATE INDEX studio_metrics_applicant ON applicant_enrollment(scenario_id,version,starts_at);
CREATE TABLE studio_editor (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, scenario_id uuid NOT NULL, staff_id uuid NOT NULL,
  client_id uuid NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scenario_id,staff_id,client_id),
  FOREIGN KEY(tenant_id,store_id,scenario_id) REFERENCES scenario(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
ALTER TABLE studio_editor ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_editor FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_editor_scope ON studio_editor USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));
