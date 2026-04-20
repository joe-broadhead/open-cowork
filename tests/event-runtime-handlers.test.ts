import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { handleRuntimeSideEffectEvent } from '../apps/desktop/src/main/event-runtime-handlers.ts'
import {
  getTaskRun,
  registerSession,
  resetEventTaskState,
  resolveRootSession,
  trackParentSession,
} from '../apps/desktop/src/main/event-task-state.ts'

function createDispatchCollector() {
  const events: unknown[] = []
  return {
    events,
    dispatch: (_win: BrowserWindow, event: unknown) => {
      events.push(event)
    },
  }
}

test.afterEach(() => {
  resetEventTaskState()
})

test('returns false for events outside the runtime side-effect handler scope', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'message.updated',
    properties: {},
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, false)
  assert.equal(collector.events.length, 0)
})

test('permission.updated emits an approval event for the resolved root session', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.updated',
    properties: {
      id: 'perm-1',
      type: 'bash',
      title: 'Run shell command',
      sessionID: 'child-session',
      metadata: { command: 'echo hello' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.equal(collector.events.length, 1)
  assert.deepEqual(collector.events[0], {
    type: 'approval',
    sessionId: 'root-session',
    data: {
      type: 'approval',
      id: 'perm-1',
      taskRunId: 'child:child-session',
      tool: 'Run shell command',
      input: { command: 'echo hello' },
      description: 'Sub-Agent: Run shell command',
      sourceSessionId: 'child-session',
    },
  })
})

test('session.status tracks child task runs through running and complete states', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.status',
    properties: {
      sessionID: 'child-session',
      status: { type: 'busy' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.deepEqual(getTaskRun('child:child-session'), {
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Sub-Agent',
    agent: null,
    childSessionId: 'child-session',
    status: 'running',
  })

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.status',
    properties: {
      sessionID: 'child-session',
      status: { type: 'idle' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(collector.events.length, 0)
  assert.deepEqual(getTaskRun('child:child-session'), {
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Sub-Agent',
    agent: null,
    childSessionId: 'child-session',
    status: 'complete',
  })
})

test('session.error resolves camelCase session ids and nested provider messages', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'session.error',
    properties: {
      sessionId: 'root-session',
      error: {
        error: {
          message: 'Vertex rejected the selected model',
          status: 'NOT_FOUND',
        },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events[0], {
    type: 'error',
    sessionId: 'root-session',
    data: {
      type: 'error',
      message: 'Vertex rejected the selected model',
      taskRunId: null,
      sourceSessionId: 'root-session',
    },
  })
})

// The widened error extractor should surface payloads whose message lives
// on any of the fallback paths — .error.data.message, .response.body.error,
// or simply the payload itself when nothing else matches. Without this
// coverage a future narrowing regression silently collapses to the
// generic "An error occurred" again.
test('session.error reaches into error.data.message when the top-level message is missing', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.error',
    properties: {
      sessionID: 'root-session',
      error: {
        data: { message: 'rate limit hit — retry later' },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal((collector.events[0] as { data: { message: string } }).data.message, 'rate limit hit — retry later')
})

test('session.error stringifies the payload when no known message field matches', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.error',
    properties: {
      sessionID: 'root-session',
      error: {
        unknown_field: 'weird-shape',
        nested: { hint: 'provider-specific' },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  const message = (collector.events[0] as { data: { message: string } }).data.message
  assert.notEqual(message, 'An error occurred')
  assert.ok(message.includes('weird-shape'))
})

// session.deleted should fully untrack both the deleted session AND any
// descendant lineage rows that pointed at it — otherwise resolveRootSession
// continues to walk into an id OpenCode has already removed. This is the
// M2 cleanup from the post-checkpoint audit plan.
test('session.deleted removes descendant lineage entries for the deleted root', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-a', 'root-session')
  registerSession('child-b', 'root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.deleted',
    properties: {
      info: { id: 'root-session' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  // After deletion the root and both descendants should all resolve to
  // themselves (no dangling lineage pointing at the gone root).
  assert.equal(resolveRootSession('child-a'), 'child-a')
  assert.equal(resolveRootSession('child-b'), 'child-b')
  assert.equal(resolveRootSession('root-session'), 'root-session')
})
