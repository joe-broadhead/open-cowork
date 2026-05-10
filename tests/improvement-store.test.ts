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
import type { CrewDefinitionDraft } from '../packages/shared/src/crews.ts'
import type { SopDraft } from '../packages/shared/src/sops.ts'
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
import { listCustomAgents, listCustomSkills } from '../apps/desktop/src/main/native-customizations.ts'
import { createCrewFromDraft, getCrewDetail, listCrewCatalog } from '../apps/desktop/src/main/crew-service.ts'
import { clearCrewStoreCache, createEvalSuite, listEvalCasesForSuite } from '../apps/desktop/src/main/crew-store.ts'
import { clearAutomationStoreCache } from '../apps/desktop/src/main/automation-store.ts'
import { getSop, listSopDefinitions } from '../apps/desktop/src/main/sop-service.ts'
import { createSopDefinition } from '../apps/desktop/src/main/sop-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-improvement-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetImprovementStore(userDataDir: string) {
  closeLogger()
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearImprovementStoreCache()
  clearCrewStoreCache()
  clearAutomationStoreCache()
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
    clearCrewStoreCache()
    clearAutomationStoreCache()
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

function skillContent(name: string, body = 'Use evidence-backed defaults when this skill is loaded.') {
  return `---\nname: ${name}\ndescription: ${name} guidance.\n---\n\n${body}\n`
}

function crewMembers(): CrewDefinitionDraft['members'] {
  return [
    {
      role: 'lead',
      agentName: 'build',
      displayName: 'Build Lead',
      description: 'Coordinates the crew run.',
      required: true,
    },
    {
      role: 'specialist',
      agentName: 'plan',
      displayName: 'Planner',
      description: 'Shapes the execution plan.',
      required: true,
    },
    {
      role: 'specialist',
      agentName: 'general',
      displayName: 'Generalist',
      description: 'Handles broad implementation work.',
      required: true,
    },
    {
      role: 'evaluator',
      agentName: 'explore',
      displayName: 'Evaluator',
      description: 'Checks the outcome against evidence.',
      required: true,
    },
  ]
}

function sopDraft(overrides: Partial<SopDraft> = {}): SopDraft {
  return {
    name: 'Weekly Reporting SOP',
    description: 'Prepares a weekly reporting package.',
    triggerTypes: ['manual'],
    requiredInputs: [{
      schemaVersion: 1,
      id: 'report-owner',
      label: 'Report owner',
      description: 'The person accountable for the report.',
      required: true,
    }],
    workflow: [{
      schemaVersion: 1,
      id: 'execute-report',
      kind: 'execute',
      title: 'Prepare report',
      agentName: 'build',
      approvalRequired: false,
    }],
    approvalPolicy: {
      schemaVersion: 1,
      reviewFirst: true,
      approvalBoundary: 'Review before delivery.',
    },
    retryPolicy: {
      maxRetries: 1,
      baseDelayMinutes: 30,
      maxDelayMinutes: 120,
    },
    runPolicy: {
      dailyRunCap: 1,
      maxRunDurationMinutes: 60,
    },
    deliveryPolicy: {
      schemaVersion: 1,
      provider: 'in_app',
      target: 'automation-inbox',
      draftFirst: true,
    },
    outcomeRubricId: null,
    ...overrides,
  }
}

function sopPayload(overrides: Partial<SopDraft> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify(sopDraft(overrides))) as Record<string, unknown>
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

