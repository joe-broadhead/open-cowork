import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_SEEN_COST_EVENT_IDS_PER_SESSION,
  SessionCostEventTracker,
} from '../apps/desktop/src/main/session-cost-event-tracker.ts'

test('session cost event tracker treats missing ids as non-deduped events', () => {
  const tracker = new SessionCostEventTracker()

  assert.equal(tracker.mark('session-a'), true)
  assert.equal(tracker.mark('session-a', null), true)
})

test('session cost event tracker dedupes event ids per session', () => {
  const tracker = new SessionCostEventTracker()

  assert.equal(tracker.mark('session-a', 'cost-1'), true)
  assert.equal(tracker.mark('session-a', 'cost-1'), false)
  assert.equal(tracker.mark('session-b', 'cost-1'), true)
})

test('session cost event tracker bounds remembered ids and evicts the oldest', () => {
  const tracker = new SessionCostEventTracker()

  for (let index = 0; index <= MAX_SEEN_COST_EVENT_IDS_PER_SESSION; index += 1) {
    assert.equal(tracker.mark('session-a', `cost-${index}`), true)
  }

  assert.equal(tracker.mark('session-a', 'cost-0'), true)
  assert.equal(tracker.mark('session-a', `cost-${MAX_SEEN_COST_EVENT_IDS_PER_SESSION}`), false)
})

test('session cost event tracker can forget all ids for a session', () => {
  const tracker = new SessionCostEventTracker()

  assert.equal(tracker.mark('session-a', 'cost-1'), true)
  assert.equal(tracker.mark('session-a', 'cost-1'), false)

  tracker.forgetSession('session-a')

  assert.equal(tracker.mark('session-a', 'cost-1'), true)
})
