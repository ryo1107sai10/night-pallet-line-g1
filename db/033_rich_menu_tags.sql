SET search_path = night, pg_catalog;

ALTER TABLE workflow_menu ADD COLUMN tag_rules jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(tag_rules) = 'array' AND jsonb_array_length(tag_rules) <= 10);
