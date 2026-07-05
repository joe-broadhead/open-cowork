import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { assignCoordinationTask, clearCoordinationStoreCache, createCoordinationProject, createCoordinationTask, createCoordinationWatch, deleteCoordinationWatch, listCoordinationBoard, listCoordinationTasks, listCoordinationWatches, moveCoordinationTask, setCoordinationDatabaseForTests, updateCoordinationTask, updateCoordinationWatch } from '@open-cowork/runtime-host/coordination/coordination-store'
import { configureCoordinationWatchDeliveryAdapter, emitCoordinationWatchEvent, getCoordinationTaskWorkTarget, linkCoordinationTaskToSession, moveCoordinationTask as moveCoordinationTaskService, planCoordinationProjectWithCleo, updateCoordinationTask as updateCoordinationTaskService } from '@open-cowork/runtime-host/coordination/coordination-service'
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

async function withMemoryCoordinationStoreAsync(run: () => Promise<void>) {
  const db = new DatabaseSync(':memory:')
  try {
    setCoordinationDatabaseForTests(db)
    await run()
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

test('chief-of-staff planner creates specced planning tasks and assigns coworkers', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Studio board',
    objective: 'Ship the Studio projects board with Cleo planning.',
    team: ['cleo', 'explore', 'builder'],
  }, { id: 'project-cleo' })

  const result = planCoordinationProjectWithCleo({ projectId: project.id })

  assert.ok(result)
  assert.equal(result.plannerAgent, 'chief-of-staff')
  assert.equal(result.displayName, 'Cleo')
  assert.equal(result.project.id, project.id)
  assert.equal(result.tasks.length, 4)
  assert.deepEqual(result.tasks.map((task) => task.column), ['planning', 'planning', 'planning', 'planning'])
  assert.equal(result.tasks[0]?.priority, 'high')
  assert.equal(result.tasks[0]?.assigneeAgent, 'explore')
  assert.equal(result.tasks[2]?.assigneeAgent, 'builder')
  assert.equal(result.tasks.some((task) => task.assigneeAgent === 'cleo' || task.assigneeAgent === 'chief-of-staff'), false)
  for (const task of result.tasks) {
    assert.equal(task.projectId, project.id)
    assert.match(task.spec, /Ship the Studio projects board/)
    assert.match(task.externalRef || '', /^chief-of-staff:/)
  }

  const board = listCoordinationBoard()
  assert.equal(board.tasks.length, 4)
}))

test('chief-of-staff planner persists explicit task drafts using the coordination task shape', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Explicit Cleo plan',
    objective: 'Use supplied plan drafts.',
    team: ['builder'],
  }, { id: 'project-cleo-explicit' })

  const result = planCoordinationProjectWithCleo({
    projectId: project.id,
    tasks: [
      {
        spec: 'Build the first board slice.\n\nAcceptance: the board renders persisted tasks.',
        priority: 'low',
        assigneeAgent: 'cleo',
      },
    ],
  })

  assert.ok(result)
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0]?.title, 'Build the first board slice.')
  assert.equal(result.tasks[0]?.spec, 'Build the first board slice.\n\nAcceptance: the board renders persisted tasks.')
  assert.equal(result.tasks[0]?.priority, 'low')
  assert.equal(result.tasks[0]?.column, 'planning')
  assert.equal(result.tasks[0]?.assigneeAgent, 'builder')
}))

test('chief-of-staff planner preserves meaningful leading digits in generated task titles', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Identifier title Cleo plan',
    objective: 'Keep generated task titles faithful.',
    team: ['builder'],
  }, { id: 'project-cleo-identifier-title' })

  const result = planCoordinationProjectWithCleo({
    projectId: project.id,
    tasks: [
      {
        spec: '2FA migration path.\n\nAcceptance: the title keeps the product identifier.',
        assigneeAgent: 'builder',
      },
      {
        spec: '1. Build ordered-list task.\n\nAcceptance: list markers are still removed.',
        assigneeAgent: 'builder',
      },
    ],
  })

  assert.ok(result)
  assert.equal(result.tasks[0]?.title, '2FA migration path.')
  assert.equal(result.tasks[1]?.title, 'Build ordered-list task.')
}))

