import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileAtomic } from '../apps/desktop/src/main/fs-atomic.ts'

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-atomic-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('writeFileAtomic writes and can be read back', () => withTempDir((dir) => {
  const target = join(dir, 'settings.enc')
  writeFileAtomic(target, 'payload', { mode: 0o600 })
  assert.equal(readFileSync(target, 'utf-8'), 'payload')
}))

test('writeFileAtomic sets 0o600 perms by default', () => withTempDir((dir) => {
  const target = join(dir, 'creds.json')
  writeFileAtomic(target, 'secret')
  // Mask against ownership bits so the test is stable across platforms
  // that surface group/other bits differently. 0o777 is plenty to
  // verify the owner-only-readable promise.
  const mode = statSync(target).mode & 0o777
  assert.equal(mode, 0o600)
}))

test('writeFileAtomic replaces an existing file in place', () => withTempDir((dir) => {
  const target = join(dir, 'settings.enc')
  writeFileSync(target, 'old-content', { mode: 0o600 })
  writeFileAtomic(target, 'new-content')
  assert.equal(readFileSync(target, 'utf-8'), 'new-content')
}))

test('writeFileAtomic does not leave temp files behind after a successful write', () => withTempDir((dir) => {
  const target = join(dir, 'settings.enc')
  writeFileAtomic(target, 'ok')
  const residue = readdirSync(dir).filter((entry) => entry.startsWith('settings.enc.tmp-'))
  assert.deepEqual(residue, [])
}))

test('writeFileAtomic leaves the original file intact if the write fails midway', () => withTempDir((dir) => {
  const target = join(dir, 'settings.enc')
  writeFileSync(target, 'stable-old', { mode: 0o600 })

  // Invalid mode forces open() to throw. The helper should reject
  // before touching the real target, so the stable "old" file survives.
  assert.throws(() => {
    // @ts-expect-error intentionally passing an invalid mode to trigger failure
    writeFileAtomic(target, 'new-bytes', { mode: 'not-a-number' })
  })

  assert.equal(readFileSync(target, 'utf-8'), 'stable-old')
  // Confirm any half-created temp was cleaned up.
  const residue = readdirSync(dir).filter((entry) => entry.startsWith('settings.enc.tmp-'))
  assert.deepEqual(residue, [])
}))
