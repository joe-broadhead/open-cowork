import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
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
  let listeners: Array<(event: unknown) => void>
  let composerText: string

  beforeEach(() => {
    supportFlags.canVoiceCapture = true
    supportFlags.canVoiceStt = true
    supportFlags.canPrompt = true
    listeners = []
    composerText = 'Draft: '
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
          tts: { engine: 'system_os', ready: false, detail: null },
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
            tts: { engine: 'system_os', ready: false },
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
          tts: { engine: 'system_os', ready: false },
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
    // @ts-expect-error test double
    window.coworkApi.voice.stopSession = vi.fn(async () => ({
      enabled: true,
      phase: 'ready',
      captureMode: 'voice_host',
      stt: { engine: 'aurum_local', ready: true },
      tts: { engine: 'system_os', ready: false },
      permissions: { microphone: 'granted' },
      reason: null,
      sessionId: null,
    }))

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
    // @ts-expect-error test double
    window.coworkApi.app.config = vi.fn(async () => ({ features: {} }))
    const { result } = renderHook(() => useVoicePtt({
      getComposerText: () => '',
      setComposerText: vi.fn(),
    }))
    await waitFor(() => expect(result.current.visible).toBe(false))
  })
})
