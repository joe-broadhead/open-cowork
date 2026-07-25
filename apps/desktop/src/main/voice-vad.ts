/**
 * Energy-based voice activity detection for continuous conversation (JOE-1104).
 *
 * Local-only RMS gate — not a neural VAD. Default off at the product layer;
 * this module is pure policy + clock so host/tests can drive it.
 */
import { computeRms } from './voice-partial-window.ts'
import { VOICE_PCM_SAMPLE_RATE } from './voice-pcm-buffer.ts'

export type VoiceVadPolicy = {
  /** RMS above this counts as speech (float samples roughly in [-1, 1]). */
  speechRms: number
  /** RMS below this counts as silence once speech has started. */
  silenceRms: number
  /** Minimum continuous speech frames before we consider speech "started". */
  minSpeechFrames: number
  /** Silence frames after speech before end-of-utterance. */
  endSilenceFrames: number
  /** Hard cap on a single listen window (frames). */
  maxListenFrames: number
  /** Ignore leading silence until this many frames (avoid immediate end). */
  prerollFrames: number
}

export type VoiceVadState = {
  speechActive: boolean
  speechFrames: number
  silenceFrames: number
  totalFrames: number
  ended: boolean
  timedOut: boolean
}

export type VoiceVadTickResult = {
  state: VoiceVadState
  /** True once when end-of-utterance or max-listen fires. */
  shouldFinalize: boolean
  reason: 'silence' | 'timeout' | null
}

export function defaultConversationVadPolicy(): VoiceVadPolicy {
  return {
    speechRms: 0.012,
    silenceRms: 0.006,
    minSpeechFrames: Math.floor(VOICE_PCM_SAMPLE_RATE * 0.25), // ~250ms
    endSilenceFrames: Math.floor(VOICE_PCM_SAMPLE_RATE * 0.9), // ~900ms
    maxListenFrames: VOICE_PCM_SAMPLE_RATE * 30, // 30s hard cap
    prerollFrames: Math.floor(VOICE_PCM_SAMPLE_RATE * 0.15),
  }
}

export function createVadState(): VoiceVadState {
  return {
    speechActive: false,
    speechFrames: 0,
    silenceFrames: 0,
    totalFrames: 0,
    ended: false,
    timedOut: false,
  }
}

/**
 * Feed a new PCM chunk. Pure: returns next state + whether the host should
 * finalize the listen session (end of utterance or timeout).
 */
export function tickVad(
  previous: VoiceVadState,
  chunk: Float32Array,
  policy: VoiceVadPolicy = defaultConversationVadPolicy(),
): VoiceVadTickResult {
  if (previous.ended) {
    return { state: previous, shouldFinalize: false, reason: null }
  }

  const rms = computeRms(chunk)
  const frames = chunk.length
  let speechActive = previous.speechActive
  let speechFrames = previous.speechFrames
  let silenceFrames = previous.silenceFrames
  const totalFrames = previous.totalFrames + frames

  if (rms >= policy.speechRms) {
    speechFrames += frames
    silenceFrames = 0
    if (!speechActive && speechFrames >= policy.minSpeechFrames) {
      speechActive = true
    }
  } else if (rms <= policy.silenceRms) {
    if (speechActive) {
      silenceFrames += frames
    } else {
      // Still in preroll / waiting for speech — do not accumulate "end" silence.
      silenceFrames = 0
      // Decay weak false-start speech counters slowly.
      speechFrames = Math.max(0, speechFrames - frames)
    }
  } else {
    // Hysteresis band: keep current counters lightly sticky.
    if (speechActive) silenceFrames += Math.floor(frames / 2)
  }

  let ended = false
  let timedOut = false
  let shouldFinalize = false
  let reason: 'silence' | 'timeout' | null = null

  if (totalFrames >= policy.maxListenFrames) {
    ended = true
    timedOut = true
    shouldFinalize = true
    reason = 'timeout'
  } else if (
    speechActive
    && silenceFrames >= policy.endSilenceFrames
    && totalFrames >= policy.prerollFrames
  ) {
    ended = true
    shouldFinalize = true
    reason = 'silence'
  }

  return {
    state: {
      speechActive,
      speechFrames,
      silenceFrames,
      totalFrames,
      ended,
      timedOut,
    },
    shouldFinalize,
    reason,
  }
}

/**
 * Lightweight barge-in detector: true when a chunk looks like speech while
 * the assistant is speaking (host-owned, no STT).
 */
export function isBargeInSpeech(
  chunk: Float32Array,
  policy: VoiceVadPolicy = defaultConversationVadPolicy(),
): boolean {
  return computeRms(chunk) >= policy.speechRms * 1.4
}
