import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
  type AgentMemoryDraft,
  type ImprovementCandidateDiff,
  type ImprovementEvidenceRef,
} from '../packages/shared/src/improvements.ts'
import type { AppSettings } from '../packages/shared/src/app-config.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import {
  IMPROVEMENT_STORE_SCHEMA_VERSION,
  archiveDreamRun,
  approveAgentMemoryEntry,
  approveImprovementProposal,
  buildImprovementDiagnosticsSummary,
  buildMemoryInjectionPlan,
  cancelDreamRun,
  clearImprovementStoreCache,
  completeDreamRun,
  createAgentMemoryProposal,
  createImprovementProposal,
  failDreamRun,
  getAgentMemoryEntry,
  getDreamRun,
  getImprovementDb,
  getImprovementProposal,
  ImprovementProposalPolicyDisabledError,
  listImprovementReviewQueue,
  listAgentMemoryEntries,
  listImprovementProposals,
  rejectImprovementProposal,
  startDreamRun,
  updateImprovementProposal,
} from '../apps/desktop/src/main/improvement-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-improvement-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetImprovementStore(userDataDir: string) {
  closeLogger()
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearImprovementStoreCache()
}

function withImprovementStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetImprovementStore(userDataDir)
    fn()
  } finally {
    closeLogger()
    clearImprovementStoreCache()
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
    title: 'Prefer short evidence notes',
    summary: 'Use concise evidence notes.',
    body: 'When producing weekly reporting output, cite the source run and keep the recommendation section concise.',
    tags: ['reporting', 'evidence'],
    privacy: 'internal',
    provenance: [evidence()],
    ...overrides,
  }
}

function memoryDiff(overrides: Partial<ImprovementCandidateDiff> = {}): ImprovementCandidateDiff {
  return {
    schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
    targetType: 'memory',
    targetId: null,
    operation: 'create',
    summary: 'Create a proposed reporting memory.',
    beforeHash: null,
    afterHash: 'sha256:after',
    payload: {
      title: 'Prefer short evidence notes',
    },
    ...overrides,
  }
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: null,
    automationQuietHoursEnd: null,
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    dreamConsolidationScheduleEnabled: false,
    dreamConsolidationIntervalHours: 168,
    ...overrides,
  }
}

test('agent memory starts proposed and requires provenance plus review before injection', () => withImprovementStore('memory-review', () => {
  assert.throws(() => createAgentMemoryProposal(memoryDraft({ provenance: [] })), /requires at least one evidence reference/)
  assert.throws(
    () => createAgentMemoryProposal(memoryDraft({ privacy: 'secret' as unknown as AgentMemoryDraft['privacy'] })),
    /privacy classification secret is not supported/,
  )

  const proposed = createAgentMemoryProposal(memoryDraft())
  assert.equal(proposed.schemaVersion, 1)
  assert.equal(proposed.status, 'proposed')
  assert.equal(proposed.reviewedBy, null)

  assert.deepEqual(buildMemoryInjectionPlan([{ scopeKind: 'machine' }]).entries, [])
  assert.throws(() => approveAgentMemoryEntry(proposed.id, ''), /Memory reviewer is required/)

  const approved = approveAgentMemoryEntry(proposed.id, 'local-user', 'Evidence checked.')
  assert.equal(approved?.status, 'approved')
  assert.equal(approved?.reviewedBy, 'local-user')
  assert.ok(approved?.reviewedAt)

  const plan = buildMemoryInjectionPlan([{ scopeKind: 'machine' }], { limit: 5 })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0]?.id, proposed.id)
  assert.equal(plan.diagnostics.consideredCount, 1)
  assert.equal(plan.diagnostics.returnedCount, 1)
  assert.equal(plan.diagnostics.limit, 5)
  assert.deepEqual(plan.diagnostics.scopeKeys, ['machine:*'])
}))

