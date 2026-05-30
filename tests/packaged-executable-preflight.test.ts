import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../scripts/require-packaged-executable.mjs', import.meta.url))

function runPreflight(path: string | null) {
  const env = { ...process.env }
  if (path === null) delete env.OPEN_COWORK_PACKAGED_EXECUTABLE
  else env.OPEN_COWORK_PACKAGED_EXECUTABLE = path
  return spawnSync(process.execPath, [scriptPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
  })
}

function withTempDir(callback: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-packaged-preflight-'))
  try {
    callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('packaged executable preflight fails closed without an explicit executable', () => {
  const result = runPreflight(null)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /OPEN_COWORK_PACKAGED_EXECUTABLE must point at a packaged desktop executable/)
  assert.match(result.stderr, /pnpm --dir apps\/desktop dist:ci:mac/)
  assert.match(result.stderr, /node scripts\/find-macos-packaged-executable\.mjs/)
})

test('packaged executable preflight accepts executable files', () => {
  withTempDir((dir) => {
    const executable = join(dir, 'open-cowork')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const result = runPreflight(executable)
    assert.equal(result.status, 0, result.stderr)
  })
})

test('packaged executable preflight rejects non-executable files', () => {
  withTempDir((dir) => {
    const executable = join(dir, 'open-cowork')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o644)
    const result = runPreflight(executable)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /is not executable/)
  })
})

test('packaged executable preflight accepts macOS app bundles', () => {
  withTempDir((dir) => {
    const appBundle = join(dir, 'Open Cowork.app')
    const macOsDir = join(appBundle, 'Contents', 'MacOS')
    mkdirSync(macOsDir, { recursive: true })
    const executable = join(macOsDir, 'Open Cowork')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const result = runPreflight(appBundle)
    assert.equal(result.status, 0, result.stderr)
  })
})

test('packaged executable preflight rejects app bundles without a resolvable executable', () => {
  withTempDir((dir) => {
    const appBundle = join(dir, 'Open Cowork.app')
    mkdirSync(join(appBundle, 'Contents', 'MacOS'), { recursive: true })
    const result = runPreflight(appBundle)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /without one resolvable executable/)
  })
})
