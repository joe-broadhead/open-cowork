import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  regenerateWindowsUpdateMetadata,
  regenerateWindowsUpdateMetadataText,
  sha512Base64,
} from '../scripts/regenerate-windows-update-metadata.mjs'

test('regenerateWindowsUpdateMetadataText rewrites sha512/size and drops blockMapSize', () => {
  const yaml = [
    'version: 1.0.0',
    'files:',
    '  - url: Open-Cowork-1.0.0-x64-setup.exe',
    '    sha512: STALEHASH==',
    '    size: 111',
    '    blockMapSize: 222',
    'path: Open-Cowork-1.0.0-x64-setup.exe',
    'sha512: STALEHASH==',
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n')

  const rewritten = regenerateWindowsUpdateMetadataText(yaml, (name) => {
    assert.equal(name, 'Open-Cowork-1.0.0-x64-setup.exe')
    return { sha512: 'NEWHASH==', size: 999 }
  })

  assert.match(rewritten, /^ {4}sha512: NEWHASH==$/m)
  assert.match(rewritten, /^ {4}size: 999$/m)
  assert.match(rewritten, /^sha512: NEWHASH==$/m)
  assert.doesNotMatch(rewritten, /blockMapSize/)
  assert.match(rewritten, /version: 1\.0\.0/)
  assert.match(rewritten, /releaseDate:/)
})

test('regenerateWindowsUpdateMetadata recomputes against the signed installer and deletes stale blockmaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-win-metadata-'))
  try {
    const installer = 'Open-Cowork-1.0.0-x64-setup.exe'
    const signedBytes = Buffer.from('signed-installer-contents')
    writeFileSync(join(dir, installer), signedBytes)
    writeFileSync(join(dir, `${installer}.blockmap`), 'stale-blockmap')
    writeFileSync(join(dir, 'latest.yml'), [
      'version: 1.0.0',
      'files:',
      `  - url: ${installer}`,
      '    sha512: STALEHASH==',
      '    size: 1',
      '    blockMapSize: 2',
      `path: ${installer}`,
      'sha512: STALEHASH==',
      '',
    ].join('\n'))

    const result = regenerateWindowsUpdateMetadata({ dir })
    assert.equal(result.updated, true)
    assert.deepEqual(result.removedBlockmaps, [`${installer}.blockmap`])
    assert.equal(existsSync(join(dir, `${installer}.blockmap`)), false)

    const expectedHash = createHash('sha512').update(signedBytes).digest('base64')
    const rewritten = readFileSync(join(dir, 'latest.yml'), 'utf8')
    assert.equal(sha512Base64(join(dir, installer)), expectedHash)
    assert.match(rewritten, new RegExp(`sha512: ${expectedHash.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`))
    assert.match(rewritten, new RegExp(`size: ${signedBytes.length}`))
    assert.doesNotMatch(rewritten, /blockMapSize/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('regenerateWindowsUpdateMetadata is a no-op without latest.yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-win-metadata-'))
  try {
    const result = regenerateWindowsUpdateMetadata({ dir })
    assert.equal(result.updated, false)
    assert.deepEqual(result.removedBlockmaps, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
