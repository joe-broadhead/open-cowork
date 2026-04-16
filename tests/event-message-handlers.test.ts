import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  handleMessagePartDeltaEvent,
  handleMessageUpdatedEvent,
  type PendingTextEvent,
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
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  const pending = new Map<string, PendingTextEvent[]>()
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
    messageRoles,
    pending,
  )

  assert.equal(collector.events.length, 0)
  assert.equal(pending.get('msg_1')?.length, 1)

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
    messageRoles,
    pending,
  )

  assert.equal(pending.has('msg_1'), false)
  assert.equal(collector.events.length, 1)
})

test('user-role message updates drop buffered text instead of dispatching it', () => {
  const win = {} as BrowserWindow
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  const pending = new Map<string, PendingTextEvent[]>()
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
    messageRoles,
    pending,
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
    messageRoles,
    pending,
  )

  assert.equal(pending.has('msg_user'), false)
  assert.equal(collector.events.length, 0)
})
