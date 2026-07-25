/**
 * First-run STT/TTS asset readiness (JOE-1109).
 *
 * Models are **files** under the Open Cowork data dir (or Aurum system cache).
 * Download is never silent: default is local_only fail-closed. Opt-in download
 * is operator-controlled (`OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1`) and only moves
 * model weights — never user audio or transcripts.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AURUM_DEFAULT_MODEL,
  AURUM_DEFAULT_MODEL_FILE,
  isAurumModelAvailable,
  isAurumModelCached,
  resolveAurumBinPath,
  resolveDefaultAurumCacheDir,
} from './voice-stt.ts'
import { createDefaultVoiceTts } from './voice-tts.ts'

export type VoiceAssetIntegrity = 'ok' | 'missing' | 'unverified' | 'mismatch' | 'too_small'

export type VoiceSttAssetStatus = {
  model: string
  modelFile: string
  ready: boolean
  /** Open Cowork preferred cache root (userData/voice/aurum). */
  cacheDir: string
  /** Resolved model path when present, else null. Never a network URL. */
  modelPath: string | null
  integrity: VoiceAssetIntegrity
  /** Explicit opt-in for file download (env). Default false. */
  allowDownload: boolean
  /** Aurum CLI on PATH / OPEN_COWORK_AURUM_BIN. */
  cliAvailable: boolean
  detail: string | null
}

export type VoiceTtsAssetStatus = {
  ready: boolean
  backend: 'system_os' | 'fake' | 'unavailable'
  detail: string | null
}

export type VoiceAssetStatus = {
  stt: VoiceSttAssetStatus
  tts: VoiceTtsAssetStatus
  /** True when STT model is local + TTS backend ready — offline conversation possible. */
  offlineReady: boolean
}

export type VoiceAssetEnsureResult = {
  status: VoiceAssetStatus
  action: 'already_ready' | 'copied_from_system' | 'verified' | 'needs_download' | 'failed'
  detail: string
}

/** ggml tiny-q5_1 is ~30MB; reject obvious empty stubs. */
export const AURUM_MIN_MODEL_BYTES: Record<string, number> = {
  'tiny-q5_1': 10_000_000,
  tiny: 10_000_000,
  'base-q5_1': 20_000_000,
  base: 20_000_000,
}

const MODEL_FILES: Record<string, string> = {
  'tiny-q5_1': AURUM_DEFAULT_MODEL_FILE,
  tiny: 'ggml-tiny.bin',
  'base-q5_1': 'ggml-base-q5_1.bin',
  base: 'ggml-base.bin',
}

export function aurumModelFilename(model: string): string {
  return MODEL_FILES[model] || `ggml-${model}.bin`
}

export function isAurumDownloadAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OPEN_COWORK_AURUM_ALLOW_DOWNLOAD === '1'
}

export function listSystemAurumCacheDirs(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env.HOME || env.USERPROFILE || ''
  const dirs: string[] = []
  if (platform === 'darwin' && home) {
    dirs.push(join(home, 'Library', 'Caches', 'aurum'))
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (local) dirs.push(join(local, 'aurum', 'cache'))
  } else if (home) {
    dirs.push(join(home, '.cache', 'aurum'))
  }
  return dirs
}

/** Candidate absolute paths for a model file (OC cache + system Aurum caches). */
export function resolveAurumModelCandidates(
  model: string,
  cacheDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const filename = aurumModelFilename(model)
  const paths = [
    join(cacheDir, 'models', filename),
    join(cacheDir, filename),
  ]
  for (const dir of listSystemAurumCacheDirs(process.platform, env)) {
    paths.push(join(dir, 'models', filename), join(dir, filename))
  }
  return paths
}

export function findAurumModelPath(
  model: string,
  cacheDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const path of resolveAurumModelCandidates(model, cacheDir, env)) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Verify size floor + optional sibling `.sha256` file (sha256sum format).
 * Never logs file contents — only path + integrity label.
 */
export function verifyAurumModelFile(modelPath: string, model: string): VoiceAssetIntegrity {
  if (!existsSync(modelPath)) return 'missing'
  let size: number
  try {
    size = statSync(modelPath).size
  } catch {
    return 'missing'
  }
  const min = AURUM_MIN_MODEL_BYTES[model] ?? 1_000_000
  if (size < min) return 'too_small'

  const shaPath = `${modelPath}.sha256`
  if (!existsSync(shaPath)) return 'unverified'

  try {
    const expectedLine = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0] || ''
    if (!/^[a-f0-9]{64}$/i.test(expectedLine)) return 'unverified'
    const hash = createHash('sha256')
    hash.update(readFileSync(modelPath))
    const actual = hash.digest('hex')
    return actual.toLowerCase() === expectedLine.toLowerCase() ? 'ok' : 'mismatch'
  } catch {
    return 'unverified'
  }
}

