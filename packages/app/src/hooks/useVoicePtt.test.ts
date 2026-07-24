import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useVoicePtt } from './useVoicePtt'

const supportFlags = {
  canVoiceCapture: true,
  canVoiceStt: true,
  canPrompt: true,
  reasons: {
    voiceCapture: 'no capture',
    voiceStt: 'no stt',
    prompt: 'no prompt',
  },
}

vi.mock('../stores/workspace-support', () => ({
  useActiveWorkspaceSupport: () => ({
    workspaceId: 'local',
    isLocal: true,
    flags: supportFlags,
  }),
}))

vi.mock('../runtime-env', () => ({
  isDesktopRuntime: () => true,
}))

describe('useVoicePtt', () => {
  beforeEach(() => {
    supportFlags.canVoiceCapture = true
    supportFlags.canVoiceStt = true
    supportFlags.canPrompt = true
    const listeners: Array<(event: unknown) => void> = []
    // @ts-expect-error test double
    window.coworkApi = {
      app: {
        config: vi.fn(async () => ({ features: { voice: true } })),
      },
      voice: {
        status: vi.fn(async () => ({
          enabled: true,
          phase: 'ready',
          captureMode: 'voice_host',
          stt: { engine: 'aurum_local', ready: true, detail: 'ok' },
          tts: { engine: 'sibling', ready: false, detail: null },
          permissions: { microphone: 'granted' },
          reason: null,
          sessionId: null,
          capture: {
            backend: 'fake',
            detail: 'fake',
            sampleRate: 16000,
            channels: 1,
            frames: 0,
            durationSeconds: 0,
            peak: 0,
          },
        })),
        startSession: vi.fn(async () => ({
          id: 'voice-1',
          openCodeSessionId: null,
          workspaceId: 'local',
          mode: 'ptt',
          phase: 'listening',
          startedAt: new Date().toISOString(),
        })),
        stopSession: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: 'final',
              event: {
                sessionId: 'voice-1',
                text: 'hello dictated',
                isFinal: true,
                at: new Date().toISOString(),
              },
            })
          }
          return {
            enabled: true,
            phase: 'ready',
            captureMode: 'voice_host',
            stt: { engine: 'aurum_local', ready: true },
            tts: { engine: 'sibling', ready: false },
            permissions: { microphone: 'granted' },
            reason: null,
            sessionId: null,
          }
        }),
        cancel: vi.fn(async () => ({
          enabled: true,
          phase: 'ready',
          captureMode: 'voice_host',
          stt: { engine: 'aurum_local', ready: true },
          tts: { engine: 'sibling', ready: false },
          permissions: { microphone: 'granted' },
          reason: null,
          sessionId: null,
        })),
      },
      on: {
        voiceEvent: (callback: (event: unknown) => void) => {
          listeners.push(callback)
          return () => {
            const index = listeners.indexOf(callback)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
      },
    }
  })

  it('toggles listening and injects final text', async () => {
    const onFinalText = vi.fn()
    const { result } = renderHook(() => useVoicePtt({
      openCodeSessionId: 'ses_1',
      onFinalText,
    }))

    await waitFor(() => expect(result.current.visible).toBe(true))
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      await result.current.toggle()
    })
    expect(window.coworkApi.voice.startSession).toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')

    await act(async () => {
      await result.current.toggle()
    })
    expect(window.coworkApi.voice.stopSession).toHaveBeenCalled()
    expect(onFinalText).toHaveBeenCalledWith('hello dictated')
  })

  it('hides when features.voice is off', async () => {
    // @ts-expect-error test double
    window.coworkApi.app.config = vi.fn(async () => ({ features: {} }))
    const { result } = renderHook(() => useVoicePtt({
      onFinalText: vi.fn(),
    }))
    await waitFor(() => expect(result.current.visible).toBe(false))
  })
})
