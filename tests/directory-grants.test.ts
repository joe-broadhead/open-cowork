import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProjectDirectoryGrantRegistry, trustedRecordDirectoryMatches } from '../apps/desktop/src/main/directory-grants.ts'

test('project directory grants reject arbitrary renderer-supplied roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-grant-'))
  try {
    const grants = new ProjectDirectoryGrantRegistry()

    assert.throws(
      () => grants.resolve(root),
      /must be selected with the native directory picker/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project directory grants authorize native-picker selections by real path', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-grant-parent-'))
  const root = join(parent, 'project')
  const linkedRoot = join(parent, 'project-link')
  try {
    mkdirSync(root)
    symlinkSync(root, linkedRoot)
    const grants = new ProjectDirectoryGrantRegistry()

    const granted = grants.grant(linkedRoot)

    assert.equal(granted, realpathSync.native(root))
    assert.equal(grants.resolve(root), realpathSync.native(root))
    assert.equal(grants.resolve(linkedRoot), realpathSync.native(root))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('project directory grants allow main-owned session record directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-session-grant-'))
  try {
    const trusted = realpathSync.native(root)
    const grants = new ProjectDirectoryGrantRegistry((directory) => (
      directory === trusted ? 'session-record' : null
    ))

    assert.equal(grants.resolve(root), trusted)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('trusted record directory matching does not rebind through a later symlink replacement', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-record-rebind-'))
  const original = join(parent, 'project')
  const replacement = join(parent, 'replacement')
  try {
    mkdirSync(original)
    mkdirSync(replacement)
    const stored = resolve(original)

    rmSync(original, { recursive: true, force: true })
    symlinkSync(replacement, original)

    const candidate = realpathSync.native(original)
    assert.notEqual(candidate, stored)
    assert.equal(trustedRecordDirectoryMatches(candidate, stored), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
