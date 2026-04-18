import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKFILL_PROGRESS_BATCH,
  FAST_BACKFILL_LIMIT,
  planDashboardBackfill,
  shouldEmitBackfillProgress,
} from '../apps/desktop/src/main/dashboard-summary.ts'

// Dashboard summary orchestrates a fast-path backfill for sessions
// whose usage summary hasn't been computed yet, deferring the rest to
// a background drainer. The IPC round-trip is tested at the behavior
// level in smoke tests; these tests pin the two correctness-critical
// properties of the scheduler: (1) the synchronous slice does not
// exceed `FAST_BACKFILL_LIMIT`, and (2) sessions in the failure memo
// are never re-queued.

type TestRecord = { id: string; summary: unknown }

function record(id: string, summary: unknown = null): TestRecord {
  return { id, summary }
}

test('FAST_BACKFILL_LIMIT pins the synchronous backfill budget at 3', () => {
  // The constant has drifted before (12 caused 3-5s first-paint stalls
  // for users with a legacy session backlog). Lock it to a test so a
  // future reviewer doesn't silently nudge it back up.
  assert.equal(FAST_BACKFILL_LIMIT, 3)
})

test('planDashboardBackfill slices the immediate batch to the limit and defers the rest', () => {
  const records = Array.from({ length: 10 }, (_, index) => record(`s-${index}`))
  const { immediate, deferred } = planDashboardBackfill(records, new Set())

  assert.equal(immediate.length, FAST_BACKFILL_LIMIT)
  assert.equal(deferred.length, records.length - FAST_BACKFILL_LIMIT)
  // Planner must preserve input order so callers can rely on "oldest
  // updated first" sort done by the caller.
  assert.deepEqual(immediate.map((r) => r.id), ['s-0', 's-1', 's-2'])
})

test('planDashboardBackfill skips records that already have a summary', () => {
  const records: TestRecord[] = [
    record('cached-1', { totals: {} }),
    record('missing-1'),
    record('cached-2', { totals: {} }),
    record('missing-2'),
  ]
  const { immediate, deferred } = planDashboardBackfill(records, new Set())

  const ids = [...immediate, ...deferred].map((r) => r.id)
  assert.deepEqual(ids, ['missing-1', 'missing-2'])
})

test('planDashboardBackfill skips sessions recorded in the persistent failure memo', () => {
  const records = [
    record('ok-1'),
    record('fails'),
    record('ok-2'),
  ]
  const knownFailures = new Set(['fails'])
  const { immediate, deferred } = planDashboardBackfill(records, knownFailures)

  const ids = [...immediate, ...deferred].map((r) => r.id)
  assert.deepEqual(ids, ['ok-1', 'ok-2'])
  assert.ok(!ids.includes('fails'), 'recorded failures must not be re-queued')
})

test('planDashboardBackfill produces empty batches when every record has a summary', () => {
  const records = [record('a', { totals: {} }), record('b', { totals: {} })]
  const { immediate, deferred } = planDashboardBackfill(records, new Set())
  assert.equal(immediate.length, 0)
  assert.equal(deferred.length, 0)
})

test('planDashboardBackfill is idempotent across repeated calls with the same inputs', () => {
  const records = Array.from({ length: 20 }, (_, index) => record(`s-${index}`))
  const failures = new Set<string>(['s-5', 's-15'])

  const first = planDashboardBackfill(records, failures)
  const second = planDashboardBackfill(records, failures)
  assert.deepEqual(
    first.immediate.map((r) => r.id),
    second.immediate.map((r) => r.id),
  )
  assert.deepEqual(
    first.deferred.map((r) => r.id),
    second.deferred.map((r) => r.id),
  )
})

test('planDashboardBackfill honors a custom limit override', () => {
  const records = Array.from({ length: 10 }, (_, index) => record(`s-${index}`))
  const { immediate, deferred } = planDashboardBackfill(records, new Set(), 5)
  assert.equal(immediate.length, 5)
  assert.equal(deferred.length, 5)
})

test('shouldEmitBackfillProgress does not flush before any success has landed', () => {
  assert.equal(shouldEmitBackfillProgress(0, 5), false)
  assert.equal(shouldEmitBackfillProgress(0, 0), false)
})

test('shouldEmitBackfillProgress flushes every Nth success during active drain', () => {
  // Cadence: 3 successes per emission (the constant is exercised directly
  // so it fails loudly if BACKFILL_PROGRESS_BATCH drifts out of sync).
  assert.equal(BACKFILL_PROGRESS_BATCH, 3)
  assert.equal(shouldEmitBackfillProgress(1, 10), false)
  assert.equal(shouldEmitBackfillProgress(2, 10), false)
  assert.equal(shouldEmitBackfillProgress(3, 10), true)
  assert.equal(shouldEmitBackfillProgress(4, 10), false)
  assert.equal(shouldEmitBackfillProgress(6, 10), true)
})

test('shouldEmitBackfillProgress always flushes when the pending queue drains', () => {
  assert.equal(shouldEmitBackfillProgress(1, 0), true)
  assert.equal(shouldEmitBackfillProgress(2, 0), true)
  assert.equal(shouldEmitBackfillProgress(5, 0), true)
})
