import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumePendingPromptEcho,
  ensureTaskRunForChild,
  findFallbackTaskRun,
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
import { SessionTaskStateStore } from '../apps/desktop/src/main/session-task-state-store.ts'

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

test('rejects lineage updates that would create parent-child cycles', () => {
  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerSession('root-session', 'child-session')

  assert.equal(resolveRootSession('child-session'), 'root-session')
  assert.equal(resolveRootSession('root-session'), 'root-session')
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

test('fallback task run lookup refuses ambiguous child candidates', () => {
  ensureTaskRunForChild('root-session', 'child-a', 'analyst')
  ensureTaskRunForChild('root-session', 'child-b', 'charts')

  assert.equal(findFallbackTaskRun('root-session', 'root-session'), null)
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

test('binds same-parent sibling child sessions by event order instead of task metadata', () => {
  trackParentSession('root-session')

  registerTaskRun({
    id: 'task-a',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Prepare forecast',
    agent: 'analyst',
    childSessionId: null,
    status: 'queued',
  })
  registerTaskRun({
    id: 'task-b',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Build chart pack',
    agent: 'charts',
    childSessionId: null,
    status: 'queued',
  })

  const boundB = queueOrBindChildSession('root-session', 'child-b')
  const boundA = queueOrBindChildSession('root-session', 'child-a')

  assert.equal(boundB?.id, 'task-a')
  assert.equal(boundA?.id, 'task-b')
  assert.equal(getTaskRun('task-a')?.childSessionId, 'child-b')
  assert.equal(getTaskRun('task-b')?.childSessionId, 'child-a')
})

test('does not reorder same-parent sibling sessions from partial task titles', () => {
  trackParentSession('root-session')

  registerTaskRun({
    id: 'task-a',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Prepare European forecast',
    agent: null,
    childSessionId: null,
    status: 'queued',
  })
  registerTaskRun({
    id: 'task-b',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Build chart pack',
    agent: null,
    childSessionId: null,
    status: 'queued',
  })

  const bound = queueOrBindChildSession('root-session', 'child-partial')

  assert.equal(bound?.id, 'task-a')
  assert.equal(getTaskRun('task-a')?.childSessionId, 'child-partial')
  assert.equal(getTaskRun('task-b')?.childSessionId, null)
})

test('registerTaskRun drains queued same-parent child sessions by event order', () => {
  trackParentSession('root-session')

  queueOrBindChildSession('root-session', 'child-b')
  queueOrBindChildSession('root-session', 'child-a')

  const taskA = registerTaskRun({
    id: 'task-a',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Prepare forecast',
    agent: 'analyst',
    childSessionId: null,
    status: 'queued',
  })
  const taskB = registerTaskRun({
    id: 'task-b',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Build chart pack',
    agent: 'charts',
    childSessionId: null,
    status: 'queued',
  })

  assert.equal(taskA.childSessionId, 'child-b')
  assert.equal(taskB.childSessionId, 'child-a')
})

test('repeated child session events do not consume the next pending sibling task', () => {
  trackParentSession('root-session')

  registerTaskRun({
    id: 'task-a',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Prepare forecast',
    agent: 'analyst',
    childSessionId: null,
    status: 'queued',
  })
  registerTaskRun({
    id: 'task-b',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Build chart pack',
    agent: 'charts',
    childSessionId: null,
    status: 'queued',
  })

  const first = queueOrBindChildSession('root-session', 'child-a')
  const repeated = queueOrBindChildSession('root-session', 'child-a')
  const second = queueOrBindChildSession('root-session', 'child-b')

  assert.equal(first?.id, 'task-a')
  assert.equal(repeated?.id, 'task-a')
  assert.equal(second?.id, 'task-b')
  assert.equal(getTaskRun('task-a')?.childSessionId, 'child-a')
  assert.equal(getTaskRun('task-b')?.childSessionId, 'child-b')
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

test('SessionTaskStateStore keeps hierarchy indexes isolated per instance', () => {
  const first = new SessionTaskStateStore()
  const second = new SessionTaskStateStore()

  first.trackParentSession('root-session')
  first.registerSession('child-session', 'root-session')
  first.ensureTaskRunForChild('root-session', 'child-session', 'research')
  first.rememberSubmittedPrompt('child-session', 'pending echo')

  assert.equal(first.resolveRootSession('child-session'), 'root-session')
  assert.equal(first.getTaskRun('child:child-session')?.childSessionId, 'child-session')
  assert.equal(second.resolveRootSession('child-session'), 'child-session')
  assert.equal(second.getTaskRun('child:child-session'), null)

  first.removeSessionState('child-session', 'root-session')

  assert.equal(first.getTaskRun('child:child-session'), null)
  assert.equal(first.consumePendingPromptEcho('child-session', 'pending echo'), 'pending echo')
})

test('SessionTaskStateStore returns task run snapshots at public boundaries', () => {
  const store = new SessionTaskStateStore()
  store.trackParentSession('root-session')
  const registered = store.registerTaskRun({
    id: 'task-copy',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Original title',
    agent: 'research',
    childSessionId: null,
    status: 'queued',
  })

  registered.title = 'Mutated registration result'
  registered.status = 'complete'
  assert.equal(store.getTaskRun('task-copy')?.title, 'Original title')
  assert.equal(store.getTaskRun('task-copy')?.status, 'queued')

  const bound = store.queueOrBindChildSession('root-session', 'child-session')
  assert.ok(bound)
  bound.childSessionId = 'mutated-child'
  assert.equal(store.getTaskRun('task-copy')?.childSessionId, 'child-session')

  const updated = store.updateTaskRun('task-copy', { status: 'running' })
  assert.ok(updated)
  updated.status = 'error'
  assert.equal(store.getTaskRun('task-copy')?.status, 'running')

  const read = store.getTaskRun('task-copy')
  assert.ok(read)
  read.title = 'Mutated read result'
  assert.equal(store.getTaskRun('task-copy')?.title, 'Original title')
})

test('consumes pending prompt echo incrementally', () => {
  rememberSubmittedPrompt('session-1', 'awesome')

  assert.equal(consumePendingPromptEcho('session-1', 'awe'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'some'), '')
  assert.equal(consumePendingPromptEcho('session-1', 'Perfect!'), 'Perfect!')
})
