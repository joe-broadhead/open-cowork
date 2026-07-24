/**
 * Private STT engines for Desktop Local voice (JOE-1101).
 *
 * Default path is Aurum local provider only — never OpenRouter/cloud ASR.
 * local_only fail-closed: refuse transcription when the model file is missing
 * unless OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 (explicit operator opt-in).
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAppPathHost } from '@open-cowork/shared/node'
import { VOICE_PCM_SAMPLE_RATE } from './voice-pcm-buffer.ts'

export const AURUM_DEFAULT_MODEL = 'tiny-q5_1'
export const AURUM_DEFAULT_MODEL_FILE = 'ggml-tiny-q5_1.bin'

export type VoiceSttBackendId = 'fake' | 'aurum_cli' | 'unavailable'

export type VoiceSttResult = {
  text: string
  model: string
  backend: VoiceSttBackendId
  /** Milliseconds spent in the engine (best-effort). */
  durationMs: number
  cleaned: boolean
}

export type VoiceSttEngine = {
  readonly backend: VoiceSttBackendId
  readonly detail: string
  readonly model: string
  /** True when offline transcription can run (model present or fake). */
  isReady(): boolean
  /** Optional warm-up; no-op for CLI until first transcribe. */
  preload?(): Promise<void>
  transcribePcm(samples: Float32Array, options?: { language?: string }): Promise<VoiceSttResult>
  dispose?(): void
}

export class FakeVoiceStt implements VoiceSttEngine {
  readonly backend = 'fake' as const
  readonly detail = 'Injected STT for tests'
  readonly model: string
  private readonly text: string

  constructor(options: { text?: string; model?: string } = {}) {
    this.text = options.text ?? 'hello from fake stt'
    this.model = options.model ?? AURUM_DEFAULT_MODEL
  }

  isReady() {
    return true
  }

  async transcribePcm(samples: Float32Array): Promise<VoiceSttResult> {
    const start = Date.now()
    if (samples.length === 0) {
      return {
        text: '',
        model: this.model,
        backend: 'fake',
        durationMs: Date.now() - start,
        cleaned: false,
      }
    }
    return {
      text: this.text,
      model: this.model,
      backend: 'fake',
      durationMs: Date.now() - start,
      cleaned: true,
    }
  }
}

export class UnavailableVoiceStt implements VoiceSttEngine {
  readonly backend = 'unavailable' as const
  readonly model = AURUM_DEFAULT_MODEL
  readonly detail: string
  constructor(detail: string) {
    this.detail = detail
  }
  isReady() {
    return false
  }
  async transcribePcm(): Promise<VoiceSttResult> {
    throw new Error(this.detail)
  }
}

export type AurumCliVoiceSttOptions = {
  binPath: string
  model?: string
  cacheDir?: string
  /** Fail closed when model missing (default true). */
  localOnly?: boolean
  /** On-device rules cleanup style (default clean). Use raw to skip. */
  cleanup?: 'raw' | 'clean' | 'bullets' | 'professional' | 'summary'
  language?: string
  spawnImpl?: typeof spawn
  /** Override model presence probe (tests). */
  isModelCached?: (cacheDir: string, model: string) => boolean
}

/**
 * Spawns the Aurum CLI with `--provider local` only.
 * Never passes openrouter. Model download is blocked when localOnly.
 */
export class AurumCliVoiceStt implements VoiceSttEngine {
  readonly backend = 'aurum_cli' as const
  readonly model: string
  readonly detail: string
  private readonly binPath: string
  private readonly cacheDir: string
  private readonly localOnly: boolean
  private readonly cleanup: NonNullable<AurumCliVoiceSttOptions['cleanup']>
  private readonly language: string
  private readonly spawnImpl: typeof spawn
  private readonly isModelCachedFn: (cacheDir: string, model: string) => boolean

  constructor(options: AurumCliVoiceSttOptions) {
    this.binPath = options.binPath
    this.model = options.model || AURUM_DEFAULT_MODEL
    this.cacheDir = options.cacheDir || resolveDefaultAurumCacheDir()
    this.localOnly = options.localOnly !== false
    this.cleanup = options.cleanup || 'clean'
    this.language = options.language || 'en'
    this.spawnImpl = options.spawnImpl || spawn
    this.isModelCachedFn = options.isModelCached || ((dir, model) => isAurumModelAvailable(model, dir))
    this.detail = `Aurum CLI (${this.binPath}) model=${this.model} local_only=${this.localOnly ? '1' : '0'}`
  }

  isReady() {
    if (!this.localOnly) return true
    return this.isModelCachedFn(this.cacheDir, this.model)
  }

  async preload() {
    if (this.isReady()) return
    if (this.localOnly) {
      throw new Error(
        `Aurum model ${this.model} is not cached under ${this.cacheDir}. `
        + 'Install/download offline models first, or set OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 intentionally.',
      )
    }
  }

