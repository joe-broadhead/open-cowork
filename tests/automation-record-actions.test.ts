import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationDraft } from '../packages/shared/src/index.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearAutomationStoreCache,
  getAutomationDetail,
} from '../apps/desktop/src/main/automation-store.ts'
import {
  archiveAutomationRecordWithContext,
  createAutomationRecordWithContext,
  pauseAutomationRecordWithContext,
  resumeAutomationRecordWithContext,
  updateAutomationRecordWithContext,
} from '../apps/desktop/src/main/automation-record-actions.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-automation-record-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetAutomationStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearAutomationStoreCache()
}

function makeDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: 'Weekly data review',
    goal: 'Review product analytics every Monday.',
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
    preferredAgentNames: ['data-analyst'],
    ...overrides,
  }
}

test('automation record action wrappers persist updates and publish after every mutation', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('actions')
  let publishCount = 0
  const publishAutomationUpdated = () => {
    publishCount += 1
  }

  try {
    resetAutomationStore(userDataDir)

    const created = createAutomationRecordWithContext(makeDraft(), publishAutomationUpdated)
    assert.equal(created.title, 'Weekly data review')
    assert.equal(created.status, 'draft')

    const updated = updateAutomationRecordWithContext(
      created.id,
      { title: 'Monday data review', preferredAgentNames: ['data-analyst', 'chart-creator'] },
      publishAutomationUpdated,
    )
    assert.equal(updated?.title, 'Monday data review')
    assert.deepEqual(updated?.preferredAgentNames, ['data-analyst', 'chart-creator'])

    const paused = pauseAutomationRecordWithContext(created.id, publishAutomationUpdated)
    assert.equal(paused?.status, 'paused')

    const resumed = resumeAutomationRecordWithContext(created.id, publishAutomationUpdated)
    assert.equal(resumed?.status, 'draft')

    const archived = archiveAutomationRecordWithContext(created.id, publishAutomationUpdated)
    assert.equal(archived?.status, 'archived')

    const detail = getAutomationDetail(created.id)
    assert.equal(detail?.title, 'Monday data review')
    assert.equal(detail?.status, 'archived')
    assert.deepEqual(detail?.preferredAgentNames, ['data-analyst', 'chart-creator'])
    assert.equal(publishCount, 5)
  } finally {
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