test('chief-of-staff planner never falls back explicit self-assignees to read-only agents', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Self-assignee Cleo plan',
    objective: 'Use supplied plan drafts without writable coworkers.',
    team: ['cleo', 'explore'],
  }, { id: 'project-cleo-self-assignee' })

  const result = planCoordinationProjectWithCleo({
    projectId: project.id,
    tasks: [
      {
        spec: 'Build the implementation slice.\n\nAcceptance: a writable coworker can execute this task.',
        priority: 'high',
        assigneeAgent: 'cleo',
      },
    ],
  })

  assert.ok(result)
  assert.equal(result.tasks[0]?.assigneeAgent, 'general')
}))

test('chief-of-staff planner validates generated multibyte titles before task inserts', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Multibyte Cleo plan',
    objective: 'Avoid partial task creation from generated titles.',
    team: ['builder'],
  }, { id: 'project-cleo-multibyte' })

  const result = planCoordinationProjectWithCleo({
    projectId: project.id,
    tasks: [
      {
        spec: 'Prepare the implementation path.\n\nAcceptance: the first task persists.',
        assigneeAgent: 'builder',
      },
      {
        spec: `${'🚀'.repeat(100)}\n\nAcceptance: the generated title stays inside the store byte limit.`,
        assigneeAgent: 'builder',
      },
    ],
  })

  assert.ok(result)
  assert.equal(result.tasks.length, 2)
  assert.equal(Buffer.byteLength(result.tasks[1]?.title || '', 'utf8') <= 240, true)
  assert.equal(listCoordinationTasks({ projectId: project.id }).length, 2)
}))

