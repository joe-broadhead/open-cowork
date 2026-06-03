import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SEEN_COST_EVENT_IDS_PER_SESSION, SessionEngine } from '../apps/desktop/src/main/session-engine.ts'
import { MAX_WARM_SESSION_DETAILS } from '../apps/desktop/src/lib/session-view-model.ts'
import { resetSessionScopedFallbackIdsForTests } from '../apps/desktop/src/main/runtime-fallback-ids.ts'

function apply(engine: SessionEngine, sessionId: string, data: Record<string, unknown>) {
  engine.applyStreamEvent({
    type: String(data.type || 'unknown'),
    sessionId,
    data,
  } as any)
}

const SNAPSHOT_DYNAMIC_KEYS = new Set(['finishedAt', 'lastEventAt', 'order', 'revision', 'startedAt', 'timestamp'])

function stableSessionSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSessionSnapshot)
  if (!value || typeof value !== 'object') return value

  const next: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    next[key] = SNAPSHOT_DYNAMIC_KEYS.has(key)
      ? `<${key}>`
      : stableSessionSnapshot((value as Record<string, unknown>)[key])
  }
  return next
}

test('SessionView shape matches snapshot', () => {
  const engine = new SessionEngine()
  const sessionId = 'snapshot-session'
  engine.activateSession(sessionId)

  apply(engine, sessionId, { type: 'busy' })
  apply(engine, sessionId, {
    type: 'text',
    role: 'user',
    messageId: 'msg-user',
    partId: 'msg-user:part:0',
    content: 'Please inspect the repo.',
    mode: 'replace',
  })
  apply(engine, sessionId, {
    type: 'text',
    role: 'assistant',
    messageId: 'msg-assistant',
    partId: 'msg-assistant:part:0',
    content: 'I will delegate a focused read.',
    mode: 'replace',
  })
  apply(engine, sessionId, {
    type: 'task_run',
    id: 'task-explore',
    title: 'Inspect runtime wiring',
    agent: 'explore',
    status: 'running',
    sourceSessionId: 'child-explore',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-read',
    taskRunId: 'task-explore',
    name: 'read',
    status: 'complete',
    input: { path: 'apps/desktop/src/main/runtime.ts' },
    output: { ok: true },
    sourceSessionId: 'child-explore',
  })
  apply(engine, sessionId, {
    type: 'todos',
    taskRunId: 'task-explore',
    todos: [{ id: 'todo-1', content: 'Check auth isolation', status: 'completed', priority: 'high' }],
  })
  apply(engine, sessionId, {
    type: 'cost',
    id: 'cost-1',
    taskRunId: 'task-explore',
    cost: 0.42,
    tokens: {
      input: 1200,
      output: 320,
      reasoning: 40,
      cache: { read: 100, write: 20 },
    },
  })
  apply(engine, sessionId, { type: 'done' })

  const actual = `${JSON.stringify(stableSessionSnapshot(engine.getSessionView(sessionId)), null, 2)}\n`
  const expected = readFileSync(join(process.cwd(), 'tests/__snapshots__/session-engine-view.json'), 'utf-8')
  assert.equal(actual, expected)
})

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

test('session engine assigns stable increasing order to live task runs', () => {
  const engine = new SessionEngine({ nowMs: () => 1_700_000_000_000 })
  const sessionId = 'session-task-order'
  engine.activateSession(sessionId)

  apply(engine, sessionId, {
    type: 'task_run',
    id: 'task-a',
    title: 'First branch',
    agent: 'explore',
    status: 'running',
  })
  apply(engine, sessionId, {
    type: 'task_run',
    id: 'task-b',
    title: 'Second branch',
    agent: 'general',
    status: 'running',
  })

  const view = engine.getSessionView(sessionId)
  assert.deepEqual(view.taskRuns.map((taskRun) => taskRun.id), ['task-a', 'task-b'])
  assert.equal(view.taskRuns[0]!.order < view.taskRuns[1]!.order, true)
})

