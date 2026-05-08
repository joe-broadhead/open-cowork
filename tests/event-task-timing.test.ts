import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRunMeta } from '../apps/desktop/src/main/event-task-state.ts'
import {
  applyTaskTimingTransition,
  isTerminalTaskStatus,
  normalizeTaskTiming,
} from '../apps/desktop/src/main/event-task-timing.ts'

const taskRun = (overrides: Partial<TaskRunMeta> = {}): TaskRunMeta => ({
  id: 'task-1',
  rootSessionId: 'root-session',
  parentSessionId: 'root-session',
  title: 'Research',
  agent: 'research',
  childSessionId: null,
  status: 'queued',
  ...overrides,
})

test('isTerminalTaskStatus recognizes complete and error states only', () => {
  assert.equal(isTerminalTaskStatus('queued'), false)
  assert.equal(isTerminalTaskStatus('running'), false)
  assert.equal(isTerminalTaskStatus('complete'), true)
  assert.equal(isTerminalTaskStatus('error'), true)
})

test('normalizeTaskTiming anchors live tasks and only finishes terminal tasks', () => {
  const running = normalizeTaskTiming(taskRun({ status: 'running' }), () => '2026-05-08T00:00:00.000Z')
  assert.equal(running.startedAt, '2026-05-08T00:00:00.000Z')
  assert.equal(running.finishedAt, null)

  const terminalTimes = ['2026-05-08T00:00:01.000Z', '2026-05-08T00:00:02.000Z']
  let index = 0
  const complete = normalizeTaskTiming(taskRun({ status: 'complete' }), () => terminalTimes[index++] || 'fallback')
  assert.equal(complete.startedAt, '2026-05-08T00:00:01.000Z')
  assert.equal(complete.finishedAt, '2026-05-08T00:00:02.000Z')
})

test('normalizeTaskTiming preserves caller-supplied anchors', () => {
  const normalized = normalizeTaskTiming(taskRun({
    status: 'complete',
    startedAt: '2026-05-08T00:00:00.000Z',
    finishedAt: '2026-05-08T00:00:05.000Z',
  }), () => 'unused')

  assert.equal(normalized.startedAt, '2026-05-08T00:00:00.000Z')
  assert.equal(normalized.finishedAt, '2026-05-08T00:00:05.000Z')
})

test('applyTaskTimingTransition preserves start time and clamps terminal finish time', () => {
  const existing = taskRun({
    status: 'running',
    startedAt: '2026-05-08T00:00:00.000Z',
    finishedAt: null,
  })

  const complete = applyTaskTimingTransition(
    existing,
    { status: 'complete' },
    () => '2026-05-08T00:00:07.000Z',
  )

  assert.equal(complete.startedAt, '2026-05-08T00:00:00.000Z')
  assert.equal(complete.finishedAt, '2026-05-08T00:00:07.000Z')
})

test('applyTaskTimingTransition clears stale finish time when a task returns to running', () => {
  const existing = taskRun({
    status: 'complete',
    startedAt: '2026-05-08T00:00:00.000Z',
    finishedAt: '2026-05-08T00:00:07.000Z',
  })

  const running = applyTaskTimingTransition(existing, { status: 'running' }, () => 'unused')

  assert.equal(running.startedAt, '2026-05-08T00:00:00.000Z')
  assert.equal(running.finishedAt, null)
})
