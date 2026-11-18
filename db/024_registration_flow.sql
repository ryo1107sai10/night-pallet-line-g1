SET search_path = night, pg_catalog;

-- 登録フロー再設計（設計書 §12）: 監督者ウィザードで作成した法人の記録。
-- tenant_id は作成された法人、supervisor_tenant_id は作成した監督者の法人。
-- 監督者は自分の法人にスコープしたまま、自分が作成した法人を一覧できる。
CREATE TABLE platform_registration (
  tenant_id uuid PRIMARY KEY REFERENCES tenant (id),
  supervisor_tenant_id uuid NOT NULL REFERENCES tenant (id),
  store_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id),
  FOREIGN KEY (supervisor_tenant_id, created_by) REFERENCES staff (tenant_id, id)
);
ALTER TABLE platform_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_registration FORCE ROW LEVEL SECURITY;
CREATE POLICY registration_scope ON platform_registration
  USING (tenant_id = scope_tenant() OR supervisor_tenant_id = scope_tenant())
  WITH CHECK (tenant_id = scope_tenant() OR supervisor_tenant_id = scope_tenant());

-- tenant_master の作成は従来、移行用ロール（所有者）だけに許可されていた（019の
-- tenant_master_owner）。ウィザード経由の法人作成では、監督者本人の操作であることを
-- night.platform_principal と platform_registration の記録で確認できた場合に限り、
-- アプリケーションロールからの INSERT を許可する（既存の supervisor UPDATE ポリシーと同じ方式）。
CREATE POLICY tenant_master_registration ON tenant_master FOR INSERT WITH CHECK (
  tenant_id = scope_tenant() AND EXISTS (
    SELECT 1 FROM platform_master p
    JOIN platform_registration r ON r.supervisor_tenant_id = p.tenant_id
    WHERE p.staff_id::text = current_setting('night.platform_principal', true)
      AND r.tenant_id = tenant_master.tenant_id
  )
);

-- 店舗セットアップウィザード（エール側）の進捗。各ステップの確定は
-- 「確定した時点の設定内容のダイジェスト」とセットで記録し、後からその設定が
-- 変わるとダイジェスト不一致で自動的に未確定へ戻る（再確定が必要になる）。
-- 関係ない設定の変更では失効しないよう、ステップごとに対象を分けて照合する。
CREATE TABLE store_setup (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  profile_confirmed_at timestamptz,
  profile_digest text,
  features_confirmed_at timestamptz,
  features_digest text,
  hours_confirmed_at timestamptz,
  hours_digest text,
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id)
);
ALTER TABLE store_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_setup FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON store_setup
  USING (tenant_id = scope_tenant() AND (scope_all_stores() OR store_id = scope_store()));
