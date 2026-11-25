SET search_path = night, pg_catalog;
CREATE TABLE studio_media (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL,
  sha256 text NOT NULL CHECK(length(sha256)=64), content bytea NOT NULL CHECK(octet_length(content)<=800000),
  bytes integer NOT NULL CHECK(bytes=octet_length(content)), width integer NOT NULL CHECK(width BETWEEN 1 AND 1600),
  height integer NOT NULL CHECK(height BETWEEN 1 AND 1600), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,sha256),
  FOREIGN KEY(tenant_id,store_id) REFERENCES store(tenant_id,id)
);
ALTER TABLE studio_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_media FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_media_scope ON studio_media USING(tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));
-- The public route contains only random IDs and the internal routing scope. The
-- image is explicitly published for use by LINE; no staff or applicant info is returned.
CREATE TABLE studio_media_route (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,store_id,id) REFERENCES studio_media(tenant_id,store_id,id)
);
