import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  createSessionScopedMessageState,
  handleMessagePartDeltaEvent,
  handleMessagePartUpdatedEvent,
  handleMessageUpdatedEvent,
  handleNativeStepEndedEvent,
  handleNativeTextDeltaEvent,
  handleNativeTextEndedEvent,
  handleNativeToolEvent,
} from '../apps/desktop/src/main/event-message-handlers.ts'
import { trackParentSession } from '../apps/desktop/src/main/event-task-state.ts'

function createDispatchCollector() {
  const events: unknown[] = []
  return {
    events,
    dispatch: (_win: BrowserWindow, event: unknown) => {
      events.push(event)
    },
  }
}

test('message text deltas buffer until assistant role is known, then flush', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  handleMessagePartDeltaEvent(
    win,
    collector.dispatch,
    {
      messageID: 'msg_1',
      sessionID: 'sess_1',
      partID: 'part_1',
      delta: 'Hello',
    },
    messageState,
  )

  assert.equal(collector.events.length, 0)
  assert.equal(messageState.pendingTextEventsBySession.get('sess_1')?.get('msg_1')?.length, 1)
  assert.equal(messageState.totalPendingTextEvents, 1)

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'msg_1',
        role: 'assistant',
        sessionID: 'sess_1',
      },
    },
    messageState,
  )

  assert.equal(messageState.pendingTextEventsBySession.has('sess_1'), false)
  assert.equal(messageState.totalPendingTextEvents, 0)
  assert.equal(collector.events.length, 1)
})

test('message text deltas accept SDK ids from the part payload', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'msg_part_scoped',
        role: 'assistant',
        sessionID: 'sess_part_scoped',
      },
    },
    messageState,
  )

  handleMessagePartDeltaEvent(
    win,
    collector.dispatch,
    {
      part: {
        id: 'part_scoped',
        sessionID: 'sess_part_scoped',
        messageID: 'msg_part_scoped',
        type: 'text',
      },
      delta: 'streamed from SDK shape',
    },
    messageState,
  )

  assert.deepEqual(collector.events[0], {
    type: 'text',
    sessionId: 'sess_part_scoped',
    data: {
      type: 'text',
      mode: 'append',
      content: 'streamed from SDK shape',
      taskRunId: null,
      sourceSessionId: 'sess_part_scoped',
      messageId: 'msg_part_scoped',
      partId: 'part_scoped',
    },
  })
})

test('user-role message updates drop buffered text instead of dispatching it', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  handleMessagePartDeltaEvent(
    win,
    collector.dispatch,
    {
      messageID: 'msg_user',
      sessionID: 'sess_1',
      partID: 'part_1',
      delta: 'prompt echo',
    },
    messageState,
  )

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'msg_user',
        role: 'user',
        sessionID: 'sess_1',
      },
    },
    messageState,
  )

  assert.equal(messageState.pendingTextEventsBySession.has('sess_1'), false)
  assert.equal(messageState.totalPendingTextEvents, 0)
  assert.equal(collector.events.length, 0)
})

test('pending text eviction is scoped per session', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  handleMessagePartDeltaEvent(
    win,
    collector.dispatch,
    {
      messageID: 'msg_b',
      sessionID: 'sess_b',
      partID: 'part_b',
      delta: 'preserve me',
    },
    messageState,
  )

  for (let index = 0; index < 505; index += 1) {
    handleMessagePartDeltaEvent(
      win,
      collector.dispatch,
      {
        messageID: `msg_a_${index}`,
        sessionID: 'sess_a',
        partID: `part_a_${index}`,
        delta: `noisy ${index}`,
      },
      messageState,
    )
  }

  assert.equal(messageState.pendingTextEventsBySession.get('sess_b')?.get('msg_b')?.length, 1)
  assert.equal(messageState.pendingTextEventsBySession.get('sess_a')?.size, 500)
  assert.equal(messageState.totalPendingTextEvents, 501)
  assert.equal(collector.events.length, 0)

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'msg_b',
        role: 'assistant',
        sessionID: 'sess_b',
      },
    },
    messageState,
  )

  assert.equal(collector.events.length, 1)
  assert.deepEqual(collector.events[0], {
    type: 'text',
    sessionId: 'sess_b',
    data: {
      type: 'text',
      mode: 'append',
      content: 'preserve me',
      taskRunId: null,
      sourceSessionId: 'sess_b',
      messageId: 'msg_b',
      partId: 'part_b',
    },
  })
  assert.equal(messageState.totalPendingTextEvents, 500)
})

