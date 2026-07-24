/**
 * Push-to-talk for private voice (JOE-1105).
 *
 * Click-to-toggle ships as the primary control (keyboard/a11y friendly).
 * Host owns capture + STT; this hook only drives IPC and injects final text.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isDesktopFeatureEnabled,
  type DesktopFeatureFlags,
  type VoiceHostEvent,
  type VoiceHostPhase,
  type VoiceHostStatus,
} from '@open-cowork/shared'
import { isDesktopRuntime } from '../runtime-env'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'

export type VoicePttUiPhase = 'idle' | 'listening' | 'transcribing' | 'error'

export type VoicePttController = {
  /** Feature + authority allow the mic control to appear. */
  visible: boolean
  /** Control is interactive (not blocked by policy / host readiness). */
  enabled: boolean
  disabledReason: string | null
  phase: VoicePttUiPhase
  statusLabel: string | null
  isActive: boolean
  toggle: () => Promise<void>
  cancel: () => Promise<void>
}

function mapPhase(phase: VoiceHostPhase | undefined): VoicePttUiPhase {
  if (phase === 'listening') return 'listening'
  if (phase === 'transcribing' || phase === 'starting') return 'transcribing'
  if (phase === 'error' || phase === 'unavailable') return 'error'
  return 'idle'
}

function statusLabelFor(phase: VoicePttUiPhase, reason: string | null): string | null {
  if (phase === 'listening') return 'Listening…'
  if (phase === 'transcribing') return 'Transcribing…'
  if (phase === 'error') return reason || 'Voice error'
  return null
}

export function useVoicePtt(options: {
  openCodeSessionId?: string | null
  onFinalText: (text: string) => void
  onError?: (message: string) => void
}): VoicePttController {
  const workspaceSupport = useActiveWorkspaceSupport()
  const [features, setFeatures] = useState<DesktopFeatureFlags | undefined>(undefined)
  const [hostStatus, setHostStatus] = useState<VoiceHostStatus | null>(null)
  const [uiPhase, setUiPhase] = useState<VoicePttUiPhase>('idle')
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const onFinalTextRef = useRef(options.onFinalText)
  const onErrorRef = useRef(options.onError)
  onFinalTextRef.current = options.onFinalText
  onErrorRef.current = options.onError

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
      if (!cancelled) setHostStatus(status)
    }).catch(() => {
      // Host unavailable — control stays hidden/disabled via gates.
    })
    const unsub = window.coworkApi.on?.voiceEvent?.((event: VoiceHostEvent) => {
      if (event.type === 'status') {
        setHostStatus(event.status)
        if (sessionIdRef.current && (event.status.phase === 'listening' || event.status.phase === 'transcribing' || event.status.phase === 'starting')) {
          setUiPhase(mapPhase(event.status.phase))
        }
      }
      if (event.type === 'final') {
        const text = event.event.text?.trim() || ''
        if (text) onFinalTextRef.current(text)
        sessionIdRef.current = null
        setUiPhase('idle')
        setErrorReason(null)
      }
      if (event.type === 'error') {
        const message = event.message || 'Voice failed'
        setErrorReason(message)
        setUiPhase('error')
        sessionIdRef.current = null
        onErrorRef.current?.(message)
      }
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const featureOn = isDesktopFeatureEnabled(features, 'voice')
  const authorityOk = workspaceSupport.flags.canVoiceCapture && workspaceSupport.flags.canVoiceStt
  const desktop = isDesktopRuntime()
  const visible = desktop && featureOn && authorityOk
  const sttReady = hostStatus?.stt.ready === true
  const captureReady = hostStatus?.capture?.backend !== 'unavailable'
  const baseEnabled = visible
    && workspaceSupport.flags.canPrompt
    && captureReady
    && (sttReady || uiPhase === 'listening')

  let disabledReason: string | null = null
  if (!desktop) disabledReason = 'Private voice is Desktop only.'
  else if (!featureOn) disabledReason = 'Private voice is off. Enable features.voice in open-cowork.config.json.'
  else if (!authorityOk) {
    disabledReason = workspaceSupport.flags.reasons.voiceCapture
      || workspaceSupport.flags.reasons.voiceStt
      || 'Voice is not supported in this workspace.'
  } else if (!workspaceSupport.flags.canPrompt) {
    disabledReason = workspaceSupport.flags.reasons.prompt
  } else if (!captureReady) {
    disabledReason = hostStatus?.capture?.detail || hostStatus?.reason || 'Microphone capture is unavailable.'
  } else if (!sttReady && uiPhase === 'idle') {
    disabledReason = hostStatus?.stt.detail || hostStatus?.reason || 'Speech-to-text is not ready.'
  } else if (errorReason && uiPhase === 'error') {
    disabledReason = errorReason
  }

  const start = useCallback(async () => {
    if (!window.coworkApi?.voice || busyRef.current) return
    busyRef.current = true
    setErrorReason(null)
    setUiPhase('listening')
    try {
      const snapshot = await window.coworkApi.voice.startSession({
        mode: 'ptt',
        openCodeSessionId: options.openCodeSessionId || null,
        workspaceId: workspaceSupport.isLocal ? 'local' : workspaceSupport.workspaceId,
      })
      sessionIdRef.current = snapshot.id
      setUiPhase('listening')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionIdRef.current = null
      setUiPhase('error')
      setErrorReason(message)
      onErrorRef.current?.(message)
    } finally {
      busyRef.current = false
    }
  }, [options.openCodeSessionId, workspaceSupport.isLocal, workspaceSupport.workspaceId])

  const stop = useCallback(async () => {
    if (!window.coworkApi?.voice || busyRef.current) return
    const sessionId = sessionIdRef.current
    if (!sessionId) {
      setUiPhase('idle')
      return
    }
    busyRef.current = true
    setUiPhase('transcribing')
    try {
      await window.coworkApi.voice.stopSession(sessionId)
      // Final text arrives via voiceEvent; clear session id after stop.
      sessionIdRef.current = null
      if (uiPhase !== 'error') setUiPhase('idle')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionIdRef.current = null
      setUiPhase('error')
      setErrorReason(message)
      onErrorRef.current?.(message)
    } finally {
      busyRef.current = false
    }
  }, [uiPhase])

  const cancel = useCallback(async () => {
    if (!window.coworkApi?.voice) return
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    setUiPhase('idle')
    setErrorReason(null)
    try {
      await window.coworkApi.voice.cancel(sessionId)
    } catch {
      // Cancel is best-effort.
    }
  }, [])

  const toggle = useCallback(async () => {
    if (uiPhase === 'listening') {
      await stop()
      return
    }
    if (uiPhase === 'transcribing') return
    await start()
  }, [start, stop, uiPhase])

  const isActive = uiPhase === 'listening' || uiPhase === 'transcribing'
  const enabled = baseEnabled && uiPhase !== 'transcribing'

  return {
    visible,
    enabled,
    disabledReason: enabled || isActive
      ? (uiPhase === 'transcribing' ? 'Transcribing…' : null)
      : disabledReason,
    phase: uiPhase,
    statusLabel: statusLabelFor(uiPhase, errorReason),
    isActive,
    toggle,
    cancel,
  }
}
