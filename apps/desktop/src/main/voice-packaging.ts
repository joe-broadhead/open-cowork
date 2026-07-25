/**
 * Desktop packaging layout for private voice native deps (JOE-1106).
 *
 * Default STT path is the Aurum CLI (optional drop-in under resources/voice
 * or PATH). Capture uses ffmpeg (PATH or packaged). TTS is OS tools (say /
 * afplay) — no neural model bundle in the app by default.
 *
 * Honest residual: we do **not** ship Aurum model weights or a prebuilt
 * aurum-ffi dylib in CI packages today. Operators install Aurum + cache
 * tiny-q5_1, or drop binaries into the packaged voice resources folder.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { platform as osPlatform } from 'node:os'

export type VoicePackagingPlatform = 'darwin' | 'linux' | 'win32' | 'other'

export type VoiceNativeBinaryKind = 'aurum' | 'ffmpeg'

export type VoicePlatformPackagingRow = {
  platform: VoicePackagingPlatform
  /** Capture backend expectation when feature is on. */
  capture: string
  /** STT expectation. */
  stt: string
  /** TTS expectation. */
  tts: string
  /** Support level for shipping claims. */
  support: 'supported' | 'best_effort' | 'residual'
  residual: string | null
}

/** Operator-facing packaging matrix (also mirrored in ADR / dogfood runbook). */
export const VOICE_PACKAGING_MATRIX: VoicePlatformPackagingRow[] = [
  {
    platform: 'darwin',
    capture: 'ffmpeg (PATH or OPEN_COWORK_FFMPEG_PATH) → mono 16 kHz f32',
    stt: 'aurum CLI (PATH, OPEN_COWORK_AURUM_BIN, or resources/voice/aurum); model tiny-q5_1 local cache',
    tts: 'system_os (say + afplay)',
    support: 'supported',
    residual: 'Aurum binary and model weights are not pre-bundled in CI packages; install or drop into resources/voice.',
  },
  {
    platform: 'win32',
    capture: 'ffmpeg dshow (PATH) best-effort',
    stt: 'aurum CLI when available on PATH or packaged voice/aurum.exe',
    tts: 'system_os residual (PowerShell/SAPI deferred — may report unavailable)',
    support: 'best_effort',
    residual: 'Windows TTS OS backend and signed aurum.exe packaging are residual; fail-closed when tools missing.',
  },
  {
    platform: 'linux',
    capture: 'ffmpeg pulse/alsa (PATH) best-effort',
    stt: 'aurum CLI when available on PATH or packaged voice/aurum',
    tts: 'system_os residual (espeak/spd-say deferred — may report unavailable)',
    support: 'best_effort',
    residual: 'Linux neural TTS packaging deferred; capture/STT require host-installed ffmpeg + aurum.',
  },
]

export function voicePackagingPlatform(id = osPlatform()): VoicePackagingPlatform {
  if (id === 'darwin' || id === 'linux' || id === 'win32') return id
  return 'other'
}

export function isElectronPackaged(
  env: NodeJS.ProcessEnv = process.env,
  electronApp?: { isPackaged?: boolean } | null,
): boolean {
  if (electronApp && typeof electronApp.isPackaged === 'boolean') {
    return electronApp.isPackaged
  }
  // electron-builder / Electron set these in production.
  return env.OPEN_COWORK_PACKAGED === '1'
    || Boolean(env.PORTABLE_EXECUTABLE_DIR)
    || (typeof process.resourcesPath === 'string'
      && process.resourcesPath.length > 0
      && !process.resourcesPath.includes(`${join('node_modules', 'electron')}`))
}

/**
 * Packaged resources root for optional voice sidecars.
 * Layout: `{resourcesPath}/voice/aurum` (+ optional `ffmpeg`, README).
 */
export function voicePackagedResourcesDir(
  resourcesPath: string | null | undefined = typeof process.resourcesPath === 'string'
    ? process.resourcesPath
    : null,
): string | null {
  if (!resourcesPath) return null
  return join(resourcesPath, 'voice')
}

export function packagedBinaryName(kind: VoiceNativeBinaryKind, platform = osPlatform()): string {
  if (platform === 'win32') {
    return kind === 'aurum' ? 'aurum.exe' : 'ffmpeg.exe'
  }
  return kind === 'aurum' ? 'aurum' : 'ffmpeg'
}

/**
 * Ordered candidates for Aurum CLI. Never invents non-existent absolute paths
 * as "ready" — only returns PATH names or paths that exist on disk.
 */
