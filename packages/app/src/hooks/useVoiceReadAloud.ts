/**
 * React binding for host-owned read-aloud (JOE-1103).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { isDesktopFeatureEnabled, type DesktopFeatureFlags } from '@open-cowork/shared'
import { isDesktopRuntime } from '../runtime-env'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import {
  canUseVoiceReadAloud,
  enqueueReadAloud,
  getVoiceReadAloudState,
  skipReadAloud,
  stopReadAloud,
  subscribeVoiceReadAloud,
  type VoiceReadAloudState,
} from './voice-read-aloud'

export type VoiceReadAloudController = {
  /** Feature + Desktop Local TTS authority. */
  visible: boolean
  enabled: boolean
  disabledReason: string | null
  state: VoiceReadAloudState
  isSpeakingMessage: (messageId: string) => boolean
  speakMessage: (messageId: string, text: string) => void
  stop: () => Promise<void>
  skip: () => Promise<void>
  toggleMessage: (messageId: string, text: string) => void
}

export function useVoiceReadAloud(): VoiceReadAloudController {
  const workspaceSupport = useActiveWorkspaceSupport()
  const [features, setFeatures] = useState<DesktopFeatureFlags | undefined>(undefined)
  const [ttsReady, setTtsReady] = useState(false)
  const [hostDetail, setHostDetail] = useState<string | null>(null)
  const state = useSyncExternalStore(subscribeVoiceReadAloud, getVoiceReadAloudState, getVoiceReadAloudState)

  useEffect(() => {
    if (!isDesktopRuntime() || !window.coworkApi?.app?.config) return
    let cancelled = false
    void window.coworkApi.app.config().then((config) => {
      if (!cancelled) setFeatures(config.features)
    }).catch(() => {
      if (!cancelled) setFeatures({})
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime() || !window.coworkApi?.voice) return
    let cancelled = false
    void window.coworkApi.voice.status().then((status) => {
      if (cancelled) return
      setTtsReady(status.tts.ready === true)
      setHostDetail(status.tts.detail || status.reason || null)
    }).catch(() => {
      if (!cancelled) {
        setTtsReady(false)
        setHostDetail(null)
      }
    })
    const unsub = window.coworkApi.on?.voiceEvent?.((event) => {
      if (event.type !== 'status') return
      setTtsReady(event.status.tts.ready === true)
      setHostDetail(event.status.tts.detail || event.status.reason || null)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const desktop = isDesktopRuntime()
  const featureOn = isDesktopFeatureEnabled(features, 'voice')
  const authorityOk = workspaceSupport.flags.canVoiceTts
  const visible = canUseVoiceReadAloud({
    desktop,
    features,
    canVoiceTts: authorityOk,
  })
  const enabled = visible && ttsReady

  let disabledReason: string | null = null
  if (!desktop) disabledReason = 'Private voice is Desktop only.'
  else if (!featureOn) disabledReason = 'Private voice is off. Enable features.voice in open-cowork.config.json.'
  else if (!authorityOk) {
    disabledReason = workspaceSupport.flags.reasons.voiceTts
      || 'Private text-to-speech is not supported in this workspace.'
  } else if (!ttsReady) {
    disabledReason = hostDetail || 'Local text-to-speech is not ready on this machine.'
  }

  const speakMessage = useCallback((messageId: string, text: string) => {
    if (!enabled) return
    enqueueReadAloud(messageId, text)
  }, [enabled])

  const stop = useCallback(async () => {
    await stopReadAloud()
  }, [])

  const skip = useCallback(async () => {
    await skipReadAloud()
  }, [])

  const isSpeakingMessage = useCallback((messageId: string) => (
    state.phase === 'speaking' && state.messageId === messageId
  ), [state.messageId, state.phase])

  const toggleMessage = useCallback((messageId: string, text: string) => {
    if (isSpeakingMessage(messageId)) {
      void stop()
      return
    }
    speakMessage(messageId, text)
  }, [isSpeakingMessage, speakMessage, stop])

  return {
    visible,
    enabled,
    disabledReason: enabled ? null : disabledReason,
    state,
    isSpeakingMessage,
    speakMessage,
    stop,
    skip,
    toggleMessage,
  }
}
