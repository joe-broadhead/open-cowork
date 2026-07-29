/**
 * Private TTS engines for Desktop Local voice (JOE-1108).
 *
 * Sibling of Aurum STT — never fold synthesis into Aurum. MVP path is OS
 * system speech (macOS `say` + `afplay`) with no cloud TTS and no model
 * download on the default path. Piper/neural sidecars remain a future option.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:os'
import { randomUUID } from 'node:crypto'

type VoiceTtsBackendId = 'fake' | 'system_os' | 'unavailable'

export type VoiceTtsVoice = {
  id: string
  name: string
  language?: string | null
}

export type VoiceTtsSpeakOptions = {
  voiceId?: string | null
  /** Words-per-minute style rate when the backend supports it (macOS say -r). */
  rate?: number | null
}

export type VoiceTtsSynthResult = {
  /** Absolute path to a temporary audio file owned by the caller to delete. */
  path: string
  format: 'aiff' | 'wav' | 'marker'
  voiceId: string
  backend: VoiceTtsBackendId
  durationMs: number
}

export type VoiceTtsEngine = {
  readonly backend: VoiceTtsBackendId
  readonly detail: string
  isReady(): boolean
  listVoices(): Promise<VoiceTtsVoice[]>
  /**
   * Local-only synthesis to a temp file. Never uploads text/audio.
   * Caller must delete the file when done (or use speak()).
   */
  synthesize(text: string, options?: VoiceTtsSpeakOptions): Promise<VoiceTtsSynthResult>
  /** Synthesize + host-owned playback. Cancels any prior speak. */
  speak(text: string, options?: VoiceTtsSpeakOptions): Promise<void>
  /** Stop current playback/synthesis if any. */
  cancel(): Promise<void>
  dispose?(): void
}

export const VOICE_TTS_MAX_TEXT_CHARS = 8_000
const VOICE_TTS_DEFERRED_REASON =
  'Local TTS not ready: OS speech tools unavailable on this platform.'

function assertSpeakableText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('TTS text is empty.')
  if (trimmed.length > VOICE_TTS_MAX_TEXT_CHARS) {
    throw new Error(`TTS text exceeds ${VOICE_TTS_MAX_TEXT_CHARS} characters.`)
  }
  return trimmed
}

