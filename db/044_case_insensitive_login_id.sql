-- Login IDs retain their original display form, but match without regard to case.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_route_slug_casefold ON night.tenant_route (lower(slug));
CREATE UNIQUE INDEX IF NOT EXISTS tenant_slug_casefold ON night.tenant (lower(slug));
