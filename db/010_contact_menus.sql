SET search_path = night, pg_catalog;

ALTER TABLE store
  ADD COLUMN rich_menus_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE workflow_contact (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  subject text NOT NULL,
  user_key text NOT NULL,
  recipient_box text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  menu_due_at timestamptz,
  menu_status text NOT NULL DEFAULT '未切替',
  notices boolean NOT NULL DEFAULT false,
  notices_changed_at timestamptz NOT NULL DEFAULT '-infinity',
  PRIMARY KEY (channel_id,purpose,subject),
  UNIQUE (tenant_id,store_id,channel_id,purpose,subject),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);
CREATE INDEX workflow_contact_menu_pending ON workflow_contact(channel_id,menu_due_at) WHERE menu_due_at IS NOT NULL;
CREATE INDEX workflow_contact_menu_user ON workflow_contact(channel_id,user_key,last_seen_at DESC);

CREATE TABLE workflow_menu (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  base_menu text,
  booked_menu text,
  generation integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (channel_id,purpose),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);

CREATE TABLE interview_waitlist (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  applicant_key text NOT NULL,
  method text NOT NULL CHECK (method IN ('onsite','online')),
  until_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  offered_at timestamptz,
  PRIMARY KEY (channel_id,applicant_key),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id)
);

CREATE TABLE service_delivery (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('customer','recruitment')),
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('interview_confirm','interview_reminder','interview_waitlist','chat_reply')),
  object_id uuid NOT NULL,
  object_revision integer NOT NULL,
  body_box text,
  actor_id uuid,
  generation integer NOT NULL,
  scope_version text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitting','accepted','cancelled','failed','unknown')),
  attempt integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  first_attempt_at timestamptz,
  accepted_at timestamptz,
  line_request_id text,
  reason text,
  UNIQUE (channel_id,purpose,subject,kind,object_id,object_revision),
  FOREIGN KEY (tenant_id,store_id,channel_id) REFERENCES channel (tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES staff (tenant_id,id)
);
CREATE INDEX service_due ON service_delivery(channel_id,next_at,id)
  WHERE status IN ('queued','submitting','unknown');
CREATE INDEX service_spend ON service_delivery(store_id,first_attempt_at);

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['workflow_contact','workflow_menu','interview_waitlist','service_delivery']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY store_scope ON %I USING (tenant_id=scope_tenant() AND store_id=scope_store())',name);
  END LOOP;
END $$;

ALTER POLICY store_scope ON service_delivery USING (tenant_id=scope_tenant() AND (scope_all_stores() OR store_id=scope_store()));
