import { clearSessionRegistryCache, flushSessionRegistryWrites, getSessionRecord, listSessionRecords, removeSessionRecord, SESSION_REGISTRY_SCHEMA_VERSION, toSessionRecord, updateSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { closeLogger } from '@open-cowork/shared/node'
function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-session-registry-${name}-`))
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
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { schemaVersion: number; sessions: Array<{ id: string }> }
    assert.equal(registry.schemaVersion, SESSION_REGISTRY_SCHEMA_VERSION)
    assert.ok(registry.sessions.some((record) => record.id === sessionId), 'expected the inserted session id to be on disk immediately')
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
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { sessions: Array<{ id: string }> }
    assert.equal(registry.sessions.some((record) => record.id === sessionId), false, 'expected the deleted session id to be removed from disk immediately')
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('session composer preferences persist separately from last-used model', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('composer-prefs')
  const sessionId = `session-composer-${Date.now()}`

  try {
    resetRegistryTestState(userDataDir)

    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Composer prefs',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
      providerId: 'openrouter',
      modelId: 'openrouter/model-last-used',
      composerAgentName: 'writer-lead',
      composerModelId: 'openrouter/model-composer',
      composerReasoningVariant: 'xhigh',
    }))
    updateSessionRecord(sessionId, {
      modelId: 'openrouter/model-last-used-after-prompt',
    })
    flushSessionRegistryWrites()
    clearSessionRegistryCache()

    const record = listSessionRecords().find((entry) => entry.id === sessionId)
    assert.equal(record?.modelId, 'openrouter/model-last-used-after-prompt')
    assert.equal(record?.composerAgentName, 'writer-lead')
    assert.equal(record?.composerModelId, 'openrouter/model-composer')
    assert.equal(record?.composerReasoningVariant, 'xhigh')
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('session registry returns defensive copies from public boundaries', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('defensive-copy')
  const sessionId = `session-copy-${Date.now()}`

  try {
    resetRegistryTestState(userDataDir)

    const inserted = upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Cached state',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
      summary: {
        messages: 1,
        userMessages: 1,
        assistantMessages: 0,
        toolCalls: 0,
        taskRuns: 1,
        cost: 0.25,
        tokens: {
          input: 10,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        agentBreakdown: [{
          agent: 'research',
          taskRuns: 1,
          cost: 0.25,
          tokens: {
            input: 10,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }],
      },
    }))
    assert.ok(inserted)

    inserted.title = 'Mutated insert result'
    inserted.summary!.tokens.input = 999
    inserted.summary!.agentBreakdown![0]!.tokens.input = 999

    const listed = listSessionRecords().find((record) => record.id === sessionId)
    assert.ok(listed)
    listed.title = 'Mutated list result'
    listed.summary!.tokens.input = 500

    const updated = updateSessionRecord(sessionId, {
      changeSummary: {
        additions: 2,
        deletions: 1,
        files: 1,
      },
    })
    assert.ok(updated)
    updated.changeSummary!.additions = 999

    const fresh = getSessionRecord(sessionId)
    assert.equal(fresh?.title, 'Cached state')
    assert.equal(fresh?.summary?.tokens.input, 10)
    assert.equal(fresh?.summary?.agentBreakdown?.[0]?.tokens.input, 10)
    assert.equal(fresh?.changeSummary?.additions, 2)
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('scheduled session registry writes persist the latest coalesced state', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('coalesced-writes')
  const sessionId = `session-coalesced-${Date.now()}`

  try {
    resetRegistryTestState(userDataDir)

    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Initial',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: userDataDir,
    }))
    updateSessionRecord(sessionId, { title: 'Intermediate', updatedAt: '2026-05-18T10:00:00.000Z' })
    updateSessionRecord(sessionId, { title: 'Latest', updatedAt: '2026-05-18T10:00:01.000Z' })
    flushSessionRegistryWrites()

    const registry = JSON.parse(readFileSync(join(userDataDir, 'sessions.json'), 'utf8')) as { sessions: Array<{ id: string; title?: string }> }
    assert.equal(registry.sessions.find((record) => record.id === sessionId)?.title, 'Latest')
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('session registry loads exact current Cowork-managed records', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('managed-only')
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const managedId = `ses_${suffix}`

  try {
    resetRegistryTestState(userDataDir)
    const managed = toSessionRecord({
      id: managedId,
      title: 'Managed current thread',
      opencodeDirectory: userDataDir,
      createdAt: '2026-04-28T12:00:00.000Z',
      updatedAt: '2026-04-28T12:00:01.000Z',
    })
    writeFileSync(
      join(userDataDir, 'sessions.json'),
      JSON.stringify({
        schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
        sessions: [managed],
      }, null, 2),
    )

    const records = listSessionRecords()
    assert.deepEqual(records.map((record) => record.id), [managedId])
    assert.equal(records[0]?.managedByCowork, true)
  } finally {
    await closeLogger()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('session registry quarantines the removed unversioned array format', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('unversioned')
  const registryPath = join(userDataDir, 'sessions.json')

  try {
    resetRegistryTestState(userDataDir)
    writeFileSync(registryPath, JSON.stringify([]))

    assert.deepEqual(listSessionRecords(), [])
    assert.equal(existsSync(registryPath), false)
    assert.equal(existsSync(`${registryPath}.corrupt`), true)
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('session registry quarantines current envelopes with missing kind or association fields', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const root = uniqueUserDataDir('missing-current-fields')

  try {
    for (const field of ['kind', 'workflowId'] as const) {
      const userDataDir = join(root, field)
      const registryPath = join(userDataDir, 'sessions.json')
      mkdirSync(userDataDir, { recursive: true })
      resetRegistryTestState(userDataDir)
      const session = toSessionRecord({
        id: `ses_missing_${field}`,
        opencodeDirectory: userDataDir,
        createdAt: '2026-04-28T12:00:00.000Z',
        updatedAt: '2026-04-28T12:00:01.000Z',
      }) as Record<string, unknown>
      delete session[field]
      writeFileSync(registryPath, JSON.stringify({
        schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
        sessions: [session],
      }))

      assert.deepEqual(listSessionRecords(), [])
      assert.equal(existsSync(registryPath), false)
      assert.equal(existsSync(`${registryPath}.corrupt`), true)
    }
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(root, { recursive: true, force: true })
  }
})
