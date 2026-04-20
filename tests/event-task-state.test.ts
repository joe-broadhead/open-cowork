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
  removeSessionState,
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

test('does not infer session aliases from fuzzy runtime id suffixes', () => {
  trackParentSession('vjQwiuqO')

  assert.equal(resolveRootSession('ses_269cf6395ffe5tHYfbvjQwiuqO'), 'ses_269cf6395ffe5tHYfbvjQwiuqO')

  rememberSubmittedPrompt('vjQwiuqO', 'Hello how are you')
  assert.equal(
    consumePendingPromptEcho('ses_269cf6395ffe5tHYfbvjQwiuqO', 'Hello how are you'),
    'Hello how are you',
  )
})

test('binds queued task runs to child sessions and preserves updates', () => {
  trackParentSession('root-session')
  const taskRun = registerTaskRun({
    id: 'task-1',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Research topic',
    agent: 'research',
    childSessionId: null,
    status: 'queued',
  })

  const bound = queueOrBindChildSession('root-session', 'child-session')
  assert.equal(bound?.id, 'task-1')
  assert.equal(bound?.childSessionId, 'child-session')
  assert.equal(bound?.parentSessionId, 'root-session')

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

test('binds concurrent nested task runs by immediate parent session instead of root FIFO', () => {
  trackParentSession('root-session')
  registerSession('child-a', 'root-session')
  registerSession('child-b', 'root-session')

  registerTaskRun({
    id: 'task-a1',
    rootSessionId: 'root-session',
    parentSessionId: 'child-a',
    title: 'Nested task A',
    agent: 'analyst',
    childSessionId: null,
    status: 'queued',
  })
  registerTaskRun({
    id: 'task-b1',
    rootSessionId: 'root-session',
    parentSessionId: 'child-b',
    title: 'Nested task B',
    agent: 'research',
    childSessionId: null,
    status: 'queued',
  })

  registerSession('grandchild-b', 'child-b')
  registerSession('grandchild-a', 'child-a')

  const boundB = queueOrBindChildSession('child-b', 'grandchild-b')
  const boundA = queueOrBindChildSession('child-a', 'grandchild-a')

  assert.equal(boundB?.id, 'task-b1')
  assert.equal(boundB?.childSessionId, 'grandchild-b')
  assert.equal(boundA?.id, 'task-a1')
  assert.equal(boundA?.childSessionId, 'grandchild-a')
})

test('removeSessionState drops descendant task runs for deleted nested session trees', () => {
  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerSession('grandchild-session', 'child-session')

  ensureTaskRunForChild('root-session', 'child-session', 'research')
  ensureTaskRunForChild('root-session', 'grandchild-session', 'writer')

  removeSessionState('child-session', 'root-session')

  assert.equal(getTaskRun('child:child-session'), null)
  assert.equal(getTaskRun('child:grandchild-session'), null)
})

test('consumes pending prompt echo incrementally', () => {
  rememberSubmittedPrompt('session-1', 'awesome')

  assert.equal(consumePendingPromptEcho('session-1', 'awe'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'some'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'Perfect!'), 'Perfect!')
})
