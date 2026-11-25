SET search_path = night, pg_catalog;
ALTER TABLE test_send ADD COLUMN source_id uuid REFERENCES workflow_source(id);
ALTER TABLE test_send DROP CONSTRAINT scenario_test_body;
ALTER TABLE test_send ADD CONSTRAINT scenario_test_body CHECK (
  (scenario_id IS NULL AND scenario_revision IS NULL AND source_id IS NULL AND test_body IS NULL)
  OR (scenario_id IS NOT NULL AND scenario_revision IS NOT NULL AND source_id IS NULL AND test_body IS NOT NULL)
  OR (source_id IS NOT NULL AND scenario_id IS NULL AND scenario_revision IS NULL)
);