test('pending text eviction caps a single noisy session by event count', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  for (let index = 0; index < 505; index += 1) {
    handleMessagePartDeltaEvent(
      win,
      collector.dispatch,
      {
        messageID: 'msg_noisy',
        sessionID: 'sess_noisy',
        partID: `part_${index}`,
        delta: `chunk ${index}`,
      },
      messageState,
    )
  }

  assert.equal(messageState.pendingTextEventsBySession.get('sess_noisy')?.get('msg_noisy')?.length, 500)
  assert.equal(messageState.pendingTextEventsBySession.get('sess_noisy')?.get('msg_noisy')?.[0]?.content, 'chunk 5')
  assert.equal(messageState.totalPendingTextEvents, 500)
  assert.equal(collector.events.length, 0)
})

test('message roles without session ids do not affect session-scoped deltas', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  handleMessageUpdatedEvent(
    win,
    collector.dispatch,
    {
      info: {
        id: 'shared-message-id',
        role: 'user',
      },
    },
    messageState,
  )

  handleMessagePartDeltaEvent(
    win,
    collector.dispatch,
    {
      messageID: 'shared-message-id',
      sessionID: 'sess_with_scope',
      partID: 'part_1',
      delta: 'assistant text',
    },
    messageState,
  )

  assert.equal(collector.events.length, 0)
  assert.equal(messageState.pendingTextEventsBySession.get('sess_with_scope')?.get('shared-message-id')?.length, 1)
  assert.equal(messageState.totalPendingTextEvents, 1)
})

test('pending text buffers remain globally bounded across many sessions', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  for (let index = 0; index < 10_025; index += 1) {
    handleMessagePartDeltaEvent(
      win,
      collector.dispatch,
      {
        messageID: `pending_msg_${index}`,
        sessionID: `pending_sess_${index}`,
        partID: `pending_part_${index}`,
        delta: `pending text ${index}`,
      },
      messageState,
    )
  }

  const totalPendingMessages = Array.from(messageState.pendingTextEventsBySession.values())
    .reduce((total, pendingByMessage) => total + pendingByMessage.size, 0)

  assert.equal(totalPendingMessages, 10_000)
  assert.equal(messageState.totalPendingTextEvents, 10_000)
  assert.equal(messageState.pendingTextEventsBySession.has('pending_sess_0'), false)
  assert.equal(messageState.pendingTextEventsBySession.has('pending_sess_24'), false)
  assert.equal(messageState.pendingTextEventsBySession.has('pending_sess_25'), true)
  assert.equal(messageState.pendingTextEventsBySession.has('pending_sess_10024'), true)
  assert.equal(collector.events.length, 0)
})

test('message role cache remains globally bounded across many sessions', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()

  for (let index = 0; index < 10_025; index += 1) {
    handleMessageUpdatedEvent(
      win,
      collector.dispatch,
      {
        info: {
          id: `msg_${index}`,
          role: 'assistant',
          sessionID: `sess_${index}`,
        },
      },
      messageState,
    )
  }

  const totalRoles = Array.from(messageState.messageRolesBySession.values())
    .reduce((total, roles) => total + roles.size, 0)

  assert.equal(totalRoles, 10_000)
  assert.equal(messageState.totalMessageRoles, 10_000)
  assert.equal(messageState.messageRolesBySession.has('sess_0'), false)
  assert.equal(messageState.messageRolesBySession.has('sess_24'), false)
  assert.equal(messageState.messageRolesBySession.has('sess_25'), true)
  assert.equal(messageState.messageRolesBySession.has('sess_10024'), true)
})

test('native v2 text and reasoning event families project append and replace patches', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()
  trackParentSession('native-text-session')

  handleNativeTextDeltaEvent(win, collector.dispatch, {
    sessionID: 'native-text-session',
    assistantMessageID: 'assistant-1',
    textID: 'text-1',
    delta: 'Hello',
  }, messageState, 'text')
  handleNativeTextEndedEvent(win, collector.dispatch, {
    sessionID: 'native-text-session',
    assistantMessageID: 'assistant-1',
    textID: 'text-1',
    text: 'Hello world',
  }, messageState, 'openai/gpt-5', 'text')
  handleNativeTextDeltaEvent(win, collector.dispatch, {
    sessionID: 'native-text-session',
    assistantMessageID: 'assistant-1',
    reasoningID: 'reasoning-1',
    delta: 'Inspecting',
  }, messageState, 'reasoning')
  handleNativeTextEndedEvent(win, collector.dispatch, {
    sessionID: 'native-text-session',
    assistantMessageID: 'assistant-1',
    reasoningID: 'reasoning-1',
    text: 'Inspecting complete',
  }, messageState, 'openai/gpt-5', 'reasoning')

  assert.deepEqual(collector.events.map((event) => {
    const data = (event as { data: Record<string, unknown> }).data
    return {
      type: data.type,
      mode: data.mode,
      content: data.content,
      messageId: data.messageId,
      partId: data.partId,
    }
  }), [
    { type: 'text', mode: 'append', content: 'Hello', messageId: 'assistant-1', partId: 'text-1' },
    { type: 'text', mode: 'replace', content: 'Hello world', messageId: 'assistant-1', partId: 'text-1' },
    { type: 'reasoning', mode: 'append', content: 'Inspecting', messageId: 'assistant-1', partId: 'reasoning-1' },
    { type: 'reasoning', mode: 'replace', content: 'Inspecting complete', messageId: 'assistant-1', partId: 'reasoning-1' },
  ])
})

