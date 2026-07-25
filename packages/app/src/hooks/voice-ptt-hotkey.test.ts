import { describe, expect, it, vi } from 'vitest'
import {
  matchesAccelerator,
  normalizeAccelerator,
  registerVoicePttToggleHandler,
  requestVoicePttToggle,
} from './voice-ptt-hotkey'
import { VOICE_PTT_SHORTCUT } from '@open-cowork/shared'

describe('voice-ptt-hotkey', () => {
  it('normalizes empty accelerators to the default', () => {
    expect(normalizeAccelerator('')).toBe(VOICE_PTT_SHORTCUT)
    expect(normalizeAccelerator(null)).toBe(VOICE_PTT_SHORTCUT)
    expect(normalizeAccelerator(' CmdOrCtrl + Shift + V ')).toBe('CmdOrCtrl+Shift+V')
  })

  it('matches CmdOrCtrl+Shift+Space', () => {
    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT)).toBe(true)

    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT)).toBe(true)

    // Missing shift
    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }, VOICE_PTT_SHORTCUT)).toBe(false)

    // Command palette binding must not match
    expect(matchesAccelerator({
      key: 'p',
      code: 'KeyP',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT)).toBe(false)
  })

  it('invokes the last registered toggle handler', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsub1 = registerVoicePttToggleHandler(first)
    const unsub2 = registerVoicePttToggleHandler(second)
    expect(await requestVoicePttToggle()).toBe(true)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    unsub2()
    expect(await requestVoicePttToggle()).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    unsub1()
    expect(await requestVoicePttToggle()).toBe(false)
  })
})
