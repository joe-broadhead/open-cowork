import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMessages,
  buildSessionStateFromItems,
  buildSessionStateFromView,
  createEmptySessionViewState,
  deriveVisibleSessionPatch,
  withMessageText,
  type HistoryItem,
} from '../apps/desktop/src/lib/session-view-model.ts'
import { useSessionStore } from '../apps/desktop/src/renderer/stores/session.ts'

test('history replay keeps the final authoritative text for a message part', () => {
  const items: HistoryItem[] = [
    {
      type: 'message',
      id: 'evt-1',
      messageId: 'msg-1',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello wor',
      timestamp: '2026-04-13T10:00:00.000Z',
    },
    {
      type: 'message',
      id: 'evt-2',
      messageId: 'msg-1',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello world',
      timestamp: '2026-04-13T10:00:01.000Z',
    },
  ]

  const state = buildSessionStateFromItems(items)
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'Hello world')
  assert.deepEqual(messages[0].segments?.map((segment) => segment.content), ['Hello world'])
})

test('history replay preserves newer streamed assistant text when persisted history is lagging', () => {
  const existing = createEmptySessionViewState({
    hydrated: true,
    revision: 4,
    lastEventAt: 200,
  })
  Object.assign(existing, withMessageText(existing, {
    messageId: 'msg-1',
    role: 'assistant',
    content: 'Hello world!',
    segmentId: 'part-1',
    replace: true,
  }))

  const items: HistoryItem[] = [
    {
      type: 'message',
      id: 'evt-1',
      messageId: 'msg-1',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello',
      timestamp: '2026-04-13T10:00:00.000Z',
    },
  ]

  const state = buildSessionStateFromItems(items, existing, { preserveStreamingState: true })
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.content, 'Hello world!')
})

test('visible session state pauses generation while awaiting permission', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  const visible = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set(['session-1']),
    new Set(['session-1']),
  )

  assert.equal(visible.isGenerating, false)
  assert.equal(visible.isAwaitingPermission, true)
})

test('visible session state resumes generating when approval wait clears', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  const visible = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set(['session-1']),
    new Set<string>(),
  )

  assert.equal(visible.isGenerating, true)
  assert.equal(visible.isAwaitingPermission, false)
})

test('renderer store surfaces live permission requests immediately', () => {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    currentView: deriveVisibleSessionPatch(createEmptySessionViewState(), null, new Set<string>(), new Set<string>()),
    globalErrors: [],
    mcpConnections: [],
    agentMode: 'build',
    totalCost: 0,
    sidebarCollapsed: false,
    busySessions: new Set<string>(),
    awaitingPermissionSessions: new Set<string>(),
    awaitingQuestionSessions: new Set<string>(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })

  useSessionStore.getState().setCurrentSession('session-1')
  useSessionStore.getState().addPendingApproval({
    id: 'approval-1',
    sessionId: 'session-1',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Run shell command',
  })

  const state = useSessionStore.getState()
  assert.equal(state.currentView.pendingApprovals.length, 1)
  assert.equal(state.currentView.pendingApprovals[0]?.id, 'approval-1')
  assert.equal(state.currentView.isAwaitingPermission, true)
  assert.equal(state.currentView.isGenerating, false)
  assert.equal(state.currentView.lastEventAt, 0)
})

test('renderer live permission requests do not advance the session event clock', () => {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    currentView: deriveVisibleSessionPatch(createEmptySessionViewState(), null, new Set<string>(), new Set<string>()),
    globalErrors: [],
    mcpConnections: [],
    agentMode: 'build',
    totalCost: 0,
    sidebarCollapsed: false,
    busySessions: new Set<string>(),
    awaitingPermissionSessions: new Set<string>(),
    awaitingQuestionSessions: new Set<string>(),
    sessionStateById: {
      'session-1': createEmptySessionViewState({ lastEventAt: 200 }),
    },
    chartArtifactsBySession: {},
  })

  useSessionStore.getState().setCurrentSession('session-1')
  useSessionStore.getState().addPendingApproval({
    id: 'approval-1',
    sessionId: 'session-1',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Run shell command',
  })

  const state = useSessionStore.getState()
  assert.equal(state.currentView.lastEventAt, 200)
  assert.equal(state.sessionStateById['session-1']?.lastEventAt, 200)
})

test('session view snapshots do not wipe newer locally streamed text', () => {
  const existing = createEmptySessionViewState({
    hydrated: true,
    revision: 4,
    lastEventAt: 200,
  })
  Object.assign(existing, withMessageText(existing, {
    messageId: 'msg-1',
    role: 'assistant',
    content: 'Hello world!',
    segmentId: 'part-1',
    replace: true,
  }))

  const snapshot = createEmptySessionViewState({
    hydrated: true,
    revision: 3,
    lastEventAt: 100,
  })
  Object.assign(snapshot, withMessageText(snapshot, {
    messageId: 'msg-1',
    role: 'assistant',
    content: 'Hello',
    segmentId: 'part-1',
    replace: true,
  }))

  const view = deriveVisibleSessionPatch(snapshot, 'session-1', new Set<string>(), new Set<string>())
  const merged = buildSessionStateFromView(view, existing)
  const messages = buildMessages(merged.messageIds, merged.messageById, merged.messagePartsById)

  assert.equal(messages[0]?.content, 'Hello world!')
  assert.equal(merged.lastEventAt, 100)
  assert.equal(merged.revision, 3)
})

