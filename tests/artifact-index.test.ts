import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { clearCoordinationStoreCache, createCoordinationProject, createCoordinationTask, setCoordinationDatabaseForTests } from '@open-cowork/runtime-host/coordination/coordination-store'
import { artifactLifecycleStorageKey, clearArtifactLifecycleStoreCache, getArtifactLifecycleTransactionCountForTests, indexLocalSessionArtifactsFromView, isLocalArtifactFilePath, listLocalArtifactIndex, localArtifactFilename, normalizeArtifactLifecycleEntry, rebuildLocalArtifactIndexForSession, setArtifactLifecycleDatabaseForTests, setArtifactIndexRuntimeDepsForTests, type ArtifactLifecycleRecord } from '@open-cowork/runtime-host/artifact-index'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionArtifact, SessionView } from '@open-cowork/shared'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
function sessionViewWithArtifacts(artifacts: SessionArtifact[]): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts,
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

test('local artifact index entries merge defaults, lifecycle metadata, and task provenance', () => {
  const artifact: SessionArtifact = {
    id: 'session:tool-1:/tmp/report.md',
    toolId: 'tool-1',
    toolName: 'write',
    filePath: '/tmp/report.md',
    filename: 'report.md',
    order: 7,
  }

  const fromProvenance = normalizeArtifactLifecycleEntry({
    workspaceId: 'local',
    sessionId: 'session-1',
    sessionTitle: 'Project plan',
    artifact,
    provenance: {
      projectId: 'project-1',
      taskId: 'task-1',
      authorAgentId: 'agent-writer',
    },
    now: new Date('2026-05-27T10:00:00.000Z'),
  })
  assert.equal(fromProvenance.kind, 'document')
  assert.equal(fromProvenance.status, 'draft')
  assert.equal(fromProvenance.projectId, 'project-1')
  assert.equal(fromProvenance.taskId, 'task-1')
  assert.equal(fromProvenance.authorAgentId, 'agent-writer')
  assert.equal(fromProvenance.sessionId, 'session-1')
  assert.equal(fromProvenance.updatedAt, '2026-05-27T10:00:00.000Z')

  const lifecycle: ArtifactLifecycleRecord = {
    workspaceId: 'local',
    sessionId: 'session-1',
    artifactId: artifact.id,
    kind: 'document',
    status: 'in-review',
    authorAgentId: 'agent-reviewer',
    projectId: 'project-2',
    taskId: 'task-2',
    statusUpdatedBy: 'reviewer-1',
    statusUpdatedAt: '2026-05-27T10:03:00.000Z',
    createdAt: '2026-05-27T10:01:00.000Z',
    updatedAt: '2026-05-27T10:03:00.000Z',
  }
  const fromLifecycle = normalizeArtifactLifecycleEntry({
    workspaceId: 'local',
    sessionId: 'session-1',
    artifact,
    lifecycle,
    provenance: {
      projectId: 'project-1',
      taskId: 'task-1',
      authorAgentId: 'agent-writer',
    },
  })
  assert.equal(fromLifecycle.status, 'in-review')
  assert.equal(fromLifecycle.projectId, 'project-2')
  assert.equal(fromLifecycle.taskId, 'task-2')
  assert.equal(fromLifecycle.authorAgentId, 'agent-reviewer')
  assert.equal(fromLifecycle.statusUpdatedBy, 'reviewer-1')
  assert.equal(fromLifecycle.updatedAt, '2026-05-27T10:03:00.000Z')
})

test('local artifact lifecycle key follows file path across repeated edits', () => {
  const firstEdit: SessionArtifact = {
    id: 'session:tool-1:/tmp/report.md',
    toolId: 'tool-1',
    toolName: 'write',
    filePath: '/tmp/report.md',
    filename: 'report.md',
    order: 1,
  }
  const secondEdit: SessionArtifact = {
    ...firstEdit,
    id: 'session:tool-2:/tmp/report.md',
    toolId: 'tool-2',
    order: 2,
  }
  const cloudArtifact: SessionArtifact = {
    ...firstEdit,
    id: 'artifact-cloud-1',
    source: 'cloud',
    cloudArtifactId: 'artifact-cloud-1',
    filePath: 'cloud-artifact://artifact-cloud-1/report.md',
  }

  assert.equal(artifactLifecycleStorageKey(firstEdit), '/tmp/report.md')
  assert.equal(artifactLifecycleStorageKey(secondEdit), '/tmp/report.md')
  assert.equal(artifactLifecycleStorageKey(cloudArtifact), 'artifact-cloud-1')
})

