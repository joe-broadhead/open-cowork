/**
 * Host-side partial STT window (JOE-1102).
 *
 * Mirrors Aurum's PartialWindowPolicy / PartialClock defaults for dictation:
 * min ~1s audio, ~15s rolling window, ~1.2s interval, RMS energy gate.
 * Does not stream whisper continuously — the host decides when to call STT.
 */
import { VOICE_PCM_SAMPLE_RATE } from './voice-pcm-buffer.ts'

export type VoicePartialWindowPolicy = {
  /** Frames required before the first partial (default ~1s). */
  minFramesBeforePartial: number
  /** Rolling decode window in frames (default ~15s). */
  windowFrames: number
  /** Minimum ms between partial attempts (default 1200). */
  intervalMs: number
  /** Minimum RMS on the decode window to attempt a partial. */
  minRms: number
}

export function dictationPartialPolicy(): VoicePartialWindowPolicy {
  return {
    minFramesBeforePartial: VOICE_PCM_SAMPLE_RATE * 1,
    windowFrames: VOICE_PCM_SAMPLE_RATE * 15,
    intervalMs: 1200,
    minRms: 0.008,
  }
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

/**
 * Pure clock: given full buffer + now, optionally return a trailing slice
 * eligible for a partial decode. Returns null when gated by time/energy/length.
 */
export class VoicePartialClock {
  /** null until the first successful partial slice is taken. */
  private lastPartialAtMs: number | null = null
  private readonly policy: VoicePartialWindowPolicy

  constructor(policy: VoicePartialWindowPolicy = dictationPartialPolicy()) {
    this.policy = policy
  }

  reset() {
    this.lastPartialAtMs = null
  }

  takePartialSlice(samples: Float32Array, nowMs: number): Float32Array | null {
    if (samples.length < this.policy.minFramesBeforePartial) return null
    if (this.lastPartialAtMs !== null && nowMs - this.lastPartialAtMs < this.policy.intervalMs) {
      return null
    }

    const start = Math.max(0, samples.length - this.policy.windowFrames)
    const slice = samples.subarray(start)
    const rms = computeRms(slice)
    if (rms < this.policy.minRms) return null

    this.lastPartialAtMs = nowMs
    // Copy so STT work can run while the host buffer continues to grow.
    return new Float32Array(slice)
  }
}
