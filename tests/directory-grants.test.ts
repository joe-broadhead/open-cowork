import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('project directory grants reject files and missing paths (JOE-834)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-grant-race-'))
  const filePath = join(parent, 'not-a-directory')
  const missingPath = join(parent, 'deleted-project')
  try {
    writeFileSync(filePath, 'not a directory')
    const grants = new ProjectDirectoryGrantRegistry()

    assert.throws(() => grants.grant(filePath), /must be a directory/)
    assert.throws(() => grants.grant(missingPath), /must exist before it can be granted/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('project directory grants re-realpath on every use so symlink swaps fail closed (JOE-834)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-grant-repath-'))
  const original = join(parent, 'project')
  const replacement = join(parent, 'replacement')
  const linkPath = join(parent, 'project-link')
  try {
    mkdirSync(original)
    mkdirSync(replacement)
    symlinkSync(original, linkPath)
    const grants = new ProjectDirectoryGrantRegistry()
    const granted = grants.grant(linkPath)
    assert.equal(granted, realpathSync.native(original))

    // Replace the granted path with a symlink to a different tree after grant.
    rmSync(linkPath, { force: true })
    symlinkSync(replacement, linkPath)
    assert.throws(() => grants.resolve(linkPath), /native directory picker|must be selected/)
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