test('unsupported improvement proposal targets cannot be marked approved without an applicator', () => withImprovementStore('proposal-unsupported-target', () => {
  const proposal = createImprovementProposal({
    targetType: 'routing',
    targetId: 'analyst-routing',
    title: 'Tune analyst routing',
    summary: 'Routing changes must not be accepted without a typed persistence path.',
    evidence: [evidence('eval-agent')],
    candidateDiffs: [memoryDiff({
      targetType: 'routing',
      targetId: 'analyst-routing',
      summary: 'Update analyst routing.',
      payload: { route: 'prefer-data-analyst' },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /not wired to an existing persistence path/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
}))

test('approving crew improvement proposals applies through the crew persistence service', () => withImprovementStore('proposal-crew-apply', () => {
  const createProposal = createImprovementProposal({
    targetType: 'crew',
    targetId: null,
    title: 'Create reporting crew',
    summary: 'A reviewed crew proposal should create a typed crew definition.',
    evidence: [evidence('trace-crew-create')],
    candidateDiffs: [memoryDiff({
      targetType: 'crew',
      targetId: null,
      operation: 'create',
      summary: 'Create reporting crew.',
      afterHash: 'sha256:crew-create',
      payload: {
        name: 'Weekly Reporting Crew',
        description: 'Prepares and evaluates weekly reporting packages.',
        members: crewMembers(),
        budgetCapUsd: 12,
      },
    })],
  })

  const approvedCreate = approveImprovementProposal(createProposal.id, 'local-user')
  const created = listCrewCatalog().crews.find((crew) => crew.definition.name === 'Weekly Reporting Crew')
  assert.equal(approvedCreate?.status, 'approved')
  assert.ok(created)
  assert.equal(created?.activeVersion?.members.length, 4)
  assert.equal(created?.activeVersion?.budgetCapUsd, 12)

  const updateProposal = createImprovementProposal({
    targetType: 'crew',
    targetId: created!.definition.id,
    title: 'Update reporting crew',
    summary: 'A reviewed crew update should create a new active crew version.',
    evidence: [evidence('trace-crew-update')],
    candidateDiffs: [memoryDiff({
      targetType: 'crew',
      targetId: created!.definition.id,
      operation: 'update',
      summary: 'Update reporting crew.',
      beforeHash: 'sha256:crew-create',
      afterHash: 'sha256:crew-update',
      payload: {
        id: created!.definition.id,
        name: 'Weekly Insights Crew',
        description: 'Prepares, evaluates, and summarizes weekly insight packages.',
        members: crewMembers().map((member, index) => index === 1 ? { ...member, required: false } : member),
        budgetCapUsd: 25,
      },
    })],
  })

  approveImprovementProposal(updateProposal.id, 'local-user')
  const updated = getCrewDetail(created!.definition.id)
  assert.equal(updated?.definition.name, 'Weekly Insights Crew')
  assert.equal(updated?.activeVersion?.version, 2)
  assert.equal(updated?.activeVersion?.budgetCapUsd, 25)
  assert.equal(updated?.activeVersion?.members.find((member) => member.agentName === 'plan')?.required, false)
}))

test('crew improvement proposal approval rejects unsupported delete operations', () => withImprovementStore('proposal-crew-delete', () => {
  const proposal = createImprovementProposal({
    targetType: 'crew',
    targetId: 'crew-to-delete',
    title: 'Delete crew',
    summary: 'Crew delete proposals need a typed retire/delete path before approval.',
    evidence: [evidence('trace-crew-delete')],
    candidateDiffs: [memoryDiff({
      targetType: 'crew',
      targetId: 'crew-to-delete',
      operation: 'delete',
      summary: 'Delete crew.',
      beforeHash: 'sha256:crew',
      afterHash: null,
      payload: {
        id: 'crew-to-delete',
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /operation is not wired/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
}))

test('crew improvement proposal approval rejects mismatched payload and target ids', () => withImprovementStore('proposal-crew-target-mismatch', () => {
  const first = createCrewFromDraft({
    name: 'Primary Crew',
    description: 'Primary crew definition.',
    members: crewMembers(),
  })
  const second = createCrewFromDraft({
    name: 'Secondary Crew',
    description: 'Secondary crew definition.',
    members: crewMembers(),
  })
  const proposal = createImprovementProposal({
    targetType: 'crew',
    targetId: first.definition.id,
    title: 'Update primary crew',
    summary: 'Payload id mismatch should not update another crew.',
    evidence: [evidence('trace-crew-mismatch')],
    candidateDiffs: [memoryDiff({
      targetType: 'crew',
      targetId: first.definition.id,
      operation: 'update',
      summary: 'Update primary crew.',
      payload: {
        id: second.definition.id,
        name: 'Wrong Crew',
        description: 'This should not be applied.',
        members: crewMembers(),
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /payload id must match/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(getCrewDetail(first.definition.id)?.definition.name, 'Primary Crew')
  assert.equal(getCrewDetail(second.definition.id)?.definition.name, 'Secondary Crew')
}))

test('approving SOP improvement proposals applies through the SOP persistence service', () => withImprovementStore('proposal-sop-apply', () => {
  const createProposal = createImprovementProposal({
    targetType: 'sop',
    targetId: null,
    title: 'Create weekly SOP',
    summary: 'A reviewed SOP proposal should create a typed SOP definition.',
    evidence: [evidence('trace-sop-create')],
    candidateDiffs: [memoryDiff({
      targetType: 'sop',
      targetId: null,
      operation: 'create',
      summary: 'Create weekly SOP.',
      afterHash: 'sha256:sop-create',
      payload: sopPayload({
        name: 'Weekly Reporting SOP',
        description: 'Prepares and reviews weekly reporting packages.',
      }),
    })],
  })

  const approvedCreate = approveImprovementProposal(createProposal.id, 'local-user')
  const created = listSopDefinitions().sops.find((sop) => sop.definition.name === 'Weekly Reporting SOP')
  assert.equal(approvedCreate?.status, 'approved')
  assert.ok(created)
  assert.equal(created?.activeVersion?.triggerTypes.includes('manual'), true)
  assert.equal(created?.activeVersion?.runPolicy.maxRunDurationMinutes, 60)

  const updateProposal = createImprovementProposal({
    targetType: 'sop',
    targetId: created!.definition.id,
    title: 'Update weekly SOP',
    summary: 'A reviewed SOP update should create a new active SOP version.',
    evidence: [evidence('trace-sop-update')],
    candidateDiffs: [memoryDiff({
      targetType: 'sop',
      targetId: created!.definition.id,
      operation: 'update',
      summary: 'Update weekly SOP.',
      beforeHash: 'sha256:sop-create',
      afterHash: 'sha256:sop-update',
      payload: {
        id: created!.definition.id,
        ...sopDraft({
          name: 'Weekly Insights SOP',
          description: 'Prepares, reviews, and delivers weekly insight packages.',
          runPolicy: {
            dailyRunCap: 2,
            maxRunDurationMinutes: 90,
          },
        }),
      },
    })],
  })

  approveImprovementProposal(updateProposal.id, 'local-user')
  const updated = getSop(created!.definition.id)
  assert.equal(updated?.definition.name, 'Weekly Insights SOP')
  assert.equal(updated?.activeVersion?.version, 2)
  assert.equal(updated?.activeVersion?.runPolicy.dailyRunCap, 2)
  assert.equal(updated?.activeVersion?.runPolicy.maxRunDurationMinutes, 90)
}))

test('SOP improvement proposal approval rejects unsupported delete operations', () => withImprovementStore('proposal-sop-delete', () => {
  const proposal = createImprovementProposal({
    targetType: 'sop',
    targetId: 'sop-to-delete',
    title: 'Delete SOP',
    summary: 'SOP delete proposals need a typed retire/delete path before approval.',
    evidence: [evidence('trace-sop-delete')],
    candidateDiffs: [memoryDiff({
      targetType: 'sop',
      targetId: 'sop-to-delete',
      operation: 'delete',
      summary: 'Delete SOP.',
      beforeHash: 'sha256:sop',
      afterHash: null,
      payload: {
        id: 'sop-to-delete',
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /operation is not wired/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
}))

test('SOP improvement proposal approval rejects mixed multi-diff payloads', () => withImprovementStore('proposal-sop-mixed-diffs', () => {
  const proposal = createImprovementProposal({
    targetType: 'sop',
    targetId: null,
    title: 'Create SOP and memory',
    summary: 'SOP approvals must not apply unrelated candidate diffs.',
    evidence: [evidence('trace-sop-mixed')],
    candidateDiffs: [
      memoryDiff({
        targetType: 'sop',
        targetId: null,
        operation: 'create',
        summary: 'Create SOP.',
        payload: sopPayload({ name: 'Mixed SOP' }),
      }),
      memoryDiff({
        targetType: 'memory',
        targetId: null,
        operation: 'create',
        summary: 'Create unrelated memory.',
        payload: {
          body: 'This memory must not be applied through SOP approval.',
        },
      }),
    ],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /operation is not wired/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listSopDefinitions().sops.some((sop) => sop.definition.name === 'Mixed SOP'), false)
}))

test('SOP improvement proposal approval rejects invalid trigger types before persistence', () => withImprovementStore('proposal-sop-invalid-trigger', () => {
  const proposal = createImprovementProposal({
    targetType: 'sop',
    targetId: null,
    title: 'Create SOP with invalid trigger',
    summary: 'Invalid trigger types should not be normalized into another trigger.',
    evidence: [evidence('trace-sop-trigger')],
    candidateDiffs: [memoryDiff({
      targetType: 'sop',
      targetId: null,
      operation: 'create',
      summary: 'Create SOP.',
      payload: {
        ...sopDraft({ name: 'Invalid Trigger SOP' }),
        triggerTypes: ['manual', 'email'],
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /trigger type 2 is invalid/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listSopDefinitions().sops.some((sop) => sop.definition.name === 'Invalid Trigger SOP'), false)
}))

test('SOP improvement proposal approval rejects mismatched payload and target ids', () => withImprovementStore('proposal-sop-target-mismatch', () => {
  const first = createSopDefinition(sopDraft({ name: 'Primary SOP', description: 'Primary SOP definition.' }))
  const second = createSopDefinition(sopDraft({ name: 'Secondary SOP', description: 'Secondary SOP definition.' }))
  const proposal = createImprovementProposal({
    targetType: 'sop',
    targetId: first.definition.id,
    title: 'Update primary SOP',
    summary: 'Payload id mismatch should not update another SOP.',
    evidence: [evidence('trace-sop-mismatch')],
    candidateDiffs: [memoryDiff({
      targetType: 'sop',
      targetId: first.definition.id,
      operation: 'update',
      summary: 'Update primary SOP.',
      payload: {
        id: second.definition.id,
        ...sopDraft({
          name: 'Wrong SOP',
          description: 'This should not be applied.',
        }),
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /payload id must match/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(getSop(first.definition.id)?.definition.name, 'Primary SOP')
  assert.equal(getSop(second.definition.id)?.definition.name, 'Secondary SOP')
}))

test('approving eval-case improvement proposals applies through the eval case persistence service', () => withImprovementStore('proposal-eval-case-apply', () => {
  const suite = createEvalSuite({
    name: 'Research Crew Eval Suite',
    description: 'Regression cases for research crew outputs.',
    status: 'active',
  })
  assert.ok(suite)
  const proposal = createImprovementProposal({
    targetType: 'eval_case',
    targetId: null,
    title: 'Create evidence coverage eval case',
    summary: 'A reviewed eval-case proposal should create a typed eval case.',
    evidence: [evidence('trace-eval-case-create')],
    candidateDiffs: [memoryDiff({
      targetType: 'eval_case',
      targetId: null,
      operation: 'create',
      summary: 'Create eval case.',
      afterHash: 'sha256:eval-create',
      payload: {
        suiteId: suite!.id,
        name: 'Evidence coverage',
        inputRef: 'trace://crew-run/evidence-coverage',
        expectedOutcome: 'The final answer cites supporting tool calls or artifacts for material claims.',
      },
    })],
  })

  const approved = approveImprovementProposal(proposal.id, 'local-user')
  const cases = listEvalCasesForSuite(suite!.id)
  assert.equal(approved?.status, 'approved')
  assert.equal(cases.length, 1)
  assert.equal(cases[0]?.name, 'Evidence coverage')
  assert.equal(cases[0]?.inputRef, 'trace://crew-run/evidence-coverage')
  assert.equal(cases[0]?.expectedOutcome, 'The final answer cites supporting tool calls or artifacts for material claims.')
}))

test('eval-case improvement proposal approval rejects unsupported update operations', () => withImprovementStore('proposal-eval-case-update', () => {
  const suite = createEvalSuite({
    name: 'Update Eval Suite',
    description: 'Suite used for unsupported update checks.',
    status: 'active',
  })
  assert.ok(suite)
  const proposal = createImprovementProposal({
    targetType: 'eval_case',
    targetId: 'eval-case-existing',
    title: 'Update eval case',
    summary: 'Eval case updates need a typed update path before approval.',
    evidence: [evidence('trace-eval-case-update')],
    candidateDiffs: [memoryDiff({
      targetType: 'eval_case',
      targetId: 'eval-case-existing',
      operation: 'update',
      summary: 'Update eval case.',
      payload: {
        id: 'eval-case-existing',
        suiteId: suite!.id,
        name: 'Updated eval case',
        inputRef: 'trace://crew-run/update',
        expectedOutcome: 'Updated expected outcome.',
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /operation is not wired/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.deepEqual(listEvalCasesForSuite(suite!.id), [])
}))

test('eval-case improvement proposal approval rejects targeted creates', () => withImprovementStore('proposal-eval-case-targeted-create', () => {
  const suite = createEvalSuite({
    name: 'Targeted Eval Suite',
    description: 'Suite used for targeted create checks.',
    status: 'active',
  })
  assert.ok(suite)
  const proposal = createImprovementProposal({
    targetType: 'eval_case',
    targetId: 'eval-case-target',
    title: 'Create targeted eval case',
    summary: 'Eval case creates must not pretend to update an existing case.',
    evidence: [evidence('trace-eval-case-target')],
    candidateDiffs: [memoryDiff({
      targetType: 'eval_case',
      targetId: 'eval-case-target',
      operation: 'create',
      summary: 'Create eval case.',
      payload: {
        suiteId: suite!.id,
        name: 'Targeted eval case',
        inputRef: 'trace://crew-run/targeted',
        expectedOutcome: 'Targeted creates are rejected.',
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /operation is not wired/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.deepEqual(listEvalCasesForSuite(suite!.id), [])
}))

test('approving machine agent improvement proposals applies through custom agent persistence', () => withImprovementStore('proposal-agent-apply', () => {
  const createProposal = createImprovementProposal({
    targetType: 'agent',
    targetId: 'evidence-analyst',
    title: 'Create evidence analyst agent',
    summary: 'A reviewed agent proposal should write through the custom agent store.',
    evidence: [evidence('trace-agent-create')],
    candidateDiffs: [memoryDiff({
      targetType: 'agent',
      targetId: 'evidence-analyst',
      operation: 'create',
      summary: 'Create evidence analyst agent.',
      afterHash: 'sha256:agent-create',
      payload: {
        scope: 'machine',
        name: 'evidence-analyst',
        description: 'Reviews claims against source evidence.',
        instructions: 'Check each claim against trace evidence and call out gaps.',
        skillNames: [],
        toolIds: [],
        enabled: true,
        color: 'accent',
      },
    })],
  })

  const approvedCreate = approveImprovementProposal(createProposal.id, 'local-user')
  const created = listCustomAgents().find((agent) => agent.name === 'evidence-analyst')
  assert.equal(approvedCreate?.status, 'approved')
  assert.ok(created)
  assert.equal(created?.scope, 'machine')
  assert.equal(created?.description, 'Reviews claims against source evidence.')
  assert.match(created?.instructions || '', /Check each claim/)

  const updateProposal = createImprovementProposal({
    targetType: 'agent',
    targetId: 'evidence-analyst',
    title: 'Update evidence analyst agent',
    summary: 'A reviewed update should replace the custom agent through its persistence path.',
    evidence: [evidence('trace-agent-update')],
    candidateDiffs: [memoryDiff({
      targetType: 'agent',
      targetId: 'evidence-analyst',
      operation: 'update',
      summary: 'Update evidence analyst behavior.',
      beforeHash: 'sha256:agent-create',
      afterHash: 'sha256:agent-update',
      payload: {
        scope: 'machine',
        name: 'Evidence-Analyst',
        description: 'Reviews claims and highlights weak evidence.',
        instructions: 'Prefer concise evidence checks with one risk note.',
        enabled: false,
        color: 'success',
      },
    })],
  })

  approveImprovementProposal(updateProposal.id, 'local-user')
  const updated = listCustomAgents().find((agent) => agent.name === 'evidence-analyst')
  assert.equal(updated?.description, 'Reviews claims and highlights weak evidence.')
  assert.match(updated?.instructions || '', /risk note/)
  assert.equal(updated?.enabled, false)
  assert.equal(updated?.color, 'success')

  const deleteProposal = createImprovementProposal({
    targetType: 'agent',
    targetId: 'evidence-analyst',
    title: 'Remove evidence analyst agent',
    summary: 'A reviewed delete should remove the custom agent files.',
    evidence: [evidence('trace-agent-delete')],
    candidateDiffs: [memoryDiff({
      targetType: 'agent',
      targetId: 'evidence-analyst',
      operation: 'delete',
      summary: 'Remove evidence analyst agent.',
      beforeHash: 'sha256:agent-update',
      afterHash: null,
      payload: {
        scope: 'machine',
        name: 'Evidence-Analyst',
      },
    })],
  })

  approveImprovementProposal(deleteProposal.id, 'local-user')
  assert.equal(listCustomAgents().some((agent) => agent.name === 'evidence-analyst'), false)
}))

test('agent improvement proposal approval validates every diff before writing agent files', () => withImprovementStore('proposal-agent-apply-atomic', () => {
  const proposal = createImprovementProposal({
    targetType: 'agent',
    targetId: 'evidence-analyst',
    title: 'Create duplicate agent diffs',
    summary: 'Conflicting diffs should not leave partial agent files on disk.',
    evidence: [evidence('trace-agent-conflict')],
    candidateDiffs: [
      memoryDiff({
        targetType: 'agent',
        targetId: 'evidence-analyst',
        operation: 'create',
        summary: 'Create evidence analyst agent.',
        payload: {
          scope: 'machine',
          name: 'evidence-analyst',
          description: 'Reviews claims against source evidence.',
          instructions: 'Check each claim against trace evidence.',
          skillNames: [],
          toolIds: [],
          enabled: true,
          color: 'accent',
        },
      }),
      memoryDiff({
        targetType: 'agent',
        targetId: 'evidence-analyst',
        operation: 'create',
        summary: 'Create the same agent again.',
        payload: {
          scope: 'machine',
          name: 'evidence-analyst',
          description: 'Duplicate evidence analyst.',
          instructions: 'This duplicate should fail before writes.',
          skillNames: [],
          toolIds: [],
          enabled: true,
          color: 'accent',
        },
      }),
    ],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /already exists/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listCustomAgents().some((agent) => agent.name === 'evidence-analyst'), false)
}))

test('agent improvement proposal approval rejects project scope until directory grants are wired', () => withImprovementStore('proposal-agent-project-scope', () => {
  const proposal = createImprovementProposal({
    targetType: 'agent',
    targetId: 'project-analyst',
    title: 'Create project agent',
    summary: 'Project agent proposals need explicit project grant wiring.',
    evidence: [evidence('trace-project-agent')],
    candidateDiffs: [memoryDiff({
      targetType: 'agent',
      targetId: 'project-analyst',
      operation: 'create',
      summary: 'Create project scoped agent.',
      payload: {
        scope: 'project',
        directory: '/tmp/project',
        name: 'project-analyst',
        description: 'Project analyst.',
        instructions: 'Use project-local evidence only.',
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /Project-scoped agent improvement proposals need an explicit project grant/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
}))

test('approving machine skill improvement proposals applies through custom skill persistence', () => withImprovementStore('proposal-skill-apply', () => {
  const createProposal = createImprovementProposal({
    targetType: 'skill',
    targetId: 'analyst-notes',
    title: 'Create analyst notes skill',
    summary: 'A reviewed skill proposal should write through the custom skill store.',
    evidence: [evidence('trace-skill-create')],
    candidateDiffs: [memoryDiff({
      targetType: 'skill',
      targetId: 'analyst-notes',
      operation: 'create',
      summary: 'Create analyst notes skill.',
      afterHash: 'sha256:skill-create',
      payload: {
        scope: 'machine',
        name: 'analyst-notes',
        content: skillContent('analyst-notes'),
        toolIds: ['charts'],
        files: [{ path: 'examples/report.md', content: '# Report example\n' }],
      },
    })],
  })

  const approvedCreate = approveImprovementProposal(createProposal.id, 'local-user')
  const created = listCustomSkills().find((skill) => skill.name === 'analyst-notes')
  assert.equal(approvedCreate?.status, 'approved')
  assert.ok(created)
  assert.equal(created?.scope, 'machine')
  assert.deepEqual(created?.toolIds, ['charts'])
  assert.equal(created?.files?.[0]?.path, 'examples/report.md')

  const updateProposal = createImprovementProposal({
    targetType: 'skill',
    targetId: 'analyst-notes',
    title: 'Update analyst notes skill',
    summary: 'A reviewed update should replace the bundle atomically through the skill store.',
    evidence: [evidence('trace-skill-update')],
    candidateDiffs: [memoryDiff({
      targetType: 'skill',
      targetId: 'analyst-notes',
      operation: 'update',
      summary: 'Update analyst notes skill body.',
      beforeHash: 'sha256:skill-create',
      afterHash: 'sha256:skill-update',
      payload: {
        scope: 'machine',
        name: 'analyst-notes',
        content: skillContent('analyst-notes', 'Prefer one chart and one source link per answer.'),
        toolIds: ['charts', 'browser'],
      },
    })],
  })

  approveImprovementProposal(updateProposal.id, 'local-user')
  const updated = listCustomSkills().find((skill) => skill.name === 'analyst-notes')
  assert.match(updated?.content || '', /Prefer one chart/)
  assert.deepEqual(updated?.toolIds, ['browser', 'charts'])

  const deleteProposal = createImprovementProposal({
    targetType: 'skill',
    targetId: 'analyst-notes',
    title: 'Archive analyst notes skill',
    summary: 'A reviewed delete should remove the custom skill bundle.',
    evidence: [evidence('trace-skill-delete')],
    candidateDiffs: [memoryDiff({
      targetType: 'skill',
      targetId: 'analyst-notes',
      operation: 'delete',
      summary: 'Remove analyst notes skill.',
      beforeHash: 'sha256:skill-update',
      afterHash: null,
      payload: {
        scope: 'machine',
        name: 'analyst-notes',
      },
    })],
  })

  approveImprovementProposal(deleteProposal.id, 'local-user')
  assert.equal(listCustomSkills().some((skill) => skill.name === 'analyst-notes'), false)
}))

test('skill improvement proposal approval validates every diff before writing skill bundles', () => withImprovementStore('proposal-skill-apply-atomic', () => {
  const proposal = createImprovementProposal({
    targetType: 'skill',
    targetId: 'analyst-notes',
    title: 'Create duplicate skill diffs',
    summary: 'Conflicting diffs should not leave partial skill files on disk.',
    evidence: [evidence('trace-skill-conflict')],
    candidateDiffs: [
      memoryDiff({
        targetType: 'skill',
        targetId: 'analyst-notes',
        operation: 'create',
        summary: 'Create analyst notes skill.',
        payload: {
          scope: 'machine',
          name: 'analyst-notes',
          content: skillContent('analyst-notes'),
        },
      }),
      memoryDiff({
        targetType: 'skill',
        targetId: 'analyst-notes',
        operation: 'create',
        summary: 'Create the same skill again.',
        payload: {
          scope: 'machine',
          name: 'analyst-notes',
          content: skillContent('analyst-notes', 'Duplicate content.'),
        },
      }),
    ],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /already exists/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
  assert.equal(listCustomSkills().some((skill) => skill.name === 'analyst-notes'), false)
}))

test('skill improvement proposal approval rejects project scope until directory grants are wired', () => withImprovementStore('proposal-skill-project-scope', () => {
  const proposal = createImprovementProposal({
    targetType: 'skill',
    targetId: 'project-notes',
    title: 'Create project skill',
    summary: 'Project skill proposals need explicit project grant wiring.',
    evidence: [evidence('trace-project-skill')],
    candidateDiffs: [memoryDiff({
      targetType: 'skill',
      targetId: 'project-notes',
      operation: 'create',
      summary: 'Create project scoped skill.',
      payload: {
        scope: 'project',
        directory: '/tmp/project',
        name: 'project-notes',
        content: skillContent('project-notes'),
      },
    })],
  })

  assert.throws(
    () => approveImprovementProposal(proposal.id, 'local-user'),
    /Project-scoped skill improvement proposals need an explicit project grant/,
  )
  assert.equal(getImprovementProposal(proposal.id)?.status, 'proposed')
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
