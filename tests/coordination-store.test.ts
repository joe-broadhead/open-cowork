import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  coordinationCapabilityStatus,
  coordinationTaskColumnForStatus,
} from '../packages/shared/src/coordination.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  assignCoordinationTask,
  clearCoordinationStoreCache,
  createCoordinationProject,
  createCoordinationTask,
  listCoordinationBoard,
  moveCoordinationTask,
  setCoordinationDatabaseForTests,
  updateCoordinationTask,
} from '../apps/desktop/src/main/coordination/coordination-store.ts'
import {
  getCoordinationTaskWorkTarget,
  linkCoordinationTaskToSession,
} from '../apps/desktop/src/main/coordination/coordination-service.ts'
import {
  clearSessionRegistryCache,
  toSessionRecord,
  upsertSessionRecord,
} from '../apps/desktop/src/main/session-registry.ts'

function withTempAppData(name: string, run: (dir: string) => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), `open-cowork-coordination-${name}-`))
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = dir
    clearConfigCaches()
    clearCoordinationStoreCache()
    clearSessionRegistryCache()
    run(dir)
  } finally {
    clearCoordinationStoreCache()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(dir, { recursive: true, force: true })
  }
}

function withMemoryCoordinationStore(run: () => void) {
  const db = new DatabaseSync(':memory:')
  try {
    setCoordinationDatabaseForTests(db)
    run()
  } finally {
    setCoordinationDatabaseForTests(null)
    db.close()
  }
}

function createProjectAndTask() {
  const project = createCoordinationProject({
    title: 'Launch Studio board',
    objective: 'Plan and ship the Studio Kanban experience.',
    description: 'Project grouping for the design parity roadmap.',
    team: ['cleo', 'builder'],
    sourceSessionId: 'session-source',
  }, { id: 'project-1', now: new Date('2026-01-01T00:00:00.000Z') })
  const task = createCoordinationTask({
    projectId: project.id,
    title: 'Implement board backend',
    spec: 'Create persistence, service, IPC, and route contracts for the board.',
    column: 'planning',
    priority: 'high',
    assigneeAgent: 'builder',
    artifactRefs: [{ artifactId: 'artifact-1', title: 'Spec', sessionId: 'session-source' }],
  }, { id: 'task-1', now: new Date('2026-01-01T00:00:01.000Z') })
  return { project, task }
}

test('coordination shared status mapping keeps columns and lifecycle separate', () => {
  assert.equal(coordinationTaskColumnForStatus('open', 'planning'), 'planning')
  assert.equal(coordinationTaskColumnForStatus('open', 'doing'), 'backlog')
  assert.equal(coordinationTaskColumnForStatus('running', 'backlog'), 'doing')
  assert.equal(coordinationTaskColumnForStatus('completed', 'doing'), 'review')
  assert.equal(coordinationTaskColumnForStatus('failed', 'doing'), 'doing')
  assert.equal(coordinationTaskColumnForStatus('cancelled', 'review'), 'review')
})

test('coordination store persists projects and tasks across cache reset', () => withTempAppData('persist', (dir) => {
  const { project, task } = createProjectAndTask()
  assert.equal(project.objective, 'Plan and ship the Studio Kanban experience.')
  assert.deepEqual(project.team, ['cleo', 'builder'])
  assert.equal(task.spec, 'Create persistence, service, IPC, and route contracts for the board.')
  assert.equal(task.column, 'planning')
  assert.equal(task.priority, 'high')
  assert.equal(task.artifactRefs?.[0]?.artifactId, 'artifact-1')

  clearCoordinationStoreCache()

  const board = listCoordinationBoard()
  assert.equal(board.projects.length, 1)
  assert.equal(board.projects[0]?.id, 'project-1')
  assert.equal(board.tasks.length, 1)
  assert.equal(board.tasks[0]?.id, 'task-1')
  assert.equal(board.tasks[0]?.column, 'planning')

  const dbPath = join(dir, 'coordination.sqlite')
  assert.equal(existsSync(dbPath), true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  }
}))

