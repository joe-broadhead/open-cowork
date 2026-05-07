import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeNotification } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { useOpenCodeEvents } from './useOpenCodeEvents'

function Harness() {
  useOpenCodeEvents()
  return null
}

describe('useOpenCodeEvents', () => {
  let notify: ((event: RuntimeNotification) => void) | null = null
  let closeAudioContext: ReturnType<typeof vi.fn>

  beforeEach(() => {
    notify = null
    closeAudioContext = vi.fn(async () => undefined)

    class TestAudioContext {
      currentTime = 0
      destination = {}
      close = closeAudioContext

      createOscillator() {
        return {
          connect: vi.fn(),
          frequency: { value: 0 },
          start: vi.fn(),
          stop: vi.fn(),
          type: 'sine',
        }
      }

      createGain() {
        return {
          connect: vi.fn(),
          gain: {
            value: 0,
            exponentialRampToValueAtTime: vi.fn(),
          },
        }
      }
    }

    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: TestAudioContext,
    })
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: TestAudioContext,
    })

    installRendererTestCoworkApi({
      on: {
        authExpired: vi.fn(() => vi.fn()),
        authLogout: vi.fn(() => vi.fn()),
        mcpStatus: vi.fn(() => vi.fn()),
        notification: vi.fn((callback: (event: RuntimeNotification) => void) => {
          notify = callback
          return vi.fn()
        }),
        permissionRequest: vi.fn(() => vi.fn()),
        sessionDeleted: vi.fn(() => vi.fn()),
        sessionPatch: vi.fn(() => vi.fn()),
        sessionUpdated: vi.fn(() => vi.fn()),
        sessionView: vi.fn(() => vi.fn()),
      },
    })
  })

  it('closes the notification AudioContext after the final hook unmounts', () => {
    const first = render(<Harness />)
    const second = render(<Harness />)

    act(() => {
      notify?.({ type: 'done' })
    })

    expect(closeAudioContext).not.toHaveBeenCalled()

    first.unmount()
    expect(closeAudioContext).not.toHaveBeenCalled()

    second.unmount()
    expect(closeAudioContext).toHaveBeenCalledTimes(1)
  })
})
