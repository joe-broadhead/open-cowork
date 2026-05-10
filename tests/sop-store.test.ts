import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COWORK_SOP_SCHEMA_VERSION, type SopDraft } from '../packages/shared/src/sops.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearAutomationStoreCache,
  createAutomation,
  createAutomationRun,
  getRun,
  markRunCompleted,
  saveAutomationBrief,
} from '../apps/desktop/src/main/automation-store.ts'
import { AUTOMATION_DB_SCHEMA_VERSION, getDb } from '../apps/desktop/src/main/automation-store-db.ts'
import {
  getSop,
  listSopDefinitions,
  runSopNow,
  saveAutomationRunAsSop,
  updateSop,
} from '../apps/desktop/src/main/sop-service.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-sop-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
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
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function createCompletedAutomationRun() {
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
  markRunCompleted(run!.id, 'Report prepared and ready for review.')
  return { automation, run: getRun(run!.id)! }
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
  const link = runSopNow(v2.definition.id, { requester: 'local-user' })
  const startedRun = getRun(link.automationRunId)

  assert.ok(startedRun)
  assert.equal(startedRun?.automationId, v2.definition.sourceAutomationId)
  assert.equal(startedRun?.status, 'queued')
  assert.equal(link.sopVersionId, v2.activeVersion?.id)
  assert.equal(link.inputs.requester, 'local-user')

  const detail = getSop(v2.definition.id)
  assert.equal(detail?.runLinks.length, 2)
  assert.deepEqual(
    detail?.runLinks.map((entry) => entry.sopVersionId).sort(),
    [v1.activeVersion?.id, v2.activeVersion?.id].sort(),
  )
}))

test('manual SOP runs preserve the backing automation active-run guard', () => withAutomationStore('run-now-active-guard', () => {
  const { run } = createCompletedAutomationRun()
  const sop = saveAutomationRunAsSop(run.id)

  const first = runSopNow(sop.definition.id, { requester: 'local-user' })
  assert.ok(first)
  assert.throws(() => runSopNow(sop.definition.id, { requester: 'local-user' }), /already has an active run/)
}))

test('automation database schema includes SOP tables and records the current version', () => withAutomationStore('schema', () => {
  const db = getDb()
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name like 'sop_%' order by name").all() as Array<{ name?: string }>
  const meta = db.prepare('select value from automation_meta where key = ?').get('schema_version') as { value?: string } | undefined

  assert.deepEqual(tables.map((row) => row.name), ['sop_definitions', 'sop_run_links', 'sop_versions'])
  assert.equal(Number(meta?.value), AUTOMATION_DB_SCHEMA_VERSION)
}))
