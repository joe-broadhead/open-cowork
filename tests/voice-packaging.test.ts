import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VOICE_PACKAGING_MATRIX,
  assertNoBrokenPackagedVoicePaths,
  listAurumBinCandidates,
  listFfmpegBinCandidates,
  packagingRowForPlatform,
  resolveFirstExistingBinary,
  resolvePackagedAwareAurumBin,
  resolvePackagedAwareFfmpegBin,
  voicePackagedResourcesDir,
} from '../apps/desktop/src/main/voice-packaging.ts'

test('packaging matrix covers darwin/win32/linux with honest residuals', () => {
  assert.equal(VOICE_PACKAGING_MATRIX.length, 3)
  for (const row of VOICE_PACKAGING_MATRIX) {
    assert.ok(row.capture.length > 0)
    assert.ok(row.stt.length > 0)
    assert.ok(row.tts.length > 0)
    assert.ok(['supported', 'best_effort', 'residual'].includes(row.support))
  }
  const mac = packagingRowForPlatform('darwin')
  assert.equal(mac?.support, 'supported')
  assert.match(mac?.residual || '', /not pre-bundled|drop into/i)
})

test('voicePackagedResourcesDir nests under resourcesPath/voice', () => {
  assert.equal(voicePackagedResourcesDir(null), null)
  assert.equal(voicePackagedResourcesDir('/App/Contents/Resources'), join('/App/Contents/Resources', 'voice'))
})

test('resolveFirstExistingBinary never returns missing absolute packaged paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-voice-pkg-'))
  try {
    const missing = join(root, 'voice', 'aurum')
    const result = resolveFirstExistingBinary([missing, 'aurum'])
    assert.equal(result, 'aurum')
    const none = resolveFirstExistingBinary([missing, join(root, 'nope')])
    assert.equal(none, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packaged-aware resolve prefers existing drop-in over bare name', () => {
  const resources = mkdtempSync(join(tmpdir(), 'oc-voice-res-'))
  try {
    const voiceDir = join(resources, 'voice')
    mkdirSync(voiceDir, { recursive: true })
    const bin = join(voiceDir, 'aurum')
    writeFileSync(bin, '#!/bin/sh\necho ok\n')
    chmodSync(bin, 0o755)
    const resolved = resolvePackagedAwareAurumBin({
      resourcesPath: resources,
      platform: 'darwin',
      env: {},
    })
    assert.equal(resolved, bin)

    const ffmpegMissing = resolvePackagedAwareFfmpegBin({
      resourcesPath: resources,
      platform: 'darwin',
      env: {},
    })
    // Falls back to PATH name when packaged ffmpeg absent
    assert.equal(ffmpegMissing, 'ffmpeg')
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})

test('assertNoBrokenPackagedVoicePaths passes when drop-ins absent', () => {
  const resources = mkdtempSync(join(tmpdir(), 'oc-voice-empty-res-'))
  try {
    const check = assertNoBrokenPackagedVoicePaths(resources, 'darwin')
    assert.equal(check.ok, true)
    // Candidates may list non-existent paths; resolve must not select them
    const candidates = listAurumBinCandidates({ resourcesPath: resources, platform: 'darwin', env: {} })
    assert.ok(candidates.some((c) => c.includes(join(resources, 'voice'))))
    assert.equal(
      resolveFirstExistingBinary(candidates.filter((c) => c.startsWith(resources))),
      null,
    )
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})

test('listFfmpegBinCandidates honors env override first', () => {
  const list = listFfmpegBinCandidates({
    env: { OPEN_COWORK_FFMPEG_PATH: '/opt/custom/ffmpeg' },
    resourcesPath: '/nonexistent-resources',
    platform: 'linux',
  })
  assert.equal(list[0], '/opt/custom/ffmpeg')
})

test('electron-builder ships voice resources folder filter', () => {
  const yml = readFileSync(join(process.cwd(), 'apps/desktop/electron-builder.yml'), 'utf8')
  assert.match(yml, /resources\/voice/)
  assert.match(yml, /to:\s*voice/)
  const readme = readFileSync(join(process.cwd(), 'apps/desktop/resources/voice/README.md'), 'utf8')
  assert.match(readme, /JOE-1106/)
  assert.match(readme, /not pre-bundled|drop-in/i)
})