test('chief-of-staff planner does not assign generated implementation work to read-only agents', () => withMemoryCoordinationStore(() => {
  const project = createCoordinationProject({
    title: 'Read-only team',
    objective: 'Ship a slice with only discovery agents listed.',
    team: ['cleo', 'explore'],
  }, { id: 'project-cleo-readonly' })

  const result = planCoordinationProjectWithCleo({ projectId: project.id })

  assert.ok(result)
  assert.equal(result.tasks[0]?.assigneeAgent, 'explore')
  assert.equal(result.tasks[2]?.title, 'Build the first implementation slice')
  assert.equal(result.tasks[2]?.assigneeAgent, 'general')
  assert.equal(result.tasks[3]?.assigneeAgent, 'general')
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

test('coordination watches persist lifecycle, target filters, and cloud ownership', () => withMemoryCoordinationStore(() => {
  const { project } = createProjectAndTask()
  const watch = createCoordinationWatch({
    target: { kind: 'project', id: project.id },
    events: ['task.moved', 'task.review_ready', 'task.moved'],
    channel: {
      provider: 'telegram',
      agentId: 'agent-1',
      channelBindingId: 'binding-1',
      target: { chatId: 'chat-1' },
    },
    recipient: {
      role: 'member',
      identityId: 'identity-1',
      label: 'Project member',
    },
  }, { id: 'watch-1', now: new Date('2026-01-01T00:00:03.000Z') })

  assert.equal(watch.kind, 'watch')
  assert.equal(watch.workspaceId, 'local')
  assert.equal(watch.ownerAuthority, 'desktop_local')
  assert.deepEqual(watch.events, ['task.moved', 'task.review_ready'])
  assert.equal(watch.status, 'active')
  assert.equal(watch.channel.channelBindingId, 'binding-1')
  assert.equal(watch.recipient?.role, 'member')

  assert.deepEqual(listCoordinationWatches({ target: { kind: 'project', id: project.id } }).map((entry) => entry.id), ['watch-1'])
  assert.deepEqual(listCoordinationWatches({ status: 'active' }).map((entry) => entry.id), ['watch-1'])

  const paused = updateCoordinationWatch('watch-1', { status: 'paused', cursor: 'sequence-42' })
  assert.equal(paused?.status, 'paused')
  assert.equal(paused?.cursor, 'sequence-42')
  assert.deepEqual(listCoordinationWatches({ status: 'active' }).map((entry) => entry.id), [])
  assert.deepEqual(listCoordinationWatches({ status: 'paused' }).map((entry) => entry.id), ['watch-1'])
  assert.throws(
    () => updateCoordinationWatch('watch-1', { deliverySurface: 'not-real' as never }),
    /delivery surface/,
  )

  const cloudWatch = createCoordinationWatch({
    workspaceId: 'cloud:tenant-1',
    target: { kind: 'conversation', id: 'cloud-session-1' },
    events: ['run.finished'],
    channel: {
      provider: 'telegram',
      agentId: 'agent-cloud',
      channelBindingId: 'binding-cloud',
      target: { chatId: 'cloud-chat' },
    },
    recipient: { role: 'viewer' },
  }, { id: 'watch-cloud' })
  assert.equal(cloudWatch.ownerAuthority, 'cloud_channel_gateway')
  assert.equal(cloudWatch.executionAuthority, 'cloud_channel_gateway')
  assert.equal(cloudWatch.stateOwner, 'cloud_control_plane')

  const otherProject = createCoordinationProject({
    workspaceId: 'other-workspace',
    title: 'Other workspace',
    objective: 'Cross-workspace watch targets must fail.',
  }, { id: 'project-other' })
  assert.throws(
    () => createCoordinationWatch({
      target: { kind: 'project', id: otherProject.id },
      events: ['task.moved'],
      channel: {
        provider: 'telegram',
        agentId: 'agent-1',
        channelBindingId: 'binding-1',
        target: { chatId: 'chat-1' },
      },
    }),
    /Watch project target was not found/,
  )
  assert.throws(
    () => createCoordinationWatch({
      target: { kind: 'conversation', id: 'conversation-1' },
      events: ['run.finished'],
      deliverySurface: 'not-real' as never,
      channel: {
        provider: 'telegram',
        agentId: 'agent-1',
        channelBindingId: 'binding-1',
        target: { chatId: 'chat-1' },
      },
    }),
    /delivery surface/,
  )
  assert.throws(
    () => createCoordinationWatch({
      target: { kind: 'workflow', id: 'workflow-1' },
      events: ['run.finished'],
      channel: {
        provider: 'telegram',
        agentId: 'agent-1',
        channelBindingId: 'binding-1',
        target: { chatId: 'chat-1' },
      },
    }),
    /not supported/,
  )
  assert.throws(
    () => updateCoordinationWatch('watch-cloud', { target: { kind: 'run', id: 'run-1' } }),
    /not supported/,
  )

  assert.equal(deleteCoordinationWatch('watch-1'), true)
  assert.equal(deleteCoordinationWatch('watch-1'), false)
}))

test('coordination watch delivery matches targets and respects role gates and optional adapters', async () => {
  await withMemoryCoordinationStoreAsync(async () => {
    const { project, task } = createProjectAndTask()
    const deliveries: unknown[] = []
    configureCoordinationWatchDeliveryAdapter({
      createChannelDelivery: async (input) => {
        deliveries.push(input)
      },
    })
    try {
      createCoordinationWatch({
        target: { kind: 'project', id: project.id },
        events: ['task.moved', 'needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-1',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }, { id: 'watch-project' })
      createCoordinationWatch({
        target: { kind: 'task', id: task.id },
        events: ['task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-2',
          target: { chatId: 'task-chat' },
        },
        recipient: { role: 'member' },
      }, { id: 'watch-review-only' })
      createCoordinationWatch({
        target: { kind: 'conversation', id: 'session-1' },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-viewer',
          target: { chatId: 'viewer-chat' },
        },
        recipient: { role: 'viewer' },
      }, { id: 'watch-viewer' })
      createCoordinationWatch({
        target: { kind: 'conversation', id: 'session-1' },
        events: ['needs_input'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-approver',
          target: { chatId: 'approver-chat' },
        },
        recipient: { role: 'approver' },
      }, { id: 'watch-approver' })

      const moveResults = await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'task.moved',
        target: { kind: 'task', id: task.id },
        relatedTargets: [{ kind: 'project', id: project.id }],
        occurredAt: '2026-01-01T00:00:04.000Z',
        title: 'Task moved',
      })
      assert.deepEqual(moveResults.map((result) => result.watchId), ['watch-project'])
      assert.equal(moveResults[0]?.delivered, true)
      assert.equal(deliveries.length, 1)
      assert.equal((deliveries[0] as { channelBindingId?: string }).channelBindingId, 'binding-1')
      assert.equal(((deliveries[0] as { payload?: { watchId?: string } }).payload)?.watchId, 'watch-project')
      const firstMoveDeliveryId = (deliveries[0] as { deliveryId?: string }).deliveryId
      await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'task.moved',
        target: { kind: 'task', id: task.id },
        relatedTargets: [{ kind: 'project', id: project.id }],
        occurredAt: '2026-01-01T00:00:04.000Z',
        title: 'Task moved',
      })
      assert.equal((deliveries[1] as { deliveryId?: string }).deliveryId, firstMoveDeliveryId)

      const needsInputResults = await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'needs_input',
        target: { kind: 'conversation', id: 'session-1' },
        occurredAt: '2026-01-01T00:00:05.000Z',
        title: 'Approval needed',
      })
      assert.deepEqual(needsInputResults.map((result) => result.watchId), ['watch-approver'])
      assert.equal(deliveries.length, 3)
      assert.equal((deliveries[2] as { channelBindingId?: string }).channelBindingId, 'binding-approver')

      createCoordinationWatch({
        target: { kind: 'conversation', id: 'session-2' },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-finished',
          target: { chatId: 'finished-chat' },
        },
      }, { id: 'watch-finished' })
      const firstFinishedResults = await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'run.finished',
        target: { kind: 'conversation', id: 'session-2' },
        occurredAt: '2026-01-01T00:00:06.000Z',
        metadata: { sessionId: 'session-2', synthetic: false },
      })
      const secondFinishedResults = await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'run.finished',
        target: { kind: 'conversation', id: 'session-2' },
        occurredAt: '2026-01-01T00:00:07.000Z',
        metadata: { sessionId: 'session-2', synthetic: false },
      })
      assert.deepEqual(firstFinishedResults.map((result) => result.watchId), ['watch-finished'])
      assert.deepEqual(secondFinishedResults.map((result) => result.watchId), ['watch-finished'])
      assert.equal(deliveries.length, 5)
      assert.notEqual(
        (deliveries[3] as { deliveryId?: string }).deliveryId,
        (deliveries[4] as { deliveryId?: string }).deliveryId,
      )

      createCoordinationWatch({
        target: { kind: 'conversation', id: 'session-3' },
        events: ['run.finished'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-no-adapter',
          target: { chatId: 'no-adapter-chat' },
        },
      }, { id: 'watch-no-adapter' })
      configureCoordinationWatchDeliveryAdapter(null)
      const noAdapterResults = await emitCoordinationWatchEvent({
        workspaceId: 'local',
        eventType: 'run.finished',
        target: { kind: 'conversation', id: 'session-3' },
      })
      assert.equal(noAdapterResults[0]?.watchId, 'watch-no-adapter')
      assert.equal(noAdapterResults[0]?.delivered, false)
      assert.equal(noAdapterResults[0]?.skippedReason, 'no_delivery_adapter')
    } finally {
      configureCoordinationWatchDeliveryAdapter(null)
    }
  })
})