function runProcess(command: string, args: string[], options: {
  onSpawn?: (child: ChildProcess) => void
} = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    options.onSpawn?.(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`))
    })
  })
}

export class FakeVoiceTts implements VoiceTtsEngine {
  readonly backend = 'fake' as const
  readonly detail = 'Injected TTS for tests'
  readonly spoken: string[] = []
  private cancelled = false
  private speaking: Promise<void> | null = null

  isReady() {
    return true
  }

  async listVoices(): Promise<VoiceTtsVoice[]> {
    return [{ id: 'fake', name: 'Fake Voice', language: 'en' }]
  }

  async synthesize(text: string, options: VoiceTtsSpeakOptions = {}): Promise<VoiceTtsSynthResult> {
    const body = assertSpeakableText(text)
    const start = Date.now()
    const dir = mkdtempSync(join(tmpdir(), 'oc-voice-tts-'))
    const path = join(dir, 'speech.marker')
    writeFileSync(path, body, 'utf8')
    return {
      path,
      format: 'marker',
      voiceId: options.voiceId?.trim() || 'fake',
      backend: 'fake',
      durationMs: Date.now() - start,
    }
  }

  async speak(text: string, options: VoiceTtsSpeakOptions = {}): Promise<void> {
    await this.cancel()
    this.cancelled = false
    const body = assertSpeakableText(text)
    this.speaking = (async () => {
      if (this.cancelled) return
      this.spoken.push(body)
      // Tiny delay so cancel races can be tested.
      await new Promise((r) => setTimeout(r, 5))
      if (this.cancelled) return
      void options
    })()
    try {
      await this.speaking
    } finally {
      this.speaking = null
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.speaking) {
      try {
        await this.speaking
      } catch {
        // ignore
      }
    }
  }
}

export class UnavailableVoiceTts implements VoiceTtsEngine {
  readonly backend = 'unavailable' as const
  readonly detail: string
  constructor(detail: string) {
    this.detail = detail
  }
  isReady() {
    return false
  }
  async listVoices() {
    return []
  }
  async synthesize(): Promise<VoiceTtsSynthResult> {
    throw new Error(this.detail)
  }
  async speak(): Promise<void> {
    throw new Error(this.detail)
  }
  async cancel(): Promise<void> {}
}

/**
 * OS system speech — local only, no network.
 * macOS: `say` synthesize + `afplay` playback.
 * Linux/Windows: unavailable until a platform backend is wired (espeak / SAPI).
 */
export class SystemOsVoiceTts implements VoiceTtsEngine {
  readonly backend = 'system_os' as const
  readonly detail: string
  private readonly platformId: string
  private activeChild: ChildProcess | null = null
  private activeTempPath: string | null = null
  private generation = 0

  constructor(platformId = platform()) {
    this.platformId = platformId
    if (platformId === 'darwin' && existsSync('/usr/bin/say')) {
      this.detail = 'macOS system speech (say + afplay), local only'
    } else {
      this.detail = VOICE_TTS_DEFERRED_REASON
    }
  }

  isReady() {
    return this.platformId === 'darwin' && existsSync('/usr/bin/say')
  }

  async listVoices(): Promise<VoiceTtsVoice[]> {
    if (!this.isReady()) return []
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: out })
        else reject(new Error(`say -v ? exited ${code}`))
      })
    })
    const voices: VoiceTtsVoice[] = []
    for (const line of stdout.split('\n')) {
      // e.g. "Albert              en_US    # Hello! My name is Albert."
      const match = line.match(/^(\S+)\s+(\S+)/)
      if (!match) continue
      voices.push({ id: match[1]!, name: match[1]!, language: match[2] || null })
    }
    return voices
  }

  async synthesize(text: string, options: VoiceTtsSpeakOptions = {}): Promise<VoiceTtsSynthResult> {
    if (!this.isReady()) throw new Error(this.detail)
    const body = assertSpeakableText(text)
    const start = Date.now()
    const dir = mkdtempSync(join(tmpdir(), 'oc-voice-tts-'))
    const path = join(dir, `${randomUUID()}.aiff`)
    const args = ['-o', path]
    const voiceId = options.voiceId?.trim()
    if (voiceId) {
      args.push('-v', voiceId)
    }
    if (typeof options.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0) {
      args.push('-r', String(Math.round(options.rate)))
    }
    args.push(body)
    await runProcess('/usr/bin/say', args)
    if (!existsSync(path)) {
      throw new Error('macOS say did not produce an audio file.')
    }
    return {
      path,
      format: 'aiff',
      voiceId: voiceId || 'default',
      backend: 'system_os',
      durationMs: Date.now() - start,
    }
  }

  async speak(text: string, options: VoiceTtsSpeakOptions = {}): Promise<void> {
    if (!this.isReady()) throw new Error(this.detail)
    await this.cancel()
    const gen = ++this.generation
    const synth = await this.synthesize(text, options)
    if (gen !== this.generation) {
      rmTemp(synth.path)
      return
    }
    this.activeTempPath = synth.path
    try {
      if (!existsSync('/usr/bin/afplay')) {
        // Fall back to say without -o for playback if afplay missing (unlikely on macOS).
        await runProcess('/usr/bin/say', buildSayArgs(text, options), {
          onSpawn: (child) => {
            this.activeChild = child
          },
        })
      } else {
        await runProcess('/usr/bin/afplay', [synth.path], {
          onSpawn: (child) => {
            this.activeChild = child
          },
        })
      }
    } finally {
      if (this.activeTempPath === synth.path) this.activeTempPath = null
      this.activeChild = null
      rmTemp(synth.path)
    }
  }

  async cancel(): Promise<void> {
    this.generation += 1
    const child = this.activeChild
    this.activeChild = null
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    if (this.activeTempPath) {
      rmTemp(this.activeTempPath)
      this.activeTempPath = null
    }
  }

  dispose() {
    void this.cancel()
  }
}

function buildSayArgs(text: string, options: VoiceTtsSpeakOptions): string[] {
  const args: string[] = []
  const voiceId = options.voiceId?.trim()
  if (voiceId) args.push('-v', voiceId)
  if (typeof options.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0) {
    args.push('-r', String(Math.round(options.rate)))
  }
  args.push(assertSpeakableText(text))
  return args
}

function rmTemp(path: string) {
  try {
    rmSync(path, { force: true })
    // Remove parent temp dir if empty-ish (best effort).
    const parent = join(path, '..')
    try {
      rmSync(parent, { recursive: true, force: true })
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

export function createDefaultVoiceTts(): VoiceTtsEngine {
  const system = new SystemOsVoiceTts()
  if (system.isReady()) return system
  return new UnavailableVoiceTts(system.detail)
}