test('coordination tasks move, reassign, and auto-advance only for lifecycle states that move', () => withMemoryCoordinationStore(() => {
  const { task } = createProjectAndTask()

  const moved = moveCoordinationTask(task.id, 'doing')
  assert.equal(moved?.column, 'doing')

  const assigned = assignCoordinationTask(task.id, 'reviewer')
  assert.equal(assigned?.assigneeAgent, 'reviewer')

  const running = updateCoordinationTask(task.id, { status: 'running' })
  assert.equal(running?.status, 'running')
  assert.equal(running?.column, 'doing')

  const completed = updateCoordinationTask(task.id, { status: 'completed' })
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.column, 'review')

  const done = moveCoordinationTask(task.id, 'done')
  assert.equal(done?.column, 'done')

  const failed = updateCoordinationTask(task.id, { status: 'failed' })
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.column, 'done')

  const cancelled = updateCoordinationTask(task.id, { status: 'cancelled' })
  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(cancelled?.column, 'done')
}))

test('coordination tasks cannot use parents from another project or workspace', () => withMemoryCoordinationStore(() => {
  const { task } = createProjectAndTask()
  const sibling = createCoordinationTask({
    projectId: 'project-1',
    parentTaskId: task.id,
    title: 'Add child task',
    spec: 'Prove same-project parent links are allowed.',
  }, { id: 'task-child' })
  assert.equal(sibling.parentTaskId, task.id)

  const otherProject = createCoordinationProject({
    title: 'Other project',
    objective: 'Keep parent links inside the project boundary.',
  }, { id: 'project-2' })
  assert.throws(
    () => createCoordinationTask({
      projectId: otherProject.id,
      parentTaskId: task.id,
      title: 'Cross project child',
      spec: 'This should not be allowed.',
    }),
    /same project/,
  )

  const otherWorkspaceProject = createCoordinationProject({
    workspaceId: 'other-workspace',
    title: 'Other workspace project',
    objective: 'Keep parent links inside the workspace boundary.',
  }, { id: 'project-3' })
  const otherWorkspaceTask = createCoordinationTask({
    projectId: otherWorkspaceProject.id,
    title: 'Other workspace parent',
    spec: 'This task lives outside the local workspace.',
  }, { id: 'task-other-workspace' })
  assert.throws(
    () => updateCoordinationTask(task.id, { parentTaskId: otherWorkspaceTask.id }),
    /same project/,
  )
}))

test('coordination service links tasks only to real OpenCode sessions', () => withTempAppData('session-link', () => {
  withMemoryCoordinationStore(() => {
    const { task } = createProjectAndTask()
    assert.throws(
      () => linkCoordinationTaskToSession(task.id, { assignedSessionId: 'missing-session' }),
      /Assigned OpenCode session was not found/,
    )

    const record = upsertSessionRecord(toSessionRecord({
      id: 'session-real',
      title: 'Implement board backend',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      opencodeDirectory: '/tmp/open-cowork-coordination-session',
      providerId: 'openrouter',
      modelId: 'openrouter/test',
      kind: 'workflow_run',
      workflowId: 'workflow-1',
      runId: 'run-1',
    }))
    assert.ok(record)

    const linked = linkCoordinationTaskToSession(task.id, {
      assignedSessionId: 'session-real',
      status: 'running',
      assigneeAgent: 'builder',
    })
    assert.equal(linked?.assignedSessionId, 'session-real')
    assert.equal(linked?.assignedRunId, 'run-1')
    assert.equal(linked?.status, 'running')
    assert.equal(linked?.column, 'doing')

    const target = getCoordinationTaskWorkTarget(task.id)
    assert.equal(target?.id, 'session-real')
    assert.equal(target?.runId, 'run-1')
  })
}))

test('coordination support marks desktop local projects and tasks supported', () => {
  assert.equal(coordinationCapabilityStatus('desktop_local', 'projects'), 'supported')
  assert.equal(coordinationCapabilityStatus('desktop_local', 'tasks'), 'supported')
})
