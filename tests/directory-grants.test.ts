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

test('grant trust lookup uses inverted indexes without full session/workflow lists (JOE-896)', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-grant-index-'))
  const sessionProject = join(userDataDir, 'session-project')
  const workflowProject = join(userDataDir, 'workflow-project')
  const otherProject = join(userDataDir, 'other-project')

  try {
    mkdirSync(sessionProject)
    mkdirSync(workflowProject)
    mkdirSync(otherProject)
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir

    const { clearConfigCaches } = await import('@open-cowork/runtime-host/config')
    const {
      clearSessionRegistryCache,
      lookupSessionDirectoryTrust,
      toSessionRecord,
      upsertSessionRecord,
    } = await import('@open-cowork/runtime-host/session-registry')
    const {
      clearWorkflowStoreCache,
      createWorkflow,
      lookupWorkflowDirectoryTrust,
    } = await import('@open-cowork/runtime-host/workflow/workflow-store')

    clearConfigCaches()
    clearSessionRegistryCache()
    clearWorkflowStoreCache()

    const sessionReal = realpathSync.native(sessionProject)
    const workflowReal = realpathSync.native(workflowProject)
    const otherReal = realpathSync.native(otherProject)

    upsertSessionRecord(toSessionRecord({
      id: `session-grant-${Date.now()}`,
      title: 'Grant trust session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: sessionReal,
    }))
    createWorkflow({
      title: 'Grant trust workflow',
      instructions: 'Run a small trusted workflow.',
      agentName: 'build',
      skillNames: [],
      toolIds: [],
      projectDirectory: workflowReal,
      draftSessionId: null,
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    })

    assert.equal(lookupSessionDirectoryTrust(sessionReal), 'session-record')
    assert.equal(lookupSessionDirectoryTrust(otherReal), null)
    assert.equal(lookupWorkflowDirectoryTrust(workflowReal), 'workflow-record')
    assert.equal(lookupWorkflowDirectoryTrust(otherReal), null)

    // Mirrors apps/desktop/src/main/ipc-handlers projectDirectoryGrants trust callback.
    const trustLookup = (directory: string) => (
      lookupSessionDirectoryTrust(directory) || lookupWorkflowDirectoryTrust(directory)
    )
    const grants = new ProjectDirectoryGrantRegistry(trustLookup)
    assert.equal(grants.resolve(sessionProject), sessionReal)
    assert.equal(grants.resolve(workflowProject), workflowReal)
    assert.throws(() => grants.resolve(otherProject), /native directory picker/)
  } finally {
    const { clearConfigCaches } = await import('@open-cowork/runtime-host/config')
    const { clearSessionRegistryCache } = await import('@open-cowork/runtime-host/session-registry')
    const { clearWorkflowStoreCache } = await import('@open-cowork/runtime-host/workflow/workflow-store')
    clearSessionRegistryCache()
    clearWorkflowStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
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
