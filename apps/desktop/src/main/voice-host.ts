/**
 * Desktop Local private voice host (JOE-1097 / JOE-1101).
 *
 * Owns mic capture + PCM + Aurum STT in main. Emits text/status events only —
 * never raw audio.
 */
import { randomUUID } from 'node:crypto'
import {
  isDesktopFeatureEnabled,
  type DesktopFeatureFlags,
  type VoiceHostEvent,
  type VoiceHostStatus,
  type VoicePermissionState,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
} from '@open-cowork/shared'
import {
  createDefaultVoiceCapture,
  type VoiceCapture,
  type VoiceCaptureBackendId,
} from './voice-capture.ts'
import { VoicePcmBuffer } from './voice-pcm-buffer.ts'
import {
  createDefaultVoiceStt,
  sttLogMeta,
  type VoiceSttEngine,
} from './voice-stt.ts'
import { log } from '@open-cowork/shared/node'

export type VoiceHostOptions = {
  features?: DesktopFeatureFlags
  capture?: VoiceCapture
  stt?: VoiceSttEngine
  now?: () => Date
  /** Override OS mic permission probe (tests). */
  probeMicrophone?: () => Promise<VoicePermissionState>
  onEvent?: (event: VoiceHostEvent) => void
}

type ActiveSession = VoiceSessionSnapshot & {
  buffer: VoicePcmBuffer
}

export class VoiceHost {
  private features: DesktopFeatureFlags | undefined
  private capture: VoiceCapture
  private stt: VoiceSttEngine
  private readonly now: () => Date
  private readonly probeMicrophone: () => Promise<VoicePermissionState>
  private readonly onEvent: (event: VoiceHostEvent) => void
  private mic: VoicePermissionState = 'unknown'
  private session: ActiveSession | null = null
  private phase: VoiceHostStatus['phase'] = 'disabled'
  private lastError: string | null = null
  private lastTranscript: string | null = null

  constructor(options: VoiceHostOptions = {}) {
    this.features = options.features
    this.capture = options.capture || createDefaultVoiceCapture()
    this.stt = options.stt || createDefaultVoiceStt()
    this.now = options.now || (() => new Date())
    this.probeMicrophone = options.probeMicrophone || defaultProbeMicrophone
    this.onEvent = options.onEvent || (() => {})
    this.phase = isDesktopFeatureEnabled(this.features, 'voice') ? 'ready' : 'disabled'
  }

  setFeatures(features: DesktopFeatureFlags | undefined) {
    this.features = features
    if (!isDesktopFeatureEnabled(features, 'voice')) {
      void this.cancel(null)
      this.phase = 'disabled'
    } else if (this.phase === 'disabled' || this.phase === 'deferred') {
      this.phase = 'ready'
    }
  }

  /** Test / advanced: swap capture backend. */
  setCapture(capture: VoiceCapture) {
    this.capture = capture
  }

  setStt(stt: VoiceSttEngine) {
    this.stt = stt
  }

  getStatus(): VoiceHostStatus {
    const enabled = isDesktopFeatureEnabled(this.features, 'voice')
    const captureBackend = this.capture.backend
    const captureReady = captureBackend !== 'unavailable'
    const sttReady = this.stt.isReady()
    let phase = this.phase
    if (!enabled) phase = 'disabled'
    else if (this.session) {
      // keep current listening/transcribing
    } else if (phase === 'listening' || phase === 'transcribing') {
      phase = 'ready'
    }

    let reason: string | null = null
    if (!enabled) {
      reason = 'features.voice is disabled (secondary Studio flag, default off).'
    } else if (!captureReady) {
      reason = this.capture.detail
    } else if (!sttReady) {
      reason = this.stt.detail
    }

    if (this.lastError) {
      reason = this.lastError
      if (phase !== 'listening' && phase !== 'transcribing') phase = 'error'
    }

    const stats = this.session?.buffer.stats()
    return {
      enabled,
      phase,
      captureMode: 'voice_host',
      stt: {
        engine: this.stt.backend === 'unavailable' ? 'unavailable' : 'aurum_local',
        ready: sttReady,
        detail: this.stt.detail,
      },
      tts: {
        engine: 'sibling',
        ready: false,
        detail: 'Sibling TTS not wired yet',
      },
      permissions: {
        microphone: this.mic,
      },
      reason,
      sessionId: this.session?.id || null,
      capture: {
        backend: captureBackend,
        detail: this.capture.detail,
        sampleRate: stats?.sampleRate ?? 16_000,
        channels: 1,
        frames: stats?.frames ?? 0,
        durationSeconds: stats?.durationSeconds ?? 0,
        peak: stats?.peak ?? 0,
      },
    }
  }

  async refreshPermissions(): Promise<VoicePermissionState> {
    this.mic = await this.probeMicrophone()
    this.emitStatus()
    return this.mic
  }

