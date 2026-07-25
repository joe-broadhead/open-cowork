/**
 * PTT-gated private voice conversation driver (JOE-1107).
 *
 * Owns orchestration only: host listen/stop + session.prompt/abort + local TTS.
 * State transitions come from the pure machine.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isDesktopFeatureEnabled,
  type DesktopFeatureFlags,
  type VoiceHostEvent,
} from '@open-cowork/shared'
import { isDesktopRuntime } from '../runtime-env'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { useSessionStore } from '../stores/session'
import { registerVoicePttToggleHandler } from './voice-ptt-hotkey'
import { plainTextForTts, stopReadAloud } from './voice-read-aloud'
import {
  createInitialVoiceConversationState,
  reduceVoiceConversation,
  voiceConversationChromePhase,
  voiceConversationStatusLabel,
  type VoiceConversationEffect,
  type VoiceConversationEvent,
  type VoiceConversationPhase,
  type VoiceConversationState,
} from './voice-conversation-machine'

export type VoiceConversationController = {
  visible: boolean
  enabled: boolean
  disabledReason: string | null
  phase: VoiceConversationPhase
  chromePhase: ReturnType<typeof voiceConversationChromePhase>
  statusLabel: string | null
  isActive: boolean
  conversationMode: boolean
  setConversationMode: (on: boolean) => void
  toggle: () => Promise<void>
  cancel: () => Promise<void>
}

export function useVoiceConversation(options: {
  openCodeSessionId?: string | null
  /** Send user utterance to the agent (session.prompt). */
  onPrompt: (text: string) => Promise<void>
  /** Abort in-flight generation (session.abort). */
  onAbort: () => Promise<void>
  onError?: (message: string) => void
}): VoiceConversationController {
  const workspaceSupport = useActiveWorkspaceSupport()
  const [features, setFeatures] = useState<DesktopFeatureFlags | undefined>(undefined)
  const [hostReady, setHostReady] = useState(false)
  const [hostDetail, setHostDetail] = useState<string | null>(null)
  const [conversationMode, setConversationMode] = useState(false)
  const [machine, setMachine] = useState<VoiceConversationState>(createInitialVoiceConversationState)
  const machineRef = useRef(machine)
  machineRef.current = machine
  const voiceSessionIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const awaitingFinalRef = useRef(false)
  const onPromptRef = useRef(options.onPrompt)
  const onAbortRef = useRef(options.onAbort)
  const onErrorRef = useRef(options.onError)
  onPromptRef.current = options.onPrompt
  onAbortRef.current = options.onAbort
  onErrorRef.current = options.onError
  const openCodeSessionIdRef = useRef(options.openCodeSessionId)
  openCodeSessionIdRef.current = options.openCodeSessionId
  const workspaceRef = useRef(workspaceSupport)
  workspaceRef.current = workspaceSupport

  const dispatchRef = useRef<(event: VoiceConversationEvent) => void>(() => {})

  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const messages = useSessionStore((s) => s.currentView.messages)
  const wasGeneratingRef = useRef(false)
  const streamPhaseRef = useRef(false)

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
      setHostReady(status.stt.ready === true && status.tts.ready === true && status.capture?.backend !== 'unavailable')
      setHostDetail(status.reason || status.stt.detail || status.tts.detail || null)
    }).catch(() => {
      if (!cancelled) setHostReady(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const runEffects = useCallback(async (effects: VoiceConversationEffect[]) => {
    for (const effect of effects) {
      try {
        switch (effect.type) {
          case 'stop_read_aloud':
            await stopReadAloud()
            break
          case 'cancel_speak':
            await window.coworkApi?.voice?.cancelSpeak?.()
            break
          case 'start_listen': {
            if (!window.coworkApi?.voice) throw new Error('Voice host unavailable')
            const support = workspaceRef.current
            const snapshot = await window.coworkApi.voice.startSession({
              mode: 'conversation',
              openCodeSessionId: openCodeSessionIdRef.current || null,
              workspaceId: support.isLocal ? 'local' : support.workspaceId,
            })
            voiceSessionIdRef.current = snapshot.id
            awaitingFinalRef.current = false
            break
          }
          case 'stop_listen': {
            const id = voiceSessionIdRef.current
            awaitingFinalRef.current = true
            if (window.coworkApi?.voice && id) {
              await window.coworkApi.voice.stopSession(id)
            }
            break
          }
          case 'cancel_listen': {
            const id = voiceSessionIdRef.current
            voiceSessionIdRef.current = null
            awaitingFinalRef.current = false
            if (window.coworkApi?.voice) {
              await window.coworkApi.voice.cancel(id)
            }
            break
          }
          case 'prompt':
            await onPromptRef.current(effect.text)
            dispatchRef.current({ type: 'PROMPT_SENT' })
            break
          case 'abort_generation':
            await onAbortRef.current()
            break
          case 'speak':
            if (!window.coworkApi?.voice?.speak) {
              dispatchRef.current({ type: 'SPEAK_ERROR', message: 'Local TTS unavailable' })
              break
            }
            try {
              await window.coworkApi.voice.speak({ text: effect.text })
              dispatchRef.current({ type: 'SPEAK_DONE' })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              dispatchRef.current({ type: 'SPEAK_ERROR', message })
            }
            break
          default:
            break
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (effect.type === 'start_listen' || effect.type === 'stop_listen') {
          dispatchRef.current({ type: 'STT_ERROR', message })
        } else if (effect.type === 'prompt') {
          dispatchRef.current({ type: 'PROMPT_ERROR', message })
        } else {
          onErrorRef.current?.(message)
        }
      }
    }
  }, [])

  const dispatch = useCallback((event: VoiceConversationEvent) => {
    const previous = machineRef.current
    const { state: next, effects } = reduceVoiceConversation(previous, event)
    machineRef.current = next
    setMachine(next)
    if (next.phase === 'error' && next.lastError) {
      onErrorRef.current?.(next.lastError)
    }
    if (effects.length > 0) {
      void runEffects(effects)
    }
  }, [runEffects])
  dispatchRef.current = dispatch

  useEffect(() => {
    if (!isDesktopRuntime() || !window.coworkApi?.on?.voiceEvent) return
    const unsub = window.coworkApi.on.voiceEvent((event: VoiceHostEvent) => {
      if (event.type === 'status') {
        setHostReady(
          event.status.stt.ready === true
          && event.status.tts.ready === true
          && event.status.capture?.backend !== 'unavailable',
        )
        setHostDetail(event.status.reason || event.status.stt.detail || event.status.tts.detail || null)
      }
      if (event.type === 'final') {
        if (!awaitingFinalRef.current) return
        if (voiceSessionIdRef.current && event.event.sessionId !== voiceSessionIdRef.current) return
        awaitingFinalRef.current = false
        voiceSessionIdRef.current = null
        const text = event.event.text?.trim() || ''
        dispatchRef.current({ type: 'STT_FINAL', text })
      }
      if (event.type === 'error') {
        if (machineRef.current.phase === 'listening' || machineRef.current.phase === 'finalizing') {
          awaitingFinalRef.current = false
          voiceSessionIdRef.current = null
          dispatchRef.current({ type: 'STT_ERROR', message: event.message || 'Voice failed' })
        }
      }
    })
    return () => {
      unsub?.()
    }
  }, [])

  useEffect(() => {
    const phase = machineRef.current.phase
    if (phase === 'streaming' || phase === 'prompting') {
      streamPhaseRef.current = true
    }
    if (isGenerating) {
      wasGeneratingRef.current = true
      return
    }
    if (streamPhaseRef.current && wasGeneratingRef.current && (phase === 'streaming' || phase === 'prompting')) {
      wasGeneratingRef.current = false
      streamPhaseRef.current = false
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
      const text = plainTextForTts(lastAssistant?.content || '')
      dispatchRef.current({ type: 'STREAM_DONE', text })
      return
    }
    if (!isGenerating) {
      wasGeneratingRef.current = false
    }
  }, [isGenerating, messages])

  const desktop = isDesktopRuntime()
  const featureOn = isDesktopFeatureEnabled(features, 'voice')
  const authorityOk = workspaceSupport.flags.canVoiceCapture
    && workspaceSupport.flags.canVoiceStt
    && workspaceSupport.flags.canVoiceConversation
  const visible = desktop && featureOn && authorityOk
  const baseEnabled = visible && workspaceSupport.flags.canPrompt && hostReady
  const phase = machine.phase
  const isActive = phase !== 'idle' && phase !== 'error'
  const enabled = baseEnabled && (
    phase === 'idle'
    || phase === 'listening'
    || phase === 'error'
    || phase === 'speaking'
    || phase === 'streaming'
  )

  let disabledReason: string | null = null
  if (!desktop) disabledReason = 'Private voice is Desktop only.'
  else if (!featureOn) disabledReason = 'Private voice is off. Enable features.voice in open-cowork.config.json.'
  else if (!authorityOk) {
    disabledReason = workspaceSupport.flags.reasons.voiceConversation
      || workspaceSupport.flags.reasons.voiceCapture
      || workspaceSupport.flags.reasons.voiceStt
      || 'Voice conversation is not supported in this workspace.'
  } else if (!workspaceSupport.flags.canPrompt) {
    disabledReason = workspaceSupport.flags.reasons.prompt
  } else if (!hostReady) {
    disabledReason = hostDetail || 'Voice host is not ready (STT/TTS/capture).'
  } else if (phase === 'error' && machine.lastError) {
    disabledReason = machine.lastError
  }

  const toggle = useCallback(async () => {
    if (busyRef.current) return
    const current = machineRef.current.phase
    if (current === 'listening') {
      busyRef.current = true
      try {
        dispatch({ type: 'STOP_LISTEN' })
      } finally {
        busyRef.current = false
      }
      return
    }
    if (current === 'finalizing' || current === 'prompting') return
    if (current === 'streaming' || current === 'speaking') {
      busyRef.current = true
      try {
        dispatch({ type: 'BARGE_IN' })
      } finally {
        busyRef.current = false
      }
      return
    }
    busyRef.current = true
    try {
      dispatch({ type: 'START_LISTEN' })
    } finally {
      busyRef.current = false
    }
  }, [dispatch])

  const cancel = useCallback(async () => {
    dispatch({ type: 'CANCEL' })
  }, [dispatch])

  useEffect(() => {
    if (!visible || !conversationMode) return
    return registerVoicePttToggleHandler(() => {
      void toggle()
    })
  }, [visible, conversationMode, toggle])

  return {
    visible,
    enabled: enabled || isActive,
    disabledReason: (enabled || isActive)
      ? (phase === 'finalizing' || phase === 'prompting' ? voiceConversationStatusLabel(phase) : null)
      : disabledReason,
    phase,
    chromePhase: voiceConversationChromePhase(phase),
    statusLabel: phase === 'error'
      ? (machine.lastError || 'Voice error')
      : voiceConversationStatusLabel(phase),
    isActive,
    conversationMode,
    setConversationMode,
    toggle,
    cancel,
  }
}
