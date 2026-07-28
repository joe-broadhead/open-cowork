import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type {
  CoworkAPI,
  PublicAppConfig,
  VoiceHostEvent,
  VoiceHostStatus,
  VoiceSessionSnapshot,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { createTestVoiceApi, createTestVoiceHostStatus } from '../test/voice-fixtures'
import { appendDictation, useVoicePtt } from './useVoicePtt'

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

describe('appendDictation', () => {
  it('joins baseline and segment with a single space', () => {
    expect(appendDictation('hello', 'world')).toBe('hello world')
    expect(appendDictation('hello ', 'world')).toBe('hello world')
    expect(appendDictation('', 'world')).toBe('world')
    expect(appendDictation('hello', '')).toBe('hello')
  })
})

describe('useVoicePtt', () => {
  let listeners: Array<(event: VoiceHostEvent) => void>
  let composerText: string

  beforeEach(() => {
    supportFlags.canVoiceCapture = true
    supportFlags.canVoiceStt = true
    supportFlags.canPrompt = true
    listeners = []
    composerText = 'Draft: '
    const baseConfig = window.coworkApi.app.config
    const readyStatus = createTestVoiceHostStatus({
      tts: { engine: 'system_os', ready: false, detail: null },
      capture: {
        backend: 'fake',
        detail: 'fake',
        sampleRate: 16000,
        channels: 1,
        frames: 0,
        durationSeconds: 0,
        peak: 0,
      },
    })
    const idleStatus = createTestVoiceHostStatus({
      tts: { engine: 'system_os', ready: false },
    })
    const voiceEvent: CoworkAPI['on']['voiceEvent'] = (callback) => {
      listeners.push(callback)
      return () => {
        const index = listeners.indexOf(callback)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async (): Promise<PublicAppConfig> => ({
          ...(await baseConfig()),
          features: { voice: true },
        })),
      },
      voice: createTestVoiceApi({
        status: vi.fn(async (): Promise<VoiceHostStatus> => readyStatus),
        startSession: vi.fn(async (): Promise<VoiceSessionSnapshot> => ({
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
          return idleStatus
        }),
        cancel: vi.fn(async (): Promise<VoiceHostStatus> => idleStatus),
      }),
      on: { voiceEvent },
    })
  })

  function renderVoicePtt() {
    return renderHook(() => useVoicePtt({
      openCodeSessionId: 'ses_1',
      getComposerText: () => composerText,
      setComposerText: (text) => {
        composerText = text
      },
    }))
  }

  it('toggles listening and replaces baseline with final text', async () => {
    const { result } = renderVoicePtt()

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
    expect(composerText).toBe('Draft: hello dictated')
  })

  it('applies partials against the baseline and final replaces the segment', async () => {
    // Don't auto-emit final from stop — drive events manually.
    window.coworkApi.voice.stopSession = vi.fn(async (): Promise<VoiceHostStatus> => (
      createTestVoiceHostStatus({
        tts: { engine: 'system_os', ready: false },
      })
    ))

    const { result } = renderVoicePtt()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      await result.current.toggle()
    })

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: 'partial',
          event: {
            sessionId: 'voice-1',
            text: 'hello',
            isFinal: false,
            at: new Date().toISOString(),
          },
        })
      }
    })
    expect(composerText).toBe('Draft: hello')

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: 'partial',
          event: {
            sessionId: 'voice-1',
            text: 'hello world',
            isFinal: false,
            at: new Date().toISOString(),
          },
        })
      }
    })
    // Second partial replaces the dictation segment (no double append).
    expect(composerText).toBe('Draft: hello world')

    await act(async () => {
      await result.current.toggle()
      for (const listener of listeners) {
        listener({
          type: 'final',
          event: {
            sessionId: 'voice-1',
            text: 'hello world final',
            isFinal: true,
            at: new Date().toISOString(),
          },
        })
      }
    })
    expect(composerText).toBe('Draft: hello world final')
  })

  it('restores baseline on cancel after partials', async () => {
    const { result } = renderVoicePtt()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      await result.current.toggle()
    })

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: 'partial',
          event: {
            sessionId: 'voice-1',
            text: 'scratch this',
            isFinal: false,
            at: new Date().toISOString(),
          },
        })
      }
    })
    expect(composerText).toBe('Draft: scratch this')

    await act(async () => {
      await result.current.cancel()
    })
    expect(window.coworkApi.voice.cancel).toHaveBeenCalled()
    expect(composerText).toBe('Draft: ')
    expect(result.current.phase).toBe('idle')
  })

  it('hides when features.voice is off', async () => {
    const baseConfig = window.coworkApi.app.config
    window.coworkApi.app.config = vi.fn(async (): Promise<PublicAppConfig> => ({
      ...(await baseConfig()),
      features: {},
    }))
    const { result } = renderHook(() => useVoicePtt({
      getComposerText: () => '',
      setComposerText: vi.fn(),
    }))
    await waitFor(() => expect(result.current.visible).toBe(false))
  })
})
