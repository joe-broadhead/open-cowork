import { resetSessionScopedFallbackIdsForTests } from '@open-cowork/runtime-host/runtime-fallback-ids'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  handleRuntimeSideEffectEvent,
  resetRuntimeEventStateForTests,
} from '../apps/desktop/src/main/event-runtime-handlers.ts'
import {
  createSessionScopedMessageState,
  handleMessagePartDeltaEvent,
  handleMessageUpdatedEvent,
  handleMessagePartUpdatedEvent,
} from '../apps/desktop/src/main/event-message-handlers.ts'
import {
  getTaskRun,
  registerSession,
  registerTaskRun,
  resetEventTaskState,
  resolveRootSession,
  seedReplayedChildSessionLineage,
  trackParentSession,
} from '../apps/desktop/src/main/event-task-state.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
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
  resetRuntimeEventStateForTests()
  resetSessionScopedFallbackIdsForTests()
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
          sourceSessionId: 'child-session',
          taskRunId: 'child:child-session',
      tool: 'Run shell command',
      input: { command: 'echo hello' },
      description: 'Sub-Agent: Run shell command',
    },
  }])
})

test('replayed child lineage routes live child deltas into the parent task lane', () => {
  const collector = createDispatchCollector()
  const { win } = createWindowSendCollector()
  const messageState = createSessionScopedMessageState()

  seedReplayedChildSessionLineage('root-session', [{
    id: 'child-session',
    parentSessionId: 'root-session',
    title: 'Research docs',
    agent: 'researcher',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  }])

  assert.equal(resolveRootSession('child-session'), 'root-session')
  assert.deepEqual(getTaskRun('child:child-session'), {
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Research docs',
    agent: 'researcher',
    childSessionId: 'child-session',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
  })

  handleMessageUpdatedEvent(win, collector.dispatch, {
    info: {
      id: 'message-1',
      sessionID: 'child-session',
      role: 'assistant',
    },
  }, messageState)
  handleMessagePartDeltaEvent(win, collector.dispatch, {
    sessionID: 'child-session',
    messageID: 'message-1',
    partID: 'part-1',
    delta: 'hello from replayed child',
    part: { type: 'text' },
  }, messageState)

  assert.deepEqual(collector.events, [{
    type: 'text',
    sessionId: 'root-session',
    data: {
      type: 'text',
      mode: 'append',
      content: 'hello from replayed child',
      taskRunId: 'child:child-session',
      sourceSessionId: 'child-session',
      messageId: 'message-1',
      partId: 'part-1',
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
    sourceSessionId: 'root-session',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'bash',
  })
})

test('permission.v2.asked projects native action, resources, save rules, and source ownership', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()
  trackParentSession('native-root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.v2.asked',
    properties: {
      id: 'native-permission-1',
      sessionID: 'native-root-session',
      action: 'file.read',
      resources: ['README.md'],
      save: ['README.md'],
      source: { sessionID: 'native-root-session', messageID: 'assistant-1', callID: 'call-1' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events, [{
    type: 'approval',
    sessionId: 'native-root-session',
    data: {
      type: 'approval',
      id: 'native-permission-1',
      taskRunId: null,
      tool: 'file.read',
      input: {
        resources: ['README.md'],
        save: ['README.md'],
        source: { sessionID: 'native-root-session', messageID: 'assistant-1', callID: 'call-1' },
      },
      description: 'file.read',
      sourceSessionId: 'native-root-session',
    },
  }])
  assert.equal(sent[0]?.channel, 'permission:request')
})

test('question.v2.asked projects native prompts and reply ownership', () => {
  const collector = createDispatchCollector()
  const { win } = createWindowSendCollector()
  trackParentSession('native-question-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'question.v2.asked',
    properties: {
      id: 'native-question-1',
      sessionID: 'native-question-session',
      questions: [{
        header: 'Scope',
        question: 'Run all checks?',
        options: [{ label: 'Yes', description: 'Run everything' }],
        multiple: false,
        custom: true,
      }],
      tool: { messageID: 'assistant-1', callID: 'call-1' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events, [{
    type: 'question_asked',
    sessionId: 'native-question-session',
    data: {
      type: 'question_asked',
      id: 'native-question-1',
      questions: [{
        header: 'Scope',
        question: 'Run all checks?',
        options: [{ label: 'Yes', description: 'Run everything' }],
        multiple: false,
        custom: true,
      }],
      tool: { messageId: 'assistant-1', callId: 'call-1' },
      sourceSessionId: 'native-question-session',
    },
  }])
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
        sourceSessionId: 'root-session',
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

test('permission.replied clears the approval card for the resolved root session', () => {
  const collector = createDispatchCollector()
  const { win } = createWindowSendCollector()

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.replied',
    properties: {
      sessionID: 'child-session',
      requestID: 'perm-1',
      reply: 'once',
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  // Stop the idle-reconciliation timer the handler arms so the test does not
  // leak a pending setTimeout into the runner.
  stopSessionStatusReconciliation('root-session')

  assert.equal(handled, true)
  assert.equal(collector.events.length, 1)
  assert.deepEqual(collector.events[0], {
    type: 'approval_resolved',
    sessionId: 'root-session',
    data: {
      type: 'approval_resolved',
      id: 'perm-1',
    },
  })
})

test('permission.replied without a request id is ignored', () => {
  const collector = createDispatchCollector()
  const { win } = createWindowSendCollector()

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'permission.replied',
    properties: {
      sessionID: 'root-session',
      reply: 'once',
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })
  stopSessionStatusReconciliation('root-session')

  assert.equal(handled, true)
  assert.equal(collector.events.length, 0)
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

test('session.idle drives the same root completion path as session.status idle', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'session.idle',
    properties: {
      sessionID: 'root-session',
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events, [
    {
      type: 'history_refresh',
      sessionId: 'root-session',
      data: { type: 'history_refresh' },
    },
    {
      type: 'done',
      sessionId: 'root-session',
      data: { type: 'done' },
    },
  ])
})

test('session.status idle and session.idle are deduped for the same SDK transition', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.status',
    properties: {
      sessionID: 'root-session',
      status: { type: 'idle' },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.idle',
    properties: {
      sessionID: 'root-session',
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(collector.events.length, 2)
  assert.equal((collector.events[0] as { type?: string }).type, 'history_refresh')
  assert.equal((collector.events[1] as { type?: string }).type, 'done')
})

test('session.next.agent.switched updates root active agent without waiting for message parts', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'session.next.agent.switched',
    properties: {
      sessionID: 'root-session',
      agent: 'business-analyst',
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events, [{
    type: 'agent',
    sessionId: 'root-session',
    data: { type: 'agent', name: 'business-analyst' },
  }])
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
    createSessionScopedMessageState(),
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

test('subtask parts do not derive live agent identity from prompt or raw text', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'subtask-1',
        type: 'subtask',
        description: 'Investigate live projection parity',
        prompt: 'Ask @spurious to summarize the result.',
        raw: '@spurious should not become the task agent',
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('subtask-1')
  assert.equal(task?.agent, null)
  assert.equal(task?.title, 'Investigate live projection parity')
})

test('task tool descriptors do not derive live agent identity from prompt or raw text', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Start task',
        raw: '@spurious should not become the task agent',
        state: {
          status: 'running',
          input: {
            description: 'Investigate task tool parity',
            prompt: 'Ask @spurious to inspect this.',
          },
          metadata: {},
          raw: '@spurious should not become the task agent',
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('call-task-1')
  assert.equal(task?.agent, null)
  assert.equal(task?.title, 'Investigate task tool parity')
})

test('child tool updates do not derive live agent identity from prompt or raw text', () => {
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
        tool: 'read',
        title: 'Read notes',
        state: {
          status: 'running',
          input: {
            prompt: 'Ask @spurious to read this.',
          },
          metadata: {},
          raw: '@spurious should not become the task agent',
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(task?.agent, null)
  assert.equal(collector.events.length, 1)
  assert.equal((collector.events[0] as { data?: { agent?: string | null } }).data?.agent, null)
})

test('message.part.updated fallback tool ids do not collide within one session', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow
  const messageState = createSessionScopedMessageState()

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'running',
          input: { path: 'README.md' },
        },
      },
    },
    messageState,
    'openai/gpt-5.5',
  )
  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-2',
      part: {
        type: 'tool',
        tool: 'write',
        state: {
          status: 'running',
          input: { path: 'notes.md' },
        },
      },
    },
    messageState,
    'openai/gpt-5.5',
  )

  const ids = collector.events.map((event) => {
    return (event as { data?: { id?: string } }).data?.id
  })
  assert.deepEqual(ids, [
    'root-session:tool:fallback:1',
    'root-session:tool:fallback:2',
  ])
})

test('message.part.updated reads SDK part-scoped ids for child transcript text', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow
  const messageState = createSessionScopedMessageState()

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'message-1',
        role: 'assistant',
        sessionID: 'child-session',
      },
    },
    messageState,
  )

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      part: {
        id: 'part-1',
        sessionID: 'child-session',
        messageID: 'message-1',
        type: 'text',
        text: 'Subagent findings should be visible.',
      },
    },
    messageState,
    'openai/gpt-5.5',
  )

  assert.deepEqual(collector.events[0], {
    type: 'text',
    sessionId: 'root-session',
    data: {
      type: 'text',
      mode: 'replace',
      content: 'Subagent findings should be visible.',
      taskRunId: 'child:child-session',
      sourceSessionId: 'child-session',
      messageId: 'message-1',
      partId: 'part-1',
    },
  })
})

