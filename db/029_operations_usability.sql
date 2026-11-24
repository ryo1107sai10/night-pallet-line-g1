SET search_path = night, pg_catalog;

CREATE TABLE inbox_template (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  label text NOT NULL,
  body_box text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id,store_id) REFERENCES store (tenant_id,id)
);
CREATE INDEX inbox_template_store ON inbox_template(store_id,purpose,label) WHERE NOT archived;
ALTER TABLE inbox_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_template FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inbox_template USING (tenant_id=scope_tenant() AND store_id=scope_store());

ALTER TABLE service_delivery ADD COLUMN manual_retry_at timestamptz;
