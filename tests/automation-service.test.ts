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
  markRunStarted,
  saveAutomationBrief,
  updateAutomationStatus,
} from '../apps/desktop/src/main/automation-store.ts'
import {
  previewAutomationBrief,
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
