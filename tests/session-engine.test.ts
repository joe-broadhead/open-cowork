import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionEngine } from '../apps/desktop/src/main/session-engine.ts'
import { MAX_WARM_SESSION_DETAILS } from '../apps/desktop/src/lib/session-view-model.ts'

function apply(engine: SessionEngine, sessionId: string, data: Record<string, unknown>) {
  engine.applyStreamEvent({
    type: String(data.type || 'unknown'),
    sessionId,
    data,
  } as any)
}

test('session engine pauses generation for approvals and resumes after approval resolves', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-1'
  engine.activateSession(sessionId)

  apply(engine, sessionId, { type: 'busy' })
  let view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, true)
  assert.equal(view.isAwaitingPermission, false)

  apply(engine, sessionId, {
    type: 'approval',
    id: 'approval-1',
    tool: 'bash',
    input: { cmd: 'pwd' },
    description: 'Allow bash',
  })
  view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, false)
  assert.equal(view.isAwaitingPermission, true)
  assert.equal(view.pendingApprovals.length, 1)
  assert.equal(view.pendingApprovals[0]?.id, 'approval-1')

  apply(engine, sessionId, {
    type: 'approval_resolved',
    id: 'approval-1',
  })
  view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, true)
  assert.equal(view.isAwaitingPermission, false)
  assert.equal(view.pendingApprovals.length, 0)
})

test('session engine clears busy state and marks task runs errored on session errors', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-2'
  engine.activateSession(sessionId)

  apply(engine, sessionId, { type: 'busy' })
  apply(engine, sessionId, {
    type: 'task_run',
    id: 'task-1',
    title: 'Research branch',
    agent: 'researcher',
    status: 'running',
    sourceSessionId: 'child-1',
  })
  apply(engine, sessionId, {
    type: 'error',
    taskRunId: 'task-1',
    message: 'Branch failed',
  })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, false)
  assert.equal(view.errors.at(-1)?.message, 'Branch failed')
  assert.equal(view.taskRuns[0]?.status, 'error')
  assert.equal(view.taskRuns[0]?.error, 'Branch failed')
})

test('session engine exposes non-text task and cost updates through visible session views', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-3'
  engine.activateSession(sessionId)

  apply(engine, sessionId, {
    type: 'task_run',
    id: 'task-1',
    title: 'Analyze docs',
    agent: 'analyst',
    status: 'running',
    sourceSessionId: 'child-2',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-1',
    taskRunId: 'task-1',
    name: 'fetch',
    input: { url: 'https://example.com' },
    status: 'complete',
    output: { ok: true },
  })
  apply(engine, sessionId, {
    type: 'todos',
    taskRunId: 'task-1',
    todos: [{ id: 'todo-1', content: 'Read docs', status: 'in_progress', priority: 'high' }],
  })
  apply(engine, sessionId, {
    type: 'cost',
    taskRunId: 'task-1',
    cost: 0.12,
    tokens: {
      input: 100,
      output: 40,
      reasoning: 10,
      cache: { read: 5, write: 0 },
    },
  })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.taskRuns.length, 1)
  assert.equal(view.taskRuns[0]?.toolCalls.length, 1)
  assert.equal(view.taskRuns[0]?.todos.length, 1)
  assert.equal(view.taskRuns[0]?.sessionCost, 0.12)
  assert.equal(view.sessionCost, 0.12)
  assert.equal(view.sessionTokens.input, 100)
  assert.equal(view.sessionTokens.output, 40)
})

