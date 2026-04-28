import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { syncRuntimeHomeToolingBridge } from '../apps/desktop/src/main/runtime-home-bridge.ts'

function readLinkedTarget(path: string) {
  return readlinkSync(path)
}

test('runtime home tooling bridge mirrors curated tool config but not agent compatibility dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-runtime-home-bridge-'))
  const realHome = join(root, 'real-home')
  const runtimeHome = join(root, 'runtime-home')
  mkdirSync(realHome, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })

  writeFileSync(join(realHome, '.gitconfig'), '[user]\n  name = Test User\n')
  mkdirSync(join(realHome, '.ssh'), { recursive: true })
  writeFileSync(join(realHome, '.ssh', 'config'), 'Host *\n  AddKeysToAgent yes\n')
  mkdirSync(join(realHome, '.agents', 'skills', 'rogue-skill'), { recursive: true })
  writeFileSync(join(realHome, '.agents', 'skills', 'rogue-skill', 'SKILL.md'), '# Rogue\n')

  try {
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome })

    assert.equal(readLinkedTarget(join(runtimeHome, '.gitconfig')), join(realHome, '.gitconfig'))
    assert.equal(readLinkedTarget(join(runtimeHome, '.ssh')), join(realHome, '.ssh'))
    assert.equal(existsSync(join(runtimeHome, '.agents')), false)
  } catch (error) {
    // fall through to explicit assertions below
    assert.fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime home tooling bridge removes stale bridged entries when the source disappears', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-runtime-home-cleanup-'))
  const realHome = join(root, 'real-home')
  const runtimeHome = join(root, 'runtime-home')
  mkdirSync(realHome, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })

  const source = join(realHome, '.gitconfig')
  const target = join(runtimeHome, '.gitconfig')
  writeFileSync(source, '[user]\n  email = test@example.com\n')
  mkdirSync(runtimeHome, { recursive: true })
  symlinkSync(source, target)
  rmSync(source, { force: true })

  try {
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome, entries: ['.gitconfig'] })
    assert.equal(existsSync(target), false)
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime home tooling bridge removes configured links when disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-runtime-home-disabled-'))
  const realHome = join(root, 'real-home')
  const runtimeHome = join(root, 'runtime-home')
  mkdirSync(realHome, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })

  const source = join(realHome, '.gitconfig')
  const target = join(runtimeHome, '.gitconfig')
  writeFileSync(source, '[user]\n  email = test@example.com\n')
  symlinkSync(source, target)

  try {
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome, entries: ['.gitconfig'], enabled: false })
    assert.equal(existsSync(target), false)
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
