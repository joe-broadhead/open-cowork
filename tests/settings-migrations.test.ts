import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateSettingsDocument } from '../packages/runtime-host/src/settings-migrations.ts'

test('migrateSettingsDocument is identity at current schema version (JOE-878)', () => {
  const result = migrateSettingsDocument({ schemaVersion: 1, theme: 'dark' }, 1)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.migratedFrom, null)
    assert.equal(result.value.theme, 'dark')
  }
})

test('migrateSettingsDocument fails closed on missing version (JOE-878)', () => {
  const result = migrateSettingsDocument({ theme: 'dark' }, 1)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'corrupt')
})

test('migrateSettingsDocument fails closed on future version (JOE-878)', () => {
  const result = migrateSettingsDocument({ schemaVersion: 99 }, 1)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'unsupported_version')
})
