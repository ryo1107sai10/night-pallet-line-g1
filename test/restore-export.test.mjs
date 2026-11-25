import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareExport } from '../deploy/restore-export.mjs'

const sample=`CREATE SCHEMA night;\nCREATE TABLE night.schema_migration (version text);\nCOPY night.schema_migration (version) FROM stdin;\n030_agency_operations\n\\.\nGRANT ALL ON SCHEMA public TO cloudsqlsuperuser;\nGRANT USAGE ON SCHEMA night TO night_app;\n`
test('Cloud SQLの移行データを検証し、Cloud SQL専用権限だけを取り除く',()=>{
  const result=prepareExport(sample)
  assert.equal(result.tables.length,1)
  assert.equal(result.tables[0].count,1)
  assert.equal(result.tables[0].table,'schema_migration')
  assert.ok(!result.sql.includes('cloudsqlsuperuser'))
  assert.ok(result.sql.includes('GRANT USAGE ON SCHEMA night TO night_app;'))
  assert.throws(()=>prepareExport(sample.replace('CREATE SCHEMA night;','CREATE SCHEMA another;')),/Unexpected schema/)
  assert.throws(()=>prepareExport(sample.replace('COPY night.','COPY public.')),/Unexpected COPY/)
  assert.throws(()=>prepareExport(sample.replace('\\.\n','')),/Incomplete/)
})
