import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearSessionRegistryCache,
  removeSessionRecord,
  toSessionRecord,
  upsertSessionRecord,
} from '../apps/desktop/src/main/session-registry.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-session-registry-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetRegistryTestState(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearSessionRegistryCache()
}

test('upsertSessionRecord persists brand-new sessions immediately', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('insert')
  const sessionId = `session-insert-${Date.now()}`

  try {
    resetRegistryTestState(userDataDir)

    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Immediate write',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
    }))

    const registryPath = join(userDataDir, 'sessions.json')
    assert.equal(existsSync(registryPath), true, 'expected a new session insert to write sessions.json immediately')
    const records = JSON.parse(readFileSync(registryPath, 'utf8')) as Array<{ id: string }>
    assert.ok(records.some((record) => record.id === sessionId), 'expected the inserted session id to be on disk immediately')
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('removeSessionRecord persists deletions immediately', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('delete')
  const sessionId = `session-delete-${Date.now()}`

  try {
    resetRegistryTestState(userDataDir)

    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Delete write',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
    }))

    removeSessionRecord(sessionId)

    const registryPath = join(userDataDir, 'sessions.json')
    const records = JSON.parse(readFileSync(registryPath, 'utf8')) as Array<{ id: string }>
    assert.equal(records.some((record) => record.id === sessionId), false, 'expected the deleted session id to be removed from disk immediately')
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
