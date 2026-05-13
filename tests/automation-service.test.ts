import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearAutomationStoreCache,
  createAutomation,
  createAutomationRun,
  createAutomationRunWhenNoActive,
  createInboxItem,
  getActiveRunForAutomation,
  getAutomationDetail,
  getRun,
  listDueRetryRuns,
  listAutomationState,
  markRunCompleted,
  markRunFailed,
  markRunNeedsUser,
  markRunStarted,
  saveAutomationBrief,
  updateAutomationStatus,
} from '../apps/desktop/src/main/automation-store.ts'
import {
  approveAutomationBrief,
  cancelAutomationRun,
  handleAutomationQuestionAsked,
  handleAutomationQuestionResolved,
  handleAutomationSessionIdle,
  handleAutomationSessionError,
  previewAutomationBrief,
  retryAutomationRun,
  runAutomationServiceTick,
  runAutomationNow,
} from '../apps/desktop/src/main/automation-service.ts'
import {
  getSopRunDetail,
  saveAutomationRunAsSop,
} from '../apps/desktop/src/main/sop-service.ts'
import {
  clearOperationalQueueStoreCache,
  enqueueOperationalRun,
  finishOperationalQueueItem,
  getOperationalQueueDb,
  getOperationalQueueItemForRun,
  startOperationalQueueItem,
} from '../apps/desktop/src/main/operational-queue-store.ts'
import { dispatchRunnableAutomationQueueItems } from '../apps/desktop/src/main/automation-run-starter.ts'
import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-automation-service-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  closeLogger()
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
  clearOperationalQueueStoreCache()
  clearSessionRegistryCache()
}

function createScopedExecutionAutomation(title: string, projectDirectory = '/Users/example/project') {
  const automation = createAutomation({
    title,
    goal: `Execute ${title}.`,
    kind: 'recurring',
    schedule: {
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    },
    heartbeatMinutes: 15,
    retryPolicy: {
      maxRetries: 3,
      baseDelayMinutes: 5,
      maxDelayMinutes: 60,
    },
    runPolicy: {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    },
    executionMode: 'scoped_execution',
    autonomyPolicy: 'review-first',
    projectDirectory,
    preferredAgentNames: [],
  })
  saveAutomationBrief(automation.id, {
    version: 1,
    status: 'ready',
    goal: automation.goal,
    deliverables: ['Report'],
    assumptions: [],
    missingContext: [],
    successCriteria: ['Ready'],
    recommendedAgents: ['research'],
    workItems: [],
    approvalBoundary: 'Approve before delivery.',
    generatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  })
  return automation
}

