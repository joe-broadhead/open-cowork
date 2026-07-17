import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceDurableCursor,
  durableAfterCursor,
  isTrackedTerminalEventType,
  isTrackedTranscriptEventType,
  readDurableSequenceFromEvent,
  shouldSuppressGlobalEventForTrackedSession,
} from '../packages/runtime-host/src/opencode-durable-session-events.ts'
import {
  __testShouldSuppress,
  __testTrackSession,
  resetDurableSessionHubsForTests,
} from '../apps/desktop/src/main/durable-session-events.ts'

test('durableAfterCursor prefers last observed sequence over admission', () => {
  assert.equal(durableAfterCursor({ lastSequence: 12, admittedSeq: 7 }), '12')
  assert.equal(durableAfterCursor({ lastSequence: -1, admittedSeq: 7 }), '6')
  assert.equal(durableAfterCursor({ lastSequence: null, admittedSeq: 1 }), '0')
  assert.equal(durableAfterCursor({ lastSequence: null, admittedSeq: 0 }), undefined)
  assert.equal(durableAfterCursor({}), undefined)
})

test('readDurableSequenceFromEvent reads nested durable.seq', () => {
  assert.equal(readDurableSequenceFromEvent({
    type: 'session.next.text.delta',
    durable: { seq: 4, aggregateID: 'agg' },
  }), 4)
  assert.equal(readDurableSequenceFromEvent({
    payload: {
      type: 'message.part.delta',
      durable: { seq: 9 },
    },
  }), 9)
  assert.equal(readDurableSequenceFromEvent({ type: 'session.idle' }), null)
})

test('advanceDurableCursor ignores stale sequences', () => {
  const cursor = { lastSequence: 5, after: '5' }
  assert.deepEqual(
    advanceDurableCursor(cursor, { durable: { seq: 3 } }),
    cursor,
  )
  assert.deepEqual(
    advanceDurableCursor(cursor, { durable: { seq: 8 } }),
    { lastSequence: 8, after: '8' },
  )
})

test('tracked transcript and terminal predicates cover classic and native families', () => {
  assert.equal(isTrackedTranscriptEventType('session.next.text.delta'), true)
  assert.equal(isTrackedTranscriptEventType('message.part.updated'), true)
  assert.equal(isTrackedTranscriptEventType('permission.v2.asked'), false)
  assert.equal(isTrackedTerminalEventType('session.idle'), true)
  assert.equal(isTrackedTerminalEventType('session.status', 'idle'), true)
  assert.equal(isTrackedTerminalEventType('session.status', 'busy'), false)
})

test('global suppress only applies to tracked sessions for transcript and idle', () => {
  assert.equal(
    shouldSuppressGlobalEventForTrackedSession(true, 'session.next.tool.called'),
    true,
  )
  assert.equal(
    shouldSuppressGlobalEventForTrackedSession(true, 'message.part.delta'),
    true,
  )
  assert.equal(
    shouldSuppressGlobalEventForTrackedSession(true, 'session.status', 'idle'),
    true,
  )
  assert.equal(
    shouldSuppressGlobalEventForTrackedSession(true, 'permission.v2.asked'),
    false,
  )
  assert.equal(
    shouldSuppressGlobalEventForTrackedSession(false, 'session.next.text.delta'),
    false,
  )
})

test('desktop durable hub suppresses global transcript once a session is admitted', () => {
  resetDurableSessionHubsForTests()
  try {
    __testTrackSession(null, 'ses_1', 7)
    assert.equal(__testShouldSuppress(null, 'ses_1', 'session.next.text.delta'), true)
    assert.equal(__testShouldSuppress(null, 'ses_1', 'message.part.updated'), true)
    assert.equal(__testShouldSuppress(null, 'ses_1', 'permission.v2.asked'), false)
    assert.equal(__testShouldSuppress(null, 'ses_other', 'session.next.text.delta'), false)
  } finally {
    resetDurableSessionHubsForTests()
  }
})
