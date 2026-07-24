/**
 * Microphone capture backends for the Desktop voice host (JOE-1097).
 *
 * Capture stays in main/native. Renderers never receive raw audio bytes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { VOICE_PCM_SAMPLE_RATE } from './voice-pcm-buffer.ts'

export type VoiceCaptureBackendId = 'fake' | 'ffmpeg' | 'unavailable'

export type VoiceCaptureChunkHandler = (samples: Float32Array) => void

export type VoiceCapture = {
  readonly backend: VoiceCaptureBackendId
  readonly detail: string
  start(onChunk: VoiceCaptureChunkHandler): Promise<void>
  stop(): Promise<void>
}

export class FakeVoiceCapture implements VoiceCapture {
  readonly backend = 'fake' as const
  readonly detail = 'Injected capture for tests'
  private running = false
  private timer: NodeJS.Timeout | null = null
  private onChunk: VoiceCaptureChunkHandler | null = null
  private readonly options: {
    chunkFrames?: number
    intervalMs?: number
  }

  constructor(options: {
    /** Synthetic frames pushed each tick. Default: low-level sine-ish noise. */
    chunkFrames?: number
    intervalMs?: number
  } = {}) {
    this.options = options
  }

  async start(onChunk: VoiceCaptureChunkHandler) {
    if (this.running) return
    this.running = true
    this.onChunk = onChunk
    const frames = this.options.chunkFrames ?? 320 // 20ms @ 16kHz
    const intervalMs = this.options.intervalMs ?? 20
    let t = 0
    this.timer = setInterval(() => {
      if (!this.running || !this.onChunk) return
      const chunk = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) {
        chunk[i] = Math.sin((t + i) * 0.05) * 0.05
      }
      t += frames
      this.onChunk(chunk)
    }, intervalMs)
    this.timer.unref?.()
  }

  async stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.onChunk = null
  }

  /** Test helper: push one explicit chunk while running. */
  push(samples: Float32Array | number[]) {
    if (!this.onChunk) return
    this.onChunk(samples instanceof Float32Array ? samples : Float32Array.from(samples))
  }
}

export class UnavailableVoiceCapture implements VoiceCapture {
  readonly backend = 'unavailable' as const
  readonly detail: string
  constructor(detail: string) {
    this.detail = detail
  }
  async start() {
    throw new Error(this.detail)
  }
  async stop() {}
}

/**
 * ffmpeg-based capture: 16 kHz mono f32le on stdout.
 * macOS: avfoundation; Linux: pulse/alsa; Windows: dshow (best-effort).
 */
export class FfmpegVoiceCapture implements VoiceCapture {
  readonly backend = 'ffmpeg' as const
  readonly detail: string
  private child: ChildProcess | null = null
  private onChunk: VoiceCaptureChunkHandler | null = null
  private leftover: Buffer = Buffer.alloc(0)
  private readonly ffmpegPath: string

  constructor(ffmpegPath: string, platformId = platform()) {
    this.ffmpegPath = ffmpegPath
    this.detail = `ffmpeg capture (${platformId}) via ${ffmpegPath}`
  }

  async start(onChunk: VoiceCaptureChunkHandler) {
    if (this.child) return
    this.onChunk = onChunk
    const args = buildFfmpegCaptureArgs(platform())
    const child = spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.on('data', (buf: Buffer) => this.consume(buf))
    child.stderr?.on('data', () => {
      // Intentionally ignore verbose ffmpeg logs; failures surface via exit.
    })
    child.on('error', () => {
      void this.stop()
    })
    child.on('exit', () => {
      this.child = null
      this.onChunk = null
      this.leftover = Buffer.alloc(0)
    })
  }

  async stop() {
    const child = this.child
    this.child = null
    this.onChunk = null
    this.leftover = Buffer.alloc(0)
    if (!child) return
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', done)
      try {
        child.kill('SIGTERM')
      } catch {
        done()
        return
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
        done()
      }, 1500).unref?.()
    })
  }

  private consume(buf: Buffer) {
    if (!this.onChunk) return
    const data = this.leftover.length > 0
      ? Buffer.concat([this.leftover, buf])
      : Buffer.from(buf)
    const usable = data.length - (data.length % 4)
    if (usable <= 0) {
      this.leftover = data
      return
    }
    const copy = Buffer.allocUnsafe(usable)
    data.copy(copy, 0, 0, usable)
    const view = new Float32Array(copy.buffer, copy.byteOffset, usable / 4)
    // Copy so the ArrayBuffer is not reused after Buffer recycle.
    this.onChunk(new Float32Array(view))
    this.leftover = usable < data.length ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0)
  }
}

export function buildFfmpegCaptureArgs(platformId: NodeJS.Platform): string[] {
  const commonOut = [
    '-ac', '1',
    '-ar', String(VOICE_PCM_SAMPLE_RATE),
    '-f', 'f32le',
    'pipe:1',
  ]
  if (platformId === 'darwin') {
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', ':default',
      ...commonOut,
    ]
  }
  if (platformId === 'linux') {
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'pulse',
      '-i', 'default',
      ...commonOut,
    ]
  }
  if (platformId === 'win32') {
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-i', 'audio=default',
      ...commonOut,
    ]
  }
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=16000:cl=mono',
    ...commonOut,
  ]
}

function resolveFfmpegPath(): string | null {
  const candidates = [
    process.env.OPEN_COWORK_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    'ffmpeg',
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return 'ffmpeg'
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Production default: ffmpeg when resolvable, otherwise unavailable. */
export function createDefaultVoiceCapture(): VoiceCapture {
  if (process.env.OPEN_COWORK_VOICE_FAKE_CAPTURE === '1') {
    return new FakeVoiceCapture()
  }
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    return new UnavailableVoiceCapture(
      'Microphone capture requires ffmpeg on PATH (or OPEN_COWORK_FFMPEG_PATH). Host keeps audio out of the renderer.',
    )
  }
  return new FfmpegVoiceCapture(ffmpeg)
}
