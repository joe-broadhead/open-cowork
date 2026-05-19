import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { listRecentProjects } from '../apps/desktop/src/main/project-registry.ts'
import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'

test('listRecentProjects derives Cmd/Ctrl number targets from latest project sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-project-registry-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
    clearConfigCaches()
    clearSessionRegistryCache()

    upsertSessionRecord(toSessionRecord({
      id: 'session-old',
      title: 'Old project',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      opencodeDirectory: join(root, 'project-a'),
    }))
    upsertSessionRecord(toSessionRecord({
      id: 'session-new',
      title: 'New project',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      opencodeDirectory: join(root, 'project-a'),
    }))
    upsertSessionRecord(toSessionRecord({
      id: 'session-b',
      title: 'Project B',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      opencodeDirectory: join(root, 'project-b'),
    }))

    assert.deepEqual(listRecentProjects(9), [
      {
        index: 1,
        directory: join(root, 'project-a'),
        latestSessionId: 'session-new',
        latestTitle: 'New project',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        index: 2,
        directory: join(root, 'project-b'),
        latestSessionId: 'session-b',
        latestTitle: 'Project B',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ])
  } finally {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(root, { recursive: true, force: true })
  }
})
