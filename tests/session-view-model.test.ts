import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_WARM_SESSION_DETAILS,
  beginCompactionNotice,
  buildMessages,
  buildSessionStateFromItems,
  createEmptySessionViewState,
  createEmptyTaskRun,
  deriveVisibleSessionPatch,
  finishCompactionNotice,
  importMessage,
  mergeStreamingText,
  nextSeq,
  pruneSessionDetailCache,
  upsertTaskRunList,
  withMessageText,
  withTaskRun,
  type HistoryItem,
  type SessionViewState,
} from '../apps/desktop/src/lib/session-view-model.ts'

// The test suite focuses on surface area that `session-store-reducer.test.ts`
// does not already cover: execution plan derivation, task-run timing
// precedence, compaction notice flow, the LRU eviction bound, and the
// streaming-text merge heuristic.

test('mergeStreamingText prefers the longer prefix when existing is the head of incoming', () => {
  assert.equal(mergeStreamingText('Hello', 'Hello world'), 'Hello world')
})

test('mergeStreamingText keeps existing when incoming is the tail already present', () => {
  assert.equal(mergeStreamingText('Hello world', 'world'), 'Hello world')
})

test('mergeStreamingText joins with maximum overlap for partial duplicates', () => {
  assert.equal(mergeStreamingText('Hello wor', 'world'), 'Hello world')
})

test('mergeStreamingText concatenates when no overlap exists', () => {
  assert.equal(mergeStreamingText('foo', 'bar'), 'foobar')
})

test('mergeStreamingText handles empty strings without losing content', () => {
  assert.equal(mergeStreamingText('', 'fresh'), 'fresh')
  assert.equal(mergeStreamingText('existing', ''), 'existing')
})

test('beginCompactionNotice appends a new compacting entry when no id matches', () => {
  const notices = beginCompactionNotice([], { id: 'c-1', auto: true, overflow: false })
  assert.equal(notices.length, 1)
  assert.equal(notices[0].id, 'c-1')
  assert.equal(notices[0].status, 'compacting')
  assert.equal(notices[0].auto, true)
  assert.equal(notices[0].overflow, false)
})

test('beginCompactionNotice reuses the existing id and re-arms it as compacting', () => {
  const first = beginCompactionNotice([], { id: 'c-1' })
  const compacted = finishCompactionNotice(first, { id: 'c-1' })
  assert.equal(compacted[0].status, 'compacted')

  // Re-beginning the same id snaps it back to compacting in-place.
  const rearmed = beginCompactionNotice(compacted, { id: 'c-1', overflow: true })
  assert.equal(rearmed.length, 1)
  assert.equal(rearmed[0].status, 'compacting')
  assert.equal(rearmed[0].overflow, true)
})

test('finishCompactionNotice resolves the newest matching compacting entry when id is omitted', () => {
  const notices = beginCompactionNotice(
    beginCompactionNotice([], { id: 'c-1', sourceSessionId: 'sess-a' }),
    { id: 'c-2', sourceSessionId: 'sess-b' },
  )
  const done = finishCompactionNotice(notices, { sourceSessionId: 'sess-b' })
  const byId = Object.fromEntries(done.map((notice) => [notice.id, notice.status]))
  assert.equal(byId['c-1'], 'compacting')
  assert.equal(byId['c-2'], 'compacted')
})

test('finishCompactionNotice appends a synthetic completed entry when no compacting match is found', () => {
  const done = finishCompactionNotice([], { sourceSessionId: 'sess-a' })
  assert.equal(done.length, 1)
  assert.equal(done[0].status, 'compacted')
})

