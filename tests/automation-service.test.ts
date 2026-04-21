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
  getAutomationDetail,
  getRun,
  listDueRetryRuns,
  listAutomationState,
  markRunCompleted,
  markRunFailed,
  markRunStarted,
  saveAutomationBrief,
  updateAutomationStatus,
} from '../apps/desktop/src/main/automation-store.ts'
import {
  handleAutomationQuestionAsked,
  handleAutomationQuestionResolved,
  handleAutomationSessionIdle,
  handleAutomationSessionError,
  previewAutomationBrief,
  retryAutomationRun,
  runAutomationServiceTick,
  runAutomationNow,
} from '../apps/desktop/src/main/automation-service.ts'
import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-automation-service-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
  clearSessionRegistryCache()
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
    clearSessionRegistryCache()
    clearAutomationStoreCache()
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
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
