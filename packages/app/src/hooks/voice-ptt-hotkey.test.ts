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

  it('matches CmdOrCtrl with only the platform-specific modifier', () => {
    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT, 'MacIntel')).toBe(true)

    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT, 'MacIntel')).toBe(false)

    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT, 'MacIntel')).toBe(false)

    for (const platform of ['Win32', 'Linux x86_64']) {
      expect(matchesAccelerator({
        key: ' ',
        code: 'Space',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      }, VOICE_PTT_SHORTCUT, platform)).toBe(true)

      expect(matchesAccelerator({
        key: ' ',
        code: 'Space',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }, VOICE_PTT_SHORTCUT, platform)).toBe(false)

      expect(matchesAccelerator({
        key: ' ',
        code: 'Space',
        metaKey: true,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      }, VOICE_PTT_SHORTCUT, platform)).toBe(false)
    }

    // Missing shift
    expect(matchesAccelerator({
      key: ' ',
      code: 'Space',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }, VOICE_PTT_SHORTCUT, 'MacIntel')).toBe(false)

    // Command palette binding must not match
    expect(matchesAccelerator({
      key: 'p',
      code: 'KeyP',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }, VOICE_PTT_SHORTCUT, 'MacIntel')).toBe(false)
  })

  it('keeps explicit Command and Control accelerators platform-independent and exact', () => {
    expect(matchesAccelerator({
      key: 'ArrowUp',
      code: 'ArrowUp',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    }, 'Command+Alt+Up', 'Win32')).toBe(true)

    expect(matchesAccelerator({
      key: 'Escape',
      code: 'Escape',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    }, 'Control+Esc', 'MacIntel')).toBe(true)

    expect(matchesAccelerator({
      key: '!',
      code: 'Digit1',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
    }, 'Control+Shift+1', 'Linux x86_64')).toBe(true)

    expect(matchesAccelerator({
      key: 'v',
      code: 'KeyV',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }, 'Control+V', 'Linux x86_64')).toBe(false)

    expect(matchesAccelerator({
      key: 'ArrowUp',
      code: 'ArrowUp',
      metaKey: true,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    }, 'Command+Alt+Up', 'MacIntel')).toBe(false)
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
