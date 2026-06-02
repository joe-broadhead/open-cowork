import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptPath = resolve('scripts/find-linux-packaged-executable.mjs')

function makeExecutable(path: string) {
  writeFileSync(path, '')
  chmodSync(path, 0o755)
}

function runFinder(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
  })
}

function withLinuxUnpacked(callback: (root: string, unpackedDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-linux-finder-'))
  try {
    const unpackedDir = join(root, 'apps/desktop/release/linux-unpacked')
    mkdirSync(unpackedDir, { recursive: true })
    callback(root, unpackedDir)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

test('linux packaged executable finder ignores Electron helper binaries', () => {
  withLinuxUnpacked((root, unpackedDir) => {
    makeExecutable(join(unpackedDir, 'chrome-sandbox'))
    makeExecutable(join(unpackedDir, 'chrome_crashpad_handler'))
    makeExecutable(join(unpackedDir, 'libffmpeg.so'))
    makeExecutable(join(unpackedDir, 'libnode.so.1'))
    makeExecutable(join(unpackedDir, 'open-cowork'))

    const result = runFinder(root)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, realpathSync(join(unpackedDir, 'open-cowork')))
  })
})

test('linux packaged executable finder fails closed without app executable', () => {
  withLinuxUnpacked((root, unpackedDir) => {
    makeExecutable(join(unpackedDir, 'chrome-sandbox'))
    makeExecutable(join(unpackedDir, 'libffmpeg.so'))

    const result = runFinder(root)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /No packaged Linux executable found/)
  })
})
