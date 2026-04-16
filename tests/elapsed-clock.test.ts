import test from 'node:test'
import assert from 'node:assert/strict'
import { formatElapsedMs, parseIsoToMs } from '../apps/desktop/src/renderer/components/chat/elapsed-clock-utils.ts'

test('formatElapsedMs renders sub-minute runs as seconds only', () => {
  assert.equal(formatElapsedMs(0), '0s')
  assert.equal(formatElapsedMs(900), '0s')
  assert.equal(formatElapsedMs(1_000), '1s')
  assert.equal(formatElapsedMs(59_999), '59s')
})

test('formatElapsedMs renders multi-minute runs as minutes and seconds', () => {
  assert.equal(formatElapsedMs(60_000), '1m 0s')
  assert.equal(formatElapsedMs(65_000), '1m 5s')
  assert.equal(formatElapsedMs(3_599_000), '59m 59s')
})

test('formatElapsedMs adds an hour field when the run exceeds 60 minutes', () => {
  assert.equal(formatElapsedMs(3_600_000), '1h 0m 0s')
  assert.equal(formatElapsedMs(3_661_000), '1h 1m 1s')
})

test('formatElapsedMs returns 0s for invalid or negative durations', () => {
  assert.equal(formatElapsedMs(Number.NaN), '0s')
  assert.equal(formatElapsedMs(-100), '0s')
  assert.equal(formatElapsedMs(Number.POSITIVE_INFINITY), '0s')
})

test('parseIsoToMs returns null for missing or malformed timestamps', () => {
  assert.equal(parseIsoToMs(null), null)
  assert.equal(parseIsoToMs(undefined), null)
  assert.equal(parseIsoToMs(''), null)
  assert.equal(parseIsoToMs('not a date'), null)
})

test('parseIsoToMs parses valid ISO strings to epoch millis', () => {
  assert.equal(parseIsoToMs('2026-04-16T18:00:00.000Z'), Date.parse('2026-04-16T18:00:00.000Z'))
})