test('native v2 tool terminal events retain called metadata and step events project cost', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()
  trackParentSession('native-tool-session')

  handleNativeToolEvent(win, collector.dispatch, 'session.next.tool.called', {
    sessionID: 'native-tool-session',
    assistantMessageID: 'assistant-2',
    callID: 'call-1',
    tool: 'read',
    input: { path: 'README.md' },
    provider: { executed: true, metadata: { openai: { itemId: 'item-1' } } },
  }, messageState, 'openai/gpt-5')
  handleNativeToolEvent(win, collector.dispatch, 'session.next.tool.success', {
    sessionID: 'native-tool-session',
    assistantMessageID: 'assistant-2',
    callID: 'call-1',
    structured: { bytes: 42 },
    content: [
      { type: 'text', text: 'file body' },
      { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
    ],
    outputPaths: ['/workspace/report.md'],
    provider: { executed: true, metadata: { openai: { responseId: 'response-1' } } },
  }, messageState, 'openai/gpt-5')
  handleNativeStepEndedEvent(win, collector.dispatch, {
    sessionID: 'native-tool-session',
    assistantMessageID: 'assistant-2',
    finish: 'stop',
    cost: 0.125,
    tokens: { input: 5, output: 7, reasoning: 1, cache: { read: 2, write: 3 } },
  }, messageState, 'openai/gpt-5')

  const toolEvents = collector.events.filter((event) => (event as { type?: string }).type === 'tool_call') as Array<{
    data: { name?: string; input?: unknown; status?: string; output?: unknown; outputPaths?: string[] }
  }>
  assert.equal(toolEvents.length, 2)
  assert.deepEqual(toolEvents[1]?.data, {
    type: 'tool_call',
    id: 'call-1',
    name: 'read',
    input: { path: 'README.md' },
    status: 'complete',
    output: [
      { type: 'text', text: 'file body' },
      { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
    ],
    agent: null,
    attachments: [{ mime: 'text/markdown', url: 'file:///workspace/report.md', filename: 'report.md' }],
    outputPaths: ['/workspace/report.md'],
    taskRunId: null,
    sourceSessionId: 'native-tool-session',
  })
  const cost = collector.events.find((event) => (event as { type?: string }).type === 'cost') as {
    data?: { cost?: number; tokens?: unknown }
  } | undefined
  assert.equal(cost?.data?.cost, 0.125)
  assert.deepEqual(cost?.data?.tokens, { input: 5, output: 7, reasoning: 1, cache: { read: 2, write: 3 } })
  assert.equal(messageState.nativeToolPartsByKey.size, 0)
})

test('classic message.part events are suppressed once session.next owns the message', () => {
  const win = {} as BrowserWindow
  const messageState = createSessionScopedMessageState()
  const collector = createDispatchCollector()
  trackParentSession('dual-family-session')

  handleNativeTextDeltaEvent(win, collector.dispatch, {
    sessionID: 'dual-family-session',
    assistantMessageID: 'assistant-dual',
    textID: 'text-1',
    delta: 'Native ',
  }, messageState, 'text')

  // Classic family for the same message must not double-append after native owns it.
  handleMessagePartDeltaEvent(win, collector.dispatch, {
    sessionID: 'dual-family-session',
    messageID: 'assistant-dual',
    partID: 'text-1',
    type: 'text',
    delta: 'Classic-dup',
  }, messageState)

  handleNativeToolEvent(win, collector.dispatch, 'session.next.tool.called', {
    sessionID: 'dual-family-session',
    assistantMessageID: 'assistant-dual',
    callID: 'call-dual',
    tool: 'bash',
    input: { command: 'echo hi' },
  }, messageState, 'openai/gpt-5')

  // Classic tool part with the same call id must not re-project.
  handleMessagePartUpdatedEvent(win, collector.dispatch, {
    sessionID: 'dual-family-session',
    messageID: 'assistant-dual',
    part: {
      type: 'tool',
      id: 'call-dual',
      callID: 'call-dual',
      sessionID: 'dual-family-session',
      messageID: 'assistant-dual',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'echo hi' },
        output: 'should-not-appear',
      },
    },
  }, messageState, 'openai/gpt-5')

  const textEvents = collector.events.filter((event) => {
    const data = (event as { data?: { type?: string; content?: string } }).data
    return data?.type === 'text'
  }) as Array<{ data: { content?: string } }>
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0]?.data.content, 'Native ')

  const toolEvents = collector.events.filter((event) => (event as { type?: string }).type === 'tool_call')
  // Only the native tool.called projection — not a second classic completion.
  assert.equal(toolEvents.length, 1)
})
