import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isPathInsideRoot } from '../apps/desktop/src/main/ipc/session-file-handlers.ts'

function isContained(root: string, target: string): boolean {
  const realRoot = realpathSync.native(root)
  const realPath = realpathSync.native(target)
  return isPathInsideRoot(realRoot, realPath)
}

test('realpath containment accepts regular files inside the session root', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-root-'))
  try {
    const target = join(root, 'project.json')
    writeFileSync(target, '{}')
    assert.equal(isContained(root, target), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('realpath containment rejects a symlink that dereferences outside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-root-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'))
  const secret = join(outsideDir, 'secret.txt')
  writeFileSync(secret, 'top-secret')
  try {
    const linkPath = join(root, 'sneaky-link')
    symlinkSync(secret, linkPath)

    assert.equal(isContained(root, linkPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('containment uses Windows path semantics without hard-coded separators', () => {
  assert.equal(isPathInsideRoot('C:\\repo', 'C:\\repo\\src\\index.ts', win32), true)
  assert.equal(isPathInsideRoot('C:\\repo', 'C:\\repo-other\\secret.txt', win32), false)
  assert.equal(isPathInsideRoot('C:\\repo', 'D:\\secret.txt', win32), false)
})

test('realpath containment rejects .. traversal that points outside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  const hosts = join(outside, 'hosts')
  writeFileSync(hosts, 'hosts file contents')
  try {
    // Simulate the IPC's `resolve(root, userSuppliedPath)` call for a
    // path like `../../../outside/hosts`. The resolved absolute path
    // must not be inside the session root after realpath.
    const normalizedEscape = resolve(join(root, 'nested'), '..', '..', hosts)
    assert.equal(isContained(root, normalizedEscape), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
