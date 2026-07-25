/**
 * Desktop Local private voice host (JOE-1097 / JOE-1101 / JOE-1102 / JOE-1108 / JOE-1104).
 *
 * Owns mic capture + PCM + Aurum STT + sibling TTS + energy VAD in main.
 * Emits text/status/vad events only — never raw audio.
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
  type VoiceTtsSpeakInput,
  type VoiceTtsVoiceInfo,
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
import {
  createDefaultVoiceTts,
  type VoiceTtsEngine,
} from './voice-tts.ts'
import {
  dictationPartialPolicy,
  VoicePartialClock,
  type VoicePartialWindowPolicy,
} from './voice-partial-window.ts'
import {
  createVadState,
  defaultConversationVadPolicy,
  isBargeInSpeech,
  tickVad,
  type VoiceVadPolicy,
  type VoiceVadState,
} from './voice-vad.ts'
import { log } from '@open-cowork/shared/node'

export type VoiceHostOptions = {
  features?: DesktopFeatureFlags
  capture?: VoiceCapture
  stt?: VoiceSttEngine
  tts?: VoiceTtsEngine
  now?: () => Date
  /** Override OS mic permission probe (tests). */
  probeMicrophone?: () => Promise<VoicePermissionState>
  onEvent?: (event: VoiceHostEvent) => void
  partialPolicy?: VoicePartialWindowPolicy
  /** Disable partial loop (tests that only exercise finalize). */
  partialsEnabled?: boolean
  vadPolicy?: VoiceVadPolicy
  /** Enable barge-in energy monitor during TTS (default true). */
  bargeInEnabled?: boolean
}

type ActiveSession = VoiceSessionSnapshot & {
  buffer: VoicePcmBuffer
  continuousVad: boolean
}

export class VoiceHost {
  private features: DesktopFeatureFlags | undefined
  private capture: VoiceCapture
  private stt: VoiceSttEngine
  private tts: VoiceTtsEngine
  private readonly now: () => Date
  private readonly probeMicrophone: () => Promise<VoicePermissionState>
  private readonly onEvent: (event: VoiceHostEvent) => void
  private readonly partialPolicy: VoicePartialWindowPolicy
  private readonly partialsEnabled: boolean
  private mic: VoicePermissionState = 'unknown'
  private session: ActiveSession | null = null
  private phase: VoiceHostStatus['phase'] = 'disabled'
  private lastError: string | null = null
  private lastTranscript: string | null = null
  private partialClock = new VoicePartialClock()
  private partialTimer: NodeJS.Timeout | null = null
  private partialInFlight = false
  private lastPartialText: string | null = null
  private speakInFlight = false
  private readonly vadPolicy: VoiceVadPolicy
  private readonly bargeInEnabled: boolean
  private vadState = createVadState()
  private continuousVadActive = false
  private speechActive = false
  private bargeInArmed = false
  private bargeInCapture = false
  private autoFinalizeInFlight = false
  /** Guards concurrent stopSession (UI stop + VAD auto-finalize). */
  private stopInFlight = false

  constructor(options: VoiceHostOptions = {}) {
    this.features = options.features
    this.capture = options.capture || createDefaultVoiceCapture()
    this.stt = options.stt || createDefaultVoiceStt()
    this.tts = options.tts || createDefaultVoiceTts()
    this.now = options.now || (() => new Date())
    this.probeMicrophone = options.probeMicrophone || defaultProbeMicrophone
    this.onEvent = options.onEvent || (() => {})
    this.partialPolicy = options.partialPolicy || dictationPartialPolicy()
    this.partialsEnabled = options.partialsEnabled !== false
    this.partialClock = new VoicePartialClock(this.partialPolicy)
    this.vadPolicy = options.vadPolicy || defaultConversationVadPolicy()
    this.bargeInEnabled = options.bargeInEnabled !== false
    this.phase = isDesktopFeatureEnabled(this.features, 'voice') ? 'ready' : 'disabled'
  }

