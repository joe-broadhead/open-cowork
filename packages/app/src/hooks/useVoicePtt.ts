/**
 * Push-to-talk for private voice (JOE-1105 / JOE-1102).
 *
 * Click-to-toggle ships as the primary control (keyboard/a11y friendly).
 * Host owns capture + STT; this hook drives IPC and applies partial/final text
 * against a composer baseline (partials replace the dictation segment).
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
import {
  recordFeatureValueActivation,
  recordFeatureValueDiscovery,
} from '../helpers/lazy-feature-value-telemetry'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { registerVoicePttToggleHandler } from './voice-ptt-hotkey'
import { stopReadAloud } from './voice-read-aloud'

type VoicePttUiPhase = 'idle' | 'listening' | 'transcribing' | 'error'

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

/** Join pre-dictation composer text with the current STT segment. */
export function appendDictation(baseline: string, dictated: string): string {
  const text = dictated.trim()
  if (!text) return baseline
  if (!baseline.trim()) return text
  if (/\s$/.test(baseline)) return `${baseline}${text}`
  return `${baseline.trimEnd()} ${text}`
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
  /**
   * Read the live composer value (parent should back this with a ref so the
   * hook does not capture a stale render).
   */
  getComposerText: () => string
  /** Replace the full composer text (baseline + current dictation segment). */
  setComposerText: (text: string) => void
  onError?: (message: string) => void
  /** When false, do not claim the desktop PTT hotkey (conversation mode owns it). */
  hotkeyEnabled?: boolean
}): VoicePttController {
  const workspaceSupport = useActiveWorkspaceSupport()
  const [features, setFeatures] = useState<DesktopFeatureFlags | undefined>(undefined)
  const [hostStatus, setHostStatus] = useState<VoiceHostStatus | null>(null)
  const [uiPhase, setUiPhase] = useState<VoicePttUiPhase>('idle')
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const pendingStartRef = useRef(false)
  const lifecycleGenerationRef = useRef(0)
  const lifecycleScopeRef = useRef<string | null>(null)
  /** Composer text at the moment listening began; partials replace after this. */
  const baselineRef = useRef<string | null>(null)
  const getComposerTextRef = useRef(options.getComposerText)
  const setComposerTextRef = useRef(options.setComposerText)
  const onErrorRef = useRef(options.onError)
  getComposerTextRef.current = options.getComposerText
  setComposerTextRef.current = options.setComposerText
  onErrorRef.current = options.onError

  const applyDictation = useCallback((segment: string) => {
    const baseline = baselineRef.current
    if (baseline === null) return
    setComposerTextRef.current(appendDictation(baseline, segment))
  }, [])

  const restoreBaseline = useCallback(() => {
    if (baselineRef.current === null) return
    setComposerTextRef.current(baselineRef.current)
    baselineRef.current = null
  }, [])

  const clearBaseline = useCallback(() => {
    baselineRef.current = null
  }, [])

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
      if (event.type === 'partial') {
        // Ignore events for a session we already finished/cancelled.
        if (!sessionIdRef.current || event.event.sessionId !== sessionIdRef.current) return
        if (baselineRef.current === null) return
        const text = event.event.text?.trim() || ''
        if (text) applyDictation(text)
      }
      if (event.type === 'final') {
        if (!sessionIdRef.current || event.event.sessionId !== sessionIdRef.current) return
        const text = event.event.text?.trim() || ''
        if (text) {
          applyDictation(text)
        } else if (baselineRef.current !== null) {
          // Empty final: keep baseline (drop any partial preview).
          setComposerTextRef.current(baselineRef.current)
        }
        clearBaseline()
        sessionIdRef.current = null
        setUiPhase('idle')
        setErrorReason(null)
      }
      if (event.type === 'error') {
        if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return
        const message = event.message || 'Voice failed'
        restoreBaseline()
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
  }, [applyDictation, clearBaseline, restoreBaseline])

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
  const lifecycleScope = baseEnabled
    ? `${workspaceSupport.workspaceId}\u0000${options.openCodeSessionId || ''}`
    : null

  // A capture belongs to the eligible composer + workspace/session that
  // started it. Route changes, policy loss, and unmount must release the host
  // microphone even when the user never gets a chance to press Stop.
  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1
    lifecycleGenerationRef.current = generation
    lifecycleScopeRef.current = lifecycleScope
    busyRef.current = false
    setUiPhase('idle')
    setErrorReason(null)

    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current += 1
      }
      lifecycleScopeRef.current = null
      busyRef.current = false
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      restoreBaseline()
      if (sessionId && window.coworkApi?.voice) {
        void window.coworkApi.voice.cancel(sessionId).catch(() => undefined)
      }
    }
  }, [lifecycleScope, restoreBaseline])

  useEffect(() => {
    if (visible) recordFeatureValueDiscovery('voice')
  }, [visible])

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
    const generation = lifecycleGenerationRef.current
    const scope = lifecycleScopeRef.current
    if (!window.coworkApi?.voice || busyRef.current || pendingStartRef.current || !scope) return
    pendingStartRef.current = true
    busyRef.current = true
    setErrorReason(null)
    setUiPhase('listening')
    try {
      // Barge-in prep (JOE-1103): stop local TTS before opening the mic session.
      await stopReadAloud()
      if (lifecycleGenerationRef.current !== generation || lifecycleScopeRef.current !== scope) return
      // Snapshot before start so partials never include mid-start keystrokes only.
      sessionIdRef.current = null
      baselineRef.current = getComposerTextRef.current()
      const snapshot = await window.coworkApi.voice.startSession({
        mode: 'ptt',
        openCodeSessionId: options.openCodeSessionId || null,
        workspaceId: workspaceSupport.isLocal ? 'local' : workspaceSupport.workspaceId,
      })
      if (lifecycleGenerationRef.current !== generation || lifecycleScopeRef.current !== scope) {
        await window.coworkApi.voice.cancel(snapshot.id).catch(() => undefined)
        return
      }
      sessionIdRef.current = snapshot.id
      recordFeatureValueActivation('voice')
      setUiPhase('listening')
    } catch (error) {
      if (lifecycleGenerationRef.current !== generation || lifecycleScopeRef.current !== scope) return
      const message = error instanceof Error ? error.message : String(error)
      restoreBaseline()
      sessionIdRef.current = null
      setUiPhase('error')
      setErrorReason(message)
      onErrorRef.current?.(message)
    } finally {
      pendingStartRef.current = false
      busyRef.current = false
    }
  }, [options.openCodeSessionId, restoreBaseline, workspaceSupport.isLocal, workspaceSupport.workspaceId])

  const stop = useCallback(async () => {
    if (!window.coworkApi?.voice || busyRef.current) return
    const generation = lifecycleGenerationRef.current
    const scope = lifecycleScopeRef.current
    const sessionId = sessionIdRef.current
    if (!sessionId) {
      setUiPhase('idle')
      return
    }
    busyRef.current = true
    setUiPhase('transcribing')
    try {
      await window.coworkApi.voice.stopSession(sessionId)
      if (lifecycleGenerationRef.current !== generation || lifecycleScopeRef.current !== scope) return
      // Keep the session id and baseline until final/error so late events can
      // still be matched to this capture without accepting another session.
      if (uiPhase !== 'error') setUiPhase('idle')
    } catch (error) {
      if (lifecycleGenerationRef.current !== generation || lifecycleScopeRef.current !== scope) return
      const message = error instanceof Error ? error.message : String(error)
      restoreBaseline()
      sessionIdRef.current = null
      setUiPhase('error')
      setErrorReason(message)
      onErrorRef.current?.(message)
    } finally {
      busyRef.current = false
    }
  }, [restoreBaseline, uiPhase])

  const cancel = useCallback(async () => {
    if (!window.coworkApi?.voice) return
    lifecycleGenerationRef.current += 1
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    if (!pendingStartRef.current) busyRef.current = false
    restoreBaseline()
    setUiPhase('idle')
    setErrorReason(null)
    if (sessionId) {
      try {
        await window.coworkApi.voice.cancel(sessionId)
      } catch {
        // Cancel is best-effort.
      }
    }
  }, [restoreBaseline])

  const toggle = useCallback(async () => {
    if (uiPhase === 'listening') {
      if (busyRef.current && !sessionIdRef.current) {
        await cancel()
        return
      }
      await stop()
      return
    }
    if (uiPhase === 'transcribing') return
    await start()
  }, [cancel, start, stop, uiPhase])

  const isActive = uiPhase === 'listening' || uiPhase === 'transcribing'
  const enabled = baseEnabled && uiPhase !== 'transcribing'

  // Desktop menu / keyboard hotkey (JOE-1110): last-mounted visible controller wins.
  useEffect(() => {
    if (!visible || options.hotkeyEnabled === false) return
    return registerVoicePttToggleHandler(() => {
      if (!enabled && uiPhase !== 'listening') return
      void toggle()
    })
  }, [visible, enabled, uiPhase, toggle, options.hotkeyEnabled])

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