test('session engine hydrates pending approvals and preserves waiting state across reopen', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-hydrated-approval'
  engine.activateSession(sessionId)

  engine.setPendingApprovals(sessionId, [{
    id: 'approval-hydrated',
    sessionId,
    taskRunId: 'child:child-1',
    tool: 'write',
    input: { path: 'notes.md' },
    description: 'Sub-Agent: write',
  }])

  let view = engine.getSessionView(sessionId)
  assert.equal(view.isAwaitingPermission, true)
  assert.equal(view.pendingApprovals.length, 1)
  assert.equal(view.pendingApprovals[0]?.id, 'approval-hydrated')

  engine.setPendingApprovals(sessionId, [])

  view = engine.getSessionView(sessionId)
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

test('session engine defensively copies SDK tool payloads', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-tool-copy'
  const input = { nested: { path: 'before.md' } }
  const output = { result: { ok: true } }

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-copy',
    name: 'read',
    input,
    status: 'complete',
    output,
  })

  input.nested.path = 'after.md'
  output.result.ok = false

  const tool = engine.getSessionView(sessionId).toolCalls[0]
  assert.deepEqual(tool?.input, { nested: { path: 'before.md' } })
  assert.deepEqual(tool?.output, { result: { ok: true } })
})

test('session engine fallback tool ids do not collide within one session', () => {
  resetSessionScopedFallbackIdsForTests()
  const engine = new SessionEngine({ nowMs: () => 1_700_000_000_000 })
  const sessionId = 'session-tool-fallback'

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'tool_call',
    name: 'read',
    status: 'running',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    name: 'write',
    status: 'running',
  })

  const ids = engine.getSessionView(sessionId).toolCalls.map((tool) => tool.id)
  assert.deepEqual(ids, [
    'session-tool-fallback:tool:fallback:1',
    'session-tool-fallback:tool:fallback:2',
  ])
})

test('session engine accepts deterministic id and clock dependencies for action-owned fields', () => {
  let idIndex = 0
  const engine = new SessionEngine({
    generateId: () => `generated-${++idIndex}`,
    nowIso: () => '2026-05-14T10:00:00.000Z',
  })
  const sessionId = 'session-deterministic'

  engine.activateSession(sessionId)
  apply(engine, sessionId, { type: 'error', message: 'failed' })
  apply(engine, sessionId, { type: 'compacted' })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.errors[0]?.id, 'generated-1')
  assert.equal(view.compactions[0]?.id, 'generated-2')
  assert.equal(view.lastCompactedAt, '2026-05-14T10:00:00.000Z')
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

test('session engine bounds remembered streamed cost event ids per session', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-cost-cap'
  engine.activateSession(sessionId)

  for (let index = 0; index <= MAX_SEEN_COST_EVENT_IDS_PER_SESSION; index += 1) {
    apply(engine, sessionId, {
      type: 'cost',
      id: `cost-${index}`,
      cost: 1,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
  }

  assert.equal(engine.getSessionView(sessionId).sessionCost, MAX_SEEN_COST_EVENT_IDS_PER_SESSION + 1)

  apply(engine, sessionId, {
    type: 'cost',
    id: 'cost-0',
    cost: 1,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })
  apply(engine, sessionId, {
    type: 'cost',
    id: `cost-${MAX_SEEN_COST_EVENT_IDS_PER_SESSION}`,
    cost: 1,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })

  const view = engine.getSessionView(sessionId)
  assert.equal(view.sessionCost, MAX_SEEN_COST_EVENT_IDS_PER_SESSION + 2)
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

test('streaming text after a task tool call is split into a later transcript segment', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'session-sub-split'
  const childSessionId = 'child-session-split'
  const taskRunId = 'task-run-split'

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
    partId: 'seg-live',
    role: 'assistant',
    content: 'I will inspect the repo.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
    taskRunId,
    sourceSessionId: childSessionId,
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'The README confirms the setup.',
    mode: 'append',
  })

  const taskRun = engine.getSessionView(rootSessionId).taskRuns.find((task) => task.id === taskRunId)
  assert.ok(taskRun)
  assert.equal(taskRun.transcript.length, 2)
  const tool = taskRun.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(tool)
  assert.ok(taskRun.transcript[0]!.order < tool.order)
  assert.ok(tool.order < taskRun.transcript[1]!.order)
})

test('final task text replacement reconciles split transcript segments without duplication', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'session-sub-split-replace'
  const childSessionId = 'child-session-split-replace'
  const taskRunId = 'task-run-split-replace'

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
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
    taskRunId,
    sourceSessionId: childSessionId,
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.After tool.',
    mode: 'replace',
  })

  const taskRun = engine.getSessionView(rootSessionId).taskRuns.find((task) => task.id === taskRunId)
  const tool = taskRun?.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(taskRun)
  assert.ok(tool)
  assert.equal(taskRun.transcript.length, 2)
  assert.equal(taskRun.transcript[0]?.content, 'Before tool.')
  assert.equal(taskRun.transcript[1]?.content, 'After tool.')
  assert.ok(taskRun.transcript[0]!.order < tool.order)
  assert.ok(tool.order < taskRun.transcript[1]!.order)
})