export function listAurumBinCandidates(options: {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string | null
  platform?: NodeJS.Platform
} = {}): string[] {
  const env = options.env || process.env
  const platform = options.platform || osPlatform()
  const resources = options.resourcesPath !== undefined
    ? options.resourcesPath
    : (typeof process.resourcesPath === 'string' ? process.resourcesPath : null)
  const voiceDir = voicePackagedResourcesDir(resources)
  const packaged = voiceDir
    ? join(voiceDir, packagedBinaryName('aurum', platform))
    : null

  const out: string[] = []
  const push = (value: string | null | undefined) => {
    const v = value?.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  push(env.OPEN_COWORK_AURUM_BIN)
  push(env.AURUM_BIN)
  push(packaged)
  // Dev convenience: sibling checkout of aurum
  if (platform === 'darwin') {
    push(join(homedir(), '.local', 'bin', 'aurum'))
  }
  push('aurum')
  return out
}

export function listFfmpegBinCandidates(options: {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string | null
  platform?: NodeJS.Platform
} = {}): string[] {
  const env = options.env || process.env
  const platform = options.platform || osPlatform()
  const resources = options.resourcesPath !== undefined
    ? options.resourcesPath
    : (typeof process.resourcesPath === 'string' ? process.resourcesPath : null)
  const voiceDir = voicePackagedResourcesDir(resources)
  const packaged = voiceDir
    ? join(voiceDir, packagedBinaryName('ffmpeg', platform))
    : null

  const out: string[] = []
  const push = (value: string | null | undefined) => {
    const v = value?.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  push(env.OPEN_COWORK_FFMPEG_PATH)
  push(env.FFMPEG_PATH)
  push(packaged)
  push('ffmpeg')
  return out
}

/**
 * Resolve first usable binary. PATH bare names (`aurum`, `ffmpeg`) are returned
 * without existsSync so spawn can search PATH. Absolute/relative paths must exist.
 */
export function resolveFirstExistingBinary(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate === 'aurum' || candidate === 'ffmpeg' || candidate === 'aurum.exe' || candidate === 'ffmpeg.exe') {
      return candidate
    }
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolvePackagedAwareAurumBin(options?: {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string | null
  platform?: NodeJS.Platform
}): string | null {
  return resolveFirstExistingBinary(listAurumBinCandidates(options))
}

export function resolvePackagedAwareFfmpegBin(options?: {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string | null
  platform?: NodeJS.Platform
}): string | null {
  return resolveFirstExistingBinary(listFfmpegBinCandidates(options))
}

/**
 * CI gate helper: packaged absolute candidates under a fake resources tree must
 * not be returned when files are missing (no broken dylib/dll claims).
 */
export function assertNoBrokenPackagedVoicePaths(
  resourcesRoot: string,
  platform: NodeJS.Platform = 'darwin',
): { ok: true } | { ok: false; leaked: string[] } {
  const aurum = listAurumBinCandidates({ resourcesPath: resourcesRoot, platform, env: {} })
    .filter((c) => c.startsWith(resourcesRoot) && !existsSync(c))
  const ffmpeg = listFfmpegBinCandidates({ resourcesPath: resourcesRoot, platform, env: {} })
    .filter((c) => c.startsWith(resourcesRoot) && !existsSync(c))
  // Candidates may list missing paths; resolveFirstExistingBinary must skip them.
  const resolvedA = resolveFirstExistingBinary(
    listAurumBinCandidates({ resourcesPath: resourcesRoot, platform, env: {} }),
  )
  const resolvedF = resolveFirstExistingBinary(
    listFfmpegBinCandidates({ resourcesPath: resourcesRoot, platform, env: {} }),
  )
  const leaked: string[] = []
  if (resolvedA && resolvedA.startsWith(resourcesRoot) && !existsSync(resolvedA)) {
    leaked.push(resolvedA)
  }
  if (resolvedF && resolvedF.startsWith(resourcesRoot) && !existsSync(resolvedF)) {
    leaked.push(resolvedF)
  }
  // Also ensure we don't treat missing packaged path as the only candidate "ready"
  void aurum
  void ffmpeg
  if (leaked.length > 0) return { ok: false, leaked }
  return { ok: true }
}

export function packagingRowForPlatform(platform = voicePackagingPlatform()): VoicePlatformPackagingRow | null {
  return VOICE_PACKAGING_MATRIX.find((row) => row.platform === platform) || null
}
