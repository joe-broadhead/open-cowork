import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COWORK_SOP_SCHEMA_VERSION, type SopDraft } from '../packages/shared/src/sops.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import {
  clearAutomationStoreCache,
  createAutomation,
  createDeliveryRecord,
  createAutomationRun,
  createAutomationRunWhenNoActive,
  createInboxItem,
  getRun,
  listAutomationState,
  markRunCompleted,
  markRunFailed,
  markRunStarted,
  saveAutomationBrief,
} from '../apps/desktop/src/main/automation-store.ts'
import { AUTOMATION_DB_SCHEMA_VERSION, getDb } from '../apps/desktop/src/main/automation-store-db.ts'
import {
  getSop,
  getSopRunDetail,
  listSopDefinitions,
  runSopForTrigger,
  runSopNow,
  saveAutomationRunAsSop,
  updateSop,
} from '../apps/desktop/src/main/sop-service.ts'
import { getChartArtifactMetadataPath, getChartArtifactsRoot } from '../apps/desktop/src/main/chart-artifacts.ts'
import { createSopDefinitionWithRunLink, recordSopRunEvaluation } from '../apps/desktop/src/main/sop-store.ts'
import {
  resolveSopRunContextForAutomationStart,
  resolveSopRunContextForSopTrigger,
} from '../apps/desktop/src/main/sop-run-context.ts'

const ONE_PX_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-sop-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  closeLogger()
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
}

function withAutomationStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetAutomationStore(userDataDir)
    fn()
  } finally {
    closeLogger()
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function withAutomationStoreAsync(name: string, fn: () => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetAutomationStore(userDataDir)
    await fn()
  } finally {
    closeLogger()
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function createCompletedAutomationRun(summary = 'Report prepared and ready for review.') {
  const automation = createAutomation({
    title: 'Weekly market report',
    goal: 'Prepare a Monday report for the revenue team.',
    kind: 'recurring',
    schedule: { type: 'weekly', timezone: 'UTC', dayOfWeek: 1, runAtHour: 9, runAtMinute: 0 },
    heartbeatMinutes: 15,
    retryPolicy: { maxRetries: 3, baseDelayMinutes: 5, maxDelayMinutes: 60 },
    runPolicy: { dailyRunCap: 6, maxRunDurationMinutes: 120 },
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: '/Users/example/project',
    preferredAgentNames: ['research', 'charts'],
  })
  saveAutomationBrief(automation.id, {
    version: 1,
    status: 'ready',
    goal: automation.goal,
    deliverables: ['Weekly report'],
    assumptions: ['Use the existing dashboard metrics'],
    missingContext: [],
    successCriteria: ['Readable summary'],
    recommendedAgents: ['research', 'charts'],
    workItems: [
      {
        id: 'research-market',
        title: 'Research market movement',
        description: 'Collect competitor and trend changes.',
        ownerAgent: 'research',
        dependsOn: [],
      },
      {
        id: 'chart-market',
        title: 'Chart market movement',
        description: 'Create the delivery chart.',
        ownerAgent: 'charts',
        dependsOn: ['research-market'],
      },
    ],
    approvalBoundary: 'Approve before sending anything externally.',
    generatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  })
  const run = createAutomationRun(automation.id, 'execution', 'Execute weekly report')
  assert.ok(run)
  markRunStarted(run!.id, 'session-completed-run')
  markRunCompleted(run!.id, summary)
  return { automation, run: getRun(run!.id)! }
}

function minimalSopDraft(name = 'Weekly market report SOP'): SopDraft {
  return {
    name,
    description: 'Reusable weekly reporting process.',
    triggerTypes: ['manual'],
    requiredInputs: [],
    workflow: [
      {
        schemaVersion: COWORK_SOP_SCHEMA_VERSION,
        id: 'execute',
        kind: 'execute',
        title: 'Execute the report',
        agentName: 'build',
        approvalRequired: true,
      },
    ],
    approvalPolicy: {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      reviewFirst: true,
      approvalBoundary: 'Review before delivery.',
    },
    retryPolicy: { maxRetries: 3, baseDelayMinutes: 5, maxDelayMinutes: 60 },
    runPolicy: { dailyRunCap: 6, maxRunDurationMinutes: 120 },
    deliveryPolicy: {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      provider: 'in_app',
      target: 'automation-inbox',
      draftFirst: true,
    },
    outcomeRubricId: null,
  }
}

function draftFromSop(detail: NonNullable<ReturnType<typeof getSop>>): SopDraft {
  const active = detail.activeVersion
  assert.ok(active)
  return {
    name: `${detail.definition.name} v2`,
    description: `${detail.definition.description} Updated.`,
    triggerTypes: active.triggerTypes,
    requiredInputs: active.requiredInputs,
    workflow: [
      ...active.workflow,
      {
        schemaVersion: COWORK_SOP_SCHEMA_VERSION,
        id: 'final-review',
        kind: 'approval',
        title: 'Final human review',
        agentName: null,
        approvalRequired: true,
      },
    ],
    approvalPolicy: active.approvalPolicy,
    retryPolicy: active.retryPolicy,
    runPolicy: active.runPolicy,
    deliveryPolicy: active.deliveryPolicy,
    outcomeRubricId: active.outcomeRubricId,
  }
}

function createLinkedSopRun(sopId: string, inputs: Record<string, unknown>, triggerType: 'manual' | 'schedule' | 'inbox' | 'webhook' = 'manual') {
  const resolved = resolveSopRunContextForSopTrigger({ sopId, triggerType, inputs })
  const run = createAutomationRunWhenNoActive(resolved.automationId, 'execution', `Test SOP ${triggerType}`, {
    sopRunLink: resolved.context,
  })
  if (!run) throw new Error('SOP backing automation already has an active run.')
  const detail = getSopRunDetail(run!.id)
  assert.ok(detail)
  return detail.link
}

test('successful automation runs can be saved as versioned SOPs with exact run provenance', () => withAutomationStore('save-run', () => {
  const { automation, run } = createCompletedAutomationRun()
  const detail = saveAutomationRunAsSop(run.id)

  assert.equal(detail.definition.schemaVersion, COWORK_SOP_SCHEMA_VERSION)
  assert.equal(detail.definition.name, automation.title)
  assert.equal(detail.definition.sourceAutomationId, automation.id)
  assert.equal(detail.activeVersion?.version, 1)
  assert.equal(detail.activeVersion?.sourceRunId, run.id)
  assert.deepEqual(detail.activeVersion?.triggerTypes, ['manual', 'schedule'])
  assert.equal(detail.activeVersion?.requiredInputs[0]?.id, 'project-directory')
  assert.deepEqual(detail.activeVersion?.workflow.map((step) => step.kind), ['plan', 'execute', 'execute', 'deliver'])
  assert.equal(detail.runLinks.length, 1)
  assert.equal(detail.runLinks[0]?.sopVersionId, detail.activeVersion?.id)
  assert.equal(detail.runLinks[0]?.automationRunId, run.id)

  const listed = listSopDefinitions()
  assert.equal(listed.sops.length, 1)
  assert.equal(listed.sops[0]?.activeVersion?.id, detail.activeVersion?.id)
}))

test('saving automation runs as SOPs bounds long summary provenance', () => withAutomationStore('save-run-long-summary', () => {
  const { run } = createCompletedAutomationRun('x'.repeat(100_000))
  const detail = saveAutomationRunAsSop(run.id)
  const link = detail.runLinks[0]

  assert.ok(link)
  assert.equal(String(link.inputs.summary).length, 4_000)
  assert.equal(link.inputs.summaryTruncated, true)
  assert.equal(listSopDefinitions().sops.length, 1)
  assert.equal(saveAutomationRunAsSop(run.id).definition.id, detail.definition.id)
  assert.equal(listSopDefinitions().sops.length, 1)
}))

test('SOP creation and source run linking are atomic', () => withAutomationStore('atomic-link', () => {
  const { automation, run } = createCompletedAutomationRun()

  assert.throws(() => createSopDefinitionWithRunLink(minimalSopDraft(), {
    automationId: automation.id,
    runId: run.id,
  }, {
    automationRunId: run.id,
    triggerType: 'manual',
    inputs: { oversized: 'x'.repeat(100_000) },
  }), /SOP run inputs are too large/)
  assert.equal(listSopDefinitions().sops.length, 0)
}))

test('only completed automation runs can be promoted into SOPs', () => withAutomationStore('save-incomplete-run', () => {
  const automation = createAutomation({
    title: 'Draft report',
    goal: 'Prepare a report.',
    kind: 'recurring',
    schedule: { type: 'weekly', timezone: 'UTC', dayOfWeek: 1, runAtHour: 9, runAtMinute: 0 },
    heartbeatMinutes: 15,
    retryPolicy: { maxRetries: 3, baseDelayMinutes: 5, maxDelayMinutes: 60 },
    runPolicy: { dailyRunCap: 6, maxRunDurationMinutes: 120 },
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: null,
    preferredAgentNames: [],
  })
  const run = createAutomationRun(automation.id, 'execution', 'Execute draft report')
  assert.ok(run)

  assert.throws(() => saveAutomationRunAsSop(run!.id), /Only completed automation runs/)
}))

test('editing a SOP creates a new active version without rewriting previous run links', () => withAutomationStore('version-history', () => {
  const { run } = createCompletedAutomationRun()
  const v1 = saveAutomationRunAsSop(run.id)
  const v1VersionId = v1.activeVersion?.id
  assert.ok(v1VersionId)

  const v2 = updateSop(v1.definition.id, draftFromSop(v1))
  assert.equal(v2.versions.length, 2)
  assert.equal(v2.activeVersion?.version, 2)
  assert.notEqual(v2.activeVersion?.id, v1VersionId)
  assert.equal(v2.runLinks[0]?.automationRunId, run.id)
  assert.equal(v2.runLinks[0]?.sopVersionId, v1VersionId)

  const reloaded = getSop(v1.definition.id)
  assert.equal(reloaded?.versions.map((version) => version.version).join(','), '2,1')
  assert.equal(reloaded?.runLinks[0]?.sopVersionId, v1VersionId)
}))

test('manual SOP runs create automation runs linked to the active SOP version', () => withAutomationStore('run-now', () => {
  const { run } = createCompletedAutomationRun()
  const v1 = saveAutomationRunAsSop(run.id)
  const v2 = updateSop(v1.definition.id, draftFromSop(v1))
  const link = createLinkedSopRun(v2.definition.id, { requester: 'local-user', 'project-directory': '/Users/example/project' })
  const startedRun = getRun(link.automationRunId)

  assert.ok(startedRun)
  assert.equal(startedRun?.automationId, v2.definition.sourceAutomationId)
  assert.equal(startedRun?.status, 'queued')
  assert.equal(link.sopVersionId, v2.activeVersion?.id)
  assert.equal(link.inputs.requester, 'local-user')
  assert.equal(link.inputs['project-directory'], '/Users/example/project')

  const detail = getSop(v2.definition.id)
  assert.equal(detail?.runLinks.length, 2)
  assert.deepEqual(
    detail?.runLinks.map((entry) => entry.sopVersionId).sort(),
    [v1.activeVersion?.id, v2.activeVersion?.id].sort(),
  )
}))

test('SOP trigger entry points start execution through the automation runner', async () => withAutomationStoreAsync('trigger-entrypoints', async () => {
  const { run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const active = updateSop(sop.definition.id, {
    ...draftFromSop(sop),
    triggerTypes: ['manual', 'inbox', 'webhook'],
  })
  const triggers = [
    ['manual', 'automation_page'],
    ['inbox', 'automation_inbox'],
    ['webhook', 'automation_webhook'],
  ] as const

  for (const [triggerType, source] of triggers) {
    const existingRunIds = new Set(listAutomationState().runs.map((entry) => entry.id))
    const start = triggerType === 'manual'
      ? () => runSopNow(active.definition.id, { source })
      : () => runSopForTrigger(active.definition.id, triggerType, { source })
    await assert.rejects(start, /Runtime not started/)
    const startedRun = listAutomationState().runs.find((entry) => !existingRunIds.has(entry.id))
    assert.ok(startedRun)
    const detail = getSopRunDetail(startedRun!.id)
    assert.equal(startedRun?.status, 'failed')
    assert.equal(detail?.version.id, active.activeVersion?.id)
    assert.equal(detail?.link.triggerType, triggerType)
    assert.equal(detail?.inputs.source, source)
    assert.equal(detail?.inputs['project-directory'], '/Users/example/project')
  }
}))

test('manual SOP runs validate active status and required inputs before creating automation runs', () => withAutomationStore('run-now-eligibility', () => {
  const { run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const runnableSop = updateSop(sop.definition.id, {
    ...draftFromSop(sop),
    requiredInputs: [
      ...(sop.activeVersion?.requiredInputs || []),
      {
        schemaVersion: COWORK_SOP_SCHEMA_VERSION,
        id: 'report-owner',
        label: 'Report owner',
        description: 'Required reviewer that cannot be inferred from the backing automation.',
        required: true,
      },
    ],
  })
  const runCountBefore = (getDb().prepare('select count(*) as count from automation_runs').get() as { count?: number }).count

  assert.throws(() => resolveSopRunContextForSopTrigger({ sopId: runnableSop.definition.id, triggerType: 'manual', inputs: {} }), /Missing required SOP input: Report owner/)
  assert.equal((getDb().prepare('select count(*) as count from automation_runs').get() as { count?: number }).count, runCountBefore)

  getDb().prepare('update sop_definitions set status = ? where id = ?').run('paused', runnableSop.definition.id)
  assert.throws(() => resolveSopRunContextForSopTrigger({
    sopId: runnableSop.definition.id,
    triggerType: 'manual',
    inputs: { 'project-directory': '/Users/example/project', 'report-owner': 'qa' },
  }), /Only active SOPs/)
  assert.equal((getDb().prepare('select count(*) as count from automation_runs').get() as { count?: number }).count, runCountBefore)
  getDb().prepare('update sop_definitions set status = ? where id = ?').run('active', runnableSop.definition.id)

  assert.throws(() => resolveSopRunContextForSopTrigger({
    sopId: runnableSop.definition.id,
    triggerType: 'manual',
    inputs: {
      'project-directory': '/Users/example/project',
      'report-owner': 'qa',
      oversized: 'x'.repeat(100_000),
    },
  }), /SOP run inputs are too large/)
  assert.equal((getDb().prepare('select count(*) as count from automation_runs').get() as { count?: number }).count, runCountBefore)

  const link = createLinkedSopRun(runnableSop.definition.id, { 'project-directory': '/Users/example/project', 'report-owner': 'qa' })
  assert.equal(link.inputs['project-directory'], '/Users/example/project')
  assert.equal(link.inputs['report-owner'], 'qa')
  assert.equal((getDb().prepare('select count(*) as count from automation_runs').get() as { count?: number }).count, Number(runCountBefore) + 1)
}))

test('automation service starts can resolve active SOP trigger context', () => withAutomationStore('start-context', () => {
  const { automation, run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const context = resolveSopRunContextForAutomationStart({
    automation,
    kind: 'execution',
    triggerType: 'schedule',
    inputs: {
      source: 'automation_schedule',
      scheduledFor: '2026-05-11T09:00:00.000Z',
    },
  })

  assert.equal(context?.sopVersionId, sop.activeVersion?.id)
  assert.equal(context?.triggerType, 'schedule')
  assert.equal(context?.inputs.source, 'automation_schedule')
  assert.equal(context?.inputs['project-directory'], '/Users/example/project')
}))

test('automation service starts skip SOP links when required inputs are unavailable', () => withAutomationStore('start-context-missing-input', () => {
  const { automation, run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  updateSop(sop.definition.id, {
    ...draftFromSop(sop),
    requiredInputs: [
      ...(sop.activeVersion?.requiredInputs || []),
      {
        schemaVersion: COWORK_SOP_SCHEMA_VERSION,
        id: 'report-owner',
        label: 'Report owner',
        description: 'Required reviewer that the automation service cannot infer.',
        required: true,
      },
    ],
  })

  const context = resolveSopRunContextForAutomationStart({
    automation,
    kind: 'execution',
    triggerType: 'schedule',
    inputs: {
      source: 'automation_schedule',
      scheduledFor: '2026-05-11T09:00:00.000Z',
    },
  })
  assert.equal(context, null)

  const started = createAutomationRunWhenNoActive(automation.id, 'execution', 'Execute scheduled automation', {
    sopRunLink: context,
  })
  assert.ok(started)
  assert.equal(getSopRunDetail(started!.id), null)
}))

test('automation run creation can atomically link a scheduled SOP run', () => withAutomationStore('atomic-start-link', () => {
  const { automation, run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const context = resolveSopRunContextForAutomationStart({
    automation,
    kind: 'execution',
    triggerType: 'schedule',
    inputs: { source: 'automation_schedule' },
  })
  assert.ok(context)

  const started = createAutomationRunWhenNoActive(automation.id, 'execution', 'Execute scheduled SOP', {
    sopRunLink: context,
  })
  assert.ok(started)

  const detail = getSopRunDetail(started!.id)
  assert.equal(detail?.version.id, sop.activeVersion?.id)
  assert.equal(detail?.link.triggerType, 'schedule')
  assert.equal(detail?.inputs.source, 'automation_schedule')
  assert.equal(detail?.inputs['project-directory'], '/Users/example/project')
}))

test('retry SOP runs inherit the original SOP version even after edits', () => withAutomationStore('retry-context', () => {
  const { automation, run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const first = createLinkedSopRun(sop.definition.id, { requester: 'local-user', 'project-directory': '/Users/example/project' })
  markRunFailed(first.automationRunId, 'Temporary runtime failure', undefined, { retryable: true })
  const edited = updateSop(sop.definition.id, draftFromSop(sop))

  const context = resolveSopRunContextForAutomationStart({
    automation,
    kind: 'execution',
    retryOfRunId: first.automationRunId,
  })

  assert.equal(context?.sopVersionId, sop.activeVersion?.id)
  assert.notEqual(context?.sopVersionId, edited.activeVersion?.id)
  assert.equal(context?.triggerType, 'manual')
  assert.equal(context?.inputs.requester, 'local-user')
}))

test('SOP run detail projects durable automation operations for the exact version', () => withAutomationStore('run-detail', () => {
  const { run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)
  const link = createLinkedSopRun(sop.definition.id, { requester: 'qa-user', priority: 'high', 'project-directory': '/Users/example/project' })
  const startedRun = getRun(link.automationRunId)
  assert.ok(startedRun)
  const runningRun = markRunStarted(startedRun!.id, 'session-run-detail')
  assert.ok(runningRun)
  const chartRoot = getChartArtifactsRoot('session-run-detail')
  const chartPath = join(chartRoot, 'chart-chart-weekly-sessions.png')
  mkdirSync(chartRoot, { recursive: true })
  writeFileSync(chartPath, ONE_PX_PNG_BYTES, { mode: 0o600 })
  writeFileSync(getChartArtifactMetadataPath(chartPath), JSON.stringify({
    format: 'vega-lite',
    title: 'Weekly sessions chart',
    spec: {
      mark: 'line',
      data: { values: [{ day: 'Mon', sessions: 42 }] },
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'sessions', type: 'quantitative' },
      },
    },
  }), { mode: 0o600 })
  const inRunArtifactTime = new Date(Date.parse(runningRun!.startedAt || runningRun!.createdAt))
  utimesSync(chartPath, inRunArtifactTime, inRunArtifactTime)

  const approval = createInboxItem({
    automationId: startedRun!.automationId,
    runId: startedRun!.id,
    type: 'approval',
    title: 'Approve delivery',
    body: 'Review the SOP output before delivery.',
    promoteAutomationStatus: false,
  })
  const failure = createInboxItem({
    automationId: startedRun!.automationId,
    runId: startedRun!.id,
    type: 'failure',
    title: 'Delivery failed',
    body: 'The delivery target rejected the payload.',
    promoteAutomationStatus: false,
  })
  const delivery = createDeliveryRecord({
    automationId: startedRun!.automationId,
    runId: startedRun!.id,
    provider: 'in_app',
    target: 'automation-inbox',
    status: 'failed',
    title: 'SOP delivery',
    body: 'Delivery failed after execution.',
  })
  const failedRun = markRunFailed(startedRun!.id, 'Run exceeded its duration cap.', null, {
    retryable: false,
    failureCode: 'run_timeout',
  })
  assert.ok(failedRun)
  const postRunChartPath = join(chartRoot, 'chart-late-followup.png')
  writeFileSync(postRunChartPath, ONE_PX_PNG_BYTES, { mode: 0o600 })
  writeFileSync(getChartArtifactMetadataPath(postRunChartPath), JSON.stringify({
    format: 'vega-lite',
    title: 'Late follow-up chart',
    spec: {
      mark: 'bar',
      data: { values: [{ day: 'Tue', sessions: 7 }] },
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'sessions', type: 'quantitative' },
      },
    },
  }), { mode: 0o600 })
  const postRunArtifactTime = new Date(Date.parse(failedRun!.finishedAt || failedRun!.createdAt) + 60_000)
  utimesSync(postRunChartPath, postRunArtifactTime, postRunArtifactTime)
  const evaluation = recordSopRunEvaluation({
    automationRunId: startedRun!.id,
    evaluatorAgentName: 'qa-evaluator',
    status: 'needs_revision',
    score: 72,
    summary: 'The output needs a tighter evidence note before delivery.',
    recommendation: 'revise',
  })
  assert.ok(evaluation)
  saveAutomationBrief(startedRun!.automationId, {
    version: 2,
    status: 'ready',
    goal: 'Prepare a refreshed report.',
    deliverables: ['Refreshed report'],
    assumptions: ['Newer brief should not rewrite old SOP run detail.'],
    missingContext: [],
    successCriteria: ['Readable summary'],
    recommendedAgents: ['research'],
    workItems: [
      {
        id: 'research-market',
        title: 'Research market movement',
        description: 'Collect competitor and trend changes.',
        ownerAgent: 'research',
        dependsOn: [],
      },
      {
        id: 'chart-market',
        title: 'Chart market movement',
        description: 'Create the delivery chart.',
        ownerAgent: 'charts',
        dependsOn: ['research-market'],
      },
      {
        id: 'newer-run-only',
        title: 'Newer run only',
        description: 'This work item belongs to a later run.',
        ownerAgent: 'research',
        dependsOn: [],
      },
    ],
    approvalBoundary: 'Approve before sending anything externally.',
    generatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  })
  const newerRun = createAutomationRun(startedRun!.automationId, 'execution', 'Execute refreshed report')
  assert.ok(newerRun)
  markRunStarted(newerRun!.id, 'session-newer-run')

  const sourceDetail = getSopRunDetail(run.id)
  assert.ok(sourceDetail)
  assert.equal(sourceDetail?.run.id, run.id)
  assert.equal(sourceDetail?.workItems.length, 2)
  assert.deepEqual(sourceDetail?.workItems.map((item) => item.id).sort(), ['chart-market', 'research-market'])
  assert.equal(sourceDetail?.workItems.some((item) => item.id === 'newer-run-only'), false)

  const detail = getSopRunDetail(startedRun!.id)
  assert.ok(detail)
  assert.equal(detail?.link.sopVersionId, sop.activeVersion?.id)
  assert.equal(detail?.version.id, sop.activeVersion?.id)
  assert.equal(detail?.run.id, startedRun!.id)
  assert.equal(detail?.inputs.requester, 'qa-user')
  assert.equal(detail?.inputs['project-directory'], '/Users/example/project')
  assert.equal(detail?.outputs.summary, null)
  assert.equal(detail?.outputs.deliveries[0]?.id, delivery?.id)
  assert.equal(detail?.artifacts.length, 1)
  assert.equal(detail?.artifacts[0]?.title, 'Weekly sessions chart')
  assert.equal(detail?.artifacts[0]?.mime, 'image/png')
  assert.equal(detail?.artifacts[0]?.uri, 'chart-artifact:session-run-detail/chart-chart-weekly-sessions.png')
  assert.equal(detail?.artifacts[0]?.hash, null)
  assert.equal(detail?.approvals[0]?.id, approval?.id)
  assert.ok(detail?.inbox.some((item) => item.id === failure?.id))
  assert.deepEqual(detail?.workItems, [])
  assert.equal(detail?.evaluatorResults.length, 1)
  assert.equal(detail?.evaluatorResults[0]?.id, evaluation?.id)
  assert.equal(detail?.evaluatorResults[0]?.status, 'needs_revision')
  assert.equal(detail?.evaluatorResults[0]?.score, 72)
  assert.equal(detail?.evaluatorResults[0]?.summary, 'The output needs a tighter evidence note before delivery.')
  assert.equal(detail?.evaluatorResults[0]?.recommendation, 'revise')
  assert.deepEqual(detail?.failures.map((entry) => entry.source).sort(), ['delivery', 'inbox', 'run'])
  assert.equal(getSopRunDetail('not-linked'), null)
}))

test('SOP evaluation results require an exact SOP run link', () => withAutomationStore('evaluation-link-guard', () => {
  const { run } = createCompletedAutomationRun()
  assert.throws(() => recordSopRunEvaluation({
    automationRunId: run.id,
    evaluatorAgentName: 'qa-evaluator',
    status: 'passed',
    score: 91,
    summary: 'Looks good.',
    recommendation: 'deliver',
  }), /not linked to a SOP run/)
}))

test('manual SOP runs preserve the backing automation active-run guard', () => withAutomationStore('run-now-active-guard', () => {
  const { run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)

  const first = createLinkedSopRun(sop.definition.id, { requester: 'local-user', 'project-directory': '/Users/example/project' })
  assert.ok(first)
  assert.throws(() => createLinkedSopRun(sop.definition.id, { requester: 'local-user', 'project-directory': '/Users/example/project' }), /already has an active run/)
}))

test('automation database schema includes SOP tables and records the current version', () => withAutomationStore('schema', () => {
  const db = getDb()
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name like 'sop_%' order by name").all() as Array<{ name?: string }>
  const meta = db.prepare('select value from automation_meta where key = ?').get('schema_version') as { value?: string } | undefined

  assert.deepEqual(tables.map((row) => row.name), ['sop_definitions', 'sop_run_evaluations', 'sop_run_links', 'sop_versions'])
  assert.equal(Number(meta?.value), AUTOMATION_DB_SCHEMA_VERSION)
}))
