import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
  type AgentMemoryDraft,
  type ImprovementEvidenceRef,
} from '../packages/shared/src/improvements.ts'
import type { GovernancePrincipal } from '../packages/shared/src/governance.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import { exportGovernanceAuditEvents } from '../apps/desktop/src/main/governance-audit-export.ts'
import {
  clearGovernanceAuditStoreCache,
  listGovernanceAuditEvents,
} from '../apps/desktop/src/main/governance-audit-store.ts'
import {
  approveAgentMemoryEntry,
  buildImprovementDiagnosticsSummary,
  buildMemoryInjectionPlan,
  clearImprovementStoreCache,
  createAgentMemoryProposal,
  getAgentMemoryEntry,
} from '../apps/desktop/src/main/improvement-store.ts'
import { quarantineGovernanceMemory } from '../apps/desktop/src/main/governance-memory-controls.ts'

function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-memory-control-${name}-`))
}

function withMemoryControlStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    closeLogger()
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearImprovementStoreCache()
    clearGovernanceAuditStoreCache()
    fn()
  } finally {
    closeLogger()
    clearImprovementStoreCache()
    clearGovernanceAuditStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function evidence(id = 'trace-1'): ImprovementEvidenceRef {
  return {
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    kind: 'trace',
    id,
    label: `Trace ${id}`,
    uri: null,
    hash: `sha256:${id}`,
  }
}

function memoryDraft(overrides: Partial<AgentMemoryDraft> = {}): AgentMemoryDraft {
  return {
    scopeKind: 'machine',
    scopeId: null,
    title: 'Sensitive operating lesson',
    summary: 'A reviewed lesson that may need incident quarantine.',
    body: 'Prefer concise operating summaries when evidence is strong.',
    tags: ['incident', 'memory'],
    privacy: 'internal',
    provenance: [evidence()],
    ...overrides,
  }
}

const policyDiagnostics = {
  proposalsEnabled: true,
  disabledAgentCount: 0,
  disabledProjectCount: 0,
  disabledCrewCount: 0,
}

const viewer: GovernancePrincipal = {
  kind: 'user',
  id: 'viewer',
  displayName: 'Viewer',
  roles: ['viewer'],
  groupIds: [],
}

test('quarantineGovernanceMemory removes approved memory from injection and records audit evidence', () => withMemoryControlStore('quarantine-approved', () => {
  const proposed = createAgentMemoryProposal(memoryDraft())
  approveAgentMemoryEntry(proposed.id, 'reviewer', 'Evidence checked.')
  assert.equal(buildMemoryInjectionPlan([{ scopeKind: 'machine' }]).entries.length, 1)

  const quarantined = quarantineGovernanceMemory({
    memoryId: proposed.id,
    reason: 'Potentially unsafe lesson.',
  })

  assert.equal(quarantined?.status, 'quarantined')
  assert.equal(quarantined?.reviewedBy, 'local-user')
  assert.equal(quarantined?.reviewNote, 'Potentially unsafe lesson.')
  assert.deepEqual(buildMemoryInjectionPlan([{ scopeKind: 'machine' }]).entries, [])

  const summary = buildImprovementDiagnosticsSummary(policyDiagnostics)
  assert.equal(summary.memory.approved, 0)
  assert.equal(summary.memory.quarantined, 1)
  assert.equal(summary.memory.injection.consideredCount, 0)

  const subjectId = `memory:${encodeURIComponent(proposed.id)}`
  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'memory', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.action, 'quarantine_memory')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'approved')
  assert.equal(auditEvents[0]?.afterLifecycle, 'quarantined')
  assert.equal(auditEvents[0]?.reason, 'Potentially unsafe lesson.')
  assert.equal(auditEvents[0]?.metadata.memoryId, proposed.id)

  const exported = exportGovernanceAuditEvents({ subjectKind: 'memory', subjectId })
  const rows = exported.body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(exported.eventCount, 1)
  assert.equal(rows[0]?.subjectKind, 'memory')
  assert.equal((rows[0]?.payload as Record<string, unknown>)?.action, 'quarantine_memory')
}))

test('quarantineGovernanceMemory refuses non-approved memory without mutating or auditing', () => withMemoryControlStore('quarantine-proposed', () => {
  const proposed = createAgentMemoryProposal(memoryDraft({ title: 'Unreviewed lesson' }))

  assert.throws(
    () => quarantineGovernanceMemory({ memoryId: proposed.id, reason: 'Too early.' }),
    /cannot be quarantined from proposed state/,
  )
  assert.equal(getAgentMemoryEntry(proposed.id)?.status, 'proposed')
  assert.equal(listGovernanceAuditEvents().length, 0)
}))

test('quarantineGovernanceMemory records denied audit before mutating for unauthorized actors', () => withMemoryControlStore('quarantine-denied', () => {
  const proposed = createAgentMemoryProposal(memoryDraft({ title: 'Approved sensitive lesson' }))
  approveAgentMemoryEntry(proposed.id, 'reviewer', 'Evidence checked.')

  assert.throws(
    () => quarantineGovernanceMemory({
      memoryId: proposed.id,
      reason: 'Unauthorized quarantine.',
    }, {
      actor: viewer,
    }),
    /not authorized to quarantine memory/,
  )

  assert.equal(getAgentMemoryEntry(proposed.id)?.status, 'approved')
  const subjectId = `memory:${encodeURIComponent(proposed.id)}`
  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'memory', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.outcome, 'failed')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'approved')
  assert.equal(auditEvents[0]?.afterLifecycle, null)
  assert.equal((auditEvents[0]?.metadata.policyDecision as Record<string, unknown>)?.outcome, 'denied')
}))
