import { describe, expect, it } from 'vitest'
import { formatElapsedMs, parseIsoToMs } from './elapsed-clock-utils'

describe('formatElapsedMs', () => {
  it('renders invalid and sub-minute durations safely', () => {
    expect(formatElapsedMs(Number.NaN)).toBe('0s')
    expect(formatElapsedMs(-1)).toBe('0s')
    expect(formatElapsedMs(Number.POSITIVE_INFINITY)).toBe('0s')
    expect(formatElapsedMs(999)).toBe('0s')
    expect(formatElapsedMs(59_999)).toBe('59s')
  })

  it('renders minute and hour durations without rounding up', () => {
    expect(formatElapsedMs(60_000)).toBe('1m 0s')
    expect(formatElapsedMs(65_000)).toBe('1m 5s')
    expect(formatElapsedMs(3_599_999)).toBe('59m 59s')
    expect(formatElapsedMs(3_661_000)).toBe('1h 1m 1s')
  })
})

describe('parseIsoToMs', () => {
  it('returns null for missing or malformed timestamps', () => {
    expect(parseIsoToMs(null)).toBeNull()
    expect(parseIsoToMs(undefined)).toBeNull()
    expect(parseIsoToMs('')).toBeNull()
    expect(parseIsoToMs('not-a-date')).toBeNull()
  })

  it('parses ISO timestamps to epoch milliseconds', () => {
    expect(parseIsoToMs('2026-05-09T12:34:56.000Z')).toBe(Date.parse('2026-05-09T12:34:56.000Z'))
  })
})
