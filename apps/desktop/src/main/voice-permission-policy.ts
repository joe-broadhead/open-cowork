/**
 * Electron media / OS permission policy for private voice (JOE-1098).
 *
 * Capture is owned by the voice host outside the Chromium renderer by default
 * (ADR private-realtime-voice). Renderer `media` / `microphone` stay denied
 * unless an explicit future captureMode === 'renderer' is chosen.
 */
import {
  isDesktopFeatureEnabled,
  type DesktopFeatureFlags,
  type VoiceCaptureMode,
} from '@open-cowork/shared'

export type MediaPermissionDecision = {
  allowed: boolean
  reason: string
}

export function isVoiceRelatedElectronPermission(permission: string): boolean {
  return permission === 'media' || permission === 'microphone' || permission === 'mediaKeySystem'
}

/**
 * Resolve whether the Studio renderer may be granted Chromium media permission.
 * Default captureMode is voice_host → always false for renderer media.
 */
export function resolveRendererMediaPermission(options: {
  features?: DesktopFeatureFlags
  captureMode?: VoiceCaptureMode
  permission: string
}): MediaPermissionDecision {
  if (!isVoiceRelatedElectronPermission(options.permission)) {
    return {
      allowed: false,
      reason: `Permission ${options.permission} is not granted to the Open Cowork renderer.`,
    }
  }

  const captureMode = options.captureMode || 'voice_host'
  if (captureMode !== 'renderer') {
    return {
      allowed: false,
      reason: 'Private voice captures audio in the voice host outside the renderer (default).',
    }
  }

  if (!isDesktopFeatureEnabled(options.features, 'voice')) {
    return {
      allowed: false,
      reason: 'features.voice is disabled; renderer media capture stays off.',
    }
  }

  return {
    allowed: true,
    reason: 'features.voice enabled with explicit renderer capture mode.',
  }
}

/** OS-facing matrix (docs + doctor). Values are product claims, not live OS queries. */
export type OsVoicePermissionMatrixRow = {
  permission: 'microphone' | 'speech_recognition' | 'screen' | 'accessibility'
  desktopLocal: string
  cloudWeb: string
  notes: string
}

export const OS_VOICE_PERMISSION_MATRIX: OsVoicePermissionMatrixRow[] = [
  {
    permission: 'microphone',
    desktopLocal: 'Required for capture when features.voice is on; requested by voice host',
    cloudWeb: 'Not requested — voice.* not_supported',
    notes: 'Not granted via Chromium getUserMedia for Studio renderer by default',
  },
  {
    permission: 'speech_recognition',
    desktopLocal: 'Not used — Aurum on-device STT, not OS dictation APIs',
    cloudWeb: 'N/A',
    notes: 'Avoid OS cloud speech services',
  },
  {
    permission: 'screen',
    desktopLocal: 'Not required for V0–V2 voice',
    cloudWeb: 'N/A',
    notes: 'Reserved; do not couple voice to screen capture',
  },
  {
    permission: 'accessibility',
    desktopLocal: 'Not required for in-app PTT',
    cloudWeb: 'N/A',
    notes: 'ZephyrFlow may use accessibility for system-wide inject; Open Cowork does not',
  },
]