test('memory injection is bounded, deterministic, and excludes restricted entries by default', () => withImprovementStore('injection-plan', () => {
  const first = createAgentMemoryProposal(memoryDraft({
    title: 'Project convention',
    body: 'Always mention the current sprint in project reports.',
    scopeKind: 'project',
    scopeId: '/workspace/acme',
    privacy: 'internal',
    provenance: [evidence('trace-project-1')],
  }))
  const restricted = createAgentMemoryProposal(memoryDraft({
    title: 'Restricted note',
    body: 'Contains restricted customer detail.',
    scopeKind: 'project',
    scopeId: '/workspace/acme',
    privacy: 'restricted',
    provenance: [evidence('trace-project-2')],
  }))
  const otherProject = createAgentMemoryProposal(memoryDraft({
    title: 'Other project note',
    body: 'This should not enter the current project plan.',
    scopeKind: 'project',
    scopeId: '/workspace/other',
    provenance: [evidence('trace-other')],
  }))
  approveAgentMemoryEntry(first.id, 'reviewer')
  approveAgentMemoryEntry(restricted.id, 'reviewer')
  approveAgentMemoryEntry(otherProject.id, 'reviewer')

  const plan = buildMemoryInjectionPlan([{ scopeKind: 'project', scopeId: '/workspace/acme' }], { limit: 1 })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0]?.privacy, 'internal')
  assert.equal(plan.diagnostics.consideredCount, 2)
  assert.equal(plan.diagnostics.excludedRestrictedCount, 1)
  assert.equal(plan.diagnostics.returnedCount, 1)

  const withRestricted = buildMemoryInjectionPlan([{ scopeKind: 'project', scopeId: '/workspace/acme' }], {
    includeRestricted: true,
    limit: 10,
  })
  assert.deepEqual(new Set(withRestricted.entries.map((entry) => entry.id)), new Set([first.id, restricted.id]))
}))

test('improvement proposal creation enforces governed learning policy before inserting', () => withImprovementStore('proposal-policy', () => {
  const draft = {
    targetType: 'memory' as const,
    targetId: null,
    title: 'Candidate memory update',
    summary: 'A proposal that should not bypass governed learning settings.',
    evidence: [evidence('trace-policy')],
    candidateDiffs: [memoryDiff()],
  }

  assert.throws(
    () => createImprovementProposal(draft, {
      settings: settings({ improvementProposalsEnabled: false }),
    }),
    ImprovementProposalPolicyDisabledError,
  )
  assert.equal(listImprovementProposals().length, 0)

  assert.throws(
    () => createImprovementProposal(draft, {
      settings: settings({ improvementProposalsDisabledAgents: { build: true } }),
      policyScope: { agentName: 'build' },
    }),
    ImprovementProposalPolicyDisabledError,
  )
  assert.equal(listImprovementProposals().length, 0)

  const allowed = createImprovementProposal(draft, {
    settings: settings({ improvementProposalsDisabledAgents: { build: true } }),
    policyScope: { agentName: 'plan' },
  })
  assert.equal(allowed.status, 'proposed')
  assert.deepEqual(listImprovementProposals().map((entry) => entry.id), [allowed.id])
}))

test('approving memory improvement proposals applies through memory review gates', () => withImprovementStore('proposal-review', () => {
  const memory = createAgentMemoryProposal(memoryDraft())
  const proposal = createImprovementProposal({
    targetType: 'memory',
    targetId: memory.id,
    title: 'Tighten reporting memory',
    summary: 'Candidate update should be reviewed before touching live memory.',
    evidence: [evidence('eval-1')],
    candidateDiffs: [memoryDiff({
      targetId: memory.id,
      operation: 'update',
      beforeHash: memory.contentHash,
      afterHash: 'sha256:candidate-update',
      payload: {
        title: 'Updated reporting memory',
        body: 'A candidate replacement body.',
        tags: ['reporting', 'reviewed'],
      },
    })],
  })

  const approvedProposal = approveImprovementProposal(proposal.id, 'local-user', 'Looks useful.')
  const archivedOriginal = getAgentMemoryEntry(memory.id)
  const appliedMemory = listAgentMemoryEntries().find((entry) => entry.sourceProposalId === proposal.id)

  assert.equal(approvedProposal?.status, 'approved')
  assert.equal(approvedProposal?.reviewedBy, 'local-user')
  assert.equal(archivedOriginal?.status, 'archived')
  assert.equal(archivedOriginal?.body, memory.body)
  assert.equal(appliedMemory?.status, 'approved')
  assert.equal(appliedMemory?.reviewedBy, 'local-user')
  assert.equal(appliedMemory?.title, 'Updated reporting memory')
  assert.equal(appliedMemory?.body, 'A candidate replacement body.')
  assert.deepEqual(appliedMemory?.tags, ['reporting', 'reviewed'])
  assert.deepEqual(listImprovementProposals().map((entry) => entry.id), [proposal.id])
}))

