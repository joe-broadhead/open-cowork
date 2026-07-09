import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listWindowsSigningTargets } from '../scripts/windows-signing-targets.mjs'

function withFixture(name: string, callback: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `open-cowork-windows-signing-${name}-`))
  try {
    mkdirSync(join(root, 'apps/desktop/release/win-unpacked'), { recursive: true })
    mkdirSync(join(root, 'apps/desktop'), { recursive: true })
    writeFileSync(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(join(root, 'apps/desktop/release/Open-Cowork-1.2.3-x64-setup.exe'), 'installer')
    writeFileSync(join(root, 'apps/desktop/release/win-unpacked/Open Cowork.exe'), 'exe')
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Windows signing targets include the expected installer and packaged product executable', () => {
  withFixture('valid', (root) => {
    writeFileSync(join(root, 'apps/desktop/release/win-unpacked/chrome_crashpad_handler.exe'), 'helper')
    const targets = listWindowsSigningTargets({ root })
    assert.deepEqual(targets.map((target) => [target.kind, target.name]), [
      ['installer', 'Open-Cowork-1.2.3-x64-setup.exe'],
      ['packaged-executable', 'Open Cowork.exe'],
    ])
  })
})

test('Windows signing targets fail on missing or extra installers', () => {
  withFixture('installers', (root) => {
    rmSync(join(root, 'apps/desktop/release/Open-Cowork-1.2.3-x64-setup.exe'))
    assert.throws(
      () => listWindowsSigningTargets({ root }),
      /Missing Windows signing installers: Open-Cowork-1\.2\.3-x64-setup\.exe/,
    )
    writeFileSync(join(root, 'apps/desktop/release/Open-Cowork-1.2.3-x64-setup.exe'), 'installer')
    writeFileSync(join(root, 'apps/desktop/release/Open-Cowork-1.2.3-arm64-setup.exe'), 'extra')
    assert.throws(
      () => listWindowsSigningTargets({ root }),
      /Unexpected Windows signing installers: Open-Cowork-1\.2\.3-arm64-setup\.exe/,
    )
  })
})

test('Windows signing targets fail on missing or extra packaged product executables', () => {
  withFixture('executables', (root) => {
    rmSync(join(root, 'apps/desktop/release/win-unpacked/Open Cowork.exe'))
    assert.throws(
      () => listWindowsSigningTargets({ root }),
      /Missing Windows packaged executable signing target: Open Cowork\.exe/,
    )
    writeFileSync(join(root, 'apps/desktop/release/win-unpacked/Open Cowork.exe'), 'exe')
    writeFileSync(join(root, 'apps/desktop/release/win-unpacked/Other Product.exe'), 'extra')
    assert.throws(
      () => listWindowsSigningTargets({ root }),
      /Unexpected Windows packaged executable signing targets: Other Product\.exe/,
    )
  })
})

test('Windows signing targets fail on unexpected unpacked architecture directories', () => {
  withFixture('unpacked', (root) => {
    mkdirSync(join(root, 'apps/desktop/release/win-arm64-unpacked'))
    assert.throws(
      () => listWindowsSigningTargets({ root }),
      /Unexpected Windows unpacked release directories: win-arm64-unpacked/,
    )
  })
})