test('session engine dedupes repeated streamed cost updates for the same part', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-3b'
  engine.activateSession(sessionId)

  apply(engine, sessionId, {
    type: 'cost',
    id: 'child-1:message-1:step-finish-1',
    cost: 0.26,
    tokens: {
      input: 1000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })
  apply(engine, sessionId, {
    type: 'cost',
    id: 'child-1:message-1:step-finish-1',
    cost: 0.26,
    tokens: {
      input: 1000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.sessionCost, 0.26)
  assert.equal(view.sessionTokens.input, 1000)
})

test('tool calls and transcript segments share the same sequence space so a sub-agent timeline stays in order', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'session-sub-1'
  const childSessionId = 'child-session-1'
  const taskRunId = 'task-run-1'

  engine.activateSession(rootSessionId)

  apply(engine, rootSessionId, {
    type: 'task_run',
    id: taskRunId,
    title: 'Explore directory',
    agent: 'explore',
    status: 'running',
    sourceSessionId: childSessionId,
  })

  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-1',
    role: 'assistant',
    content: 'First I will read the top-level files.',
    mode: 'replace',
  })

  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-1',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
    taskRunId,
    sourceSessionId: childSessionId,
  })

  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-2',
    role: 'assistant',
    content: 'Now let me check the config.',
    mode: 'replace',
  })

  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-2',
    name: 'read',
    status: 'complete',
    input: { path: 'package.json' },
    taskRunId,
    sourceSessionId: childSessionId,
  })

  const view = engine.getSessionView(rootSessionId)
  const taskRun = view.taskRuns.find((t) => t.id === taskRunId)
  assert.ok(taskRun, 'task run must be present in view')

  const transcript = taskRun!.transcript
  const tool1 = taskRun!.toolCalls.find((t) => t.id === 'tool-1')
  const tool2 = taskRun!.toolCalls.find((t) => t.id === 'tool-2')
  assert.ok(transcript.length >= 2 && tool1 && tool2)
  const seg1 = transcript[0]
  const seg2 = transcript[1]

  // Tool orders used to be nowTs() (milliseconds in the trillions) while
  // segment orders used nextSeq() (single digits), so tools always landed
  // after all text when the TaskRunCard sorted them. After the fix both
  // live in the same monotonic sequence and the alternating input order
  // is preserved after sorting.
  assert.ok(seg1.order < tool1.order, 'seg-1 must sort before tool-1')
  assert.ok(tool1.order < seg2.order, 'tool-1 must sort before seg-2')
  assert.ok(seg2.order < tool2.order, 'seg-2 must sort before tool-2')
})

test('session engine preserves newer streamed state across forced history hydration', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-history-1'
  const historyItems = [{
    id: 'message-1',
    messageId: 'message-1',
    partId: 'message-1:part:0',
    type: 'text',
    role: 'assistant',
    content: 'Persisted reply',
    timestamp: '2026-04-16T09:00:00.000Z',
  }]

  engine.activateSession(sessionId)
  engine.setSessionFromHistory(sessionId, historyItems)

  apply(engine, sessionId, {
    type: 'text',
    messageId: 'message-1',
    partId: 'message-1:part:0',
    role: 'assistant',
    content: 'Live reply',
    mode: 'replace',
    timestamp: '2026-04-16T09:00:05.000Z',
  })

  engine.setSessionFromHistory(sessionId, historyItems, { force: true })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.messages[0]?.content, 'Live reply')
})

test('session engine surfaces pending questions as a first-class waiting state', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-4'
  engine.activateSession(sessionId)

  apply(engine, sessionId, { type: 'busy' })
  apply(engine, sessionId, {
    type: 'question_asked',
    id: 'question-1',
    questions: [{
      header: 'Engineering focus',
      question: 'What kind of engineering work are you doing?',
      options: [
        { label: 'Backend', description: 'APIs and services' },
        { label: 'Frontend', description: 'UI and interactions' },
      ],
    }],
  })

  let view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, false)
  assert.equal(view.isAwaitingQuestion, true)
  assert.equal(view.pendingQuestions.length, 1)
  assert.equal(view.pendingQuestions[0]?.id, 'question-1')

  apply(engine, sessionId, {
    type: 'question_resolved',
    id: 'question-1',
  })

  view = engine.getSessionView(sessionId)
  assert.equal(view.isGenerating, true)
  assert.equal(view.isAwaitingQuestion, false)
  assert.equal(view.pendingQuestions.length, 0)
})

