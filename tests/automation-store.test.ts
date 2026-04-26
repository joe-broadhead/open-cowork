import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearAutomationStoreCache,
  countAutomationWorkRunAttemptsForDay,
  createAutomation,
  createDeliveryRecord,
  createAutomationRun,
  createInboxItem,
  getAutomationDetail,
  getRun,
  listDueHeartbeats,
  listDueRetryRuns,
  listAutomationState,
  markHeartbeatCompleted,
  markRunCancelled,
  markRunCompleted,
  markRunFailed,
  markRunStarted,
  resumeAutomationStatus,
  saveAutomationBrief,
  updateAutomation,
  updateAutomationStatus,
} from '../apps/desktop/src/main/automation-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-automation-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
}

test('automation store persists automations, briefs, inbox items, and runs together', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('store')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Weekly market report',
      goal: 'Prepare a Monday report for the revenue team.',
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
          title: 'Research the market',
          description: 'Collect competitor and trend changes.',
          ownerAgent: 'research',
          dependsOn: [],
        },
      ],
      approvalBoundary: 'Approve before sending anything externally.',
      generatedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute weekly report')
    assert.ok(run)
    markRunCompleted(run!.id, 'Report prepared and ready for review.')
    const heartbeatRun = createAutomationRun(automation.id, 'heartbeat', 'Heartbeat weekly report')
    assert.ok(heartbeatRun)
    markHeartbeatCompleted(heartbeatRun!.id, 'No action needed.')

    const inbox = createInboxItem({
      automationId: automation.id,
      runId: run!.id,
      type: 'info',
      title: 'Review ready',
      body: 'The weekly report is ready for review.',
    })
    const delivery = createDeliveryRecord({
      automationId: automation.id,
      runId: run!.id,
      provider: 'in_app',
      target: 'automation-inbox',
      status: 'delivered',
      title: 'Weekly report delivered',
      body: 'The weekly report is ready for review.',
    })

    assert.ok(inbox)
    assert.ok(delivery)

    const detail = getAutomationDetail(automation.id)
    assert.equal(detail?.brief?.status, 'ready')
    assert.equal(detail?.status, 'completed')
    assert.equal(detail?.latestRunStatus, 'completed')
    assert.equal(detail?.deliveries.length, 1)
    assert.deepEqual(detail?.preferredAgentNames, ['research', 'charts'])
    assert.deepEqual(detail?.runPolicy, {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    })
    assert.ok(detail?.nextHeartbeatAt)
    assert.equal(listDueHeartbeats(new Date('2100-01-01T00:00:00.000Z')).length, 1)

    const payload = listAutomationState()
    assert.equal(payload.automations.length, 1)
    assert.equal(payload.workItems[0]?.ownerAgent, 'research')
    assert.deepEqual(
      payload.runs.map((entry) => entry.kind).sort(),
      ['execution', 'heartbeat'],
    )
    assert.equal(payload.inbox[0]?.title, 'Review ready')
    assert.equal(payload.deliveries[0]?.title, 'Weekly report delivered')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('work-run counts are tracked per automation day and exclude heartbeats', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('run-counts')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Daily cap counting',
      goal: 'Count only non-heartbeat work runs toward the daily cap.',
      kind: 'managed-project',
      schedule: {
        type: 'daily',
        timezone: 'UTC',
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
        dailyRunCap: 2,
        maxRunDurationMinutes: 120,
      },
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
      preferredAgentNames: [],
    })

    assert.ok(createAutomationRun(automation.id, 'enrichment', 'Enrich'))
    assert.ok(createAutomationRun(automation.id, 'execution', 'Execute'))
    assert.ok(createAutomationRun(automation.id, 'heartbeat', 'Heartbeat'))

    assert.equal(countAutomationWorkRunAttemptsForDay(automation.id, 'UTC', new Date()), 2)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('cancelled execution runs return the automation to ready state', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('cancel')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Retryable report',
      goal: 'Prepare a retryable report.',
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
      workItems: [
        {
          id: 'collect',
          title: 'Collect data',
          description: 'Gather inputs',
          ownerAgent: 'research',
          dependsOn: [],
        },
      ],
      approvalBoundary: 'Approve before external delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute retryable report')
    assert.ok(run)
    markRunStarted(run!.id, 'session-1')
    const cancelled = markRunCancelled(run!.id, 'Cancelled for retry.')
    assert.equal(cancelled?.status, 'cancelled')

    const detail = getAutomationDetail(automation.id)
    assert.equal(detail?.status, 'ready')
    assert.equal(detail?.latestRunStatus, 'cancelled')

    const payload = listAutomationState()
    assert.equal(payload.workItems[0]?.status, 'ready')
    assert.equal(payload.runs[0]?.status, 'cancelled')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('running automations are excluded from due heartbeats', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('heartbeat-running')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Long-running report',
      goal: 'Keep a long-running automation active.',
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

    const run = createAutomationRun(automation.id, 'execution', 'Execute long-running report')
    assert.ok(run)
    markRunStarted(run!.id, 'session-running')

    assert.equal(listDueHeartbeats(new Date('2100-01-01T00:00:00.000Z')).length, 0)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('automations with a scheduled retry are excluded from due heartbeats', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('heartbeat-retry')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Retrying report',
      goal: 'Avoid heartbeat churn while a retry is pending.',
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
        maxRetries: 2,
        baseDelayMinutes: 5,
        maxDelayMinutes: 15,
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

    const run = createAutomationRun(automation.id, 'execution', 'Execute retrying report')
    assert.ok(run)
    markRunFailed(run.id, 'Temporary failure.')

    assert.equal(listDueHeartbeats(new Date('2100-01-01T00:00:00.000Z')).length, 0)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('resuming a paused automation restores its previous ready status', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('resume')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Paused report',
      goal: 'Resume without re-enrichment.',
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

    updateAutomationStatus(automation.id, 'paused')
    const resumed = resumeAutomationStatus(automation.id)

    assert.equal(resumed?.status, 'ready')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('non-schedule automation edits preserve the next scheduled run time', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('update-next-run')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Stable schedule',
      goal: 'Do not shift the schedule on copy edits.',
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

    const updated = updateAutomation(automation.id, {
      title: 'Stable schedule v2',
      goal: 'Updated wording only.',
    })

    assert.equal(updated?.nextRunAt, automation.nextRunAt)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('resuming with only info inbox items restores ready instead of needs_user', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('resume-info-only')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Info-only resume',
      goal: 'Resume past informational notices.',
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
    createInboxItem({
      automationId: automation.id,
      type: 'info',
      title: 'Output ready',
      body: 'A previous run completed successfully.',
      promoteAutomationStatus: false,
    })

    updateAutomationStatus(automation.id, 'paused')
    const resumed = resumeAutomationStatus(automation.id)

    assert.equal(resumed?.status, 'ready')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('saving a refreshed brief preserves completed work items instead of resetting the backlog', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('brief-merge')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Backlog merge',
      goal: 'Keep durable work item history.',
      kind: 'managed-project',
      schedule: {
        type: 'daily',
        timezone: 'UTC',
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
      deliverables: ['Plan'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [
        {
          id: 'research-market',
          title: 'Research market',
          description: 'Collect external context.',
          ownerAgent: 'research',
          dependsOn: [],
        },
        {
          id: 'build-report',
          title: 'Build report',
          description: 'Assemble output.',
          ownerAgent: 'build',
          dependsOn: ['research-market'],
        },
      ],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute plan')
    assert.ok(run)
    markRunStarted(run!.id, 'session-merge')
    markRunCompleted(run!.id, 'Done.')

    saveAutomationBrief(automation.id, {
      version: 2,
      status: 'ready',
      goal: automation.goal,
      deliverables: ['Plan'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [
        {
          id: 'research-market',
          title: 'Research market',
          description: 'Collect refreshed context.',
          ownerAgent: 'research',
          dependsOn: [],
        },
      ],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const payload = listAutomationState()
    const items = payload.workItems.filter((item) => item.automationId === automation.id)
    const preserved = items.find((item) => item.id === 'build-report')
    const refreshed = items.find((item) => item.id === 'research-market')

    assert.equal(preserved?.status, 'completed')
    assert.equal(refreshed?.description, 'Collect refreshed context.')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('failed execution runs schedule bounded retries and return work items to ready', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('retry-schedule')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Retry policy',
      goal: 'Retry failed execution work with backoff.',
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
        maxRetries: 2,
        baseDelayMinutes: 5,
        maxDelayMinutes: 15,
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
      deliverables: ['Retryable report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Ready'],
      recommendedAgents: ['research'],
      workItems: [
        {
          id: 'collect',
          title: 'Collect data',
          description: 'Gather inputs',
          ownerAgent: 'research',
          dependsOn: [],
        },
      ],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    })

    const run = createAutomationRun(automation.id, 'execution', 'Execute retry policy')
    assert.ok(run)
    markRunStarted(run.id, 'session-retry')
    const failed = markRunFailed(run.id, 'Temporary upstream failure.', undefined, { failureCode: 'provider_capacity' })
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.failureCode, 'provider_capacity')
    assert.equal(failed?.attempt, 1)
    assert.ok(failed?.nextRetryAt)

    const dueRetriesNow = listDueRetryRuns(new Date(failed!.nextRetryAt!))
    assert.equal(dueRetriesNow[0]?.id, run.id)
    assert.equal(getRun(run.id)?.nextRetryAt, failed?.nextRetryAt)

    const payload = listAutomationState()
    assert.equal(payload.workItems.find((item) => item.automationId === automation.id)?.status, 'ready')
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('retry backoff grows exponentially and stops after the configured max retries', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('retry-backoff')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Exponential retry policy',
      goal: 'Cap retry growth and stop after max retries.',
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
        maxRetries: 2,
        baseDelayMinutes: 5,
        maxDelayMinutes: 15,
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

    const first = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(first)
    const firstFailed = markRunFailed(first.id, 'First failure.')
    assert.ok(firstFailed?.nextRetryAt)
    const firstDelayMs = new Date(firstFailed!.nextRetryAt!).getTime() - new Date(firstFailed!.finishedAt!).getTime()
    assert.equal(firstDelayMs, 5 * 60_000)

    const second = createAutomationRun(automation.id, 'execution', 'Attempt 2', {
      attempt: 2,
      retryOfRunId: first.id,
    })
    assert.ok(second)
    const secondFailed = markRunFailed(second.id, 'Second failure.')
    assert.ok(secondFailed?.nextRetryAt)
    const secondDelayMs = new Date(secondFailed!.nextRetryAt!).getTime() - new Date(secondFailed!.finishedAt!).getTime()
    assert.equal(secondDelayMs, 10 * 60_000)

    const third = createAutomationRun(automation.id, 'execution', 'Attempt 3', {
      attempt: 3,
      retryOfRunId: first.id,
    })
    assert.ok(third)
    const thirdFailed = markRunFailed(third.id, 'Third failure.')
    assert.equal(thirdFailed?.nextRetryAt, null)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('successful retry completion clears stale pending retries from the whole chain', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('retry-clear-on-complete')

  try {
    resetAutomationStore(userDataDir)

    const automation = createAutomation({
      title: 'Retry chain completion',
      goal: 'Do not leave stale retry timers after success.',
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

    const first = createAutomationRun(automation.id, 'execution', 'Attempt 1')
    assert.ok(first)
    const firstFailed = markRunFailed(first.id, 'First failure.')
    assert.ok(firstFailed?.nextRetryAt)

    const second = createAutomationRun(automation.id, 'execution', 'Attempt 2', {
      attempt: 2,
      retryOfRunId: first.id,
    })
    assert.ok(second)
    const completed = markRunCompleted(second.id, 'Recovered successfully.')
    assert.equal(completed?.status, 'completed')
    assert.equal(getRun(first.id)?.nextRetryAt, null)
    assert.equal(listDueRetryRuns(new Date('2100-01-01T00:00:00.000Z')).filter((entry) => entry.automationId === automation.id).length, 0)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
