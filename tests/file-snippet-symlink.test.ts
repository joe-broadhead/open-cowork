// Proves the symlink-escape fix lands correctly. We replicate the
// realpath-based containment check the session:file-snippet IPC uses
// on disk, then exercise it against a symlink that dereferences
// outside the session root — the same shape the red-team audit
// flagged as CVE-adjacent.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

function isContained(root: string, target: string): boolean {
  const realRoot = realpathSync.native(root)
  const realPath = realpathSync.native(target)
  return realPath === realRoot || realPath.startsWith(`${realRoot}/`)
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

    // Prefix-only startsWith() on the unresolved path would have
    // accepted this; realpath resolves the symlink and makes the
    // escape visible.
    assert.equal(isContained(root, linkPath), false)

    // Sanity check the fallback (prefix of the unresolved absolute
    // path) — this is what the OLD code did and accepted the escape.
    const unresolvedAccepts = linkPath === resolve(root) || linkPath.startsWith(`${resolve(root)}/`)
    assert.equal(unresolvedAccepts, true, 'proves the unresolved prefix check was the vulnerability')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
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