  setFeatures(features: DesktopFeatureFlags | undefined) {
    this.features = features
    if (!isDesktopFeatureEnabled(features, 'voice')) {
      void this.cancel(null)
      void this.cancelSpeak()
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

  setTts(tts: VoiceTtsEngine) {
    this.tts = tts
  }

  getStatus(): VoiceHostStatus {
    const enabled = isDesktopFeatureEnabled(this.features, 'voice')
    const captureBackend = this.capture.backend
    const captureReady = captureBackend !== 'unavailable'
    const sttReady = this.stt.isReady()
    const ttsReady = this.tts.isReady()
    let phase = this.phase
    if (!enabled) phase = 'disabled'
    else if (this.session) {
      // keep current listening/transcribing
    } else if (this.speakInFlight) {
      phase = 'speaking'
    } else if (phase === 'listening' || phase === 'transcribing' || phase === 'speaking') {
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
      if (phase !== 'listening' && phase !== 'transcribing' && phase !== 'speaking') phase = 'error'
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
        engine: this.tts.backend === 'unavailable' ? 'unavailable' : 'system_os',
        ready: ttsReady,
        detail: this.tts.detail,
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
      vad: {
        continuous: this.continuousVadActive || Boolean(this.session?.continuousVad),
        speechActive: this.speechActive,
        bargeInArmed: this.bargeInArmed,
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
    // Stop TTS so mic capture and speech playback do not fight the audio device.
    await this.cancelSpeak()

    this.lastError = null
    this.lastTranscript = null
    this.lastPartialText = null
    this.partialClock.reset()
    this.vadState = createVadState()
    this.speechActive = false
    this.autoFinalizeInFlight = false
    const continuousVad = input.continuousVad === true && input.mode === 'conversation'
    this.continuousVadActive = continuousVad
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
      continuousVad,
      buffer,
    }

    try {
      await this.capture.start((chunk) => {
        if (!this.session || this.session.id !== id) return
        this.session.buffer.push(chunk)
        if (this.session.continuousVad) {
          this.onVadChunk(id, chunk)
        }
      })
    } catch (error) {
      this.session = null
      this.continuousVadActive = false
      this.phase = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitError(id, this.lastError)
      this.emitStatus()
      throw error
    }

    this.phase = 'listening'
    this.startPartialLoop(id)
    if (continuousVad) {
      this.emitVad(id, 'armed', false)
    }
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
    // Serialize finalize so VAD auto-stop and UI stop cannot double-transcribe.
    if (this.stopInFlight) {
      return this.getStatus()
    }
    this.stopInFlight = true

    try {
      this.stopPartialLoop()
      // Wait for in-flight partial to finish so we don't race finalize on shared CLI.
      await this.waitForPartialIdle()

      // Re-check: cancel may have cleared the session while we waited.
      if (!this.session || this.session.id !== active.id) {
        return this.getStatus()
      }

      await this.capture.stop()
      const pcm = active.buffer.snapshot()
      const sessionIdFinal = active.id
      const wasContinuous = active.continuousVad
      active.buffer.clear()
      this.continuousVadActive = false
      this.speechActive = false
      if (wasContinuous) {
        this.emitVad(sessionIdFinal, 'disarmed', false)
      }

      this.phase = 'transcribing'
      this.session = { ...active, phase: 'transcribing', continuousVad: false, buffer: new VoicePcmBuffer() }
      this.emitStatus()

      try {
        if (pcm.length > 0) {
          if (!this.stt.isReady()) {
            throw new Error(this.stt.detail)
          }
          const result = await this.stt.transcribePcm(pcm)
          this.lastTranscript = result.text
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
        this.lastPartialText = null
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
    } finally {
      this.stopInFlight = false
    }
  }

  async cancel(sessionId?: string | null): Promise<VoiceHostStatus> {
    const active = this.session
    if (active && (!sessionId || active.id === sessionId)) {
      this.stopPartialLoop()
      await this.waitForPartialIdle()
      await this.capture.stop()
      active.buffer.clear()
      if (active.continuousVad) {
        this.emitVad(active.id, 'disarmed', false)
      }
      this.session = null
    }
    this.continuousVadActive = false
    this.speechActive = false
    this.autoFinalizeInFlight = false
    this.lastPartialText = null
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

  getLastPartialText(): string | null {
    return this.lastPartialText
  }

  getCaptureBackend(): VoiceCaptureBackendId {
    return this.capture.backend
  }

  getSttBackend() {
    return this.stt.backend
  }

  getTtsBackend() {
    return this.tts.backend
  }

  async listTtsVoices(): Promise<VoiceTtsVoiceInfo[]> {
    if (!this.tts.isReady()) return []
    return this.tts.listVoices()
  }

  /**
   * Host-owned local TTS playback (JOE-1108). Never sends audio to the renderer.
   * Text only crosses IPC; synthesis + playback stay in main.
   */
  async speak(input: VoiceTtsSpeakInput): Promise<VoiceHostStatus> {
    if (!isDesktopFeatureEnabled(this.features, 'voice')) {
      throw new Error('Private voice is disabled. Set features.voice to true in open-cowork.config.json to opt in.')
    }
    if (this.session) {
      throw new Error('Cannot speak while a capture session is active.')
    }
    if (!this.tts.isReady()) {
      throw new Error(this.tts.detail)
    }
    const text = input.text?.trim() || ''
    if (!text) throw new Error('TTS text is empty.')

    await this.cancelSpeak()
    this.lastError = null
    this.speakInFlight = true
    this.phase = 'speaking'
    this.emitStatus()
    let bargedIn = false
    try {
      await this.startBargeInMonitor(() => {
        bargedIn = true
      })
      await this.tts.speak(text, {
        voiceId: input.voiceId,
        rate: input.rate,
      })
      log('voice', `tts.speak ${JSON.stringify({ chars: text.length, backend: this.tts.backend, bargedIn })}`)
      this.phase = bargedIn ? 'ready' : 'ready'
    } catch (error) {
      // Barge-in cancel surfaces as speak abort — not a hard error.
      if (bargedIn) {
        this.phase = 'ready'
        this.lastError = null
      } else {
        this.phase = 'error'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.emitError(null, this.lastError)
        throw error
      }
    } finally {
      await this.stopBargeInMonitor()
      this.speakInFlight = false
      this.emitStatus()
    }
    return this.getStatus()
  }

  async cancelSpeak(): Promise<VoiceHostStatus> {
    try {
      await this.tts.cancel()
    } catch {
      // best-effort
    }
    await this.stopBargeInMonitor()
    if (this.speakInFlight || this.phase === 'speaking') {
      this.speakInFlight = false
      if (this.phase === 'speaking') {
        this.phase = isDesktopFeatureEnabled(this.features, 'voice') ? 'ready' : 'disabled'
      }
      this.emitStatus()
    }
    return this.getStatus()
  }

  /** Test helper: last VAD speech-active flag. */
  getVadSpeechActive(): boolean {
    return this.speechActive
  }

  getBargeInArmed(): boolean {
    return this.bargeInArmed
  }

  private startPartialLoop(sessionId: string) {
    this.stopPartialLoop()
    if (!this.partialsEnabled || !this.stt.isReady()) return

    const tick = () => {
      void this.maybeEmitPartial(sessionId)
    }
    // Tick a bit faster than interval so the clock can fire promptly after min audio.
    const period = Math.max(200, Math.floor(this.partialPolicy.intervalMs / 2))
    this.partialTimer = setInterval(tick, period)
    this.partialTimer.unref?.()
  }

  private stopPartialLoop() {
    if (this.partialTimer) {
      clearInterval(this.partialTimer)
      this.partialTimer = null
    }
  }

  private async waitForPartialIdle() {
    const deadline = Date.now() + 15_000
    while (this.partialInFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    this.partialInFlight = false
  }

  private async maybeEmitPartial(sessionId: string) {
    if (this.partialInFlight) return
    const active = this.session
    if (!active || active.id !== sessionId || this.phase !== 'listening') return
    if (!this.stt.isReady()) return

    const samples = active.buffer.snapshot()
    const slice = this.partialClock.takePartialSlice(samples, this.now().getTime())
    if (!slice || slice.length === 0) return

    this.partialInFlight = true
    try {
      const result = await this.stt.transcribePcm(slice)
      // Session may have ended while STT ran.
      if (!this.session || this.session.id !== sessionId || this.phase !== 'listening') return
      const text = result.text.trim()
      if (!text || text === this.lastPartialText) return
      this.lastPartialText = text
      log('voice', `stt.partial ${JSON.stringify({ ...sttLogMeta(result), frames: slice.length })}`)
      this.onEvent({
        type: 'partial',
        event: {
          sessionId,
          text,
          isFinal: false,
          at: this.now().toISOString(),
        },
      })
    } catch {
      // Partials are best-effort; finalize still runs on stop.
    } finally {
      this.partialInFlight = false
    }
  }

  private onVadChunk(sessionId: string, chunk: Float32Array) {
    if (this.autoFinalizeInFlight) return
    const previous = this.vadState
    const { state, shouldFinalize, reason } = tickVad(previous, chunk, this.vadPolicy)
    this.vadState = state
    if (state.speechActive !== this.speechActive) {
      this.speechActive = state.speechActive
      this.emitVad(sessionId, state.speechActive ? 'speech_start' : 'speech_end', state.speechActive)
      this.emitStatus()
    }
    if (shouldFinalize) {
      this.autoFinalizeInFlight = true
      this.emitVad(sessionId, reason === 'timeout' ? 'timeout' : 'speech_end', false)
      void this.stopSession(sessionId).finally(() => {
        this.autoFinalizeInFlight = false
      })
    }
  }

  private async startBargeInMonitor(onBargeIn: () => void) {
    if (!this.bargeInEnabled) return
    if (this.capture.backend === 'unavailable') return
    if (this.session || this.bargeInCapture) return
    this.bargeInArmed = true
    this.bargeInCapture = true
    this.emitVad(null, 'armed', false)
    this.emitStatus()
    try {
      await this.capture.start((chunk) => {
        if (!this.speakInFlight || !this.bargeInArmed) return
        if (!isBargeInSpeech(chunk, this.vadPolicy)) return
        this.bargeInArmed = false
        this.emitVad(null, 'barge_in', true)
        onBargeIn()
        void this.tts.cancel()
      })
    } catch {
      this.bargeInArmed = false
      this.bargeInCapture = false
    }
  }

  private async stopBargeInMonitor() {
    const wasArmed = this.bargeInArmed || this.bargeInCapture
    this.bargeInArmed = false
    if (this.bargeInCapture) {
      this.bargeInCapture = false
      // Only stop capture if no active listen session owns it.
      if (!this.session) {
        try {
          await this.capture.stop()
        } catch {
          // best-effort
        }
      }
    }
    if (wasArmed) {
      this.emitVad(null, 'disarmed', false)
    }
  }

  private emitVad(
    sessionId: string | null,
    reason: 'speech_start' | 'speech_end' | 'timeout' | 'barge_in' | 'armed' | 'disarmed',
    speechActive: boolean,
  ) {
    this.onEvent({
      type: 'vad',
      event: {
        sessionId,
        speechActive,
        reason,
        at: this.now().toISOString(),
      },
    })
  }

  private publicSession(session: ActiveSession): VoiceSessionSnapshot {
    return {
      id: session.id,
      openCodeSessionId: session.openCodeSessionId,
      workspaceId: session.workspaceId,
      mode: session.mode,
      phase: session.phase,
      startedAt: session.startedAt,
      continuousVad: session.continuousVad,
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
