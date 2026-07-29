/**
 * Private voice security policy helpers (JOE-1111).
 *
 * Private-by-construction rules for the Desktop voice host:
 * - Logs / diagnostics: lengths + engine metadata only — never PCM or transcript text
 * - Network: Aurum STT default is local_only; OpenRouter/cloud ASR must not appear on the default path
 * - Download: model files only when OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 (never audio upload)
 * - IPC: text/status/vad only — no raw samples on the renderer path
 *
 * Greppable audit notes also live in docs/adr/private-realtime-voice.md §Security audit (JOE-1111).
 */

/**
 * Keys allowed on STT/TTS log metadata objects. Anything else is treated as a leak risk.
 * Intentionally excludes `text` / transcript bodies.
 */
export const VOICE_STT_LOG_ALLOWED_KEYS = [
  'backend',
  'model',
  'textChars',
  'durationMs',
  'cleaned',
  'frames',
] as const

export const VOICE_TTS_LOG_ALLOWED_KEYS = [
  'chars',
  'backend',
  'bargedIn',
  'voiceId',
] as const

export type VoiceTtsLogMeta = {
  chars: number
  backend: string
  bargedIn?: boolean
  voiceId?: string | null
}

/** TTS log meta: length + backend only — never the spoken string. */
export function ttsLogMeta(input: {
  text: string
  backend: string
  bargedIn?: boolean
  voiceId?: string | null
}): VoiceTtsLogMeta {
  return {
    chars: input.text.length,
    backend: input.backend,
    ...(input.bargedIn !== undefined ? { bargedIn: input.bargedIn } : {}),
    ...(input.voiceId ? { voiceId: input.voiceId } : {}),
  }
}

/**
 * True when a JSON-serialized status/event payload looks free of bulk audio.
 * Allows intentional product text fields (`text` on partial/final events) when
 * `allowEventText` is true — those are renderer product surface, not logs.
 */
export function payloadLooksFreeOfAudio(
  serialized: string,
  options: { allowEventText?: boolean } = {},
): boolean {
  // Explicit audio sample keys (not sampleRate).
  if (/"samples"\s*:/i.test(serialized)) return false
  if (/"pcm"\s*:/i.test(serialized)) return false
  if (/"rawAudio"\s*:/i.test(serialized)) return false
  if (/"audioBase64"\s*:/i.test(serialized)) return false
  if (/"waveform"\s*:/i.test(serialized)) return false
  if (/Float32Array|ArrayBuffer|Int16Array/.test(serialized)) return false
  if (!options.allowEventText && /"text"\s*:\s*"[^"]{3,}"/.test(serialized)) {
    // Status/log paths should not embed transcript bodies
    return false
  }
  return true
}

/** Assert log meta objects only use allowlisted keys (no transcript body). */
export function assertVoiceLogMetaKeys(
  meta: Record<string, unknown>,
  allowed: readonly string[],
): { ok: true } | { ok: false; extra: string[] } {
  const extra = Object.keys(meta).filter((k) => !allowed.includes(k))
  if (extra.length > 0) return { ok: false, extra }
  if ('text' in meta) return { ok: false, extra: ['text'] }
  return { ok: true }
}

/**
 * Residual risks accepted for private voice (documented, not ignored).
 * Keep in sync with ADR §Security audit.
 */
export const VOICE_SECURITY_RESIDUAL_RISKS = [
  {
    id: 'R-VOICE-01',
    summary: 'Partial/final IPC intentionally carries transcript text to the renderer for product UX.',
    mitigation: 'No raw audio on IPC; renderer must not re-log full text to adoption telemetry.',
  },
  {
    id: 'R-VOICE-02',
    summary: 'STT writes a short-lived temp WAV on disk for the Aurum CLI; cleared in finally.',
    mitigation: 'Work dir under OS temp; rmSync recursive after each call; never under project roots.',
  },
  {
    id: 'R-VOICE-03',
    summary: 'OS TTS may write a temp AIFF/WAV for afplay/say; local filesystem only.',
    mitigation: 'Host-owned playback; no upload; cancel best-effort deletes.',
  },
  {
    id: 'R-VOICE-04',
    summary: 'OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 permits model file fetch (weights only).',
    mitigation: 'Default off; never audio/transcript upload; Settings copy states opt-in.',
  },
  {
    id: 'R-VOICE-05',
    summary: 'getLastTranscript() exists for tests/host diagnostics; not exposed on renderer IPC.',
    mitigation: 'Preload surface has no lastTranscript channel; only status/session/tts/assets.',
  },
  {
    id: 'R-VOICE-06',
    summary: 'Aurum CLI and ffmpeg are not pre-bundled in every CI package.',
    mitigation: 'resources/voice drop-in + fail-closed status; packaging matrix documents macOS supported vs Win/Linux best-effort.',
  },
  {
    id: 'R-VOICE-07',
    summary: 'Windows/Linux OS TTS backends remain residual.',
    mitigation: 'system_os reports unavailable when tools missing; no cloud TTS default.',
  },
] as const
