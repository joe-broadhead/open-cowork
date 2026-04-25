import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDesktopAfterPack,
  getPackageName,
  getPackageVersion,
  getTargetArchName,
  listInstalledOpencodePackages,
  packageTargetsArch,
} from '../scripts/desktop-after-pack.mjs'

function makeNativePackage(virtualStoreDir: string, packageName: string, version = '1.2.3') {
  const packageDir = join(virtualStoreDir, `${packageName}@${version}`, 'node_modules', packageName)
  mkdirSync(join(packageDir, 'bin'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }))
  writeFileSync(join(packageDir, 'bin', 'opencode'), 'binary')
  return packageDir
}

test('desktop-after-pack helpers parse pnpm store package names and target arches', () => {
  assert.equal(getPackageName('opencode-linux-x64@1.2.3'), 'opencode-linux-x64')
  assert.equal(getPackageName('opencode-linux-x64@1.2.3_react@19.0.0'), 'opencode-linux-x64')
  assert.equal(getPackageVersion('opencode-linux-x64@1.2.3'), '1.2.3')
  assert.equal(getPackageVersion('opencode-linux-x64@1.2.3_react@19.0.0'), '1.2.3')
  assert.equal(getTargetArchName(1), 'x64')
  assert.equal(getTargetArchName(3), 'arm64')
  assert.equal(getTargetArchName('arm64'), 'arm64')
  assert.equal(getTargetArchName(999), null)

  assert.equal(packageTargetsArch('opencode-linux-x64', 'x64'), true)
  assert.equal(packageTargetsArch('opencode-linux-arm64', 'x64'), false)
  assert.equal(packageTargetsArch('opencode-darwin-arm64', 'universal'), true)
})

test('listInstalledOpencodePackages finds only matching native packages with binaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-after-pack-'))
  try {
    const store = join(root, '.pnpm')
    mkdirSync(store, { recursive: true })
    makeNativePackage(store, 'opencode-linux-x64', '0.9.0')
    const linuxX64 = makeNativePackage(store, 'opencode-linux-x64')
    makeNativePackage(store, 'opencode-linux-arm64')
    mkdirSync(join(store, 'opencode-linux-riscv64@1.2.3', 'node_modules', 'opencode-linux-riscv64'), {
      recursive: true,
    })

    const packages = listInstalledOpencodePackages('linux', 'x64', {
      expectedVersion: '1.2.3',
      virtualStoreDir: store,
    })
    assert.deepEqual(packages, [{ name: 'opencode-linux-x64', version: '1.2.3', sourceDir: linuxX64 }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('desktop-after-pack copies native OpenCode packages into app.asar.unpacked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-after-pack-'))
  try {
    const store = join(root, '.pnpm')
    const appOutDir = join(root, 'out')
    mkdirSync(store, { recursive: true })
    mkdirSync(appOutDir, { recursive: true })
    makeNativePackage(store, 'opencode-linux-x64')

    makeNativePackage(store, 'opencode-linux-x64', '0.9.0')

    const afterPack = createDesktopAfterPack({ expectedVersion: '1.2.3', virtualStoreDir: store })
    await afterPack({ appOutDir, arch: 'x64', electronPlatformName: 'linux' })

    const copiedPackage = join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'opencode-linux-x64')
    assert.equal(existsSync(join(copiedPackage, 'bin', 'opencode')), true)
    assert.equal(readFileSync(join(copiedPackage, 'bin', 'opencode'), 'utf8'), 'binary')
    assert.equal(JSON.parse(readFileSync(join(copiedPackage, 'package.json'), 'utf8')).version, '1.2.3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('desktop-after-pack reports a clear error when pnpm virtual store is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-after-pack-'))
  try {
    assert.throws(
      () => listInstalledOpencodePackages('linux', 'x64', { virtualStoreDir: join(root, 'missing-store') }),
      /pnpm virtual store not found/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
