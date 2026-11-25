SET search_path = night, pg_catalog;

ALTER TABLE scenario ADD COLUMN folder text NOT NULL DEFAULT '' CHECK (length(folder)<=50),
  ADD COLUMN is_template boolean NOT NULL DEFAULT false;
ALTER TABLE scenario ADD CONSTRAINT scenario_template_unpublished CHECK (NOT is_template OR published_version IS NULL);
