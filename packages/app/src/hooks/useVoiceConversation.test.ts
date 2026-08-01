import { act, renderHook, waitFor } from '@testing-library/react'
import type { PublicAppConfig, VoiceSessionSnapshot } from '@open-cowork/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installRendererTestCoworkApi } from '../test/setup'
import { createTestVoiceApi, createTestVoiceHostStatus } from '../test/voice-fixtures'
import { useVoiceConversation } from './useVoiceConversation'

const featureValueTelemetry = vi.hoisted(() => ({
  recordFeatureValueDiscovery: vi.fn(),
  recordFeatureValueActivation: vi.fn(),
}))

const supportFlags = {
  canVoiceCapture: true,
  canVoiceStt: true,
  canVoiceConversation: true,
  canPrompt: true,
  reasons: {
    voiceCapture: 'no capture',
    voiceStt: 'no stt',
    voiceConversation: 'no conversation',
    prompt: 'no prompt',
  },
}

vi.mock('../helpers/lazy-feature-value-telemetry', () => featureValueTelemetry)
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

describe('useVoiceConversation value telemetry', () => {
  beforeEach(() => {
    supportFlags.canVoiceCapture = true
    supportFlags.canVoiceStt = true
    supportFlags.canVoiceConversation = true
    supportFlags.canPrompt = true
    const baseConfig = window.coworkApi.app.config
    const readyStatus = createTestVoiceHostStatus()
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async (): Promise<PublicAppConfig> => ({
          ...(await baseConfig()),
          features: { voice: true },
        })),
      },
      voice: createTestVoiceApi({
        status: vi.fn(async () => readyStatus),
        startSession: vi.fn(async (): Promise<VoiceSessionSnapshot> => ({
          id: 'conversation-1',
          openCodeSessionId: 'ses_1',
          workspaceId: 'local',
          mode: 'conversation',
          phase: 'listening',
          startedAt: '2026-01-01T00:00:00.000Z',
        })),
        cancel: vi.fn(async () => readyStatus),
        cancelSpeak: vi.fn(async () => readyStatus),
      }),
    })
  })

  function renderConversation() {
    return renderHook(() => useVoiceConversation({
      openCodeSessionId: 'ses_1',
      onPrompt: vi.fn(async () => undefined),
      onAbort: vi.fn(async () => undefined),
    }))
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  it('discovers an eligible control and activates only after session start succeeds', async () => {
    const { result } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(featureValueTelemetry.recordFeatureValueDiscovery).toHaveBeenCalledWith('voice')

    await act(async () => {
      await result.current.toggle()
    })

    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())
    expect(featureValueTelemetry.recordFeatureValueActivation).toHaveBeenCalledWith('voice')
  })

  it('does not activate when the Voice host rejects session start', async () => {
    window.coworkApi.voice.startSession = vi.fn(async () => {
      throw new Error('host unavailable')
    })
    const { result } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      await result.current.toggle()
    })

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(featureValueTelemetry.recordFeatureValueActivation).not.toHaveBeenCalledWith('voice')
  })

  it('cancels listening and speech when the chat composer unmounts', async () => {
    const { result, unmount } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await act(async () => {
      await result.current.toggle()
    })
    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())

    unmount()

    await waitFor(() => expect(window.coworkApi.voice.cancel).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.voice.cancel).toHaveBeenCalledWith('conversation-1')
    expect(window.coworkApi.voice.cancelSpeak).toHaveBeenCalled()
  })

  it('cancels a deferred conversation capture that resolves after unmount', async () => {
    const pending = deferred<VoiceSessionSnapshot>()
    window.coworkApi.voice.startSession = vi.fn(() => pending.promise)
    const { result, unmount } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      void result.current.toggle()
    })
    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())
    unmount()
    pending.resolve({
      id: 'conversation-deferred',
      openCodeSessionId: 'ses_1',
      workspaceId: 'local',
      mode: 'conversation',
      phase: 'listening',
      startedAt: '2026-01-01T00:00:00.000Z',
    })

    await waitFor(() => expect(window.coworkApi.voice.cancel).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.voice.cancel).toHaveBeenCalledWith('conversation-deferred')
    expect(featureValueTelemetry.recordFeatureValueActivation).not.toHaveBeenCalledWith('voice')
  })

  it('cancels a deferred conversation capture when toggled off before startup completes', async () => {
    const pending = deferred<VoiceSessionSnapshot>()
    window.coworkApi.voice.startSession = vi.fn(() => pending.promise)
    const { result } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    await act(async () => {
      void result.current.toggle()
    })
    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())
    await act(async () => {
      await result.current.toggle()
    })
    expect(result.current.phase).toBe('idle')
    await act(async () => {
      await result.current.toggle()
    })
    expect(window.coworkApi.voice.startSession).toHaveBeenCalledTimes(1)

    pending.resolve({
      id: 'conversation-deferred',
      openCodeSessionId: 'ses_1',
      workspaceId: 'local',
      mode: 'conversation',
      phase: 'listening',
      startedAt: '2026-01-01T00:00:00.000Z',
    })

    await waitFor(() => expect(window.coworkApi.voice.cancel).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.voice.cancel).toHaveBeenCalledWith('conversation-deferred')
    expect(featureValueTelemetry.recordFeatureValueActivation).not.toHaveBeenCalledWith('voice')
  })

  it('cancels conversation capture when the owning chat session changes', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useVoiceConversation({
        openCodeSessionId: sessionId,
        onPrompt: vi.fn(async () => undefined),
        onAbort: vi.fn(async () => undefined),
      }),
      { initialProps: { sessionId: 'ses_1' } },
    )
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await act(async () => {
      await result.current.toggle()
    })
    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())

    rerender({ sessionId: 'ses_2' })

    await waitFor(() => expect(window.coworkApi.voice.cancel).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.voice.cancel).toHaveBeenCalledWith('conversation-1')
    expect(result.current.phase).toBe('idle')
  })

  it('cancels conversation capture when Voice eligibility is lost', async () => {
    const { result, rerender } = renderConversation()
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await act(async () => {
      await result.current.toggle()
    })
    await waitFor(() => expect(window.coworkApi.voice.startSession).toHaveBeenCalled())

    supportFlags.canVoiceConversation = false
    rerender()

    await waitFor(() => expect(window.coworkApi.voice.cancel).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.voice.cancel).toHaveBeenCalledWith('conversation-1')
    expect(result.current.visible).toBe(false)
    expect(result.current.phase).toBe('idle')
  })
})