test('local artifact paths support POSIX, Windows drive, and UNC absolute paths', () => {
  const windowsDrivePath = 'C:\\Users\\joe\\Documents\\report.md'
  const windowsUncPath = '\\\\server\\share\\charts\\summary.csv'
  assert.equal(isLocalArtifactFilePath('/tmp/report.md'), true)
  assert.equal(isLocalArtifactFilePath(windowsDrivePath), true)
  assert.equal(isLocalArtifactFilePath(windowsUncPath), true)
  assert.equal(isLocalArtifactFilePath('relative/report.md'), false)
  assert.equal(localArtifactFilename(windowsDrivePath), 'report.md')
  assert.equal(localArtifactFilename(windowsUncPath), 'summary.csv')
  assert.equal(artifactLifecycleStorageKey({
    id: 'session:tool-1:windows',
    toolId: 'tool-1',
    toolName: 'write',
    filePath: windowsDrivePath,
    filename: 'report.md',
    order: 1,
  }), windowsDrivePath)
})

test('local artifact index reads persisted rows and rebuilds a single session explicitly', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-artifacts-cold-'))
  const sessionId = `artifact-cold-${Date.now()}`
  const artifact: SessionArtifact = {
    id: 'session:tool-1:/tmp/cold-report.md',
    toolId: 'tool-1',
    toolName: 'write',
    filePath: '/tmp/cold-report.md',
    filename: 'cold-report.md',
    order: 1,
  }
  const calls = {
    getSessionView: 0,
    syncSessionView: 0,
    activate: null as boolean | null | undefined,
  }

  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearSessionRegistryCache()
    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Cold artifact session',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:01:00.000Z',
      opencodeDirectory: userDataDir,
    }))

    setArtifactIndexRuntimeDepsForTests({
      isHydrated: (id) => {
        assert.equal(id, sessionId)
        return false
      },
      getSessionView: () => {
        calls.getSessionView += 1
        return sessionViewWithArtifacts([])
      },
      syncSessionView: async (id, options) => {
        calls.syncSessionView += 1
        calls.activate = options?.activate
        assert.equal(id, sessionId)
        return sessionViewWithArtifacts([artifact])
      },
    })

    const emptyIndex = await listLocalArtifactIndex({ sessionId, limit: 10 })
    assert.equal(emptyIndex.artifacts.length, 0)
    assert.equal(calls.getSessionView, 0)
    assert.equal(calls.syncSessionView, 0)

    const rebuilt = await rebuildLocalArtifactIndexForSession(sessionId)
    assert.equal(rebuilt.length, 1)
    const index = await listLocalArtifactIndex({ sessionId, limit: 10 })
    assert.equal(index.artifacts.length, 1)
    assert.equal(index.artifacts[0]?.filePath, '/tmp/cold-report.md')
    assert.equal(index.artifacts[0]?.sessionTitle, 'Cold artifact session')
    assert.equal(calls.syncSessionView, 1)
    assert.equal(calls.activate, false)
  } finally {
    setArtifactIndexRuntimeDepsForTests(null)
    clearArtifactLifecycleStoreCache()
    clearCoordinationStoreCache()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('local artifact provenance prefers exact task-run matches over session-level tasks', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-artifacts-provenance-'))
  const coordinationDb = new DatabaseSync(':memory:')
  const sessionId = `artifact-provenance-${Date.now()}`
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearSessionRegistryCache()
    setCoordinationDatabaseForTests(coordinationDb)
    upsertSessionRecord(toSessionRecord({
      id: sessionId,
      title: 'Task run artifact session',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:01:00.000Z',
      opencodeDirectory: userDataDir,
    }))

    createCoordinationProject({
      title: 'Broad project',
      objective: 'Own broad session work.',
      team: [],
    }, { id: 'project-broad', now: new Date('2026-05-27T10:00:00.000Z') })
    createCoordinationProject({
      title: 'Exact project',
      objective: 'Own exact task-run work.',
      team: [],
    }, { id: 'project-exact', now: new Date('2026-05-27T10:00:00.000Z') })
    createCoordinationTask({
      projectId: 'project-broad',
      title: 'Broad session task',
      spec: 'This task is assigned to the same session but not the artifact task run.',
      assigneeAgent: 'broad-agent',
      assignedSessionId: sessionId,
    }, { id: 'task-broad', now: new Date('2026-05-27T10:03:00.000Z') })
    createCoordinationTask({
      projectId: 'project-exact',
      title: 'Exact task-run task',
      spec: 'This task owns the artifact task run.',
      assigneeAgent: 'exact-agent',
      assignedSessionId: sessionId,
      assignedRunId: 'run-exact',
    }, { id: 'task-exact', now: new Date('2026-05-27T10:02:00.000Z') })

    setArtifactIndexRuntimeDepsForTests({
      isHydrated: () => true,
      getSessionView: () => ({
        ...sessionViewWithArtifacts([]),
        taskRuns: [{
          id: 'run-exact',
          title: 'Exact task run',
          agent: 'exact-agent',
          status: 'complete',
          sourceSessionId: 'child-session-1',
          content: '',
          transcript: [],
          toolCalls: [{
            id: 'tool-1',
            name: 'write',
            input: { filePath: '/tmp/task-run-report.md' },
            status: 'complete',
            order: 1,
          }],
          compactions: [],
          todos: [],
          error: null,
          sessionCost: 0,
          sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          order: 1,
        }],
      }),
      syncSessionView: async () => sessionViewWithArtifacts([]),
    })

    await rebuildLocalArtifactIndexForSession(sessionId)
    const index = await listLocalArtifactIndex({ sessionId, limit: 10 })
    assert.equal(index.artifacts.length, 1)
    assert.equal(index.artifacts[0]?.taskRunId, 'run-exact')
    assert.equal(index.artifacts[0]?.projectId, 'project-exact')
    assert.equal(index.artifacts[0]?.taskId, 'task-exact')
    assert.equal(index.artifacts[0]?.authorAgentId, 'exact-agent')

    const broadProjectIndex = await listLocalArtifactIndex({ sessionId, projectId: 'project-broad', limit: 10 })
    assert.equal(broadProjectIndex.artifacts.length, 0)
  } finally {
    setArtifactIndexRuntimeDepsForTests(null)
    clearArtifactLifecycleStoreCache()
    setCoordinationDatabaseForTests(null)
    coordinationDb.close()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('local artifact indexing batches lifecycle, provenance, and index writes', async () => {
  const db = new DatabaseSync(':memory:')
  const sessionId = 'artifact-batch-session'
  const artifactCount = 40
  try {
    setArtifactLifecycleDatabaseForTests(db)
    const artifacts: SessionArtifact[] = Array.from({ length: artifactCount }, (_, index) => ({
      id: `artifact-${index}`,
      toolId: `tool-${index}`,
      toolName: 'write',
      filePath: `/tmp/batch-${index}.md`,
      filename: `batch-${index}.md`,
      order: index,
      taskRunId: `run-${index}`,
    }))
    const insertLifecycle = db.prepare(`
      insert into artifact_lifecycle (
        workspace_id, session_id, artifact_id, kind, status, author_agent_id,
        project_id, task_id, status_updated_by, status_updated_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const artifact of artifacts) {
      insertLifecycle.run(
        'local',
        sessionId,
        artifactLifecycleStorageKey(artifact),
        'document',
        'in-review',
        null,
        null,
        null,
        'reviewer',
        '2026-05-27T10:10:00.000Z',
        '2026-05-27T10:00:00.000Z',
        '2026-05-27T10:10:00.000Z',
      )
    }

    let runIdReads = 0
    let sessionIdReads = 0
    const tasks = Array.from({ length: artifactCount }, (_, index) => {
      const task: Record<string, unknown> = {
        id: `task-${index}`,
        projectId: `project-${index}`,
        assigneeAgent: `agent-${index}`,
      }
      Object.defineProperty(task, 'assignedRunId', {
        enumerable: true,
        get() {
          runIdReads += 1
          return `run-${index}`
        },
      })
      Object.defineProperty(task, 'assignedSessionId', {
        enumerable: true,
        get() {
          sessionIdReads += 1
          return sessionId
        },
      })
      return task
    })

    const beforeTransactions = getArtifactLifecycleTransactionCountForTests()
    const entries = indexLocalSessionArtifactsFromView({
      sessionId,
      sessionTitle: 'Batch artifact session',
      view: sessionViewWithArtifacts(artifacts),
      tasks: tasks as NonNullable<Parameters<typeof indexLocalSessionArtifactsFromView>[0]['tasks']>,
    })
    const afterTransactions = getArtifactLifecycleTransactionCountForTests()

    assert.equal(afterTransactions - beforeTransactions, 1)
    assert.equal(runIdReads, artifactCount)
    assert.equal(sessionIdReads, artifactCount)
    assert.equal(entries.length, artifactCount)
    const sampledEntry = entries.find((entry) => entry.id === 'artifact-17')
    assert.equal(sampledEntry?.status, 'in-review')
    assert.equal(sampledEntry?.taskId, 'task-17')
    assert.equal(sampledEntry?.projectId, 'project-17')
    const indexed = await listLocalArtifactIndex({ sessionId, limit: artifactCount })
    assert.equal(indexed.artifacts.length, artifactCount)
  } finally {
    setArtifactLifecycleDatabaseForTests(null)
    db.close()
  }
})

test('local artifact index lists persisted artifacts without hydrating sessions', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    setArtifactLifecycleDatabaseForTests(db)
    setArtifactIndexRuntimeDepsForTests({
      isHydrated: () => {
        throw new Error('artifact index read must not inspect session hydration')
      },
      getSessionView: () => {
        throw new Error('artifact index read must not materialize session views')
      },
      syncSessionView: async () => {
        throw new Error('artifact index read must not sync session history')
      },
    })

    for (let index = 0; index < 1200; index += 1) {
      indexLocalSessionArtifactsFromView({
        sessionId: `session-${index}`,
        sessionTitle: `Session ${index}`,
        tasks: [],
        view: sessionViewWithArtifacts([{
          id: `session-${index}:tool-${index}:/tmp/report-${index}.md`,
          toolId: `tool-${index}`,
          toolName: 'write',
          filePath: `/tmp/report-${index}.md`,
          filename: `report-${index}.md`,
          order: index,
          createdAt: `2026-05-27T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
          updatedAt: `2026-05-27T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }]),
      })
    }

    const index = await listLocalArtifactIndex({ limit: 25 })
    assert.equal(index.artifacts.length, 25)
    assert.equal(index.total, 26)
    assert.equal(index.truncated, true)
  } finally {
    setArtifactIndexRuntimeDepsForTests(null)
    setArtifactLifecycleDatabaseForTests(null)
    db.close()
  }
})

test('artifact lifecycle metadata persists in the restart-safe store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-artifacts-'))
  const dbPath = join(dir, 'artifact-lifecycle.sqlite')
  try {
    const db = new DatabaseSync(dbPath)
    setArtifactLifecycleDatabaseForTests(db)
    db.prepare(`
      insert into artifact_lifecycle (
        workspace_id,
        session_id,
        artifact_id,
        kind,
        status,
        author_agent_id,
        project_id,
        task_id,
        status_updated_by,
        status_updated_at,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'local',
      'session-1',
      'artifact-1',
      'document',
      'in-review',
      'agent-writer',
      'project-1',
      'task-1',
      'reviewer-1',
      '2026-05-27T10:03:00.000Z',
      '2026-05-27T10:01:00.000Z',
      '2026-05-27T10:03:00.000Z',
    )
    db.close()
    setArtifactLifecycleDatabaseForTests(null)

    const reopened = new DatabaseSync(dbPath)
    try {
      const row = reopened.prepare(`
        select status, author_agent_id, project_id, task_id, status_updated_by
        from artifact_lifecycle
        where workspace_id = ? and session_id = ? and artifact_id = ?
      `).get('local', 'session-1', 'artifact-1') as Record<string, unknown>
      assert.equal(row.status, 'in-review')
      assert.equal(row.author_agent_id, 'agent-writer')
      assert.equal(row.project_id, 'project-1')
      assert.equal(row.task_id, 'task-1')
      assert.equal(row.status_updated_by, 'reviewer-1')
    } finally {
      reopened.close()
    }
  } finally {
    setArtifactLifecycleDatabaseForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
