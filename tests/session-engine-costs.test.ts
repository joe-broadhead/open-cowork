import { createEmptySessionViewState, createEmptyTaskRun } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyCostEventToSessionState } from '../apps/desktop/src/main/session-engine-costs.ts'

test('applyCostEventToSessionState updates root session cost and measured context', () => {
  const current = createEmptySessionViewState({
    sessionCost: 0.25,
    lastInputTokens: 12,
    contextState: 'idle',
  })
  const next = applyCostEventToSessionState(current, {
    type: 'cost',
    cost: 0.75,
    tokens: {
      input: 100,
      output: 40,
      reasoning: 10,
      cache: { read: 5, write: 2 },
    },
  })

  assert.equal(next.sessionCost, 1)
  assert.equal(next.lastInputTokens, 100)
  assert.equal(next.contextState, 'measured')
  assert.deepEqual(next.sessionTokens, {
    input: 100,
    output: 40,
    reasoning: 10,
    cacheRead: 5,
    cacheWrite: 2,
  })
  assert.deepEqual(current.sessionTokens, {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test('applyCostEventToSessionState adds task-run cost without changing root input context', () => {
  const taskRun = createEmptyTaskRun({
    id: 'task-1',
    title: 'Research',
    agent: 'explore',
    status: 'running',
    sessionCost: 0.1,
  })
  const current = createEmptySessionViewState({
    taskRuns: [taskRun],
    sessionCost: 0.1,
    lastInputTokens: 8,
    contextState: 'idle',
  })
  const next = applyCostEventToSessionState(current, {
    type: 'cost',
    taskRunId: 'task-1',
    cost: 0.4,
    tokens: {
      input: 12,
      output: 6,
      reasoning: 3,
      cache: { read: 2, write: 1 },
    },
  })

  assert.equal(next.sessionCost, 0.5)
  assert.equal(next.lastInputTokens, 8)
  assert.equal(next.contextState, 'idle')
  assert.deepEqual(next.sessionTokens, {
    input: 12,
    output: 6,
    reasoning: 3,
    cacheRead: 2,
    cacheWrite: 1,
  })
  assert.equal(next.taskRuns[0]?.sessionCost, 0.5)
  assert.deepEqual(next.taskRuns[0]?.sessionTokens, {
    input: 12,
    output: 6,
    reasoning: 3,
    cacheRead: 2,
    cacheWrite: 1,
  })
})