test('final task text replacement applies authoritative text when split prefix changes', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'session-sub-split-prefix-replace'
  const childSessionId = 'child-session-split-prefix-replace'
  const taskRunId = 'task-run-split-prefix-replace'

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
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
    taskRunId,
    sourceSessionId: childSessionId,
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool!After tool.',
    mode: 'replace',
  })

  const taskRun = engine.getSessionView(rootSessionId).taskRuns.find((task) => task.id === taskRunId)
  const tool = taskRun?.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(taskRun)
  assert.ok(tool)
  assert.equal(taskRun.transcript.length, 2)
  assert.equal(taskRun.transcript[0]?.content, 'Before tool!')
  assert.equal(taskRun.transcript[1]?.content, 'After tool.')
  assert.ok(taskRun.transcript[0]!.order < tool.order)
  assert.ok(tool.order < taskRun.transcript[1]!.order)
})

test('final task text replacement preserves post-tool segment when earlier text shortens', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'session-sub-split-short-prefix'
  const childSessionId = 'child-session-split-short-prefix'
  const taskRunId = 'task-run-split-short-prefix'

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
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
    taskRunId,
    sourceSessionId: childSessionId,
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, rootSessionId, {
    type: 'text',
    taskRunId,
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before After tool.',
    mode: 'replace',
  })

  const taskRun = engine.getSessionView(rootSessionId).taskRuns.find((task) => task.id === taskRunId)
  const tool = taskRun?.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(taskRun)
  assert.ok(tool)
  assert.equal(taskRun.transcript.length, 2)
  assert.equal(taskRun.transcript[0]?.content, 'Before ')
  assert.equal(taskRun.transcript[1]?.content, 'After tool.')
  assert.ok(taskRun.transcript[0]!.order < tool.order)
  assert.ok(tool.order < taskRun.transcript[1]!.order)
})

test('streaming root text after a root tool call is split into a later message segment', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-root-split'

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'I will inspect the repo.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'The README confirms the setup.',
    mode: 'append',
  })

  const view = engine.getSessionView(sessionId)
  const message = view.messages.find((entry) => entry.id === 'msg-live')
  const tool = view.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(message?.segments)
  assert.ok(tool)
  assert.equal(message.segments.length, 2)
  assert.ok(message.segments[0]!.order < tool.order)
  assert.ok(tool.order < message.segments[1]!.order)
})

test('final root text replacement reconciles split message segments without duplication', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-root-split-replace'

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.After tool.',
    mode: 'replace',
  })

  const view = engine.getSessionView(sessionId)
  const message = view.messages.find((entry) => entry.id === 'msg-live')
  const tool = view.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(message?.segments)
  assert.ok(tool)
  assert.equal(message.segments.length, 2)
  assert.equal(message.segments[0]?.content, 'Before tool.')
  assert.equal(message.segments[1]?.content, 'After tool.')
  assert.ok(message.segments[0]!.order < tool.order)
  assert.ok(tool.order < message.segments[1]!.order)
})

test('final root text replacement applies authoritative text when split prefix changes', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-root-split-prefix-replace'

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool!After tool.',
    mode: 'replace',
  })

  const view = engine.getSessionView(sessionId)
  const message = view.messages.find((entry) => entry.id === 'msg-live')
  const tool = view.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(message?.segments)
  assert.ok(tool)
  assert.equal(message.segments.length, 2)
  assert.equal(message.segments[0]?.content, 'Before tool!')
  assert.equal(message.segments[1]?.content, 'After tool.')
  assert.ok(message.segments[0]!.order < tool.order)
  assert.ok(tool.order < message.segments[1]!.order)
})

