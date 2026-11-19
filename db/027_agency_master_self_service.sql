SET LOCAL search_path TO night,pg_catalog;

-- 代理店マスター本人による自法人のマスター交代（後任の招待・切り替え）を許可する。
-- 019 の tenant_master 更新ポリシーは所有者ロールと監督者（night.platform_principal
-- 照合）だけで、アプリロールからは自法人の行でも更新できなかった。ゲート
-- （platform.ts の requireAgencyMasterAccess）が「現在のマスター本人であること」を
-- 確認したセッションに限り night.agency_master へ自分の staff id を設定する方式で、
-- 監督者方式と同じ強度にする。USING は対象行を「自分が現マスターである自法人の行」
-- だけに絞り、WITH CHECK はテナント境界だけを見る（切り替え後は staff_id が後任に
-- 変わるため、staff_id の一致を新しい行に要求すると正規の切り替えまで弾かれる）。
CREATE POLICY tenant_master_self_service ON tenant_master FOR UPDATE USING (
  tenant_id=scope_tenant() AND staff_id::text=current_setting('night.agency_master',true)
) WITH CHECK (
  tenant_id=scope_tenant()
);
