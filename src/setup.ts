import { readFile } from 'node:fs/promises'
import type pg from 'pg'
import { z } from 'zod'
import { audit, configFromEnvironment, email, newId, poolFor, scope, slug, text, tx, type DB } from './core.js'
import { createInvite } from './auth.js'
import { prepareSupervisorHandoff } from './supervisor-handoff.js'

export async function migrate(pool: pg.Pool, role: string) {
  if (!/^[a-z][a-z0-9_]{0,61}$/.test(role)) throw new Error('Invalid application role.')
  const versions = ['001_g1','002_scenarios','003_operations','004_interviews','005_interview_hours',
    '006_interview_availability','007_store_features','008_forms_sources','009_campaigns','010_contact_menus','011_inbox',
    '012_interviewer_calendar','013_guest_interviews','014_line_modules','015_line_onboarding','016_tenant_master','017_platform_master','018_agency_handoff','019_agency_master_management',
    '020_tour_revisions','021_supervisor_handoff','022_interview_link_tokens','023_liff_free_links',
    '024_registration_flow','025_remove_liff','026_recruitment_delivery','027_agency_master_self_service',
    '028_registered_supervision','029_operations_usability','030_agency_operations','031_applicant_tags','032_master_password_reset','033_rich_menu_tags','034_source_test','035_tag_verification','036_self_service_calendar','037_studio_library','038_studio_pro','039_studio_media','040_agency_co_master','041_recruitment_intake','042_piyomaru']
  await tx(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('night.migrate'))")
    await db.query('CREATE SCHEMA IF NOT EXISTS night')
    await db.query('CREATE TABLE IF NOT EXISTS night.schema_migration(version text PRIMARY KEY)')
    for (const version of versions) {
      if ((await db.query('SELECT 1 FROM night.schema_migration WHERE version=$1',[version])).rowCount) continue
      await db.query(await readFile(new URL('../db/'+version+'.sql',import.meta.url),'utf8'))
      await db.query('INSERT INTO night.schema_migration VALUES($1)',[version])
    }
    await db.query(`GRANT USAGE ON SCHEMA night TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.staff,night.staff_session,night.invite,
      night.invite_route,night.auth_rate,night.operation,night.tester,night.test_send,night.channel_relationship,
      night.webhook_event,night.store_grant,night.channel,night.store TO ${role}`)
    await db.query(`GRANT SELECT ON night.tenant_route,night.tenant_master,night.platform_master TO ${role}`)
    await db.query(`GRANT UPDATE (staff_id,co_staff_id,pending_staff_id,pending_mode,pending_replace_id) ON night.tenant_master TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.tour_revision TO ${role}`)
    await db.query(`GRANT SELECT,DELETE ON night.supervisor_handoff TO ${role}`)
    await db.query(`GRANT SELECT,DELETE,UPDATE (attempts) ON night.master_password_reset TO ${role}`)
    await db.query(`GRANT SELECT,UPDATE ON night.tenant TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.scenario TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.studio_editor TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.studio_media,night.studio_media_route TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.scenario_version TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.channel_route,night.audit TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.customer,night.booking_slot,night.visit_booking,
      night.delivery_event,night.enrollment,night.automatic_send TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.applicant_event,night.applicant_enrollment,
      night.applicant_send TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.applicant_tag,night.applicant_tag_subject,night.applicant_tag_assignment,night.applicant_tag_campaign TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.customer_tag_rule TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.customer_tag_filter TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.piyomaru_settings,night.piyomaru_usage,night.piyomaru_job,night.piyomaru_knowledge TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.piyomaru_proof TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,DELETE ON night.piyomaru_note TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.recruitment_intake,night.recruitment_intake_run TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.workflow_form,night.recruitment_case,night.workflow_source TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.workflow_response,night.workflow_attribution TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.campaign,night.campaign_delivery TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.workflow_contact,night.workflow_menu,night.service_delivery TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.interview_waitlist TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.line_handoff TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.inbox_thread,night.inbox_message,night.inbox_template TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.interview_host,night.interview_google_sync TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.interview_google_session,night.interview_google_calendar,night.interview_shared_calendar TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.line_module_session TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.line_onboarding TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,DELETE ON night.line_onboarding_route TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,DELETE ON night.interview_block TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.interview_slot,night.interview_booking TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,DELETE ON night.interview_session TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.interview_link_token TO ${role}`)
    await db.query(`GRANT INSERT ON night.tenant,night.tenant_route,night.tenant_master TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.platform_registration TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE ON night.store_setup TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON night.link_token TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,DELETE ON night.customer_session TO ${role}`)
    await db.query(`GRANT SELECT,INSERT ON night.preference_event,night.delivery_note,night.applicant_note TO ${role}`)
    await db.query(`GRANT USAGE ON SEQUENCE night.audit_id_seq,night.delivery_note_id_seq,night.applicant_note_id_seq TO ${role}`)
  })
}