test('session engine caps hydrated sessions at the LRU budget after many activations', () => {
  const engine = new SessionEngine()
  const total = MAX_WARM_SESSION_DETAILS + 5

  for (let index = 0; index < total; index += 1) {
    const sessionId = `warm-${index}`
    engine.setSessionFromHistory(sessionId, [
      {
        id: `evt-${index}`,
        messageId: `msg-${index}`,
        partId: `part-${index}`,
        type: 'text',
        role: 'user',
        content: 'hi',
        timestamp: new Date(2026, 3, 17, 10, index).toISOString(),
      },
    ])
    engine.activateSession(sessionId)
  }

  let hydrated = 0
  for (let index = 0; index < total; index += 1) {
    if (engine.isHydrated(`warm-${index}`)) hydrated += 1
  }
  // Budget tolerance: MAX warm + the currently active session. Any more and
  // the LRU prune pass did not run, which would leak memory under normal
  // sidebar-driven session churn.
  assert.ok(
    hydrated <= MAX_WARM_SESSION_DETAILS + 1,
    `expected at most ${MAX_WARM_SESSION_DETAILS + 1} hydrated sessions, got ${hydrated}`,
  )
})

test('session engine memoizes getSessionView until the state changes', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-cache-1'
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      role: 'assistant',
      content: 'Hello',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  } as any)

  const first = engine.getSessionView(sessionId)
  const second = engine.getSessionView(sessionId)
  // Identity equality is the contract — renderer relies on it to avoid
  // reconciling a stable session view on every idle tick.
  assert.strictEqual(first, second, 'unchanged state must return the cached view')

  engine.applyStreamEvent({
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      role: 'assistant',
      content: ' world',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  } as any)
  const third = engine.getSessionView(sessionId)
  assert.notStrictEqual(third, second, 'a projector revision bump must rebuild the view')
  assert.equal(third.messages[0]?.content, 'Hello world')
})

test('session engine view cache invalidates when busy toggles without a revision bump', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-cache-busy'
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      role: 'assistant',
      content: 'hi',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  } as any)

  const idleView = engine.getSessionView(sessionId)
  assert.equal(idleView.isGenerating, false)

  engine.applyStreamEvent({ type: 'busy', sessionId, data: { type: 'busy' } } as any)
  const busyView = engine.getSessionView(sessionId)
  assert.equal(busyView.isGenerating, true)
  assert.notStrictEqual(busyView, idleView, 'busy flag is part of the cache key')
})

test('session engine removeSession evicts view cache and cost dedup memory', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-remove-1'
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      role: 'assistant',
      content: 'hi',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  } as any)
  assert.equal(engine.getSessionView(sessionId).messages.length, 1)

  engine.removeSession(sessionId)
  const fresh = engine.getSessionView(sessionId)
  assert.equal(fresh.messages.length, 0)
  assert.equal(engine.isHydrated(sessionId), false)
})

test('session engine session meta tracks revision progress independently of view materialization', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-meta-1'
  engine.activateSession(sessionId)

  const before = engine.getSessionMeta(sessionId)
  engine.applyStreamEvent({
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      role: 'assistant',
      content: 'hi',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  } as any)
  const after = engine.getSessionMeta(sessionId)

  assert.ok(after.revision > before.revision, 'revision must bump on applied events')
  assert.ok(after.lastEventAt >= before.lastEventAt, 'lastEventAt must not regress')
})

test('session engine keeps waiting when one of multiple approvals resolves', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-5'
  engine.activateSession(sessionId)

  apply(engine, sessionId, { type: 'busy' })
  apply(engine, sessionId, {
    type: 'approval',
    id: 'approval-a',
    tool: 'bash',
    input: { cmd: 'pwd' },
    description: 'Allow bash',
  })
  apply(engine, sessionId, {
    type: 'approval',
    id: 'approval-b',
    tool: 'write',
    input: { path: '/tmp/file.txt' },
    description: 'Allow write',
  })

  let view = engine.getSessionView(sessionId)
  assert.equal(view.isAwaitingPermission, true)
  assert.equal(view.pendingApprovals.length, 2)

  apply(engine, sessionId, {
    type: 'approval_resolved',
    id: 'approval-a',
  })

  view = engine.getSessionView(sessionId)
  assert.equal(view.isAwaitingPermission, true)
  assert.equal(view.pendingApprovals.length, 1)
  assert.equal(view.pendingApprovals[0]?.id, 'approval-b')
})
