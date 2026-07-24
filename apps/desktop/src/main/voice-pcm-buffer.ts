/**
 * Host-side PCM buffer for private voice (JOE-1097).
 *
 * Holds 16 kHz mono f32 samples in the main process only. Never serialize this
 * buffer onto renderer IPC.
 */

export const VOICE_PCM_SAMPLE_RATE = 16_000
export const VOICE_PCM_CHANNELS = 1

/** ~60s rolling window matches Aurum dictation defaults. */
export const VOICE_PCM_MAX_FRAMES = VOICE_PCM_SAMPLE_RATE * 60

export class VoicePcmBuffer {
  private samples: Float32Array
  private length = 0
  private peakAbs = 0
  private readonly maxFrames: number

  constructor(maxFrames = VOICE_PCM_MAX_FRAMES) {
    this.maxFrames = maxFrames
    this.samples = new Float32Array(maxFrames)
  }

  get frameCount() {
    return this.length
  }

  get peak() {
    return this.peakAbs
  }

  get durationSeconds() {
    return this.length / VOICE_PCM_SAMPLE_RATE
  }

  clear() {
    this.length = 0
    this.peakAbs = 0
  }

  /** Append mono f32 samples. Older samples drop when maxFrames is exceeded. */
  push(chunk: Float32Array | number[]) {
    if (chunk.length === 0) return
    const input = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk)
    for (let i = 0; i < input.length; i += 1) {
      const v = input[i]!
      const abs = v < 0 ? -v : v
      if (abs > this.peakAbs) this.peakAbs = abs
    }

    if (input.length >= this.maxFrames) {
      this.samples.set(input.subarray(input.length - this.maxFrames))
      this.length = this.maxFrames
      return
    }

    const overflow = this.length + input.length - this.maxFrames
    if (overflow > 0) {
      this.samples.copyWithin(0, overflow, this.length)
      this.length -= overflow
    }
    this.samples.set(input, this.length)
    this.length += input.length
  }

  /** Host-only copy of current samples (never send over IPC). */
  snapshot(): Float32Array {
    return this.samples.slice(0, this.length)
  }

  /** Diagnostics only — safe for renderer status events. */
  stats() {
    return {
      sampleRate: VOICE_PCM_SAMPLE_RATE,
      channels: VOICE_PCM_CHANNELS as 1,
      frames: this.length,
      durationSeconds: this.durationSeconds,
      peak: this.peakAbs,
    }
  }
}
