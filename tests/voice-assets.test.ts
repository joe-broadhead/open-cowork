import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureVoiceSttAsset,
  findAurumModelPath,
  isAurumDownloadAllowed,
  probeVoiceAssets,
  verifyAurumModelFile,
  voiceAssetStatusForLog,
} from '../apps/desktop/src/main/voice-assets.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { FakeVoiceStt } from '../apps/desktop/src/main/voice-stt.ts'
import { FakeVoiceTts } from '../apps/desktop/src/main/voice-tts.ts'

function writeModelFixture(dir: string, _model = 'tiny-q5_1', opts: { withSha?: boolean; size?: number } = {}) {
  const modelsDir = join(dir, 'models')
  mkdirSync(modelsDir, { recursive: true })
  const filename = 'ggml-tiny-q5_1.bin'
  const path = join(modelsDir, filename)
  const size = opts.size ?? 12_000_000
  writeFileSync(path, Buffer.alloc(size, 1))
  if (opts.withSha) {
    const hash = createHash('sha256').update(Buffer.alloc(size, 1)).digest('hex')
    writeFileSync(`${path}.sha256`, `${hash}  ${filename}\n`)
  }
  return path
}

test('isAurumDownloadAllowed is opt-in only', () => {
  assert.equal(isAurumDownloadAllowed({}), false)
  assert.equal(isAurumDownloadAllowed({ OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '0' }), false)
  assert.equal(isAurumDownloadAllowed({ OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '1' }), true)
})

test('verifyAurumModelFile rejects missing, small, mismatch, accepts ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-voice-assets-'))
  try {
    assert.equal(verifyAurumModelFile(join(dir, 'nope.bin'), 'tiny-q5_1'), 'missing')

    const small = writeModelFixture(dir, 'tiny-q5_1', { size: 100 })
    assert.equal(verifyAurumModelFile(small, 'tiny-q5_1'), 'too_small')

    const unverified = writeModelFixture(join(dir, 'u'), 'tiny-q5_1', { size: 12_000_000 })
    assert.equal(verifyAurumModelFile(unverified, 'tiny-q5_1'), 'unverified')

    const okDir = join(dir, 'ok')
    const ok = writeModelFixture(okDir, 'tiny-q5_1', { size: 12_000_000, withSha: true })
    assert.equal(verifyAurumModelFile(ok, 'tiny-q5_1'), 'ok')

    writeFileSync(`${ok}.sha256`, `${'0'.repeat(64)}  ggml-tiny-q5_1.bin\n`)
    assert.equal(verifyAurumModelFile(ok, 'tiny-q5_1'), 'mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeVoiceAssets fails closed when model missing and download off', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'oc-voice-empty-'))
  try {
    const emptyHome = join(cacheDir, 'empty-home')
    mkdirSync(emptyHome, { recursive: true })
    const status = probeVoiceAssets({
      cacheDir,
      allowDownload: false,
      env: {
        ...process.env,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '0',
      },
    })
    assert.equal(status.stt.ready, false)
    assert.equal(status.stt.integrity, 'missing')
    assert.equal(status.stt.allowDownload, false)
    assert.equal(status.offlineReady, false)
    assert.match(status.stt.detail || '', /not cached|offline|local/i)

    const logSafe = voiceAssetStatusForLog(status)
    assert.equal(logSafe.sttReady, false)
    assert.equal('modelPath' in logSafe, false)
    assert.equal(logSafe.hasModelPath, false)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('ensureVoiceSttAsset copies from system cache without network', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-voice-copy-'))
  const systemDir = join(root, 'system-aurum')
  const ocCache = join(root, 'oc-cache')
  try {
    writeModelFixture(systemDir, 'tiny-q5_1', { size: 12_000_000, withSha: true })

    // Point listSystemAurumCacheDirs via HOME override for darwin-like layout.
    const prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    mkdirSync(join(process.env.HOME, 'Library', 'Caches', 'aurum', 'models'), { recursive: true })
    // Place model in the path listSystemAurumCacheDirs will search on darwin.
    if (process.platform === 'darwin') {
      const sysModels = join(process.env.HOME, 'Library', 'Caches', 'aurum', 'models')
      const src = writeModelFixture(join(process.env.HOME, 'Library', 'Caches', 'aurum'), 'tiny-q5_1', {
        size: 12_000_000,
        withSha: true,
      })
      void src
      void sysModels
    } else {
      // Non-darwin: seed systemDir is not used unless we put it on HOME/.cache
      writeModelFixture(join(process.env.HOME, '.cache', 'aurum'), 'tiny-q5_1', {
        size: 12_000_000,
        withSha: true,
      })
    }

    const result = ensureVoiceSttAsset({
      cacheDir: ocCache,
      allowDownload: false,
      env: { ...process.env, OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '0' },
    })
    assert.ok(
      result.action === 'copied_from_system' || result.action === 'already_ready' || result.action === 'verified',
      result.detail,
    )
    assert.equal(result.status.stt.ready, true)
    assert.ok(findAurumModelPath('tiny-q5_1', ocCache) || result.status.stt.modelPath)

    process.env.HOME = prevHome
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureVoiceSttAsset offline fails closed without model and without download', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'oc-voice-fail-'))
  const prevHome = process.env.HOME
  try {
    // Isolate from developer machine system Aurum cache.
    process.env.HOME = join(cacheDir, 'empty-home')
    mkdirSync(process.env.HOME, { recursive: true })
    const result = ensureVoiceSttAsset({
      cacheDir: join(cacheDir, 'oc'),
      allowDownload: false,
      env: { ...process.env, OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '0', HOME: process.env.HOME },
    })
    assert.equal(result.action, 'failed')
    assert.equal(result.status.stt.ready, false)
    assert.match(result.detail, /fail-closed|not present|offline/i)
  } finally {
    process.env.HOME = prevHome
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('ensureVoiceSttAsset reports needs_download when allowDownload and missing', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'oc-voice-dl-'))
  const prevHome = process.env.HOME
  try {
    process.env.HOME = join(cacheDir, 'empty-home')
    mkdirSync(process.env.HOME, { recursive: true })
    const result = ensureVoiceSttAsset({
      cacheDir: join(cacheDir, 'oc'),
      allowDownload: true,
      env: { ...process.env, OPEN_COWORK_AURUM_ALLOW_DOWNLOAD: '1', HOME: process.env.HOME },
    })
    assert.equal(result.action, 'needs_download')
    assert.match(result.detail, /Download is allowed|model weights only/i)
  } finally {
    process.env.HOME = prevHome
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('voice host status includes assets snapshot without samples', () => {
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    tts: new FakeVoiceTts(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  const status = host.getStatus()
  assert.ok(status.assets)
  assert.equal(typeof status.assets!.stt.ready, 'boolean')
  assert.equal(typeof status.assets!.offlineReady, 'boolean')
  const json = JSON.stringify(status)
  assert.doesNotMatch(json, /Float32Array|"samples"\s*:/)
})
