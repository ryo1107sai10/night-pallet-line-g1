SET search_path = night, pg_catalog;
ALTER TABLE test_send ADD COLUMN tag_test_guard jsonb CHECK (tag_test_guard IS NULL OR (scenario_id IS NOT NULL AND source_id IS NULL AND jsonb_typeof(tag_test_guard)='object'));