test('memory improvement proposal approval rejects proposals without memory diffs', () => withImprovementStore('proposal-empty-memory-diff', () => {
  const proposal = createImprovementProposal({
    targetType: 'memory',
    title: 'Incomplete memory proposal',
    summary: 'This should not approve because it has no memory diff.',
    evidence: [evidence('eval-empty-memory')],
    candidateDiffs: [memoryDiff({
      targetType: 'agent',
      targetId: 'build',
      summary: 'Adjust an agent instead.',
      payload: { instructions: 'Prefer concise output.' },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /no memory candidate diff/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listAgentMemoryEntries().length, 0)
}))

test('memory update proposal approval rejects stale target ids', () => withImprovementStore('proposal-stale-memory-update', () => {
  const proposal = createImprovementProposal({
    targetType: 'memory',
    targetId: 'missing-memory',
    title: 'Update missing memory',
    summary: 'This should not turn a stale update into a create.',
    evidence: [evidence('eval-stale-memory')],
    candidateDiffs: [memoryDiff({
      operation: 'update',
      targetId: 'missing-memory',
      summary: 'Update a memory entry that no longer exists.',
      payload: { body: 'Updated memory body.' },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /Memory update proposal target does not exist/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listAgentMemoryEntries().length, 0)
}))

test('improvement review queue lists pending items and edits proposed diffs before review', () => withImprovementStore('proposal-inbox', () => {
  const memory = createAgentMemoryProposal(memoryDraft({ title: 'Pending memory' }))
  const proposal = createImprovementProposal({
    targetType: 'memory',
    targetId: memory.id,
    title: 'Draft memory update',
    summary: 'Original candidate summary.',
    evidence: [evidence('trace-inbox')],
    candidateDiffs: [memoryDiff({ targetId: memory.id })],
  })
  const dream = startDreamRun({
    title: 'Running consolidation',
    instructions: 'Look for duplicates.',
    sourceMemoryEntryIds: [memory.id],
  })
  const failedDream = startDreamRun({
    title: 'Failed consolidation',
    instructions: 'Leave failed output inspectable.',
    sourceMemoryEntryIds: [memory.id],
  })
  failDreamRun(failedDream.id, 'Provider unavailable.')
  const cancelledDream = startDreamRun({
    title: 'Cancelled consolidation',
    instructions: 'Leave cancelled output dismissable.',
    sourceMemoryEntryIds: [memory.id],
  })
  cancelDreamRun(cancelledDream.id, 'Reviewer stopped the run.')

  const queue = listImprovementReviewQueue()
  assert.deepEqual(queue.memory.map((entry) => entry.id), [memory.id])
  assert.deepEqual(queue.proposals.map((entry) => entry.id), [proposal.id])
  assert.deepEqual(new Set(queue.dreamRuns.map((entry) => entry.id)), new Set([dream.id, failedDream.id, cancelledDream.id]))

  const edited = updateImprovementProposal(proposal.id, {
    targetType: 'memory',
    targetId: memory.id,
    title: 'Edited memory update',
    summary: 'Reviewed and tightened candidate summary.',
    evidence: [evidence('trace-inbox')],
    candidateDiffs: [memoryDiff({
      targetId: memory.id,
      summary: 'Reviewed candidate diff.',
      afterHash: 'sha256:edited',
      payload: { body: 'Edited candidate memory body.' },
    })],
  })
  assert.equal(edited?.title, 'Edited memory update')
  assert.equal(edited?.candidateDiffs[0]?.summary, 'Reviewed candidate diff.')

  rejectImprovementProposal(proposal.id, 'reviewer', 'Needs better evidence.')
  assert.throws(
    () => updateImprovementProposal(proposal.id, {
      targetType: 'memory',
      title: 'Too late',
      summary: 'Already reviewed.',
      evidence: [evidence('trace-inbox')],
      candidateDiffs: [memoryDiff()],
    }),
    /Only proposed improvement proposals can be edited/,
  )
  assert.deepEqual(listImprovementReviewQueue().proposals, [])
}))

test('dream runs preserve input memory and produce candidate proposals only', () => withImprovementStore('dream-run', () => {
  const memory = createAgentMemoryProposal(memoryDraft())
  approveAgentMemoryEntry(memory.id, 'local-user')
  const beforeDream = getAgentMemoryEntry(memory.id)
  assert.ok(beforeDream)

  const dream = startDreamRun({
    title: 'Consolidate reporting lessons',
    modelId: 'openrouter/example',
    instructions: 'Review evidence and propose improvements without mutating live memory.',
    sourceMemoryEntryIds: [memory.id],
    sourceTraceEventIds: ['trace-1'],
  })
  assert.equal(dream.status, 'running')
  assert.deepEqual(dream.sourceMemoryEntryIds, [memory.id])

  const proposal = createImprovementProposal({
    targetType: 'memory',
    targetId: memory.id,
    title: 'Candidate memory update',
    summary: 'A dream-generated proposal that still needs explicit review.',
    evidence: [evidence('trace-1')],
    candidateDiffs: [memoryDiff({ targetId: memory.id })],
  })
  const completed = completeDreamRun(dream.id, {
    candidateProposalIds: [proposal.id],
    tokenUsage: { input: 10, output: 5, reasoning: 2 },
    costUsd: 0.01,
  })

  const afterDream = getAgentMemoryEntry(memory.id)
  assert.equal(completed?.status, 'completed')
  assert.deepEqual(completed?.candidateProposalIds, [proposal.id])
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(afterDream?.status, beforeDream.status)
  assert.equal(afterDream?.contentHash, beforeDream.contentHash)
  assert.throws(() => failDreamRun(dream.id, 'Too late.'), /already completed/)
}))

test('failed dream runs remain inspectable without changing source memory', () => withImprovementStore('dream-failure', () => {
  const memory = createAgentMemoryProposal(memoryDraft())
  approveAgentMemoryEntry(memory.id, 'local-user')
  const beforeFailure = getAgentMemoryEntry(memory.id)
  const dream = startDreamRun({
    title: 'Failed consolidation',
    instructions: 'Try to consolidate.',
    sourceMemoryEntryIds: [memory.id],
  })

  const failed = failDreamRun(dream.id, 'Provider unavailable.')
  const afterFailure = getAgentMemoryEntry(memory.id)

  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.error, 'Provider unavailable.')
  assert.deepEqual(getDreamRun(dream.id)?.sourceMemoryEntryIds, [memory.id])
  assert.equal(afterFailure?.contentHash, beforeFailure?.contentHash)
  assert.equal(afterFailure?.status, beforeFailure?.status)
}))

test('dream runs can be cancelled or archived without mutating source memory', () => withImprovementStore('dream-review', () => {
  const memory = createAgentMemoryProposal(memoryDraft())
  approveAgentMemoryEntry(memory.id, 'local-user')
  const beforeReview = getAgentMemoryEntry(memory.id)

  const running = startDreamRun({
    title: 'Running consolidation',
    instructions: 'Collect candidates only.',
    sourceMemoryEntryIds: [memory.id],
  })
  const cancelled = cancelDreamRun(running.id, 'User stopped the consolidation.')
  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(cancelled?.error, 'User stopped the consolidation.')

  const failed = startDreamRun({
    title: 'Failed consolidation',
    instructions: 'Collect candidates only.',
    sourceMemoryEntryIds: [memory.id],
  })
  failDreamRun(failed.id, 'Provider unavailable.')
  const archived = archiveDreamRun(failed.id, 'Dismissed after review.')
  const afterReview = getAgentMemoryEntry(memory.id)

  assert.equal(archived?.status, 'archived')
  assert.equal(archived?.error, 'Provider unavailable.')
  assert.equal(afterReview?.contentHash, beforeReview?.contentHash)
  assert.equal(afterReview?.status, beforeReview?.status)
  assert.throws(() => archiveDreamRun(startDreamRun({
    title: 'Still running',
    instructions: 'Do not archive active work.',
    sourceMemoryEntryIds: [memory.id],
  }).id), /Running dream runs must be cancelled before archiving/)
  const completed = startDreamRun({
    title: 'Completed consolidation',
    instructions: 'Keep completed learning history.',
    sourceMemoryEntryIds: [memory.id],
  })
  completeDreamRun(completed.id)
  assert.throws(() => archiveDreamRun(completed.id), /Completed dream runs are retained/)
}))

test('improvement diagnostics summarize policy, review queues, and memory injection', () => withImprovementStore('diagnostics-summary', () => {
  const approved = createAgentMemoryProposal(memoryDraft({ title: 'Approved memory' }))
  const restricted = createAgentMemoryProposal(memoryDraft({
    title: 'Restricted memory',
    privacy: 'restricted',
    provenance: [evidence('trace-restricted')],
  }))
  const proposed = createAgentMemoryProposal(memoryDraft({
    title: 'Proposed memory',
    provenance: [evidence('trace-proposed')],
  }))
  approveAgentMemoryEntry(approved.id, 'reviewer')
  approveAgentMemoryEntry(restricted.id, 'reviewer')

  createImprovementProposal({
    targetType: 'memory',
    targetId: proposed.id,
    title: 'Candidate memory update',
    summary: 'A proposal waiting for review.',
    evidence: [evidence('trace-proposed')],
    candidateDiffs: [memoryDiff({ targetId: proposed.id })],
  })
  const dream = startDreamRun({
    title: 'Inspect learning evidence',
    instructions: 'Summarize approved memory.',
    sourceMemoryEntryIds: [approved.id],
  })
  failDreamRun(dream.id, 'Provider unavailable.')

  const summary = buildImprovementDiagnosticsSummary({
    proposalsEnabled: true,
    disabledAgentCount: 1,
    disabledProjectCount: 0,
    disabledCrewCount: 1,
  })

  assert.equal(summary.memory.proposed, 1)
  assert.equal(summary.memory.approved, 2)
  assert.equal(summary.memory.approvedRestrictedCount, 1)
  assert.equal(summary.memory.injection.consideredCount, 2)
  assert.equal(summary.memory.injection.returnedCount, 1)
  assert.equal(summary.memory.injection.excludedRestrictedCount, 1)
  assert.equal(summary.proposals.proposed, 1)
  assert.equal(summary.dreamRuns.failed, 1)
  assert.deepEqual(summary.policy, {
    proposalsEnabled: true,
    disabledAgentCount: 1,
    disabledProjectCount: 0,
    disabledCrewCount: 1,
  })
}))

test('improvement database records schema metadata and durable primitives', () => withImprovementStore('schema', () => {
  const db = getImprovementDb()
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name in ('agent_memory_entries', 'improvement_proposals', 'dream_runs') order by name").all() as Array<{ name?: string }>
  const meta = db.prepare('select value from improvement_meta where key = ?').get('schema_version') as { value?: string } | undefined

  assert.deepEqual(tables.map((row) => row.name), ['agent_memory_entries', 'dream_runs', 'improvement_proposals'])
  assert.equal(Number(meta?.value), IMPROVEMENT_STORE_SCHEMA_VERSION)
  assert.equal(listAgentMemoryEntries().length, 0)
}))
