import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionEngine } from '../apps/desktop/src/main/session-engine.ts'

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
