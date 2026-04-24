import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isExplorerPathInsideDirectory } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'

test('explorer path policy accepts files inside the selected directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-explorer-'))
  try {
    writeFileSync(join(root, 'inside.txt'), 'ok')
    assert.equal(isExplorerPathInsideDirectory('inside.txt', root), true)
    assert.equal(isExplorerPathInsideDirectory('.', root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('explorer path policy rejects traversal and symlink escapes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-explorer-parent-'))
  const root = join(parent, 'project')
  const outside = join(parent, 'outside.txt')
  try {
    mkdirSync(root)
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(root, 'linked-secret.txt'))

    assert.equal(isExplorerPathInsideDirectory('../outside.txt', root), false)
    assert.equal(isExplorerPathInsideDirectory('linked-secret.txt', root), false)
    assert.equal(isExplorerPathInsideDirectory(realpathSync.native(outside), root), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
