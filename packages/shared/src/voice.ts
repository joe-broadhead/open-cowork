/**
 * Private realtime voice contracts (JOE-1096).
 *
 * Capture and engines live in the Desktop voice host (main/native), not the
 * Chromium renderer. These types are the IPC surface between host and UI.
 */

/** Workspace support keys for private voice (see WORKSPACE_SUPPORT_APIS). */
export const VOICE_WORKSPACE_SUPPORT_APIS = [
  'voice.capture',
  'voice.stt',
  'voice.tts',
  'voice.conversation',
] as const

export type VoiceWorkspaceSupportApi = typeof VOICE_WORKSPACE_SUPPORT_APIS[number]

/** Where microphone capture is owned. Default is voice_host. */
export type VoiceCaptureMode = 'voice_host' | 'renderer'

/** STT engine identity. Open Cowork uses Aurum local_only by decision. */
export type VoiceSttEngine = 'aurum_local' | 'unavailable'

/**
 * TTS is intentionally not Aurum (STT-first product). Sibling engine TBD.
 */
export type VoiceTtsEngine = 'sibling' | 'unavailable'

export type VoiceHostPhase =
  | 'disabled'
  | 'deferred'
  | 'starting'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'speaking'
  | 'error'
  | 'unavailable'

export type VoicePermissionState =
  | 'unknown'
  | 'not_required'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'restricted'

export type VoiceHostStatus = {
  /** Feature + authority gate: false when features.voice off or non-local workspace. */
  enabled: boolean
  phase: VoiceHostPhase
  captureMode: VoiceCaptureMode
  stt: {
    engine: VoiceSttEngine
    ready: boolean
    detail?: string | null
  }
  tts: {
    engine: VoiceTtsEngine
    ready: boolean
    detail?: string | null
  }
  permissions: {
    microphone: VoicePermissionState
  }
  /** Human-readable reason when not ready (deferred host, missing model, policy). */
  reason: string | null
  /** Active conversation session id when one is open. */
  sessionId: string | null
}

export type VoiceSessionStartInput = {
  /** OpenCode / Studio session to attach voice turns to. */
  openCodeSessionId?: string | null
  workspaceId?: string | null
  /** Push-to-talk vs continuous; V2 UI uses ptt. */
  mode?: 'ptt' | 'conversation'
}

export type VoiceSessionSnapshot = {
  id: string
  openCodeSessionId: string | null
  workspaceId: string | null
  mode: 'ptt' | 'conversation'
  phase: VoiceHostPhase
  startedAt: string
}

export type VoicePartialEvent = {
  sessionId: string
  text: string
  isFinal: false
  at: string
}

export type VoiceFinalEvent = {
  sessionId: string
  text: string
  isFinal: true
  at: string
}

export type VoiceHostEvent =
  | { type: 'status'; status: VoiceHostStatus }
  | { type: 'partial'; event: VoicePartialEvent }
  | { type: 'final'; event: VoiceFinalEvent }
  | { type: 'error'; sessionId: string | null; message: string; at: string }

/** Default host status before the voice host process is wired (V0/V1 scaffold). */
export function createDeferredVoiceHostStatus(reason: string): VoiceHostStatus {
  return {
    enabled: false,
    phase: 'deferred',
    captureMode: 'voice_host',
    stt: {
      engine: 'aurum_local',
      ready: false,
      detail: 'Aurum STT not wired yet',
    },
    tts: {
      engine: 'sibling',
      ready: false,
      detail: 'Sibling TTS not wired yet',
    },
    permissions: {
      microphone: 'unknown',
    },
    reason,
    sessionId: null,
  }
}

export const VOICE_HOST_DEFERRED_REASON =
  'Private voice host is scaffolded; STT/TTS engines are not connected yet. Keep features.voice off until V1 engines land.'

/**
 * Derive host status from feature flags alone (no engines). Used by IPC stubs
 * and unit tests before Aurum/sibling TTS are connected.
 */
export function voiceHostStatusForFeatures(features: { voice?: boolean } | undefined): VoiceHostStatus {
  const enabled = features?.voice === true
  const status = createDeferredVoiceHostStatus(
    enabled
      ? VOICE_HOST_DEFERRED_REASON
      : 'features.voice is disabled (secondary Studio flag, default off).',
  )
  return {
    ...status,
    enabled,
    phase: enabled ? 'deferred' : 'disabled',
  }
}