test('upsertTaskRunList creates a new running task with a derived startedAt', () => {
  const list = upsertTaskRunList([], { id: 't-1', title: 'Explore', status: 'running' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 't-1')
  assert.equal(list[0].status, 'running')
  assert.ok(list[0].startedAt, 'startedAt should be set when status is running')
  assert.equal(list[0].finishedAt, null)
})

test('upsertTaskRunList keeps caller-supplied startedAt through status transitions', () => {
  const initial = upsertTaskRunList([], {
    id: 't-1',
    title: 'Explore',
    status: 'running',
    startedAt: '2026-04-17T00:00:00.000Z',
  })
  assert.equal(initial[0].startedAt, '2026-04-17T00:00:00.000Z')

  const completed = upsertTaskRunList(initial, {
    id: 't-1',
    status: 'complete',
  })
  assert.equal(completed[0].startedAt, '2026-04-17T00:00:00.000Z', 'startedAt must be preserved')
  assert.ok(completed[0].finishedAt, 'finishedAt should be derived on transition to complete')
})

test('withTaskRun creates the task on first touch when the id is unknown', () => {
  const list = withTaskRun([], 't-new', (task) => ({
    ...task,
    title: 'Summarize',
    status: 'running',
  }))
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 't-new')
  assert.equal(list[0].title, 'Summarize')
  assert.equal(list[0].status, 'running')
})

test('deriveVisibleSessionPatch synthesizes an execution plan from task runs', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  state.taskRuns = upsertTaskRunList(state.taskRuns, {
    id: 't-1',
    title: 'Step one',
    status: 'complete',
  })
  state.taskRuns = upsertTaskRunList(state.taskRuns, {
    id: 't-2',
    title: 'Step two',
    status: 'running',
  })

  const view = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set(['session-1']),
    new Set<string>(),
  )

  // launch + t-1 + t-2 + synthesize = 4 items.
  assert.equal(view.executionPlan.length, 4)
  assert.equal(view.executionPlan[0].id, 'execution:launch')
  assert.equal(view.executionPlan[0].status, 'completed')
  assert.equal(view.executionPlan[1].id, 'execution:t-1')
  assert.equal(view.executionPlan[1].status, 'completed')
  assert.equal(view.executionPlan[2].id, 'execution:t-2')
  assert.equal(view.executionPlan[2].status, 'in_progress')
  // The synthesize step stays pending while any branch is still running.
  assert.equal(view.executionPlan[3].id, 'execution:synthesize')
  assert.equal(view.executionPlan[3].status, 'pending')
})

test('deriveVisibleSessionPatch marks the synthesis step blocked when any branch errored', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  state.taskRuns = upsertTaskRunList(state.taskRuns, {
    id: 't-1',
    title: 'Ran',
    status: 'complete',
  })
  state.taskRuns = upsertTaskRunList(state.taskRuns, {
    id: 't-2',
    title: 'Broke',
    status: 'error',
  })

  const view = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set<string>(),
    new Set<string>(),
  )
  const synth = view.executionPlan.find((item) => item.id === 'execution:synthesize')
  assert.equal(synth?.status, 'blocked')
})

test('deriveVisibleSessionPatch backfills startedAt for running tasks missing an anchor', () => {
  const state = createEmptySessionViewState({ hydrated: true, lastEventAt: 1_700_000_000_000 })
  // Hand-craft a running task without timing so we exercise the backfill.
  state.taskRuns = [
    {
      ...createEmptyTaskRun({ id: 't-1', title: 'Running', status: 'running' }),
      startedAt: null,
    },
  ]

  const view = deriveVisibleSessionPatch(state, 'session-1', new Set<string>(), new Set<string>())
  const patched = view.taskRuns.find((task) => task.id === 't-1')
  assert.ok(patched?.startedAt, 'running task should get a startedAt backfill for ElapsedClock')
})

test('pruneSessionDetailCache keeps the current session even when over the LRU budget', () => {
  const sessionStateById: Record<string, SessionViewState> = {}
  sessionStateById['active'] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 1 })
  for (let index = 0; index < MAX_WARM_SESSION_DETAILS + 5; index += 1) {
    const id = `warm-${index}`
    sessionStateById[id] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 100 + index })
  }

  const pruned = pruneSessionDetailCache(sessionStateById, 'active', new Set<string>())
  // The active session is always retained regardless of lastViewedAt rank.
  assert.equal(pruned['active'].hydrated, true)
})