test('new streamed messages sort after hydrated history', () => {
  const state = buildSessionStateFromView({
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Earlier user message',
        order: 10,
        segments: [{ id: 'msg-1:part-1', content: 'Earlier user message', order: 11 }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Earlier assistant reply',
        order: 20,
        segments: [{ id: 'msg-2:part-1', content: 'Earlier assistant reply', order: 21 }],
      },
    ],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: 100,
    isGenerating: false,
    isAwaitingPermission: false,
  })

  const updated = {
    ...state,
    ...withMessageText(state, {
      messageId: 'msg-3',
      role: 'assistant',
      content: 'Newest streamed reply',
      segmentId: 'msg-3:part-1',
      replace: true,
    }),
  }
  const messages = buildMessages(updated.messageIds, updated.messageById, updated.messagePartsById)

  assert.equal(messages.at(-1)?.id, 'msg-3')
  assert.ok(updated.messageById['msg-3'].order > updated.messageById['msg-2'].order)
  assert.ok(updated.messagePartsById['msg-3:part-1'].order > updated.messagePartsById['msg-2:part-1'].order)
})

test('history hydration does not re-import the live user placeholder after a real message absorbed it', () => {
  // Simulate the real sequence: the renderer dispatched an optimistic user
  // bubble, then the main process synced history from OpenCode.
  const existing = createEmptySessionViewState({ hydrated: false, lastEventAt: 200 })
  Object.assign(existing, withMessageText(existing, {
    messageId: 'ses_X:user:live',
    role: 'user',
    content: 'explore this dir',
    segmentId: 'ses_X:user:segment:live',
    replace: true,
  }))

  const items: HistoryItem[] = [
    {
      type: 'message',
      id: 'evt-user',
      messageId: 'msg_real_user',
      partId: 'msg_real_user:part:0',
      role: 'user',
      content: 'explore this dir',
      timestamp: '2026-04-16T21:31:00.000Z',
    },
  ]

  // preserveStreamingState is true when existing.lastEventAt is newer than
  // history (the common mid-stream case — the placeholder is newer than
  // whatever the server had recorded when we fetched).
  const next = buildSessionStateFromItems(items, existing, { preserveStreamingState: true })
  const messages = buildMessages(next.messageIds, next.messageById, next.messagePartsById)

  const userMessages = messages.filter((m) => m.role === 'user')
  assert.equal(userMessages.length, 1)
  assert.equal(userMessages[0]?.id, 'msg_real_user')
  assert.equal(userMessages[0]?.content, 'explore this dir')
  assert.equal(next.messageById['ses_X:user:live'], undefined)
})

test('real user ids absorb placeholder live user messages so the optimistic prompt is not duplicated', () => {
  const state = createEmptySessionViewState({ hydrated: true })

  // Optimistic user insert from the IPC session:prompt handler.
  Object.assign(state, withMessageText(state, {
    messageId: 'session-1:user:live',
    role: 'user',
    content: 'plan how to refactor X',
    segmentId: 'session-1:user:segment:live',
    replace: true,
  }))

  // Real message.updated from OpenCode carrying the same prompt.
  Object.assign(state, withMessageText(state, {
    messageId: 'msg_real_user',
    role: 'user',
    content: 'plan how to refactor X',
    segmentId: 'msg_real_user:part:0',
    replace: true,
  }))

  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.id, 'msg_real_user')
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.content, 'plan how to refactor X')
  assert.equal(state.messageById['session-1:user:live'], undefined)
})

test('real assistant ids absorb placeholder live messages without leaving duplicates', () => {
  const state = createEmptySessionViewState({ hydrated: true })

  Object.assign(state, withMessageText(state, {
    messageId: 'session-1:assistant:live',
    role: 'assistant',
    content: 'Hello',
    segmentId: 'session-1:segment:live',
  }))

  Object.assign(state, withMessageText(state, {
    messageId: 'msg-1',
    role: 'assistant',
    content: 'Hello world',
    segmentId: 'part-1',
    replace: true,
  }))

  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.id, 'msg-1')
  assert.equal(messages[0]?.content, 'Hello world')
  assert.equal(state.messageById['session-1:assistant:live'], undefined)
})

test('late placeholder patches append into the current real assistant message', () => {
  const state = buildSessionStateFromView({
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello',
        order: 10,
        segments: [{ id: 'part-1', content: 'Hello', order: 11 }],
      },
    ],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: 100,
    isGenerating: true,
    isAwaitingPermission: false,
  })

  const updated = {
    ...state,
    ...withMessageText(state, {
      messageId: 'session-1:assistant:live',
      role: 'assistant',
      content: ' world',
      segmentId: 'session-1:segment:live',
    }),
  }
  const messages = buildMessages(updated.messageIds, updated.messageById, updated.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.id, 'msg-1')
  assert.equal(messages[0]?.content, 'Hello world')
  assert.equal(updated.messageById['session-1:assistant:live'], undefined)
})
