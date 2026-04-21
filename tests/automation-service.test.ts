import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearAutomationStoreCache,
  createAutomation,
  createAutomationRun,
  getRun,
  listDueRetryRuns,
  listAutomationState,
  markRunFailed,
  markRunStarted,
  saveAutomationBrief,
  updateAutomationStatus,
} from '../apps/desktop/src/main/automation-store.ts'
import {
  previewAutomationBrief,
  retryAutomationRun,
  runAutomationNow,
} from '../apps/desktop/src/main/automation-service.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-automation-service-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
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
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
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
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
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
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('manual retry supersedes existing scheduled retries for the whole chain', async () => {
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
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
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
    assert.ok(chainRuns[0]?.nextRetryAt)
    assert.equal(listDueRetryRuns(new Date('2100-01-01T00:00:00.000Z')).filter((entry) => entry.automationId === automation.id).length, 1)
  } finally {
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
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
      projectDirectory: null,
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
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