test('root task tool calls create a pending subagent lane before the child session exists', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Start task',
        state: {
          status: 'running',
          input: {
            agent: 'business-analyst',
            description: 'UK web traffic & conversion analysis',
            prompt: 'Analyze the UK website traffic and conversion trend.',
          },
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const pendingTask = getTaskRun('call-task-1')
  assert.deepEqual({
    ...pendingTask,
    startedAt: undefined,
    finishedAt: undefined,
  }, {
    id: 'call-task-1',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'UK web traffic & conversion analysis',
    agent: 'business-analyst',
    childSessionId: null,
    status: 'queued',
    startedAt: undefined,
    finishedAt: undefined,
  })
  assert.equal(collector.events.length, 0)

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.created',
    properties: {
      info: {
        id: 'child-session',
        parentID: 'root-session',
        title: 'UK web traffic & conversion analysis (@business-analyst subagent)',
        time: { created: 1000, updated: 1000 },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  const boundTask = getTaskRun('call-task-1')
  assert.equal(boundTask?.childSessionId, 'child-session')
  assert.equal(boundTask?.parentSessionId, 'root-session')
  assert.equal(boundTask?.title, 'UK web traffic & conversion analysis')
  assert.equal(boundTask?.agent, 'business-analyst')
})

test('terminal root task tool calls do not bind a later child session', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Start task',
        state: {
          status: 'completed',
          input: {
            agent: 'business-analyst',
            description: 'UK web traffic & conversion analysis',
            prompt: 'Analyze the UK website traffic and conversion trend.',
          },
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const terminalTask = getTaskRun('call-task-1')
  assert.equal(terminalTask?.status, 'complete')
  assert.equal(terminalTask?.childSessionId, null)
  assert.equal(terminalTask?.parentSessionId, 'root-session')

  handleRuntimeSideEffectEvent({
    win,
    type: 'session.created',
    properties: {
      info: {
        id: 'child-session',
        parentID: 'root-session',
        title: 'Unrelated later child',
        time: { created: 1000, updated: 1000 },
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(getTaskRun('call-task-1')?.childSessionId, null)
  assert.equal(getTaskRun('child:child-session'), null)
})

test('completed root task tool with explicit child metadata starts the child task lane only', () => {
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
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {
            parentSessionId: 'root-session',
            sessionId: 'child-session',
          },
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(getTaskRun('call-task-1'), null)
  assert.equal(task?.childSessionId, 'child-session')
  assert.equal(task?.parentSessionId, 'root-session')
  assert.equal(task?.status, 'running')
  assert.equal(task?.agent, 'explore')
  assert.equal(task?.title, 'Explore MCP examples and structure')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const updatedTask = getTaskRun('child:child-session')
  assert.equal(getTaskRun('call-task-1'), null)
  assert.equal(updatedTask?.childSessionId, 'child-session')
  assert.equal(updatedTask?.status, 'running')
})

test('late explicit child metadata binds the pending task call without duplicating lanes', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'running',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {
            parentSessionId: 'root-session',
            sessionId: 'child-session',
          },
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('call-task-1')
  assert.equal(getTaskRun('child:child-session'), null)
  assert.equal(task?.childSessionId, 'child-session')
  assert.equal(task?.parentSessionId, 'root-session')
  assert.equal(task?.status, 'running')
  assert.equal(task?.agent, 'explore')
  assert.equal(task?.title, 'Explore MCP examples and structure')
})

test('late explicit child metadata preserves child-owned terminal status when merging lanes', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerTaskRun({
    id: 'call-task-1',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Explore MCP examples and structure',
    agent: 'explore',
    childSessionId: null,
    status: 'queued',
  })
  registerTaskRun({
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Explore MCP examples and structure',
    agent: 'explore',
    childSessionId: 'child-session',
    status: 'complete',
  })

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {
            parentSessionId: 'root-session',
            sessionId: 'child-session',
          },
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(getTaskRun('call-task-1'), null)
  assert.equal(task?.childSessionId, 'child-session')
  assert.equal(task?.status, 'complete')
})

test('late explicit child metadata preserves child-owned running status when merging lanes', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerTaskRun({
    id: 'call-task-1',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Explore MCP examples and structure',
    agent: 'explore',
    childSessionId: null,
    status: 'complete',
  })
  registerTaskRun({
    id: 'child:child-session',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Explore MCP examples and structure',
    agent: 'explore',
    childSessionId: 'child-session',
    status: 'running',
  })

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {
            parentSessionId: 'root-session',
            sessionId: 'child-session',
          },
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(getTaskRun('call-task-1'), null)
  assert.equal(task?.childSessionId, 'child-session')
  assert.equal(task?.status, 'running')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        state: {
          status: 'completed',
          input: {
            subagent_type: 'explore',
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const updatedTask = getTaskRun('child:child-session')
  assert.equal(getTaskRun('call-task-1'), null)
  assert.equal(updatedTask?.childSessionId, 'child-session')
  assert.equal(updatedTask?.status, 'running')
})

test('task tool child ids can arrive in state metadata while top-level metadata is present', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Explore MCP examples and structure',
        metadata: {
          agent: 'explore',
        },
        state: {
          status: 'completed',
          input: {
            description: 'Explore MCP examples and structure',
            prompt: 'Explore engaging MCP examples.',
          },
          output: 'task_id: child-session',
          metadata: {
            parentSessionId: 'root-session',
            sessionId: 'child-session',
          },
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const task = getTaskRun('child:child-session')
  assert.equal(task?.childSessionId, 'child-session')
  assert.equal(task?.parentSessionId, 'root-session')
  assert.equal(task?.status, 'running')
  assert.equal(task?.agent, 'explore')
})

test('root task tool state.error marks the pending subagent lane failed', () => {
  const collector = createDispatchCollector()
  const win = {
    webContents: { send: () => undefined },
    isDestroyed: () => false,
  } as unknown as BrowserWindow

  trackParentSession('root-session')

  handleMessagePartUpdatedEvent(
    win,
    collector.dispatch,
    {
      sessionID: 'root-session',
      messageID: 'message-1',
      part: {
        id: 'part-task',
        callID: 'call-task-1',
        type: 'tool',
        tool: 'task',
        title: 'Start task',
        state: {
          input: {
            agent: 'business-analyst',
            description: 'UK web traffic & conversion analysis',
            prompt: 'Analyze the UK website traffic and conversion trend.',
          },
          error: { message: 'Task delegation failed' },
          metadata: {},
        },
      },
    },
    createSessionScopedMessageState(),
    'openai/gpt-5.5',
  )

  const failedTask = getTaskRun('call-task-1')
  assert.equal(failedTask?.status, 'error')
  assert.equal(failedTask?.childSessionId, null)
  assert.equal(failedTask?.parentSessionId, 'root-session')
  assert.equal(collector.events.length, 0)
})

test('session.updated preserves event-order binding instead of rebinding from metadata', () => {
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

  assert.equal(getTaskRun('task-a')?.childSessionId, 'child-b')
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

  assert.equal(getTaskRun('task-a')?.childSessionId, 'child-b')
  assert.equal(getTaskRun('task-b')?.childSessionId, null)
  assert.equal(getTaskRun('child:child-b'), null)
})

test('session.error resolves camelCase session ids and nested provider messages', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

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
  assert.deepEqual(sent, [{
    channel: 'runtime:notification',
    data: {
      type: 'error',
      sessionId: 'root-session',
      message: 'Vertex rejected the selected model',
    },
  }])
})

test('todo.updated dispatches an empty authoritative list to clear stale todos', () => {
  const collector = createDispatchCollector()
  const { win } = createWindowSendCollector()

  trackParentSession('root-session')

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'todo.updated',
    properties: {
      sessionID: 'root-session',
      todos: [],
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.deepEqual(collector.events, [{
    type: 'todos',
    sessionId: 'root-session',
    data: {
      type: 'todos',
      todos: [],
      taskRunId: null,
    },
  }])
})

test('session.error marks child task failed without dropping lineage', () => {
  const collector = createDispatchCollector()
  const { win, sent } = createWindowSendCollector()

  trackParentSession('root-session')
  registerSession('child-session', 'root-session')
  registerTaskRun({
    id: 'task-1',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Analyze data',
    agent: 'analyst',
    childSessionId: 'child-session',
    status: 'running',
  })

  const handled = handleRuntimeSideEffectEvent({
    win,
    type: 'session.error',
    properties: {
      sessionID: 'child-session',
      error: {
        message: 'Provider terminated the child session',
      },
    },
    dispatchRuntimeEvent: collector.dispatch,
    getMainWindow: () => win,
  })

  assert.equal(handled, true)
  assert.equal(getTaskRun('task-1')?.status, 'error')
  assert.equal(getTaskRun('task-1')?.childSessionId, 'child-session')
  assert.equal(resolveRootSession('child-session'), 'root-session')
  assert.deepEqual(collector.events[0], {
    type: 'error',
    sessionId: 'root-session',
    data: {
      type: 'error',
      message: 'Provider terminated the child session',
      taskRunId: 'task-1',
      sourceSessionId: 'child-session',
    },
  })
  assert.deepEqual(sent, [{
    channel: 'runtime:notification',
    data: {
      type: 'error',
      sessionId: 'root-session',
      message: 'Provider terminated the child session',
    },
  }])
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