type BootstrapInput = { slug: string; name: string; email: string; billing_contact?: string }

async function firstInvite(db:DB,cfg:ReturnType<typeof configFromEnvironment>,data:BootstrapInput,supervisorOnly:boolean) {
  const {rows:[registered]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route WHERE slug=$1',[data.slug])
  const id=registered?.tenant_id??newId()
  await scope(db,id,undefined,true)
  if (registered) {
    const {rows:[first]}=await db.query(`SELECT f.id FROM staff f JOIN tenant t ON t.id=f.tenant_id
      WHERE f.tenant_id=$2 AND f.email=$1 AND f.role='admin' AND NOT f.platform_actor AND t.supervisor_only=$3
      AND f.password_hash IS NULL AND f.disabled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM tenant_master m WHERE m.tenant_id=f.tenant_id AND m.staff_id<>f.id)`,
    [data.email,id,supervisorOnly])
    if (!first) throw new Error('法人IDは既に使用されています。')
  } else {
    await db.query('INSERT INTO tenant(id,slug,legal_name,billing_contact,supervisor_only) VALUES($1,$2,$3,$4,$5)',
      [id,data.slug,data.name,data.billing_contact??data.email,supervisorOnly])
    await db.query('INSERT INTO tenant_route VALUES($1,$2)',[data.slug,id])
  }
  const invite=await createInvite(db,cfg,id,{email:data.email,role:'admin',stores:[]},null)
  await db.query('INSERT INTO tenant_master (tenant_id,staff_id) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING',
    [id,invite.id])
  return {invite,id}
}

export async function bootstrap(pool:pg.Pool,cfg:ReturnType<typeof configFromEnvironment>,data:BootstrapInput) {
  return tx(pool,async db=>(await firstInvite(db,cfg,data,false)).invite)
}

export async function inviteSupervisor(pool:pg.Pool,cfg:ReturnType<typeof configFromEnvironment>,
  data:BootstrapInput & { agency: string; displayName: string }) {
  return tx(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('night.platform_master'))")
    const {rows:[agency]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route WHERE slug=$1',[data.agency])
    if (!agency) throw new Error('管理対象の法人が見つかりません。')
    await scope(db,agency.tenant_id)
    if (!(await db.query('SELECT 1 FROM tenant WHERE NOT supervisor_only')).rowCount) {
      throw new Error('管理会社の法人IDを指定してください。')
    }
    const {invite,id}=await firstInvite(db,cfg,data,true)
    const result=await db.query(`INSERT INTO platform_master (tenant_id,staff_id,agency_id,display_name)
      VALUES ($1,$2,$3,$4) ON CONFLICT (singleton) DO UPDATE
      SET tenant_id=excluded.tenant_id,staff_id=excluded.staff_id,agency_id=excluded.agency_id,display_name=excluded.display_name
      WHERE platform_master.agency_id IS NULL
        OR (platform_master.tenant_id,platform_master.staff_id)=(excluded.tenant_id,excluded.staff_id)`,
    [id,invite.id,agency.tenant_id,data.displayName])
    if (!result.rowCount) throw new Error('監督者が既に登録されています。')
    await audit(db,id,null,null,'platform.designated',invite.id,null,{agency_id:agency.tenant_id})
    return invite
  })
}