  async transcribePcm(samples: Float32Array, options: { language?: string } = {}): Promise<VoiceSttResult> {
    const start = Date.now()
    if (samples.length === 0) {
      return {
        text: '',
        model: this.model,
        backend: 'aurum_cli',
        durationMs: 0,
        cleaned: false,
      }
    }
    if (this.localOnly && !this.isModelCachedFn(this.cacheDir, this.model)) {
      throw new Error(
        `Aurum local_only: model ${this.model} is not present on disk (cache ${this.cacheDir}).`,
      )
    }

    const workDir = mkdtempSync(join(tmpdir(), 'open-cowork-voice-stt-'))
    const wavPath = join(workDir, `${randomUUID()}.wav`)
    try {
      writeWavFile(wavPath, samples, VOICE_PCM_SAMPLE_RATE)
      const args = [
        '--provider', 'local',
        '--model', this.model,
        '--language', options.language || this.language,
        '-o', 'txt',
      ]
      if (this.cleanup !== 'raw') {
        args.push('--cleanup', this.cleanup, '--cleanup-provider', 'rules')
      }
      args.push(wavPath)

      const { stdout, code, stderr } = await runProcess(this.spawnImpl, this.binPath, args, {
        env: {
          ...process.env,
          // Keep OpenRouter credentials out of the default STT path.
          OPENROUTER_API_KEY: '',
        },
      })
      if (code !== 0) {
        const hint = (stderr || stdout || '').trim().slice(0, 400)
        throw new Error(`Aurum CLI failed (exit ${code})${hint ? `: ${hint}` : ''}`)
      }
      const text = stdout.trim()
      return {
        text,
        model: this.model,
        backend: 'aurum_cli',
        durationMs: Date.now() - start,
        cleaned: this.cleanup !== 'raw',
      }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function resolveDefaultAurumCacheDir(): string {
  const fromEnv = process.env.OPEN_COWORK_AURUM_CACHE_DIR?.trim()
  if (fromEnv) return fromEnv
  const host = getAppPathHost()
  const userData = host?.getPath?.('userData')
  if (userData) {
    return join(userData, 'voice', 'aurum')
  }
  // Fallback mirrors Aurum defaults when Electron host is unavailable (unit tests).
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'aurum')
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'aurum', 'cache')
  }
  return join(homedir(), '.cache', 'aurum')
}

const MODEL_FILES: Record<string, string> = {
  'tiny-q5_1': 'ggml-tiny-q5_1.bin',
  tiny: 'ggml-tiny.bin',
  'base-q5_1': 'ggml-base-q5_1.bin',
  base: 'ggml-base.bin',
}

export function isAurumModelCached(cacheDir: string, model: string): boolean {
  const filename = MODEL_FILES[model] || `ggml-${model}.bin`
  return [
    join(cacheDir, 'models', filename),
    join(cacheDir, filename),
  ].some((path) => existsSync(path))
}

/** Probe OC cache first, then platform Aurum default caches. */
export function isAurumModelAvailable(model: string, cacheDir: string): boolean {
  if (isAurumModelCached(cacheDir, model)) return true
  const filename = MODEL_FILES[model] || `ggml-${model}.bin`
  const systemDirs: string[] = []
  if (process.platform === 'darwin') {
    systemDirs.push(join(homedir(), 'Library', 'Caches', 'aurum'))
  } else if (process.platform === 'win32') {
    systemDirs.push(join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'aurum', 'cache'))
  } else {
    systemDirs.push(join(homedir(), '.cache', 'aurum'))
  }
  return systemDirs.some((dir) => existsSync(join(dir, 'models', filename)))
}

export function resolveAurumBinPath(): string | null {
  const candidates = [
    process.env.OPEN_COWORK_AURUM_BIN,
    process.env.AURUM_BIN,
    'aurum',
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  for (const candidate of candidates) {
    if (candidate === 'aurum') return 'aurum'
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function createDefaultVoiceStt(): VoiceSttEngine {
  if (process.env.OPEN_COWORK_VOICE_FAKE_STT === '1') {
    return new FakeVoiceStt()
  }
  const bin = resolveAurumBinPath()
  if (!bin) {
    return new UnavailableVoiceStt(
      'Aurum STT requires the aurum CLI on PATH (or OPEN_COWORK_AURUM_BIN). '
      + 'Models stay local_only; install Aurum and cache tiny-q5_1 first.',
    )
  }
  const allowDownload = process.env.OPEN_COWORK_AURUM_ALLOW_DOWNLOAD === '1'
  return new AurumCliVoiceStt({
    binPath: bin,
    model: process.env.OPEN_COWORK_AURUM_MODEL?.trim() || AURUM_DEFAULT_MODEL,
    cacheDir: resolveDefaultAurumCacheDir(),
    localOnly: !allowDownload,
    cleanup: 'clean',
  })
}

/** Write mono f32 PCM as 16-bit PCM WAV for Aurum/ffmpeg loaders. */
export function writeWavFile(path: string, samples: Float32Array, sampleRate: number) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // audio format PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    buffer.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
}

function runProcess(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf8')
    if (typeof child.stderr?.setEncoding === 'function') child.stderr.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

/** Test helper: integrity digests of fixture text only (never audio). */
export function hashTranscriptText(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** Ensure no PCM-looking bulk payload is logged (length only). */
export function sttLogMeta(result: VoiceSttResult) {
  return {
    backend: result.backend,
    model: result.model,
    textChars: result.text.length,
    durationMs: result.durationMs,
    cleaned: result.cleaned,
  }
}