test('final root text replacement preserves post-tool segment when earlier text shortens', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-root-split-short-prefix'

  engine.activateSession(sessionId)
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'tool_call',
    id: 'tool-live',
    name: 'read',
    status: 'complete',
    input: { path: 'README.md' },
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'After tool.',
    mode: 'append',
  })
  apply(engine, sessionId, {
    type: 'text',
    messageId: 'msg-live',
    partId: 'seg-live',
    role: 'assistant',
    content: 'Before After tool.',
    mode: 'replace',
  })

  const view = engine.getSessionView(sessionId)
  const message = view.messages.find((entry) => entry.id === 'msg-live')
  const tool = view.toolCalls.find((entry) => entry.id === 'tool-live')
  assert.ok(message?.segments)
  assert.ok(tool)
  assert.equal(message.segments.length, 2)
  assert.equal(message.segments[0]?.content, 'Before ')
  assert.equal(message.segments[1]?.content, 'After tool.')
  assert.ok(message.segments[0]!.order < tool.order)
  assert.ok(tool.order < message.segments[1]!.order)
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

test('session engine preserves global history sequence when hydrating messages and task runs', () => {
  const engine = new SessionEngine()
  const sessionId = 'session-history-order'

  engine.setSessionFromHistory(sessionId, [
    {
      id: 'launch-message',
      messageId: 'launch-message',
      partId: 'launch-text',
      type: 'message',
      role: 'assistant',
      content: 'I will delegate this.',
      timestamp: '2026-05-18T13:42:10.000Z',
      sequence: 1,
    },
    {
      id: 'child:analyst-child',
      type: 'task_run',
      timestamp: '2026-05-18T13:42:12.000Z',
      sequence: 2,
      taskRun: {
        title: 'UK website traffic and conversion analysis',
        agent: 'business-analyst',
        status: 'complete',
        sourceSessionId: 'analyst-child',
      },
    },
    {
      id: 'final-message',
      messageId: 'final-message',
      partId: 'final-text',
      type: 'message',
      role: 'assistant',
      content: 'The analyst finished the work.',
      timestamp: '2026-05-18T13:46:48.000Z',
      sequence: 3,
    },
  ])

  const view = engine.getSessionView(sessionId)
  const launch = view.messages.find((message) => message.id === 'launch-message')
  const final = view.messages.find((message) => message.id === 'final-message')
  const taskRun = view.taskRuns.find((task) => task.id === 'child:analyst-child')

  assert.ok(launch?.segments?.[0])
  assert.ok(final?.segments?.[0])
  assert.ok(taskRun)
  assert.ok(launch.segments[0].order < taskRun.order)
  assert.ok(taskRun.order < final.segments[0].order)
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

test('session engine keeps ten concurrent subagent branches inspectable through final synthesis', () => {
  const engine = new SessionEngine()
  const rootSessionId = 'task-substrate-root'
  engine.activateSession(rootSessionId)
  apply(engine, rootSessionId, { type: 'busy' })

  for (let index = 0; index < 10; index += 1) {
    const taskRunId = `branch-${index}`
    const childSessionId = `child-${index}`
    apply(engine, rootSessionId, {
      type: 'task_run',
      id: taskRunId,
      title: `Specialist branch ${index}`,
      agent: `specialist-${index}`,
      status: 'running',
      sourceSessionId: childSessionId,
    })
    apply(engine, rootSessionId, {
      type: 'text',
      taskRunId,
      partId: `${taskRunId}:summary`,
      role: 'assistant',
      content: `Finding from branch ${index}`,
      mode: 'replace',
    })
    apply(engine, rootSessionId, {
      type: 'tool_call',
      id: `${taskRunId}:tool`,
      taskRunId,
      name: 'read',
      input: { path: `branch-${index}.md` },
      status: 'complete',
      output: { ok: true },
      sourceSessionId: childSessionId,
    })
  }

  let view = engine.getSessionView(rootSessionId)
  assert.equal(view.taskRuns.length, 10)
  assert.equal(view.isGenerating, true)
  assert.equal(view.executionPlan.at(-1)?.status, 'pending')

  for (let index = 0; index < 10; index += 1) {
    const taskRun = view.taskRuns[index]
    assert.equal(taskRun?.id, `branch-${index}`)
    assert.equal(taskRun?.status, 'running')
    assert.equal(taskRun?.sourceSessionId, `child-${index}`)
    assert.equal(taskRun?.content, `Finding from branch ${index}`)
    assert.equal(taskRun?.toolCalls.length, 1)
    assert.equal(taskRun?.toolCalls[0]?.id, `branch-${index}:tool`)
  }

  for (let index = 0; index < 10; index += 1) {
    apply(engine, rootSessionId, {
      type: 'task_run',
      id: `branch-${index}`,
      status: 'complete',
      sourceSessionId: `child-${index}`,
    })
  }

  view = engine.getSessionView(rootSessionId)
  assert.equal(view.taskRuns.every((taskRun) => taskRun.status === 'complete'), true)
  assert.equal(view.isGenerating, true)
  assert.equal(view.executionPlan.at(-1)?.status, 'in_progress')

  apply(engine, rootSessionId, {
    type: 'text',
    messageId: 'root-final',
    partId: 'root-final:part',
    role: 'assistant',
    content: 'Synthesis complete.',
    mode: 'replace',
  })
  apply(engine, rootSessionId, { type: 'done' })

  view = engine.getSessionView(rootSessionId)
  assert.equal(view.isGenerating, false)
  assert.equal(view.executionPlan.at(-1)?.status, 'completed')
  assert.equal(view.messages.at(-1)?.content, 'Synthesis complete.')
  assert.equal(view.taskRuns.length, 10)
  assert.equal(view.taskRuns.every((taskRun) => taskRun.content.startsWith('Finding from branch')), true)
})

test('session engine isolates twenty active streaming sessions without status bleed', () => {
  const engine = new SessionEngine()
  const sessionIds = Array.from({ length: 20 }, (_, index) => `active-session-${index}`)

  for (const [index, sessionId] of sessionIds.entries()) {
    engine.activateSession(sessionId)
    apply(engine, sessionId, { type: 'busy' })
    apply(engine, sessionId, {
      type: 'text',
      messageId: `message-${index}`,
      partId: `message-${index}:part`,
      role: 'assistant',
      content: `Streaming reply ${index}`,
      mode: 'replace',
    })
  }

  apply(engine, sessionIds[4]!, {
    type: 'approval',
    id: 'approval-active-4',
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Active session 4 approval',
  })
  apply(engine, sessionIds[9]!, {
    type: 'question_asked',
    id: 'question-active-9',
    questions: [{
      header: 'Need context',
      question: 'Which target should this use?',
      options: [{ label: 'Default', description: 'Use default target' }],
    }],
  })

  for (const [index, sessionId] of sessionIds.entries()) {
    const view = engine.getSessionView(sessionId)
    assert.equal(view.messages.length, 1)
    assert.equal(view.messages[0]?.content, `Streaming reply ${index}`)
    assert.equal(view.messages[0]?.id, `message-${index}`)
    assert.equal(view.taskRuns.length, 0)
    assert.equal(view.isAwaitingPermission, index === 4)
    assert.equal(view.isAwaitingQuestion, index === 9)
    assert.equal(view.isGenerating, index !== 4 && index !== 9)
  }

  for (const [index, sessionId] of sessionIds.entries()) {
    if (index % 2 === 0) {
      apply(engine, sessionId, { type: 'done' })
    }
  }

  for (const [index, sessionId] of sessionIds.entries()) {
    const view = engine.getSessionView(sessionId)
    if (index % 2 === 0) {
      assert.equal(view.isGenerating, false)
      assert.equal(view.isAwaitingPermission, false)
    } else {
      assert.equal(view.isGenerating, index !== 9)
      assert.equal(view.isAwaitingQuestion, index === 9)
    }
    assert.equal(view.messages[0]?.content, `Streaming reply ${index}`)
  }
})
