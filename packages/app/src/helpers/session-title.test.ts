import { describe, expect, it } from 'vitest'
import { displaySessionTitle } from './session-title'

describe('displaySessionTitle', () => {
  it('passes user and history-derived titles through unchanged', () => {
    expect(displaySessionTitle({ title: 'Fix the perf gate', createdAt: '2026-07-17T09:24:11.216Z' }))
      .toBe('Fix the perf gate')
    // Titles that merely mention the SDK default are not defaults.
    expect(displaySessionTitle({ title: 'New session planning doc' }))
      .toBe('New session planning doc')
  })

  it('returns null for missing or blank titles so callers keep their fallbacks', () => {
    expect(displaySessionTitle({ title: null })).toBeNull()
    expect(displaySessionTitle({ title: '   ' })).toBeNull()
    expect(displaySessionTitle({})).toBeNull()
  })

  it('humanizes SDK default titles using the embedded timestamp', () => {
    const result = displaySessionTitle({ title: 'New session - 2026-07-17T09:24:11.216Z' })
    expect(result).toMatch(/^New chat · /)
    expect(result).not.toContain('2026-07-17T')
  })

  it('falls back to createdAt when the default title has no timestamp', () => {
    const result = displaySessionTitle({ title: 'New session', createdAt: '2026-07-17T09:24:11.216Z' })
    expect(result).toMatch(/^New chat · /)
  })

  it('degrades to a plain label when no timestamp is available', () => {
    expect(displaySessionTitle({ title: 'New session' })).toBe('New chat')
    expect(displaySessionTitle({ title: 'New session', createdAt: 'not-a-date' })).toBe('New chat')
  })
})