test('runAutomationNow rejects when an automation already has an active run', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('active-run')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Duplicate guard',
      goal: 'Prevent duplicate execution runs.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute duplicate guard')
    assert.ok(run)
    markRunStarted(run!.id, 'session-running')

    await assert.rejects(
      () => runAutomationNow(automation.id),
      /already has an active execution run/i,
    )
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('runAutomationNow queues scoped execution when the project target is already active', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operational-queue-wait')

  try {
    resetAutomationStore(userDataDir)

    const projectDirectory = '/Users/example/project'
    const blocker = enqueueOperationalRun({
      runKind: 'agent',
      runId: 'active-writer',
      title: 'Active writer',
      requestedAutonomy: 'supervised',
      globalMaxAutonomy: 'supervised',
      workspaceProfileId: 'project-workspace',
      projectId: projectDirectory,
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    assert.equal(startOperationalQueueItem(blocker.id)?.status, 'running')

    const automation = createScopedExecutionAutomation('Queued project execution', projectDirectory)
    const queuedRun = await runAutomationNow(automation.id)

    assert.equal(queuedRun?.status, 'queued')
    const queueItem = getOperationalQueueItemForRun('automation', queuedRun!.id)
    assert.equal(queueItem?.status, 'queued')
    assert.deepEqual(queueItem?.queueKeys, [`project:${projectDirectory}`])
    assert.equal(queueItem?.workspaceProfileId, 'project-workspace')
    assert.equal(queueItem?.effectiveAutonomy, 'approve')
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('queued automation dispatches after its project queue key is released', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operational-queue-dispatch')

  try {
    resetAutomationStore(userDataDir)

    const projectDirectory = '/Users/example/project'
    const blocker = enqueueOperationalRun({
      runKind: 'agent',
      runId: 'active-writer',
      title: 'Active writer',
      requestedAutonomy: 'supervised',
      globalMaxAutonomy: 'supervised',
      workspaceProfileId: 'project-workspace',
      projectId: projectDirectory,
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    assert.equal(startOperationalQueueItem(blocker.id)?.status, 'running')

    const automation = createScopedExecutionAutomation('Dispatch after writer', projectDirectory)
    const queuedRun = await runAutomationNow(automation.id)
    assert.equal(queuedRun?.status, 'queued')

    finishOperationalQueueItem(blocker.id, 'completed')
    await dispatchRunnableAutomationQueueItems(() => {})

    const failedRun = getRun(queuedRun!.id)
    assert.equal(failedRun?.status, 'failed')
    assert.match(failedRun?.error || '', /runtime not started/i)
    const queueItem = getOperationalQueueItemForRun('automation', queuedRun!.id)
    assert.equal(queueItem?.status, 'failed')
    assert.match(queueItem?.error || '', /runtime not started/i)
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('queued automation runs can be cancelled before OpenCode dispatch', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operational-queue-cancel')

  try {
    resetAutomationStore(userDataDir)

    const projectDirectory = '/Users/example/project'
    const blocker = enqueueOperationalRun({
      runKind: 'agent',
      runId: 'active-writer',
      title: 'Active writer',
      requestedAutonomy: 'supervised',
      globalMaxAutonomy: 'supervised',
      workspaceProfileId: 'project-workspace',
      projectId: projectDirectory,
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    assert.equal(startOperationalQueueItem(blocker.id)?.status, 'running')

    const automation = createScopedExecutionAutomation('Cancel queued execution', projectDirectory)
    const queuedRun = await runAutomationNow(automation.id)
    assert.equal(queuedRun?.status, 'queued')

    assert.equal(await cancelAutomationRun(queuedRun!.id), true)
    const cancelledRun = getRun(queuedRun!.id)
    assert.equal(cancelledRun?.status, 'cancelled')
    const queueItem = getOperationalQueueItemForRun('automation', queuedRun!.id)
    assert.equal(queueItem?.status, 'cancelled')
    assert.match(queueItem?.error || '', /cancelled/i)
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('automation queue dispatch skips blocked head items before applying the start cap', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operational-queue-skip-blocked')

  try {
    resetAutomationStore(userDataDir)

    const blockedProject = '/Users/example/project-a'
    const runnableProject = '/Users/example/project-b'
    const blockedWriter = enqueueOperationalRun({
      runKind: 'agent',
      runId: 'active-writer-a',
      title: 'Active writer A',
      requestedAutonomy: 'supervised',
      globalMaxAutonomy: 'supervised',
      workspaceProfileId: 'project-workspace',
      projectId: blockedProject,
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    const releasedWriter = enqueueOperationalRun({
      runKind: 'agent',
      runId: 'active-writer-b',
      title: 'Active writer B',
      requestedAutonomy: 'supervised',
      globalMaxAutonomy: 'supervised',
      workspaceProfileId: 'project-workspace',
      projectId: runnableProject,
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    assert.equal(startOperationalQueueItem(blockedWriter.id)?.status, 'running')
    assert.equal(startOperationalQueueItem(releasedWriter.id)?.status, 'running')

    const blockedAutomation = createScopedExecutionAutomation('Blocked queued execution', blockedProject)
    const blockedRun = await runAutomationNow(blockedAutomation.id)
    assert.equal(blockedRun?.status, 'queued')

    const runnableAutomation = createScopedExecutionAutomation('Runnable queued execution', runnableProject)
    const runnableRun = await runAutomationNow(runnableAutomation.id)
    assert.equal(runnableRun?.status, 'queued')

    finishOperationalQueueItem(releasedWriter.id, 'completed')
    await dispatchRunnableAutomationQueueItems(() => {}, 1)

    assert.equal(getRun(blockedRun!.id)?.status, 'queued')
    assert.equal(getOperationalQueueItemForRun('automation', blockedRun!.id)?.status, 'queued')
    assert.equal(getRun(runnableRun!.id)?.status, 'failed')
    assert.match(getOperationalQueueItemForRun('automation', runnableRun!.id)?.error || '', /runtime not started/i)
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('automation service tick recovers interrupted operational queue items before dispatch', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operational-queue-service-recovery')

  try {
    resetAutomationStore(userDataDir)

    const item = enqueueOperationalRun({
      runKind: 'automation',
      runId: 'interrupted-automation-run',
      title: 'Interrupted automation run',
      requestedAutonomy: 'approve',
      workspaceProfileId: 'project-workspace',
      projectId: '/Users/example/project',
      writeCapable: true,
      caps: { maxParallel: 1 },
    })
    assert.equal(startOperationalQueueItem(item.id)?.status, 'running')
    getOperationalQueueDb().prepare(`
      update operational_queue_items
      set started_at = ?, updated_at = ?
      where id = ?
    `).run('2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z', item.id)

    await runAutomationServiceTick(new Date('2026-05-10T00:02:00.000Z'))

    const recovered = getOperationalQueueItemForRun('automation', 'interrupted-automation-run')
    assert.equal(recovered?.status, 'blocked')
    assert.match(recovered?.error || '', /restarted before this run reported a terminal state/i)
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('runAutomationNow links active SOP versions before starting execution', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('manual-sop-link')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Manual SOP execution',
      goal: 'Execute the reusable SOP through the automation action.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: '/Users/example/project',
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })
    const sourceRun = createAutomationRun(automation.id, 'execution', 'Source successful run')
    assert.ok(sourceRun)
    markRunStarted(sourceRun!.id, 'session-source')
    markRunCompleted(sourceRun!.id, 'Source run completed.')
    const sop = saveAutomationRunAsSop(sourceRun!.id)

    await assert.rejects(
      () => runAutomationNow(automation.id),
      /runtime not started/i,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))

    const startedRun = listAutomationState().runs.find((entry) => entry.id !== sourceRun!.id && entry.automationId === automation.id)
    assert.ok(startedRun)
    const detail = getSopRunDetail(startedRun!.id)
    assert.equal(detail?.version.id, sop.activeVersion?.id)
    assert.equal(detail?.link.triggerType, 'manual')
    assert.equal(detail?.inputs.source, 'automation_run_now')
    assert.equal(detail?.inputs['project-directory'], '/Users/example/project')
    const queueItem = getOperationalQueueItemForRun('sop', startedRun!.id)
    assert.equal(queueItem?.status, 'failed')
    assert.equal(queueItem?.runKind, 'sop')
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('approving an enrichment brief completes the parked approval run', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('approve-enrichment')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Manual approval',
      goal: 'Approve the brief and then allow execution.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'needs_approval',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: null,
    })

    const run = createAutomationRun(automation.id, 'enrichment', 'Prepare execution brief')
    assert.ok(run)
    markRunStarted(run.id, 'session-approval')
    markRunNeedsUser(run.id, 'Execution brief is ready for approval.')
    createInboxItem({
      automationId: automation.id,
      runId: run.id,
      sessionId: 'session-approval',
      type: 'approval',
      title: 'Approve brief',
      body: 'The execution brief is ready.',
    })

    const approved = approveAutomationBrief(automation.id)

    assert.equal(approved?.brief?.status, 'ready')
    assert.ok(approved?.brief?.approvedAt)
    assert.equal(getRun(run.id)?.status, 'completed')
    assert.equal(getActiveRunForAutomation(automation.id), null)
    assert.equal(listAutomationState().inbox.filter((item) => item.automationId === automation.id && item.status === 'open').length, 0)
    assert.ok(createAutomationRunWhenNoActive(automation.id, 'execution', 'Execute approved brief'))
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('automation question resolution resumes the active run before idle completion', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('question-resume')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Question resume',
      goal: 'Resume execution after a user clarification.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execution waiting for input')
    assert.ok(run)
    markRunStarted(run.id, 'session-question')
    upsertSessionRecord(toSessionRecord({
      id: 'session-question',
      title: run.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
      kind: 'automation',
      automationId: automation.id,
      runId: run.id,
    }))

    handleAutomationQuestionAsked({
      sessionId: 'session-question',
      questionId: 'question-1',
      header: 'Need a metric',
      question: 'Which KPI should this automation use?',
    })

    assert.equal(getRun(run.id)?.status, 'needs_user')
    assert.equal(getAutomationDetail(automation.id)?.status, 'needs_user')
    assert.equal(listAutomationState().inbox.filter((item) => item.automationId === automation.id).length, 1)

    await assert.rejects(
      () => runAutomationNow(automation.id),
      /already has an active execution run/i,
    )

    await handleAutomationSessionIdle('session-question')
    assert.equal(getRun(run.id)?.status, 'needs_user')

    handleAutomationQuestionResolved('question-1', { resume: true })

    assert.equal(getRun(run.id)?.status, 'running')
    assert.equal(getAutomationDetail(automation.id)?.status, 'running')
    assert.equal(listAutomationState().inbox.filter((item) => item.automationId === automation.id).length, 0)

    await handleAutomationSessionIdle('session-question')

    assert.equal(getRun(run.id)?.status, 'completed')
    assert.equal(getAutomationDetail(automation.id)?.status, 'completed')
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('scheduler skips stale due automations that already have an active run without creating failure noise', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('scheduler-active-skip')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Stale due automation',
      goal: 'Do not create failure noise when an active run already exists.',
      kind: 'recurring',
      schedule: {
        type: 'one_time',
        timezone: 'UTC',
        startAt: '2026-01-01T09:00:00.000Z',
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Already running')
    assert.ok(run)
    markRunStarted(run.id, 'session-stale-due')

    const db = new DatabaseSync(join(userDataDir, 'automation.sqlite'))
    db.prepare('update automations set status = ?, next_run_at = ? where id = ?')
      .run('ready', '2026-01-01T09:00:00.000Z', automation.id)
    db.close()

    await runAutomationServiceTick(new Date('2026-01-01T09:05:00.000Z'))

    const detail = getAutomationDetail(automation.id)
    assert.equal(detail?.status, 'ready')
    assert.equal(getRun(run.id)?.status, 'running')
    assert.equal(listAutomationState().inbox.filter((item) => item.automationId === automation.id && item.type === 'failure').length, 0)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('scheduler links due SOP-backed execution runs with schedule trigger', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('scheduler-sop-link')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Scheduled SOP execution',
      goal: 'Run a saved SOP from the scheduler.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: '/Users/example/project',
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })
    const sourceRun = createAutomationRun(automation.id, 'execution', 'Source successful run')
    assert.ok(sourceRun)
    markRunStarted(sourceRun!.id, 'session-source')
    markRunCompleted(sourceRun!.id, 'Source run completed.')
    const sop = saveAutomationRunAsSop(sourceRun!.id)

    const db = new DatabaseSync(join(userDataDir, 'automation.sqlite'))
    db.prepare('update automations set status = ?, next_run_at = ? where id = ?')
      .run('ready', '2026-01-01T09:00:00.000Z', automation.id)
    db.close()

    await runAutomationServiceTick(new Date('2026-01-01T09:05:00.000Z'))
    await new Promise((resolve) => setTimeout(resolve, 250))

    const startedRun = listAutomationState().runs.find((entry) => entry.id !== sourceRun!.id && entry.automationId === automation.id)
    assert.ok(startedRun)
    const detail = getSopRunDetail(startedRun!.id)
    assert.equal(detail?.version.id, sop.activeVersion?.id)
    assert.equal(detail?.link.triggerType, 'schedule')
    assert.equal(detail?.inputs.source, 'automation_schedule')
    assert.equal(detail?.inputs.scheduledFor, '2026-01-01T09:00:00.000Z')
    assert.equal(detail?.inputs['project-directory'], '/Users/example/project')
  } finally {
    closeLogger()
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('runAutomationNow rejects when the daily work-run attempt cap is exhausted', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('daily-run-cap')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Daily run cap',
      goal: 'Stop work once the daily cap is reached.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 1,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(run)
    markRunCompleted(run.id, 'Done.')

    await assert.rejects(
      () => runAutomationNow(automation.id),
      /daily work-run attempt cap reached/i,
    )
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('archived automations reject preview and run-now actions', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('archived')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Archived automation',
      goal: 'Do not allow archived work to restart.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })
    updateAutomationStatus(automation.id, 'archived')

    await assert.rejects(
      () => previewAutomationBrief(automation.id),
      /archived automations cannot be started/i,
    )
    await assert.rejects(
      () => runAutomationNow(automation.id),
      /archived automations cannot be started/i,
    )
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('manual retry supersedes existing scheduled retries for the whole chain and opens the circuit on the third failed work run', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('manual-retry-chain')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Manual retry chain',
      goal: 'Retry without leaving stale scheduled retries behind.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const first = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(first)
    const firstFailed = markRunFailed(first.id, 'First failure.')
    assert.ok(firstFailed?.nextRetryAt)

    const second = createAutomationRun(automation.id, 'execution', 'Attempt 2', {
      attempt: 2,
      retryOfRunId: first.id,
    })
    assert.ok(second)
    const secondFailed = markRunFailed(second.id, 'Second failure.')
    assert.ok(secondFailed?.nextRetryAt)

    await assert.rejects(
      () => retryAutomationRun(first.id),
      /runtime not started/i,
    )

    assert.equal(getRun(first.id)?.nextRetryAt, null)
    assert.equal(getRun(second.id)?.nextRetryAt, null)

    const chainRuns = listAutomationState().runs
      .filter((entry) => entry.automationId === automation.id)
      .sort((left, right) => right.attempt - left.attempt)
    assert.equal(chainRuns[0]?.attempt, 3)
    assert.equal(chainRuns[0]?.retryOfRunId, first.id)
    assert.equal(chainRuns[0]?.nextRetryAt, null)
    assert.equal(getAutomationDetail(automation.id)?.status, 'paused')
    assert.equal(listDueRetryRuns(new Date('2100-01-01T00:00:00.000Z')).filter((entry) => entry.automationId === automation.id).length, 0)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('manual retry from an older failed ancestor keeps attempt numbering monotonic', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('manual-retry-attempts')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Monotonic retry attempts',
      goal: 'Keep manual retries monotonic even from old failed runs.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 4,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const first = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(first)
    markRunFailed(first.id, 'First failure.')

    const second = createAutomationRun(automation.id, 'execution', 'Attempt 2', {
      attempt: 2,
      retryOfRunId: first.id,
    })
    assert.ok(second)
    markRunFailed(second.id, 'Second failure.')

    await assert.rejects(
      () => retryAutomationRun(first.id),
      /runtime not started/i,
    )

    const latestAttempt = listAutomationState().runs
      .filter((entry) => entry.automationId === automation.id)
      .reduce((max, entry) => Math.max(max, entry.attempt), 0)
    assert.equal(latestAttempt, 3)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('manual retry blocked by the daily run cap keeps the scheduled retry armed', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('manual-retry-budget-guard')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Budgeted manual retry',
      goal: 'Do not drop scheduled recovery when a manual retry is blocked by the run cap.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 1,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const failedRun = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(failedRun)
    const markedFailed = markRunFailed(failedRun.id, 'Temporary failure.')
    assert.ok(markedFailed?.nextRetryAt)

    await assert.rejects(
      () => retryAutomationRun(failedRun.id),
      /daily work-run attempt cap reached/i,
    )

    assert.ok(getRun(failedRun.id)?.nextRetryAt)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('deterministic automation session failures pause the automation and do not leave retries armed', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('deterministic-pause')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Deterministic failure guard',
      goal: 'Pause when a deterministic automation failure happens.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute deterministic failure guard')
    assert.ok(run)
    markRunStarted(run.id, 'session-deterministic')
    upsertSessionRecord(toSessionRecord({
      id: 'session-deterministic',
      title: run.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
      kind: 'automation',
      automationId: automation.id,
      runId: run.id,
    }))

    handleAutomationSessionError('session-deterministic', 'Automation enrichment did not return a parseable execution brief.')

    const detail = getAutomationDetail(automation.id)
    assert.equal(detail?.status, 'paused')
    assert.equal(getRun(run.id)?.nextRetryAt, null)
    assert.equal(listDueRetryRuns(new Date('2100-01-01T00:00:00.000Z')).filter((entry) => entry.automationId === automation.id).length, 0)
    assert.equal(listAutomationState().inbox.filter((entry) => entry.automationId === automation.id && entry.type === 'failure').length, 1)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('runAutomationServiceTick fails active runs that exceed the max run duration', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('run-timeout')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Run timeout guard',
      goal: 'Fail long-running work runs once they exceed the configured cap.',
      kind: 'recurring',
      schedule: {
        type: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 1,
        runAtHour: 9,
        runAtMinute: 0,
      },
      heartbeatMinutes: 15,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMinutes: 5,
        maxDelayMinutes: 60,
      },
      runPolicy: {
        dailyRunCap: 6,
        maxRunDurationMinutes: 1,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    saveAutomationBrief(automation.id, {
      version: 1,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Long-running execution')
    assert.ok(run)
    markRunStarted(run.id, null)

    await runAutomationServiceTick(new Date(Date.now() + 2 * 60_000))

    const failedRun = getRun(run.id)
    assert.equal(failedRun?.status, 'failed')
    assert.equal(failedRun?.failureCode, 'run_timeout')
    assert.match(failedRun?.error || '', /timed out after exceeding the 1-minute run cap/i)
    assert.ok(failedRun?.nextRetryAt)
  } finally {
    clearSessionRegistryCache()
    clearAutomationStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
