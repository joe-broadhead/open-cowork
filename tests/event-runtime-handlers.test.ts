import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { handleRuntimeSideEffectEvent } from '../apps/desktop/src/main/event-runtime-handlers.ts'
import {
  getTaskRun,
  registerSession,
  resetEventTaskState,
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
    title: 'Sub-Agent',
    agent: null,
    childSessionId: 'child-session',
    status: 'complete',
  })
})