  async startSession(input: VoiceSessionStartInput = {}): Promise<VoiceSessionSnapshot> {
    if (!isDesktopFeatureEnabled(this.features, 'voice')) {
      throw new Error('Private voice is disabled. Set features.voice to true in open-cowork.config.json to opt in.')
    }
    if (this.session) {
      await this.cancel(this.session.id)
    }

    this.lastError = null
    this.lastTranscript = null
    this.phase = 'starting'
    this.emitStatus()

    this.mic = await this.probeMicrophone()
    if (this.mic === 'denied' || this.mic === 'restricted') {
      this.phase = 'error'
      this.lastError = 'Microphone permission is denied. Enable it in system settings, then retry.'
      this.emitError(null, this.lastError)
      this.emitStatus()
      throw new Error(this.lastError)
    }

    if (this.capture.backend === 'unavailable') {
      this.phase = 'unavailable'
      this.lastError = this.capture.detail
      this.emitError(null, this.lastError)
      this.emitStatus()
      throw new Error(this.lastError)
    }

    const id = randomUUID()
    const startedAt = this.now().toISOString()
    const buffer = new VoicePcmBuffer()
    this.session = {
      id,
      openCodeSessionId: input.openCodeSessionId || null,
      workspaceId: input.workspaceId || null,
      mode: input.mode === 'conversation' ? 'conversation' : 'ptt',
      phase: 'listening',
      startedAt,
      buffer,
    }

    try {
      await this.capture.start((chunk) => {
        if (!this.session || this.session.id !== id) return
        this.session.buffer.push(chunk)
      })
    } catch (error) {
      this.session = null
      this.phase = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitError(id, this.lastError)
      this.emitStatus()
      throw error
    }

    this.phase = 'listening'
    this.emitStatus()
    return this.publicSession(this.session)
  }

  async stopSession(sessionId?: string | null): Promise<VoiceHostStatus> {
    const active = this.session
    if (!active) {
      this.phase = isDesktopFeatureEnabled(this.features, 'voice') ? 'ready' : 'disabled'
      return this.getStatus()
    }
    if (sessionId && active.id !== sessionId) {
      return this.getStatus()
    }

    await this.capture.stop()
    const pcm = active.buffer.snapshot()
    const sessionIdFinal = active.id
    active.buffer.clear()

    // Transcribe before dropping the session id so final events stay correlated.
    this.phase = 'transcribing'
    this.session = { ...active, phase: 'transcribing', buffer: new VoicePcmBuffer() }
    this.emitStatus()

    try {
      if (pcm.length > 0) {
        if (!this.stt.isReady()) {
          throw new Error(this.stt.detail)
        }
        const result = await this.stt.transcribePcm(pcm)
        this.lastTranscript = result.text
        // Log metadata only — never transcript body or PCM.
        log('voice', `stt.final ${JSON.stringify(sttLogMeta(result))}`)
        this.onEvent({
          type: 'final',
          event: {
            sessionId: sessionIdFinal,
            text: result.text,
            isFinal: true,
            at: this.now().toISOString(),
          },
        })
      } else {
        this.lastTranscript = ''
        this.onEvent({
          type: 'final',
          event: {
            sessionId: sessionIdFinal,
            text: '',
            isFinal: true,
            at: this.now().toISOString(),
          },
        })
      }
      this.lastError = null
      this.phase = 'ready'
    } catch (error) {
      this.phase = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitError(sessionIdFinal, this.lastError)
    } finally {
      this.session = null
      this.emitStatus()
    }

    return this.getStatus()
  }

  async cancel(sessionId?: string | null): Promise<VoiceHostStatus> {
    const active = this.session
    if (active && (!sessionId || active.id === sessionId)) {
      await this.capture.stop()
      active.buffer.clear()
      this.session = null
    }
    this.phase = isDesktopFeatureEnabled(this.features, 'voice') ? 'ready' : 'disabled'
    this.lastError = null
    this.emitStatus()
    return this.getStatus()
  }

  /** Host-only access for STT/tests. Never expose via IPC. */
  getHostPcmSnapshot(): Float32Array | null {
    return this.session ? this.session.buffer.snapshot() : null
  }

  getLastTranscript(): string | null {
    return this.lastTranscript
  }

  getCaptureBackend(): VoiceCaptureBackendId {
    return this.capture.backend
  }

  getSttBackend() {
    return this.stt.backend
  }

  private publicSession(session: ActiveSession): VoiceSessionSnapshot {
    return {
      id: session.id,
      openCodeSessionId: session.openCodeSessionId,
      workspaceId: session.workspaceId,
      mode: session.mode,
      phase: session.phase,
      startedAt: session.startedAt,
    }
  }

  private emitStatus() {
    this.onEvent({ type: 'status', status: this.getStatus() })
  }

  private emitError(sessionId: string | null, message: string) {
    this.onEvent({
      type: 'error',
      sessionId,
      message,
      at: this.now().toISOString(),
    })
  }
}

async function defaultProbeMicrophone(): Promise<VoicePermissionState> {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }
  try {
    const { systemPreferences } = await import('electron')
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return 'granted'
    if (status === 'denied') return 'denied'
    if (status === 'restricted') return 'restricted'
    if (status === 'not-determined') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      return ok ? 'granted' : 'denied'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

let sharedHost: VoiceHost | null = null

export function getVoiceHost(): VoiceHost {
  if (!sharedHost) sharedHost = new VoiceHost()
  return sharedHost
}

export function resetVoiceHostForTests(host?: VoiceHost | null) {
  sharedHost = host ?? null
}
