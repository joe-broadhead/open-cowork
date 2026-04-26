import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getRuntimeNotification,
  getSessionPatch,
  shouldPublishSessionView,
} from '../apps/desktop/src/main/session-event-dispatcher.ts'

function eventOf(type: string, sessionId?: string | null) {
  return {
    type,
    sessionId: sessionId ?? null,
    data: { type },
  }
}

test('dispatcher derives renderer-safe text patches', () => {
  assert.deepEqual(getSessionPatch({
    type: 'text',
    sessionId: 'session-1',
    data: {
      type: 'text',
      messageId: 'msg-1',
      partId: 'part-1',
      content: 'Hello',
      mode: 'append',
      role: 'assistant',
    },
  }), {
    type: 'message_text',
    sessionId: 'session-1',
    messageId: 'msg-1',
    segmentId: 'part-1',
    content: 'Hello',
    mode: 'append',
    role: 'assistant',
    attachments: undefined,
    eventAt: 0,
  })

  assert.deepEqual(getSessionPatch({
    type: 'text',
    sessionId: 'session-1',
    data: {
      type: 'text',
      taskRunId: 'task-1',
      partId: 'task-part-1',
      content: 'Working',
      mode: 'replace',
    },
  }), {
    type: 'task_text',
    sessionId: 'session-1',
    taskRunId: 'task-1',
    segmentId: 'task-part-1',
    content: 'Working',
    mode: 'replace',
    eventAt: 0,
  })

  assert.equal(getSessionPatch(eventOf('done', 'session-1')), null)
  assert.equal(getSessionPatch(eventOf('error')), null)
})

test('dispatcher publishes session views for non-text session state transitions', () => {
  assert.equal(shouldPublishSessionView(eventOf('text', 'session-1')), false)
  assert.equal(shouldPublishSessionView(eventOf('history_refresh', 'session-1')), false)
  assert.equal(shouldPublishSessionView(eventOf('busy', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('tool_call', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('error', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('done', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('busy')), false)
})

test('dispatcher derives notifications for completion and global errors', () => {
  assert.deepEqual(getRuntimeNotification(eventOf('done', 'session-1')), {
    type: 'done',
    sessionId: 'session-1',
    synthetic: false,
  })

  assert.deepEqual(getRuntimeNotification({
    type: 'done',
    sessionId: 'session-2',
    data: { type: 'done', synthetic: true },
  }), {
    type: 'done',
    sessionId: 'session-2',
    synthetic: true,
  })

  assert.deepEqual(getRuntimeNotification({
    type: 'error',
    sessionId: null,
    data: { type: 'error', message: 'Runtime disconnected' },
  }), {
    type: 'error',
    sessionId: null,
    message: 'Runtime disconnected',
  })

  assert.equal(getRuntimeNotification(eventOf('error', 'session-1')), null)
  assert.equal(getRuntimeNotification(eventOf('busy', 'session-1')), null)
})
