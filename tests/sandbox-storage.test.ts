import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupSandboxStorage, cleanupSandboxWorkspaceForSession, getSandboxStorageStats } from '../apps/desktop/src/main/sandbox-storage.ts'
import { flushSessionRegistryWrites, removeSessionRecord, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'

function uniqueSandboxRoot(name: string) {
  return join(tmpdir(), `open-cowork-sandbox-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function writeWorkspaceFile(directory: string, filename: string, content: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, filename), content)
}

test('sandbox storage stats count referenced and unreferenced workspaces', () => {
  const previousSandboxDir = process.env.OPEN_COWORK_SANDBOX_DIR
  const sandboxRoot = uniqueSandboxRoot('stats')
  process.env.OPEN_COWORK_SANDBOX_DIR = sandboxRoot

  const referencedDir = join(sandboxRoot, 'thread-ref')
  const unreferencedDir = join(sandboxRoot, 'thread-unused')
  const sessionId = `sandbox-stats-${Date.now()}`

  try {
    writeWorkspaceFile(referencedDir, 'report.txt', 'hello sandbox')
    writeWorkspaceFile(unreferencedDir, 'draft.txt', 'unused workspace')

    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Sandbox stats',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: referencedDir,
    }))
    flushSessionRegistryWrites()

    const stats = getSandboxStorageStats()
    assert.equal(stats.workspaceCount, 2)
    assert.equal(stats.referencedWorkspaceCount, 1)
    assert.equal(stats.unreferencedWorkspaceCount, 1)
    assert.ok(stats.totalBytes > 0)
  } finally {
    removeSessionRecord(sessionId)
    flushSessionRegistryWrites()
    rmSync(sandboxRoot, { recursive: true, force: true })
    if (previousSandboxDir === undefined) delete process.env.OPEN_COWORK_SANDBOX_DIR
    else process.env.OPEN_COWORK_SANDBOX_DIR = previousSandboxDir
  }
})

test('cleanupSandboxStorage removes only stale unreferenced workspaces', () => {
  const previousSandboxDir = process.env.OPEN_COWORK_SANDBOX_DIR
  const sandboxRoot = uniqueSandboxRoot('cleanup')
  process.env.OPEN_COWORK_SANDBOX_DIR = sandboxRoot

  const staleDir = join(sandboxRoot, 'thread-stale')
  const freshDir = join(sandboxRoot, 'thread-fresh')

  try {
    writeWorkspaceFile(staleDir, 'old.txt', 'old data')
    writeWorkspaceFile(freshDir, 'fresh.txt', 'fresh data')

    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    utimesSync(staleDir, oldDate, oldDate)
    utimesSync(join(staleDir, 'old.txt'), oldDate, oldDate)

    const result = cleanupSandboxStorage('old-unreferenced')
    assert.equal(result.mode, 'old-unreferenced')
    assert.equal(result.removedWorkspaces, 1)
    assert.ok(result.removedBytes > 0)

    const stats = getSandboxStorageStats()
    assert.equal(stats.workspaceCount, 1)
    assert.equal(stats.unreferencedWorkspaceCount, 1)
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true })
    if (previousSandboxDir === undefined) delete process.env.OPEN_COWORK_SANDBOX_DIR
    else process.env.OPEN_COWORK_SANDBOX_DIR = previousSandboxDir
  }
})

test('cleanupSandboxWorkspaceForSession preserves sandboxes still referenced by another session', () => {
  const previousSandboxDir = process.env.OPEN_COWORK_SANDBOX_DIR
  const sandboxRoot = uniqueSandboxRoot('shared')
  process.env.OPEN_COWORK_SANDBOX_DIR = sandboxRoot

  const sharedDir = join(sandboxRoot, 'thread-shared')
  const sessionOne = `sandbox-shared-1-${Date.now()}`
  const sessionTwo = `sandbox-shared-2-${Date.now()}`

  try {
    writeWorkspaceFile(sharedDir, 'shared.txt', 'shared data')

    const recordOne = upsertSessionRecord(toSessionRecord({
      id: sessionOne,
      title: 'Shared one',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: sharedDir,
    }))
    upsertSessionRecord(toSessionRecord({
      id: sessionTwo,
      title: 'Shared two',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: sharedDir,
    }))
    flushSessionRegistryWrites()

    const removed = cleanupSandboxWorkspaceForSession(recordOne)
    assert.equal(removed, false)
  } finally {
    removeSessionRecord(sessionOne)
    removeSessionRecord(sessionTwo)
    flushSessionRegistryWrites()
    rmSync(sandboxRoot, { recursive: true, force: true })
    if (previousSandboxDir === undefined) delete process.env.OPEN_COWORK_SANDBOX_DIR
    else process.env.OPEN_COWORK_SANDBOX_DIR = previousSandboxDir
  }
})
