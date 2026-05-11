import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
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
}))
