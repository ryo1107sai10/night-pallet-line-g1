SET search_path = night, pg_catalog;

CREATE TABLE interview_shared_calendar (
  store_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  calendar_id text NOT NULL UNIQUE CHECK (calendar_id ~ '^[a-z0-9._+%#-]+@group[.]calendar[.]google[.]com$' AND length(calendar_id)<=250),
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id),
  FOREIGN KEY (tenant_id,linked_by) REFERENCES staff(tenant_id,id)
);
ALTER TABLE interview_shared_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_shared_calendar FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON interview_shared_calendar
  USING (tenant_id=scope_tenant() AND store_id=scope_store())
  WITH CHECK (tenant_id=scope_tenant() AND store_id=scope_store());
