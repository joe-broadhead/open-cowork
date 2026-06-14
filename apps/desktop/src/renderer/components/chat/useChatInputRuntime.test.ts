import { describe, expect, it } from 'vitest'
import { isMentionableCustomAgent } from './useChatInputRuntime'

describe('isMentionableCustomAgent', () => {
  it('keeps only enabled valid subagents in the @mention catalog', () => {
    expect(isMentionableCustomAgent({ enabled: true, valid: true, mode: 'subagent' })).toBe(true)
    expect(isMentionableCustomAgent({ enabled: true, valid: true, mode: 'primary' })).toBe(false)
    expect(isMentionableCustomAgent({ enabled: false, valid: true, mode: 'subagent' })).toBe(false)
    expect(isMentionableCustomAgent({ enabled: true, valid: false, mode: 'subagent' })).toBe(false)
  })
})
