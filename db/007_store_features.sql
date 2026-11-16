SET search_path = night, pg_catalog;

ALTER TABLE store
  ADD COLUMN tags_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN tags_enabled_at timestamptz,
  ADD COLUMN visits_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN visits_enabled_at timestamptz,
  ADD COLUMN interviews_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN google_calendar_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE customer_tag_rule (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  trigger text CHECK (trigger IN ('follow', 'booking_created', 'visit')),
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, name),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id)
);
ALTER TABLE customer_tag_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tag_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer_tag_rule
  USING (tenant_id=scope_tenant() AND store_id=scope_store());

CREATE TABLE customer_tag_filter (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  tags text[] NOT NULL CHECK (cardinality(tags) BETWEEN 1 AND 30),
  match_mode text NOT NULL CHECK (match_mode IN ('all','any')),
  PRIMARY KEY (tenant_id, store_id, name),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id)
);
ALTER TABLE customer_tag_filter ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tag_filter FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer_tag_filter
  USING (tenant_id=scope_tenant() AND store_id=scope_store());