test('coordination service emits task moved watches for generic task column updates', async () => {
  await withMemoryCoordinationStoreAsync(async () => {
    const deliveries: Array<Record<string, unknown>> = []
    configureCoordinationWatchDeliveryAdapter({
      async createChannelDelivery(input) {
        deliveries.push(input)
      },
    })
    try {
      const { project, task } = createProjectAndTask()
      createCoordinationWatch({
        target: { kind: 'project', id: project.id },
        events: ['task.moved', 'task.review_ready'],
        channel: {
          provider: 'telegram',
          agentId: 'agent-1',
          channelBindingId: 'binding-generic-update',
          target: { chatId: 'project-chat' },
        },
        recipient: { role: 'member' },
      }, { id: 'watch-generic-update' })

      const updated = updateCoordinationTaskService(task.id, { column: 'review' })
      assert.equal(updated?.column, 'review')
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.deepEqual(deliveries.map((delivery) => delivery.eventType), ['task.moved', 'task.review_ready'])
      assert.equal(deliveries[0]?.deliveryId !== deliveries[1]?.deliveryId, true)
      assert.deepEqual((deliveries[0]?.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata, {
        taskId: task.id,
        projectId: project.id,
        previousColumn: 'planning',
        column: 'review',
      })

      const noOpMove = moveCoordinationTaskService(task.id, { column: 'review' })
      assert.equal(noOpMove?.column, 'review')
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(deliveries.length, 2)
    } finally {
      configureCoordinationWatchDeliveryAdapter(null)
    }
  })
})

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