export function probeVoiceAssets(options: {
  model?: string
  cacheDir?: string
  allowDownload?: boolean
  env?: NodeJS.ProcessEnv
} = {}): VoiceAssetStatus {
  const env = options.env || process.env
  const model = options.model || env.OPEN_COWORK_AURUM_MODEL?.trim() || AURUM_DEFAULT_MODEL
  const cacheDir = options.cacheDir || resolveDefaultAurumCacheDir()
  const allowDownload = options.allowDownload ?? isAurumDownloadAllowed(env)
  const cliAvailable = Boolean(resolveAurumBinPath())
  const modelPath = findAurumModelPath(model, cacheDir, env)
  const integrity = modelPath ? verifyAurumModelFile(modelPath, model) : 'missing'
  // Size-ok without sha sidecar is still usable offline (unverified).
  // Mismatch / too_small / missing are not ready.
  const sttReady = Boolean(modelPath)
    && (integrity === 'ok' || integrity === 'unverified')

  let detail: string | null = null
  if (!cliAvailable && !sttReady) {
    detail = 'Aurum CLI not found and STT model is not cached. Install Aurum and cache the model offline, or set OPEN_COWORK_AURUM_BIN.'
  } else if (!sttReady) {
    detail = integrity === 'mismatch'
      ? `STT model checksum mismatch for ${model}. Re-download offline or replace the file under ${cacheDir}.`
      : integrity === 'too_small'
        ? `STT model file for ${model} looks incomplete under ${cacheDir}.`
        : `STT model ${model} is not cached. Offline path requires a local file (default local_only).`
  } else if (integrity === 'unverified') {
    detail = `STT model ${model} present without checksum sidecar — usable offline, integrity unverified.`
  }

  const tts = createDefaultVoiceTts()
  const ttsReady = tts.isReady()
  const ttsStatus: VoiceTtsAssetStatus = {
    ready: ttsReady,
    backend: tts.backend === 'fake' ? 'fake' : tts.backend === 'system_os' ? 'system_os' : 'unavailable',
    detail: ttsReady ? null : tts.detail,
  }

  return {
    stt: {
      model,
      modelFile: aurumModelFilename(model),
      ready: sttReady,
      cacheDir,
      modelPath,
      integrity: modelPath ? integrity : 'missing',
      allowDownload,
      cliAvailable,
      detail,
    },
    tts: ttsStatus,
    offlineReady: sttReady && ttsReady,
  }
}

/**
 * Ensure the preferred OC cache has a usable model file.
 * - Already ready → no-op
 * - Present in system Aurum cache → copy into OC cache (no network)
 * - Missing + !allowDownload → fail closed
 * - Missing + allowDownload → report needs_download (operator/CLI pull; no silent network)
 */
export function ensureVoiceSttAsset(options: {
  model?: string
  cacheDir?: string
  allowDownload?: boolean
  env?: NodeJS.ProcessEnv
} = {}): VoiceAssetEnsureResult {
  const status = probeVoiceAssets(options)
  if (status.stt.ready) {
    return {
      status,
      action: status.stt.integrity === 'ok' ? 'verified' : 'already_ready',
      detail: status.stt.detail || `STT model ${status.stt.model} is ready offline.`,
    }
  }

  const env = options.env || process.env
  const model = status.stt.model
  const cacheDir = status.stt.cacheDir
  const filename = status.stt.modelFile
  const systemPath = listSystemAurumCacheDirs(process.platform, env)
    .flatMap((dir) => [join(dir, 'models', filename), join(dir, filename)])
    .find((path) => existsSync(path))

  // Prefer OC models/ subdir.
  const targetDir = join(cacheDir, 'models')
  const targetPath = join(targetDir, filename)

  if (systemPath && systemPath !== targetPath) {
    try {
      mkdirSync(targetDir, { recursive: true })
      copyFileSync(systemPath, targetPath)
      const shaSrc = `${systemPath}.sha256`
      if (existsSync(shaSrc)) {
        copyFileSync(shaSrc, `${targetPath}.sha256`)
      }
      const next = probeVoiceAssets({ ...options, model, cacheDir })
      if (next.stt.ready) {
        return {
          status: next,
          action: 'copied_from_system',
          detail: `Copied ${filename} from system Aurum cache into ${targetDir} (files only — no network).`,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: probeVoiceAssets(options),
        action: 'failed',
        detail: `Failed to copy STT model into Open Cowork cache: ${message}`,
      }
    }
  }

  if (!status.stt.allowDownload) {
    return {
      status,
      action: 'failed',
      detail:
        `Offline fail-closed: model ${model} is not present under ${cacheDir}. `
        + 'Pre-cache the model offline, or set OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1 to permit an explicit file download later. '
        + 'Audio and transcripts never leave the machine on the default path.',
    }
  }

  return {
    status,
    action: 'needs_download',
    detail:
      `Model ${model} is missing. Download is allowed (OPEN_COWORK_AURUM_ALLOW_DOWNLOAD=1) but not automatic in this build — `
      + `place ${filename} under ${join(cacheDir, 'models')} (or run Aurum’s local model fetch into that cache), then retry. `
      + 'Download moves model weights only; never user audio.',
  }
}

/** Redacted status for IPC/logs — paths ok, never file bytes. */
export function voiceAssetStatusForLog(status: VoiceAssetStatus): Record<string, unknown> {
  return {
    sttModel: status.stt.model,
    sttReady: status.stt.ready,
    integrity: status.stt.integrity,
    allowDownload: status.stt.allowDownload,
    cliAvailable: status.stt.cliAvailable,
    offlineReady: status.offlineReady,
    ttsReady: status.tts.ready,
    ttsBackend: status.tts.backend,
    // Cache dir is local path metadata (not a secret); keep for operator UI.
    cacheDir: status.stt.cacheDir,
    hasModelPath: Boolean(status.stt.modelPath),
  }
}

/** Helper used by tests / host: is the default STT model available offline? */
export function isDefaultSttOfflineReady(cacheDir = resolveDefaultAurumCacheDir()): boolean {
  return isAurumModelAvailable(AURUM_DEFAULT_MODEL, cacheDir)
    || isAurumModelCached(cacheDir, AURUM_DEFAULT_MODEL)
}
