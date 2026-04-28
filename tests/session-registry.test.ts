import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import {
  clearSessionRegistryCache,
  listSessionRecords,
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

test('legacy session registry migration keeps only Cowork-created sessions from logs', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('legacy-migration')
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const managedId = `ses_${suffix}`
  const externalId = `ses_external${suffix}`

  try {
    resetRegistryTestState(userDataDir)
    mkdirSync(join(userDataDir, 'logs'), { recursive: true })
    writeFileSync(
      join(userDataDir, 'logs', 'open-cowork-2026-04-28.log'),
      `[2026-04-28T12:00:00.000Z] [session] Created session ${managedId}\n`,
    )
    writeFileSync(
      join(userDataDir, 'sessions.json'),
      JSON.stringify([
        {
          id: managedId,
          title: 'Managed legacy thread',
          opencodeDirectory: userDataDir,
          createdAt: '2026-04-28T12:00:00.000Z',
          updatedAt: '2026-04-28T12:00:01.000Z',
        },
        {
          id: externalId,
          title: 'External OpenCode thread',
          opencodeDirectory: '/tmp/external-opencode-project',
          createdAt: '2026-04-28T12:00:00.000Z',
          updatedAt: '2026-04-28T12:00:02.000Z',
        },
      ], null, 2),
    )

    const records = listSessionRecords()
    assert.deepEqual(records.map((record) => record.id), [managedId])
    assert.equal(records[0]?.managedByCowork, true)

    const persisted = JSON.parse(readFileSync(join(userDataDir, 'sessions.json'), 'utf8')) as Array<{ id: string; managedByCowork?: boolean }>
    assert.deepEqual(persisted.map((record) => record.id), [managedId])
    assert.equal(persisted[0]?.managedByCowork, true)
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 25))
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
