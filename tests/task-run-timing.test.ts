import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmptyTaskRun,
  upsertTaskRunList,
} from '../apps/desktop/src/lib/session-view-model.ts'
import {
  getTaskRun,
  registerTaskRun,
  resetEventTaskState,
  updateTaskRun,
} from '../apps/desktop/src/main/event-task-state.ts'

test('createEmptyTaskRun stamps startedAt when constructed with status=running', () => {
  const taskRun = createEmptyTaskRun({ id: 'task-1', status: 'running' })
  assert.ok(taskRun.startedAt, 'startedAt should be set when constructed as running')
  assert.equal(taskRun.finishedAt, null)
})

test('createEmptyTaskRun stamps finishedAt when constructed with a terminal status', () => {
  const complete = createEmptyTaskRun({ id: 'task-c', status: 'complete' })
  const errored = createEmptyTaskRun({ id: 'task-e', status: 'error' })
  // If a task is first observed as terminal we never saw it running, so
  // startedAt stays null (the clock hides in that case; "ran ?" is worse
  // than nothing). finishedAt is still useful for timeline ordering.
  assert.equal(complete.startedAt, null)
  assert.ok(complete.finishedAt)
  assert.equal(errored.startedAt, null)
  assert.ok(errored.finishedAt)
})

test('createEmptyTaskRun leaves both timestamps empty for queued tasks', () => {
  const queued = createEmptyTaskRun({ id: 'task-q', status: 'queued' })
  assert.equal(queued.startedAt, null)
  assert.equal(queued.finishedAt, null)
})

test('upsertTaskRunList sets startedAt when a queued task transitions to running', () => {
  let taskRuns = upsertTaskRunList([], { id: 'task-1', status: 'queued' })
  assert.equal(taskRuns[0]?.startedAt, null)

  taskRuns = upsertTaskRunList(taskRuns, { id: 'task-1', status: 'running' })
  assert.ok(taskRuns[0]?.startedAt, 'startedAt must be populated on queued → running transition')
  assert.equal(taskRuns[0]?.finishedAt, null)
})

test('upsertTaskRunList preserves startedAt when a running task finishes', async () => {
  let taskRuns = upsertTaskRunList([], { id: 'task-1', status: 'running' })
  const firstStart = taskRuns[0]?.startedAt
  assert.ok(firstStart)

  // Wait a tick so the clock advances.
  await new Promise((resolve) => setTimeout(resolve, 2))

  taskRuns = upsertTaskRunList(taskRuns, { id: 'task-1', status: 'complete' })
  assert.equal(taskRuns[0]?.startedAt, firstStart, 'startedAt must not shift when task finishes')
  assert.ok(taskRuns[0]?.finishedAt)
})

test('main task-run state emits stable start and finish timestamps for live subagents', async () => {
  resetEventTaskState()
  const registered = registerTaskRun({
    id: 'task-live',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Research languages',
    agent: 'research',
    childSessionId: null,
    status: 'queued',
  })

  assert.ok(registered.startedAt, 'live task runs should be anchored when registered')
  assert.equal(registered.finishedAt, null)

  await new Promise((resolve) => setTimeout(resolve, 2))

  const completed = updateTaskRun('task-live', { status: 'complete' })
  assert.ok(completed)
  assert.equal(completed!.startedAt, registered.startedAt, 'completion must not move the start anchor')
  assert.ok(completed!.finishedAt, 'terminal update should clamp the live timer')

  const stored = getTaskRun('task-live')
  assert.equal(stored?.finishedAt, completed!.finishedAt)
  resetEventTaskState()
})

test('main task-run state clears stale finishedAt when a task returns to running', async () => {
  resetEventTaskState()
  const registered = registerTaskRun({
    id: 'task-resumed',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    title: 'Research languages',
    agent: 'research',
    childSessionId: null,
    status: 'running',
  })

  const completed = updateTaskRun('task-resumed', { status: 'complete' })
  assert.ok(completed?.finishedAt)

  const running = updateTaskRun('task-resumed', { status: 'running' })
  assert.ok(running)
  assert.equal(running!.status, 'running')
  assert.equal(running!.startedAt, registered.startedAt)
  assert.equal(running!.finishedAt, null, 'running tasks must not retain a terminal timestamp')

  resetEventTaskState()
})

test('deriveVisibleSessionPatch backfills startedAt for terminal tasks that only have finishedAt', async () => {
  const { deriveVisibleSessionPatch, createEmptySessionViewState } = await import('../apps/desktop/src/lib/session-view-model.ts')
  const finishedAt = '2026-04-16T19:00:05.000Z'
  const state = createEmptySessionViewState({ hydrated: true, lastEventAt: 1_700_000_000_000 })
  state.taskRuns = [
    {
      id: 'task-finished',
      title: 'Sub-Agent',
      agent: 'explore',
      status: 'complete',
      sourceSessionId: null,
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 1,
      startedAt: null,
      finishedAt,
    },
  ]

  const view = deriveVisibleSessionPatch(state, 'session-1', new Set(), new Set())
  assert.equal(view.taskRuns[0]?.startedAt, finishedAt, 'terminal task without startedAt should fall back to finishedAt so the clock still renders')
})

