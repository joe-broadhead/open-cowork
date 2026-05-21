import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  createSessionScopedMessageState,
  handleMessagePartDeltaEvent,
  handleMessageUpdatedEvent,
} from '../apps/desktop/src/main/event-message-handlers.ts'

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