// Run with the migration database role. Web and worker roles can only read this binding.
export async function designateMaster(pool:pg.Pool,tenantSlug:string,address:string) {
  return tx(pool,async db=>{
    const {rows:[tenant]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route WHERE slug=$1',[tenantSlug])
    if (!tenant) throw new Error('該当する法人が見つかりません。')
    await scope(db,tenant.tenant_id,undefined,true)
    await db.query('SELECT id FROM tenant WHERE id=$1 FOR UPDATE',[tenant.tenant_id])
    const {rows:[staff]}=await db.query<{id:string}>(`SELECT id FROM staff WHERE tenant_id=$1 AND email=$2
      AND role='admin' AND NOT platform_actor AND password_hash IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,[tenant.tenant_id,address])
    if (!staff) throw new Error('有効な法人管理者アカウントを指定してください。')
    const result=await db.query(`INSERT INTO tenant_master(tenant_id,staff_id) VALUES($1,$2)
      ON CONFLICT (tenant_id) DO UPDATE SET staff_id=excluded.staff_id,pending_staff_id=NULL,
        pending_mode='replace',pending_replace_id=NULL
      WHERE tenant_master.staff_id<>excluded.staff_id AND tenant_master.co_staff_id IS DISTINCT FROM excluded.staff_id
      RETURNING staff_id`,[tenant.tenant_id,staff.id])
    if (result.rowCount) {
      await db.query(`DELETE FROM staff_session s USING staff f WHERE s.staff_id=f.id
        AND s.tenant_id=$1 AND f.tenant_id=s.tenant_id AND f.role='admin'
        AND NOT EXISTS (SELECT 1 FROM tenant_master m WHERE m.tenant_id=f.tenant_id AND f.id IN (m.staff_id,m.co_staff_id))`,[tenant.tenant_id])
      await audit(db,tenant.tenant_id,null,null,'master.designated',staff.id)
    }
  })
}

export async function limitAgencyOperations(pool:pg.Pool,tenantSlug:string) {
  return tx(pool,async db=>{
    const {rows:[tenant]}=await db.query<{tenant_id:string}>('SELECT tenant_id FROM tenant_route WHERE slug=$1',[tenantSlug])
    if(!tenant)throw new Error('該当する法人が見つかりません。')
    await scope(db,tenant.tenant_id,undefined,true)
    const {rowCount}=await db.query(`UPDATE tenant t SET agency_operations_only=true WHERE t.id=$1
      AND NOT t.supervisor_only AND NOT t.agency_operations_only AND EXISTS (
        SELECT 1 FROM platform_master p WHERE p.agency_id=t.id OR EXISTS (
          SELECT 1 FROM platform_registration r WHERE r.tenant_id=t.id AND r.supervisor_tenant_id=p.tenant_id
        )
      )`,[tenant.tenant_id])
    if(rowCount)await audit(db,tenant.tenant_id,null,null,'agency.operations_limited',tenant.tenant_id)
    const {rows:[state]}=await db.query<{agency_operations_only:boolean}>(
      'SELECT agency_operations_only FROM tenant WHERE id=$1',[tenant.tenant_id])
    if(!state?.agency_operations_only)throw new Error('監督対象の法人であることを確認してください。')
  })
}

if (import.meta.main) {
  const migrationPool = poolFor(process.env.MIGRATION_DATABASE_URL)
  const url = process.env.DATABASE_URL
  try {
    await migrate(migrationPool, decodeURIComponent(new URL(url ?? '').username))
    const [tenant, name, address, billing] = process.argv.slice(2)
    if (tenant==='--invite-supervisor') {
      const [agency,supervisor,organization,displayName,recipient]=process.argv.slice(3)
      const data=z.object({agency:slug,slug,name:text(120),displayName:text(120),email})
        .parse({agency,slug:supervisor,name:organization,displayName,email:recipient})
      const invite=await inviteSupervisor(migrationPool,configFromEnvironment(),data)
      console.log(JSON.stringify(invite,null,2))
    } else if (tenant==='--supervisor-handoff') {
      const data=z.strictObject({tenant:slug,address:email,nextSlug:slug.optional()}).parse({tenant:name,address,nextSlug:billing})
      const result=await prepareSupervisorHandoff(migrationPool,configFromEnvironment(),data)
      console.log(JSON.stringify(result,null,2))
    } else if (tenant==='--master') {
      await designateMaster(migrationPool,slug.parse(name),email.parse(address))
      console.log('マスターアカウントを指定しました。')
    } else if (tenant==='--limit-agency') {
      await limitAgencyOperations(migrationPool,slug.parse(name))
      console.log('管理会社の運用権限を適用しました。')
    } else if (tenant) {
      const data = z.object({ slug, name:text(120), email, billing_contact:email.optional() })
        .parse({slug:tenant,name,email:address,billing_contact:billing})
      console.log(JSON.stringify(await bootstrap(migrationPool,configFromEnvironment(),data),null,2))
    } else {
      console.log('PostgreSQL マイグレーション適用済み。')
    }
  } finally {
    await migrationPool.end()
  }
}