test('deriveVisibleSessionPatch backfills finishedAt for terminal tasks that only have startedAt', async () => {
  const { deriveVisibleSessionPatch, createEmptySessionViewState } = await import('../apps/desktop/src/lib/session-view-model.ts')
  const startedAt = '2026-04-16T19:00:05.000Z'
  const state = createEmptySessionViewState({ hydrated: true, lastEventAt: 1_700_000_000_000 })
  state.taskRuns = [
    {
      id: 'task-terminal',
      title: 'Sub-Agent',
      agent: 'explore',
      status: 'complete',
      sourceSessionId: null,
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 1,
      startedAt,
      finishedAt: null,
    },
  ]

  const view = deriveVisibleSessionPatch(state, 'session-1', new Set(), new Set())
  assert.equal(view.taskRuns[0]?.finishedAt, startedAt, 'terminal task without finishedAt should clamp to its start so elapsed time stays bounded')
})

test('deriveVisibleSessionPatch backfills startedAt for running tasks with a missing anchor', async () => {
  const { deriveVisibleSessionPatch, createEmptySessionViewState } = await import('../apps/desktop/src/lib/session-view-model.ts')
  const state = createEmptySessionViewState({ hydrated: true, lastEventAt: 1_700_000_000_000 })
  state.taskRuns = [
    {
      id: 'task-1',
      title: 'Sub-Agent',
      agent: 'explore',
      status: 'running',
      sourceSessionId: null,
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 1,
      startedAt: null,
      finishedAt: null,
    },
  ]

  const view = deriveVisibleSessionPatch(state, 'session-1', new Set(['session-1']), new Set())
  assert.ok(view.taskRuns[0]?.startedAt, 'view must expose a startedAt even if state lacked one')
  assert.equal(view.taskRuns[0]?.finishedAt, null)
})

test('history hydration that completes a running task preserves its startedAt so the clock stays visible', async () => {
  const { buildSessionStateFromItems, createEmptySessionViewState } = await import('../apps/desktop/src/lib/session-view-model.ts')

  const existingStart = '2026-04-16T19:00:00.000Z'
  const existing = createEmptySessionViewState({ hydrated: true, lastEventAt: 1_700_000_000_000 })
  existing.taskRuns = [
    {
      id: 'task-X',
      title: 'Explore',
      agent: 'explore',
      status: 'running',
      sourceSessionId: null,
      content: 'working…',
      transcript: [{ id: 'task-X:seg', content: 'working…', order: 1 }],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 1,
      startedAt: existingStart,
      finishedAt: null,
    },
  ]

  // History says the task completed. Classic projector payload: no timing.
  const items = [
    {
      type: 'task_run' as const,
      id: 'task-X',
      timestamp: '2026-04-16T19:00:05.000Z',
      sequence: 10,
      taskRun: {
        title: 'Explore',
        agent: 'explore',
        status: 'complete' as const,
        sourceSessionId: null,
      },
    },
  ]

  const next = buildSessionStateFromItems(items, existing, { preserveStreamingState: true })
  const task = next.taskRuns.find((t) => t.id === 'task-X')
  assert.ok(task)
  assert.equal(task!.status, 'complete')
  assert.equal(task!.startedAt, existingStart, 'startedAt must survive the running → complete transition')
})

test('history hydration carries projector-supplied startedAt and finishedAt into a brand-new task run', async () => {
  const { buildSessionStateFromItems, createEmptySessionViewState } = await import('../apps/desktop/src/lib/session-view-model.ts')

  // Simulates a reloaded thread where the subagent finished before the
  // app started watching — projector has both timestamps from the child
  // session record. Previously the projector dropped them, so elapsed
  // rendered 0s. The taskRun is new to the view state on this replay.
  const existing = createEmptySessionViewState({ hydrated: true, lastEventAt: 0 })
  const items = [
    {
      type: 'task_run' as const,
      id: 'task-reloaded',
      timestamp: '2026-04-17T21:00:00.000Z',
      sequence: 1,
      taskRun: {
        title: 'Research',
        agent: 'research',
        status: 'complete' as const,
        sourceSessionId: 'child-1',
        startedAt: '2026-04-17T21:00:00.000Z',
        finishedAt: '2026-04-17T21:00:42.000Z',
      },
    },
  ]

  const next = buildSessionStateFromItems(items, existing, { preserveStreamingState: false })
  const task = next.taskRuns.find((t) => t.id === 'task-reloaded')
  assert.ok(task)
  assert.equal(task!.startedAt, '2026-04-17T21:00:00.000Z')
  assert.equal(task!.finishedAt, '2026-04-17T21:00:42.000Z')
})

test('upsertTaskRunList does not overwrite a pre-set startedAt on subsequent updates', () => {
  const initialStart = '2026-01-01T00:00:00.000Z'
  let taskRuns = upsertTaskRunList([], { id: 'task-1', status: 'running' } as any)
  // Manually patch startedAt as if it came from a caller.
  taskRuns = taskRuns.map((t) => (t.id === 'task-1' ? { ...t, startedAt: initialStart } : t))

  taskRuns = upsertTaskRunList(taskRuns, { id: 'task-1', status: 'running', title: 'Renamed' })
  assert.equal(taskRuns[0]?.startedAt, initialStart)
  assert.equal(taskRuns[0]?.title, 'Renamed')
})
