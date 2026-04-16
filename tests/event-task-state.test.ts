import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumePendingPromptEcho,
  ensureTaskRunForChild,
  getTaskRun,
  isTrackedParentSession,
  queueOrBindChildSession,
  registerSession,
  registerTaskRun,
  rememberSubmittedPrompt,
  resetEventTaskState,
  resolveRootSession,
  trackParentSession,
  untrackParentSession,
  updateTaskRun,
} from '../apps/desktop/src/main/event-task-state.ts'

test.afterEach(() => {
  resetEventTaskState()
})

test('tracks parent sessions and resolves child lineage to the root', () => {
  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerSession('grandchild-session', 'child-session')

  assert.equal(isTrackedParentSession('root-session'), true)
  assert.equal(resolveRootSession('grandchild-session'), 'root-session')

  untrackParentSession('root-session')
  assert.equal(isTrackedParentSession('root-session'), false)
})

test('binds queued task runs to child sessions and preserves updates', () => {
  trackParentSession('root-session')
  const taskRun = registerTaskRun({
    id: 'task-1',
    rootSessionId: 'root-session',
    title: 'Research topic',
    agent: 'research',
    childSessionId: null,
    status: 'queued',
  })

  const bound = queueOrBindChildSession('root-session', 'child-session')
  assert.equal(bound?.id, 'task-1')
  assert.equal(bound?.childSessionId, 'child-session')

  const updated = updateTaskRun('task-1', { status: 'running' })
  assert.equal(updated?.status, 'running')
  assert.equal(getTaskRun('task-1')?.childSessionId, 'child-session')
  assert.equal(taskRun.id, 'task-1')
})

test('creates fallback task runs for unseen child sessions', () => {
  const taskRun = ensureTaskRunForChild('root-session', 'child-session', 'explore')

  assert.equal(taskRun?.id, 'child:child-session')
  assert.equal(taskRun?.agent, 'explore')
  assert.equal(getTaskRun('child:child-session')?.childSessionId, 'child-session')
})

test('consumes pending prompt echo incrementally', () => {
  rememberSubmittedPrompt('session-1', 'awesome')

  assert.equal(consumePendingPromptEcho('session-1', 'awe'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'some'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'Perfect!'), 'Perfect!')
})
