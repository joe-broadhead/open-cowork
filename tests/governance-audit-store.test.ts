import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { exportGovernanceAuditEvents } from '../apps/desktop/src/main/governance-audit-export.ts'
import {
  clearGovernanceAuditStoreCache,
  getGovernanceAuditDb,
  GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION,
  listGovernanceAuditEvents,
  recordGovernanceAuditEvent,
} from '../apps/desktop/src/main/governance-audit-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-governance-audit-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function withGovernanceAuditStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearGovernanceAuditStoreCache()
    fn()
  } finally {
    clearGovernanceAuditStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('governance audit store records incident controls and filters by subject', () => withGovernanceAuditStore('record-filter', () => {
  const first = recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'pause_crew',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
    reason: 'Manual pause.',
    metadata: { crewId: 'research' },
  })
  recordGovernanceAuditEvent({
    subjectKind: 'agent',
    subjectId: 'agent:machine:data-analyst',
    action: 'pause_agent',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
  })

  const crewEvents = listGovernanceAuditEvents({ subjectKind: 'crew', subjectId: 'crew:research' })
  assert.equal(crewEvents.length, 1)
  assert.equal(crewEvents[0]?.id, first.id)
  assert.equal(crewEvents[0]?.actor.id, 'local-user')
  assert.equal(crewEvents[0]?.outcome, 'succeeded')
  assert.equal(crewEvents[0]?.metadata.crewId, 'research')
  assert.equal(listGovernanceAuditEvents().length, 2)
}))

test('governance audit store caps result count and stores schema version', () => withGovernanceAuditStore('limit-schema', () => {
  for (let index = 0; index < 5; index += 1) {
    recordGovernanceAuditEvent({
      subjectKind: 'crew',
      subjectId: `crew:${index}`,
      action: 'retire_crew',
      beforeLifecycle: 'paused',
      afterLifecycle: 'retired',
    })
  }

  const limited = listGovernanceAuditEvents({ limit: 2 })
  assert.equal(limited.length, 2)
  const row = getGovernanceAuditDb().prepare('select value from governance_audit_meta where key = ?')
    .get('schema_version') as { value?: string } | undefined
  assert.equal(Number(row?.value), GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION)
}))

test('governance audit export includes full history by default', () => withGovernanceAuditStore('export-full-history', () => {
  for (let index = 0; index < 505; index += 1) {
    recordGovernanceAuditEvent({
      subjectKind: 'crew',
      subjectId: `crew:${index}`,
      action: 'pause_crew',
      beforeLifecycle: 'active',
      afterLifecycle: 'paused',
    })
  }

  const listed = listGovernanceAuditEvents()
  assert.equal(listed.length, 500)

  const exported = exportGovernanceAuditEvents()
  assert.equal(exported.eventCount, 505)
  assert.equal(exported.body.split('\n').length, 505)

  const explicitlyLimited = exportGovernanceAuditEvents({ limit: 3 })
  assert.equal(explicitlyLimited.eventCount, 3)
  assert.equal(explicitlyLimited.body.split('\n').length, 3)
}))

test('governance audit store exports deterministic NDJSON and OTel JSON', () => withGovernanceAuditStore('export', () => {
  recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'pause_crew',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
    metadata: { crewId: 'research' },
  })
  recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'retire_crew',
    beforeLifecycle: 'paused',
    afterLifecycle: 'retired',
    reason: 'Decommissioned.',
    metadata: { crewId: 'research', ticket: 'INC-123' },
  })

  const ndjson = exportGovernanceAuditEvents({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    format: 'ndjson',
  })
  const ndjsonRows = ndjson.body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

  assert.equal(ndjson.format, 'ndjson')
  assert.equal(ndjson.contentType, 'application/x-ndjson')
  assert.equal(ndjson.eventCount, 2)
  assert.match(ndjson.filename, /^open-cowork-governance-audit-.*\.ndjson$/)
  assert.deepEqual(ndjsonRows.map((row) => row.recordType), ['governance_incident', 'governance_incident'])
  assert.deepEqual(ndjsonRows.map((row) => (row.payload as Record<string, unknown>).action), ['pause_crew', 'retire_crew'])
  assert.deepEqual(Object.keys(ndjsonRows[0] || {}), [
    'schemaVersion',
    'recordType',
    'id',
    'occurredAt',
    'subjectKind',
    'subjectId',
    'runKind',
    'runId',
    'payload',
  ])

  const otel = exportGovernanceAuditEvents({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    format: 'otel-json',
  })
  const otelBody = JSON.parse(otel.body) as {
    resourceLogs?: Array<{
      scopeLogs?: Array<{
        logRecords?: Array<{
          severityText?: string
          body?: { stringValue?: string }
          attributes?: Array<{ key?: string; value?: { stringValue?: string; intValue?: number } }>
        }>
      }>
    }>
  }
  const logRecords = otelBody.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords || []
  const firstAttributes = new Map((logRecords[0]?.attributes || []).map((attribute) => [
    attribute.key,
    attribute.value?.stringValue ?? attribute.value?.intValue,
  ]))

  assert.equal(otel.format, 'otel-json')
  assert.equal(otel.contentType, 'application/json')
  assert.equal(otel.eventCount, 2)
  assert.match(otel.filename, /^open-cowork-governance-audit-.*\.otel\.json$/)
  assert.equal(logRecords.length, 2)
  assert.equal(logRecords[0]?.severityText, 'INFO')
  assert.equal(logRecords[0]?.body?.stringValue, 'open_cowork.audit.governance_incident.succeeded')
  assert.equal(firstAttributes.get('open_cowork.governance.subject.id'), 'crew:research')
  const firstPayload = JSON.parse(String(firstAttributes.get('open_cowork.audit.payload_json'))) as { action?: string; metadata?: Record<string, unknown> }
  assert.equal(firstPayload.action, 'pause_crew')
  assert.equal(firstPayload.metadata?.crewId, 'research')
}))

test('governance audit store rejects oversized metadata', () => withGovernanceAuditStore('bounds', () => {
  assert.throws(() => recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'pause_crew',
    metadata: { value: 'x'.repeat(129 * 1024) },
  }), /metadata is too large/)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'pause_crew',
    metadata: cyclic,
  }), /JSON-serializable/)

  assert.throws(() => listGovernanceAuditEvents({ subjectKind: 'crew' }), /require both kind and id/)
  assert.equal(listGovernanceAuditEvents({ limit: Number.NaN }).length, 0)
  assert.throws(() => exportGovernanceAuditEvents({ format: 'xml' as never }), /format is invalid/)
}))
