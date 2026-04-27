import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { handleRuntimeSideEffectEvent } from '../apps/desktop/src/main/event-runtime-handlers.ts'
import { handleMessagePartUpdatedEvent } from '../apps/desktop/src/main/event-message-handlers.ts'
import {
  getTaskRun,
  registerSession,
  registerTaskRun,
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

function createWindowSendCollector(options?: { destroyed?: boolean; webContentsDestroyed?: boolean }) {
  const sent: Array<{ channel: string; data: unknown }> = []
  const win = {
    webContents: {
      send: (channel: string, data: unknown) => {
        sent.push({ channel, data })
      },
      isDestroyed: () => options?.webContentsDestroyed ?? false,
    },
    isDestroyed: () => options?.destroyed ?? false,
  } as unknown as BrowserWindow
  return { win, sent }
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

test('permission.asked emits an approval event for the resolved root session', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.asked',
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
  assert.deepEqual(sent, [{
    channel: 'permission:request',
    data: {
      id: 'perm-1',
      sessionId: 'root-session',
      taskRunId: 'child:child-session',
      tool: 'Run shell command',
      input: { command: 'echo hello' },
      description: 'Sub-Agent: Run shell command',
    },
  }])
})

test('permission.asked accepts SDK payloads nested under permission', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.asked',
    properties: {
      permission: {
        id: 'perm-2',
        permission: 'bash',
        tool: 'bash',
        sessionID: 'root-session',
        metadata: { command: 'pwd' },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events[0], {
    type: 'approval',
    sessionId: 'root-session',
    data: {
      type: 'approval',
      id: 'perm-2',
      taskRunId: null,
      tool: 'bash',
      input: { command: 'pwd' },
      description: 'bash',
      sourceSessionId: 'root-session',
    },
  })
  assert.equal(sent[0]?.channel, 'permission:request')
  assert.deepEqual(sent[0]?.data, {
    id: 'perm-2',
    sessionId: 'root-session',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'bash',
  })
})

test('permission.asked merges nested tool details with top-level request ids', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.asked',
    properties: {
      id: 'perm-3',
      sessionID: 'root-session',
      permission: {
        permission: 'bash',
        title: 'Run shell command',
        metadata: { command: 'pwd' },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events[0], {
    type: 'approval',
    sessionId: 'root-session',
    data: {
      type: 'approval',
      id: 'perm-3',
      taskRunId: null,
      tool: 'Run shell command',
      input: { command: 'pwd' },
      description: 'Run shell command',
      sourceSessionId: 'root-session',
    },
  })
  assert.deepEqual(sent[0], {
    channel: 'permission:request',
    data: {
      id: 'perm-3',
      sessionId: 'root-session',
      taskRunId: null,
      tool: 'Run shell command',
      input: { command: 'pwd' },
      description: 'Run shell command',
    },
  })
})

test('permission.asked ignores requests without a replyable id', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.asked',
    properties: {
      type: 'bash',
      title: 'Run shell command',
      sessionID: 'root-session',
      metadata: { command: 'pwd' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.equal(collector.events.length, 0)
  assert.equal(sent.length, 0)
})

test('permission.asked skips direct IPC sends when the window is destroyed', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector({ destroyed: true })

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.asked',
    properties: {
      id: 'perm-4',
      permission: 'bash',
      sessionID: 'root-session',
      metadata: { command: 'pwd' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.equal(collector.events.length, 1)
  assert.equal(sent.length, 0)
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

  const runningTask = getTaskRun('child:child-session')
  assert.ok(runningTask?.startedAt)
  assert.equal(runningTask?.finishedAt, null)
  assert.deepEqual({
    ...runningTask,
    startedAt: undefined,
    finishedAt: undefined,
  }, {
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Sub-Agent',
    agent: null,
    childSessionId: 'child-session',
    status: 'running',
    startedAt: undefined,
    finishedAt: undefined,
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
  const completedTask = getTaskRun('child:child-session')
  assert.equal(completedTask?.startedAt, runningTask?.startedAt)
  assert.ok(completedTask?.finishedAt)
  assert.deepEqual({
    ...completedTask,
    startedAt: undefined,
    finishedAt: undefined,
  }, {
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Sub-Agent',
    agent: null,
    childSessionId: 'child-session',
    status: 'complete',
    startedAt: undefined,
    finishedAt: undefined,
  })
})

test('child tool errors do not terminalize a still-running subagent task', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'child-session',
      messageID: 'message-1',
      part: {
        id: 'part-1',
        type: 'tool',
        tool: 'websearch',
        title: 'Search the web',
        state: {
          status: 'error',
          input: { query: 'test query' },
          error: 'rate limited',
        },
      },
    },
    new Map([['message-1', 'assistant']]),
    new Map(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(task?.status, 'running')
  assert.equal(task?.finishedAt, null)
  assert.equal(collector.events.length, 1)
  assert.deepEqual(collector.events[0], {
    type: 'tool_call',
    sessionId: 'root-session',
    data: {
      type: 'tool_call',
      id: 'part-1',
      name: 'websearch',
      input: { query: 'test query' },
      status: 'error',
      output: undefined,
      agent: null,
      attachments: undefined,
      taskRunId: 'child:child-session',
      sourceSessionId: 'child-session',
    },
  })
})

test('session.updated can bind a previously queued same-parent child session once metadata arrives', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

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

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.created',
    properties: {
      info: {
        id: 'child-b',
        parentID: 'root-session',
        title: '',
        time: { created: 1000, updated: 1000 },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(getTaskRun('task-a')?.childSessionId, null)
  assert.equal(getTaskRun('task-b')?.childSessionId, null)

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.updated',
    properties: {
      info: {
        id: 'child-b',
        parentID: 'root-session',
        title: 'Build chart pack',
        time: { created: 1000, updated: 1100 },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(getTaskRun('task-b')?.childSessionId, 'child-b')
  assert.equal(getTaskRun('child:child-b'), null)
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
