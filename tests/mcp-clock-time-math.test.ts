import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MS_PER_DAY,
  addDurationMs,
  assertTimeZone,
  systemTimeZone,
  textResult,
} from '../mcps/clock/src/time-math.ts'

test('clock time-math pure helpers (JOE-871)', () => {
  assert.equal(addDurationMs(0, { days: 1 }), MS_PER_DAY)
  assert.equal(addDurationMs(1000, { seconds: 2, milliseconds: 5 }), 3005)
  assert.ok(systemTimeZone().length > 0)
  assert.equal(assertTimeZone('UTC'), 'UTC')
  assert.throws(() => assertTimeZone('Not/A_Zone'), /Invalid IANA/)
  const payload = textResult({ ok: true })
  assert.equal(payload.content[0]?.type, 'text')
  assert.match(payload.content[0]!.text, /"ok":true/)
})