test('pruneSessionDetailCache evicts the least-recently-viewed sessions past the warm budget', () => {
  const sessionStateById: Record<string, SessionViewState> = {}
  // Create MAX+3 warm sessions, all older than the current session.
  for (let index = 0; index < MAX_WARM_SESSION_DETAILS + 3; index += 1) {
    const id = `s-${index}`
    sessionStateById[id] = createEmptySessionViewState({ hydrated: true, lastViewedAt: index })
  }

  const pruned = pruneSessionDetailCache(sessionStateById, null, new Set<string>())

  // Hydrated count after prune must be exactly MAX_WARM_SESSION_DETAILS.
  const hydrated = Object.values(pruned).filter((state) => state.hydrated)
  assert.equal(hydrated.length, MAX_WARM_SESSION_DETAILS)

  // The oldest (s-0, s-1, s-2) should be reset to empty / unhydrated.
  assert.equal(pruned['s-0'].hydrated, false)
  assert.equal(pruned['s-1'].hydrated, false)
  assert.equal(pruned['s-2'].hydrated, false)
  // The newest should still be hydrated.
  assert.equal(pruned[`s-${MAX_WARM_SESSION_DETAILS + 2}`].hydrated, true)
})

test('pruneSessionDetailCache retains busy sessions regardless of lastViewedAt', () => {
  const sessionStateById: Record<string, SessionViewState> = {}
  sessionStateById['busy'] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 0 })
  for (let index = 0; index < MAX_WARM_SESSION_DETAILS + 3; index += 1) {
    sessionStateById[`warm-${index}`] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 100 + index })
  }

  const pruned = pruneSessionDetailCache(sessionStateById, null, new Set(['busy']))
  assert.equal(pruned['busy'].hydrated, true, 'busy session must survive even with the lowest lastViewedAt')
})

test('pruneSessionDetailCache preserves revision and lastEventAt on evicted sessions', () => {
  const sessionStateById: Record<string, SessionViewState> = {}
  sessionStateById['old'] = createEmptySessionViewState({
    hydrated: true,
    lastViewedAt: 0,
    revision: 42,
    lastEventAt: 1000,
  })
  for (let index = 0; index < MAX_WARM_SESSION_DETAILS; index += 1) {
    sessionStateById[`warm-${index}`] = createEmptySessionViewState({
      hydrated: true,
      lastViewedAt: 100 + index,
    })
  }

  const pruned = pruneSessionDetailCache(sessionStateById, null, new Set<string>())
  assert.equal(pruned['old'].hydrated, false)
  // These fields survive so re-hydration can decide whether its view is stale.
  assert.equal(pruned['old'].revision, 42)
  assert.equal(pruned['old'].lastEventAt, 1000)
})

test('pruneSessionDetailCache is a no-op when the state is already within budget', () => {
  const sessionStateById: Record<string, SessionViewState> = {}
  sessionStateById['a'] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 1 })
  sessionStateById['b'] = createEmptySessionViewState({ hydrated: true, lastViewedAt: 2 })

  const pruned = pruneSessionDetailCache(sessionStateById, null, new Set<string>())
  // Returns the same object reference when nothing changed — callers rely on
  // this to avoid unnecessary re-renders.
  assert.strictEqual(pruned, sessionStateById)
})

test('importMessage observes sequence numbers so later messages remain strictly ordered', () => {
  // Bump seq via nextSeq() to simulate prior activity.
  nextSeq()
  nextSeq()

  const state = createEmptySessionViewState({ hydrated: true })
  const withFirst = importMessage(state, {
    id: 'msg-1',
    role: 'user',
    content: 'Hi',
    segments: [{ id: 'msg-1:part-0', content: 'Hi', order: 500 }],
    order: 501,
  })

  const withSecond = {
    ...state,
    ...withMessageText(withFirst, {
      messageId: 'msg-2',
      role: 'assistant',
      content: 'Hello',
      segmentId: 'msg-2:part-0',
    }),
  }

  // The assistant message arrived after the imported user message, so its
  // order must exceed the imported message's order — even though the import
  // fast-forwarded the global sequence.
  assert.ok(withSecond.messageById['msg-2'].order > withFirst.messageById['msg-1'].order)
})

test('buildSessionStateFromItems preserves the hydrated flag when replaying items', () => {
  const items: HistoryItem[] = [
    {
      type: 'message',
      id: 'evt-1',
      messageId: 'msg-1',
      partId: 'msg-1:part-0',
      role: 'user',
      content: 'hi',
      timestamp: '2026-04-17T10:00:00.000Z',
    },
  ]
  const next = buildSessionStateFromItems(items)
  assert.equal(next.hydrated, true)
  const messages = buildMessages(next.messageIds, next.messageById, next.messagePartsById)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
})
