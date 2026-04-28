import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveContainedArtifactPath } from '../apps/desktop/src/main/artifact-path-policy.ts'
import { copyArtifactForExport } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'

test('artifact export writes private file permissions', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-artifact-export-'))
  try {
    const source = join(root, 'source.txt')
    const destination = join(root, 'exported.txt')
    writeFileSync(source, 'artifact')
    chmodSync(source, 0o644)

    copyArtifactForExport(source, destination)

    assert.equal(readFileSync(destination, 'utf8'), 'artifact')
    assert.equal(statSync(destination).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifact path policy rejects symlink escapes from private workspaces', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-artifact-root-'))
  try {
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const secret = join(outside, 'secret.txt')
    const link = join(workspace, 'linked-secret.txt')
    writeFileSync(secret, 'secret')
    symlinkSync(secret, link)

    assert.throws(
      () => resolveContainedArtifactPath(workspace, link),
      /outside the current private workspace/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifact path policy resolves ordinary files by real path', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-artifact-contained-'))
  try {
    const file = join(root, 'report.txt')
    writeFileSync(file, 'artifact')

    const resolved = resolveContainedArtifactPath(root, file)

    assert.equal(resolved.root, realpathSync.native(root))
    assert.equal(resolved.source, realpathSync.native(file))
    assert.equal(readFileSync(resolved.source, 'utf8'), 'artifact')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
