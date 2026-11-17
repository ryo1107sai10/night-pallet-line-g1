SET LOCAL search_path TO night,pg_catalog;

CREATE TABLE tour_revision (
  tenant_id uuid NOT NULL,
  tour text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,tour,revision),
  FOREIGN KEY (tenant_id,published_by) REFERENCES staff (tenant_id,id)
);

ALTER TABLE tour_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tour_revision_supervisor ON tour_revision
  USING (tenant_id=scope_tenant() AND EXISTS (
    SELECT 1 FROM platform_master p WHERE p.tenant_id=tour_revision.tenant_id
      AND p.staff_id::text=current_setting('night.platform_principal',true) AND p.agency_id IS NOT NULL
  ));
