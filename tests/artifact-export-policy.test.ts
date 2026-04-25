import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
