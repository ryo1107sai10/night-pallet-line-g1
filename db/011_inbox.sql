SET search_path = night, pg_catalog;

ALTER TABLE store ADD COLUMN inbox_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE inbox_thread (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment','unclassified')),
  user_key text NOT NULL,
  address_box text NOT NULL,
  assigned_to uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','handling','resolved')),
  unread boolean NOT NULL DEFAULT true,
  last_received_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,store_id,channel_id,id),
  UNIQUE (channel_id,purpose,user_key),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,assigned_to) REFERENCES staff (tenant_id,id)
);
CREATE INDEX inbox_list ON inbox_thread(store_id,purpose,last_received_at DESC);

CREATE TABLE inbox_message (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  thread_id uuid,
  remote_id text,
  service_id uuid REFERENCES service_delivery(id),
  actor_id uuid,
  direction text NOT NULL CHECK (direction IN ('incoming','outgoing','internal')),
  kind text NOT NULL,
  body_box text,
  happened_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn boolean NOT NULL DEFAULT false,
  UNIQUE (channel_id,remote_id),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,channel_id,thread_id) REFERENCES inbox_thread (tenant_id,store_id,channel_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES staff (tenant_id,id)
);
CREATE INDEX inbox_message_list ON inbox_message(thread_id,happened_at DESC);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['inbox_thread','inbox_message']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;
