import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLOUD_PROJECTED_SESSION_EVENT_TYPES,
  CLOUD_AUTOMATION_EVENT_STREAM_VERSION,
  CLOUD_PROJECTION_SYNC_CONTRACT_VERSION,
  CLOUD_SESSION_EVENT_CONTRACT,
  CLOUD_SESSION_EVENT_TYPES,
  CLOUD_SESSION_PROJECTION_CONTRACT_VERSION,
  cloudProjectionFenceIdentityKey,
  cloudProjectionFenceObserved,
  cloudSessionEventContractFor,
  cloudSessionEventHasFacet,
  cloudSessionViewToSessionView,
  createCloudAutomationEventEnvelope,
  createCloudAutomationTerminalStatusRecord,
  createCloudProjectionCheckpoint,
  createCloudProjectionFenceToken,
  createCloudSessionProjectionView,
  emptySessionView,
  evaluateCloudProjectionFenceCheckpoint,
  formatCloudAutomationTerminalStatusLine,
  normalizeCloudSessionProjectionView,
  parseCloudAutomationTerminalStatusLine,
  readCloudSessionProjection,
  reduceCloudSessionProjectionEvent,
  waitForCloudProjectionFence,
} from '../packages/shared/dist/cloud-session-projection.js'

function baseSession(overrides = {}) {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    profileName: 'default',
    status: 'idle' as const,
    title: 'Shared projection',
    updatedAt: '2026-05-28T10:00:00.000Z',
    ...overrides,
  }
}

function event(sequence: number, type: string, payload: Record<string, unknown> = {}) {
  return {
    sequence,
    type,
    payload,
    createdAt: `2026-05-28T10:${String(sequence).padStart(2, '0')}:00.000Z`,
  }
}

function minimalPayloadFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'session.created':
      return { title: 'Contract session' }
    case 'session.imported':
      return {
        sourceFingerprint: 'sha256:source',
        importedAt: '2026-05-28T10:00:00.000Z',
        itemCounts: { messages: 1 },
      }
    case 'session.project_source.bound':
      return { projectSource: { kind: 'snapshot', snapshotId: 'snapshot-1' } }
    case 'prompt.submitted':
      return { messageId: 'user-1', text: 'run checks' }
    case 'assistant.message':
      return { messageId: 'assistant-1', content: 'ok' }
    case 'tool.call':
      return { id: 'tool-1', name: 'bash', status: 'running' }
    case 'task.run':
      return { id: 'task-1', title: 'Task', status: 'running' }
    case 'permission.requested':
      return { permissionId: 'permission-1', tool: 'bash', description: 'Approve' }
    case 'permission.resolved':
      return { permissionId: 'permission-1', allowed: true }
    case 'question.asked':
      return { requestId: 'question-1', questions: [{ question: 'Continue?' }] }
    case 'question.resolved':
      return { requestId: 'question-1', answers: ['Yes'] }
    case 'todos.updated':
      return { todos: [{ id: 'todo-1', content: 'Ship it' }] }
    case 'cost.updated':
      return { cost: 0.01, tokens: { input: 1, output: 2 } }
    case 'artifact.created':
      return { artifactId: 'artifact-1', filename: 'result.txt' }
    case 'session.status':
      return { statusType: 'running' }
    case 'runtime.error':
      return { message: 'Runtime failed' }
    default:
      return {}
  }
}

test('cloud session event vocabulary is versioned and reducer-backed', () => {
  assert.equal(CLOUD_SESSION_PROJECTION_CONTRACT_VERSION, 1)
  assert.deepEqual(CLOUD_SESSION_EVENT_CONTRACT.map((entry) => entry.type), [...CLOUD_SESSION_EVENT_TYPES])
  assert.deepEqual(
    CLOUD_SESSION_EVENT_CONTRACT.filter((entry) => entry.projected).map((entry) => entry.type),
    [...CLOUD_PROJECTED_SESSION_EVENT_TYPES],
  )

  for (const entry of CLOUD_SESSION_EVENT_CONTRACT) {
    assert.equal(entry.description.length > 0, true, `${entry.type} must be documented`)
    assert.equal(entry.facets.length > 0, true, `${entry.type} must declare projection facets`)
    assert.equal(entry.consumers.length > 0, true, `${entry.type} must declare consumers`)
    assert.equal(entry.producers.length > 0, true, `${entry.type} must declare producers`)
    assert.deepEqual(cloudSessionEventContractFor(entry.type), entry)
  }

  const session = baseSession()
  for (const type of CLOUD_PROJECTED_SESSION_EVENT_TYPES) {
    const reduced = reduceCloudSessionProjectionEvent(
      session,
      createCloudSessionProjectionView(session),
      event(1, type, minimalPayloadFor(type)),
    )
    assert.equal(reduced.updatedAt, '2026-05-28T10:01:00.000Z', `${type} must be handled by the shared reducer`)
  }

  assert.equal(cloudSessionEventHasFacet('permission.requested', 'approvals'), true)
  assert.equal(cloudSessionEventHasFacet('question.asked', 'questions'), true)
  assert.equal(cloudSessionEventHasFacet('artifact.created', 'artifacts'), true)
  assert.equal(cloudSessionEventHasFacet('assistant.message', 'messages'), true)
  assert.equal(cloudSessionEventHasFacet('snapshot.required', 'control'), true)
})

test('projection sync contract uses exact identities for fences and checkpoints', () => {
  assert.equal(CLOUD_PROJECTION_SYNC_CONTRACT_VERSION, 1)
  assert.equal(CLOUD_AUTOMATION_EVENT_STREAM_VERSION, 1)

  const fence = createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    commandId: 'command-1',
    sequence: 42,
    projectionVersion: 42,
    issuedAt: '2026-05-28T10:01:00.000Z',
  })
  const staleCheckpoint = createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 41,
    projectionVersion: 41,
    updatedAt: '2026-05-28T10:01:01.000Z',
  })
  const observedCheckpoint = createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 42,
    projectionVersion: 43,
    updatedAt: '2026-05-28T10:01:02.000Z',
  })

  assert.equal(fence.version, 1)
  assert.equal(cloudProjectionFenceIdentityKey(fence), 'session:tenant-1:session-1')
  assert.equal(cloudProjectionFenceObserved(fence, staleCheckpoint), false)
  assert.equal(cloudProjectionFenceObserved(fence, observedCheckpoint), true)

  assert.throws(() => createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session*',
    sequence: 1,
  }), /canonical identifier/)
  assert.throws(() => createCloudProjectionFenceToken({
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    sequence: 1,
  }), /runId is required/)
  assert.throws(() => createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: undefined as unknown as number,
    projectionVersion: 1,
    updatedAt: '2026-05-28T10:01:03.000Z',
  }), /sequence is required/)
})

test('projection fences expose actionable wait states and timeout codes', async () => {
  const fence = createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 3,
    projectionVersion: 3,
    issuedAt: '2026-05-28T10:01:00.000Z',
  })
  const staleCheckpoint = createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 2,
    projectionVersion: 2,
    updatedAt: '2026-05-28T10:01:01.000Z',
  })
  const observedCheckpoint = createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 3,
    projectionVersion: 3,
    updatedAt: '2026-05-28T10:01:02.000Z',
  })

  assert.deepEqual(
    evaluateCloudProjectionFenceCheckpoint({ fence, checkpoint: null }).code,
    'projection_fence_checkpoint_missing',
  )
  assert.deepEqual(
    evaluateCloudProjectionFenceCheckpoint({ fence, checkpoint: staleCheckpoint }).code,
    'projection_fence_stale',
  )
  assert.deepEqual(
    evaluateCloudProjectionFenceCheckpoint({ fence, checkpoint: observedCheckpoint }).code,
    'projection_fence_observed',
  )

  let attempts = 0
  let nowMs = 0
  const observed = await waitForCloudProjectionFence({
    fence,
    timeoutMs: 30,
    intervalMs: 10,
    nowMs: () => nowMs,
    sleep: async (duration) => {
      nowMs += duration
    },
    readCheckpoint: async () => {
      attempts += 1
      return attempts >= 2 ? observedCheckpoint : staleCheckpoint
    },
  })
  assert.equal(observed.ok, true)
  assert.equal(observed.code, 'projection_fence_observed')
  assert.equal(attempts, 2)

  attempts = 0
  nowMs = 0
  const timedOut = await waitForCloudProjectionFence({
    fence,
    timeoutMs: 10,
    intervalMs: 10,
    nowMs: () => nowMs,
    sleep: async (duration) => {
      nowMs += duration
    },
    readCheckpoint: async () => {
      attempts += 1
      return staleCheckpoint
    },
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'projection_fence_timeout')
  assert.equal(timedOut.error.retryable, true)

  const expired = evaluateCloudProjectionFenceCheckpoint({
    fence: createCloudProjectionFenceToken({
      scope: 'session',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sequence: 3,
      expiresAt: '2026-05-28T10:01:00.000Z',
    }),
    checkpoint: staleCheckpoint,
    nowMs: Date.parse('2026-05-28T10:01:01.000Z'),
  })
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'projection_fence_expired')
  assert.equal(expired.error.retryable, false)
})

test('automation event envelopes are versioned and fence-bound', () => {
  const fence = createCloudProjectionFenceToken({
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    projectionVersion: 7,
    issuedAt: '2026-05-28T10:02:00.000Z',
  })
  const envelope = createCloudAutomationEventEnvelope({
    eventId: 'event-1',
    type: 'workflow.run.completed',
    source: 'workflow',
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sequence: 8,
    projectionVersion: 8,
    fence,
    payload: { status: 'complete' },
    createdAt: '2026-05-28T10:02:01.000Z',
  })

  assert.equal(envelope.version, 1)
  assert.equal(envelope.fence?.projectionVersion, 7)
  assert.deepEqual(envelope.payload, { status: 'complete' })

  assert.throws(() => createCloudAutomationEventEnvelope({
    eventId: 'event-2',
    type: 'workflow.run.completed',
    source: 'workflow',
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-2',
    sequence: 8,
    fence,
    payload: {},
  }), /fence identity/)
})

test('automation terminal status lines are structured JSON and parseable by consumers', () => {
  const envelope = createCloudAutomationEventEnvelope({
    eventId: 'event-1',
    type: 'workflow.run.completed',
    source: 'workflow',
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sequence: 8,
    payload: { status: 'complete' },
    createdAt: '2026-05-28T10:02:01.000Z',
  })
  const record = createCloudAutomationTerminalStatusRecord(envelope, '2026-05-28T10:02:02.000Z')
  const line = formatCloudAutomationTerminalStatusLine(envelope, '2026-05-28T10:02:02.000Z')
  const parsed = parseCloudAutomationTerminalStatusLine(line)

  assert.equal(record.kind, 'open-cowork.automation.event')
  assert.equal(parsed?.kind, 'open-cowork.automation.event')
  assert.equal(parsed?.event.eventId, 'event-1')
  assert.equal(parsed?.redacted, true)
  assert.equal(parseCloudAutomationTerminalStatusLine('not json'), null)
})

test('shared cloud projection reducer feeds desktop SessionView contract', () => {
  const session = baseSession()
  let view = createCloudSessionProjectionView(session)
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 1,
    type: 'prompt.submitted',
    payload: { messageId: 'user-1', text: 'run checks' },
    createdAt: '2026-05-28T10:01:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 2,
    type: 'tool.call',
    payload: {
      id: 'tool-1',
      name: 'bash',
      input: { command: 'pnpm test' },
      status: 'running',
    },
    createdAt: '2026-05-28T10:02:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 3,
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      tool: 'bash',
      input: { command: 'pnpm test' },
      description: 'Run tests',
    },
    createdAt: '2026-05-28T10:03:00.000Z',
  })
  view = reduceCloudSessionProjectionEvent(session, view, {
    sequence: 4,
    type: 'assistant.message',
    payload: { messageId: 'assistant-1', content: 'Waiting for approval.' },
    createdAt: '2026-05-28T10:04:00.000Z',
  })

  const sessionView = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      sequence: 4,
      view,
      updatedAt: '2026-05-28T10:04:00.000Z',
    },
  })

  assert.deepEqual(sessionView.messages.map((message) => message.content), [
    'run checks',
    'Waiting for approval.',
  ])
  assert.equal(sessionView.toolCalls[0]?.name, 'bash')
  assert.equal(sessionView.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(sessionView.isAwaitingPermission, true)
  assert.equal(sessionView.isGenerating, false)
})

test('assistant message events update existing streamed content by message id', () => {
  const session = baseSession()
  let view = createCloudSessionProjectionView(session)
  view = reduceCloudSessionProjectionEvent(session, view, event(1, 'assistant.message', {
    messageId: 'assistant-stream-1',
    content: 'Hel',
  }))
  view = reduceCloudSessionProjectionEvent(session, view, event(2, 'assistant.message', {
    messageId: 'assistant-stream-1',
    content: 'Hello',
  }))

  assert.equal(view.messages.length, 1)
  assert.equal(view.messages[0]?.content, 'Hello')
  assert.equal(view.messages[0]?.createdAt, '2026-05-28T10:02:00.000Z')

  const sessionView = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      sequence: 2,
      view,
      updatedAt: '2026-05-28T10:02:00.000Z',
    },
  })
  assert.deepEqual(sessionView.messages.map((message) => message.content), ['Hello'])
})

test('cloud projection reducer covers durable runtime event state transitions', () => {
  const session = baseSession({ status: 'running' as const })
  let view = createCloudSessionProjectionView(session)

  view = reduceCloudSessionProjectionEvent(session, view, event(1, 'session.created', { title: 'Runtime session' }))
  assert.equal(view.title, 'Runtime session')
  assert.equal(view.status, 'idle')

  view = reduceCloudSessionProjectionEvent(session, view, event(2, 'tool.call', {
    id: 'tool-root',
    name: 'bash',
    input: { command: 'pwd' },
    status: 'complete',
    output: 'ok',
  }))
  view = reduceCloudSessionProjectionEvent(session, view, event(3, 'tool.call', {
    id: 'tool-child',
    taskRunId: 'task-1',
    name: 'read',
    input: { path: 'README.md' },
    status: 'running',
  }))
  assert.equal(view.toolCalls[0]?.status, 'complete')
  assert.equal(view.taskRuns[0]?.toolCalls[0]?.name, 'read')

  view = reduceCloudSessionProjectionEvent(session, view, event(4, 'task.run', {
    id: 'task-1',
    title: 'Read docs',
    agent: 'researcher',
    status: 'complete',
    content: 'done',
    sessionTokens: { input: 3, output: 4, cache: { read: 1, write: 2 } },
    sessionCost: 0.25,
    startedAt: '2026-05-28T10:03:00.000Z',
    finishedAt: '2026-05-28T10:04:00.000Z',
  }))
  assert.equal(view.taskRuns[0]?.status, 'complete')
  assert.equal(view.taskRuns[0]?.sessionTokens.cacheRead, 1)

  view = reduceCloudSessionProjectionEvent(session, view, event(5, 'permission.requested', {
    requestID: 'permission-1',
    tool: 'bash',
    input: { command: 'rm -rf tmp' },
    description: 'Delete tmp',
  }))
  assert.equal(view.pendingApprovals.length, 1)
  assert.equal(view.isGenerating, false)

  view = reduceCloudSessionProjectionEvent(session, view, event(6, 'permission.resolved', { requestID: 'permission-1', allowed: false }))
  assert.equal(view.pendingApprovals.length, 0)
  assert.equal(view.resolvedApprovals[0]?.id, 'permission-1')
  assert.equal(view.resolvedApprovals[0]?.allowed, false)

  view = reduceCloudSessionProjectionEvent(session, view, event(7, 'question.asked', {
    requestID: 'question-1',
    sourceSessionId: 'child-session',
    tool: { messageID: 'message-1', callID: 'call-1' },
    questions: [{
      header: 'Scope',
      question: 'Which target?',
      options: [{ label: 'Tests', description: 'Run test target' }],
      multiple: true,
      custom: false,
    }],
  }))
  assert.equal(view.pendingQuestions[0]?.tool?.callId, 'call-1')
  assert.equal(view.pendingQuestions[0]?.questions[0]?.multiple, true)

  view = reduceCloudSessionProjectionEvent(session, view, event(8, 'question.resolved', { requestID: 'question-1', answers: ['Tests'] }))
  assert.equal(view.pendingQuestions.length, 0)
  assert.equal(view.resolvedQuestions[0]?.id, 'question-1')
  assert.deepEqual(view.resolvedQuestions[0]?.answers, ['Tests'])

  view = reduceCloudSessionProjectionEvent(session, view, event(9, 'todos.updated', {
    todos: [
      { id: 'todo-1', content: 'Ship it', status: 'pending', priority: 'high' },
      { content: '' },
    ],
  }))
  assert.deepEqual(view.todos.map((todo) => todo.content), ['Ship it'])

  view = reduceCloudSessionProjectionEvent(session, view, event(10, 'cost.updated', {
    cost: 0.5,
    tokens: { input: 10, output: 20, reasoning: 2, cacheRead: 3, cacheWrite: 4 },
  }))
  assert.equal(view.sessionCost, 0.5)
  assert.equal(view.sessionTokens.output, 20)
  assert.equal(view.lastInputTokens, 10)

  view = reduceCloudSessionProjectionEvent(session, view, event(11, 'artifact.created', {
    cloudArtifactId: 'artifact-1',
    filename: 'chart.png',
    toolId: 'tool-root',
    toolName: 'chart',
    contentType: 'image/png',
    size: 12,
  }))
  assert.equal(view.artifacts[0]?.filePath, 'cloud-artifact://artifact-1/chart.png')

  view = reduceCloudSessionProjectionEvent(session, view, event(12, 'session.status', { statusType: 'busy' }))
  assert.equal(view.status, 'running')
  assert.equal(view.isGenerating, true)

  view = reduceCloudSessionProjectionEvent(session, view, event(13, 'session.status', { statusType: 'idle' }))
  assert.equal(view.status, 'idle')

  view = reduceCloudSessionProjectionEvent(session, view, event(14, 'runtime.error', {
    commandId: 'command-1',
    message: 'Runtime failed',
  }))
  assert.equal(view.status, 'errored')
  assert.equal(view.errors[0]?.id, 'command-1')

  view = reduceCloudSessionProjectionEvent(session, view, event(15, 'session.aborted'))
  assert.equal(view.status, 'idle')

  view = reduceCloudSessionProjectionEvent(session, view, event(16, 'unknown.event'))
  assert.equal(view.updatedAt, '2026-05-28T10:15:00.000Z')
})

test('cloud projection normalization filters malformed cached fields', () => {
  const session = baseSession({
    status: 'running' as const,
    title: null,
    profileName: 'analyst',
  })
  const normalized = normalizeCloudSessionProjectionView({
    sessionId: 'session-1',
    title: 'Cached',
    status: 'not-real',
    profileName: '',
    isGenerating: 'yes',
    messages: [
      { id: 'message-1', role: 'assistant', content: 'cached', createdAt: '2026-05-28T10:00:00.000Z' },
      { role: 'assistant', content: 'missing id' },
      { id: 'message-2', role: 'debug', content: 'bad role' },
    ],
    toolCalls: [
      { id: 'tool-1', name: 'bash', status: 'complete', input: { command: 'pwd' } },
      { id: 'tool-2', name: 'bad', status: 'done' },
    ],
    taskRuns: [
      { id: 'task-1', title: 'Task', status: 'running' },
      { id: 'task-2', title: 'Bad', status: 'paused' },
    ],
    pendingApprovals: [
      { id: 'permission-1', sessionId: 'session-1', tool: 'bash', input: {}, description: 'Approve' },
      { id: 'permission-2', tool: 'missing-session' },
    ],
    pendingQuestions: [
      { id: 'question-1', sessionId: 'session-1', questions: [{ question: 'Continue?' }] },
      { id: 'question-2', sessionId: 'session-1', questions: [{ header: 'empty' }] },
    ],
    artifacts: [
      { id: 'artifact-1', filename: 'a.txt', filePath: 'cloud-artifact://artifact-1/a.txt' },
      { id: 'artifact-2', filename: '' },
    ],
    todos: [{ content: 'One' }, { nope: true }],
    errors: [{ id: 'error-1', message: 'bad' }, { id: 'error-2' }],
    sessionCost: Number.NaN,
    sessionTokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    lastInputTokens: 6,
    lastError: '',
    updatedAt: '',
  }, session)

  assert.equal(normalized.title, 'Cached')
  assert.equal(normalized.status, 'running')
  assert.equal(normalized.profileName, 'analyst')
  assert.equal(normalized.isGenerating, true)
  assert.deepEqual(normalized.messages.map((message) => message.id), ['message-1'])
  assert.deepEqual(normalized.toolCalls.map((tool) => tool.id), ['tool-1', 'tool-2'])
  assert.deepEqual(normalized.taskRuns.map((task) => task.id), ['task-1', 'task-2'])
  assert.deepEqual(normalized.pendingApprovals.map((approval) => approval.id), ['permission-1'])
  assert.deepEqual(normalized.pendingQuestions.map((question) => question.id), ['question-1', 'question-2'])
  assert.deepEqual(normalized.artifacts.map((artifact) => artifact.id), ['artifact-1', 'artifact-2'])
  assert.deepEqual(normalized.todos.map((todo) => todo.content), ['One'])
  assert.deepEqual(normalized.errors.map((error) => error.id), ['error-1'])
  assert.equal(normalized.sessionCost, 0)
  assert.equal(normalized.sessionTokens.cacheRead, 4)
  assert.equal(normalized.lastInputTokens, 6)
  assert.equal(normalized.updatedAt, session.updatedAt)
})

test('cloud SessionView conversion handles empty and error-only projections', () => {
  const session = baseSession()
  assert.deepEqual(cloudSessionViewToSessionView({ session, projection: null }), emptySessionView())
  assert.equal(readCloudSessionProjection({ session, projection: { tenantId: 'tenant-1', sessionId: 'session-1', sequence: 1, view: {}, updatedAt: session.updatedAt } }), null)

  const projection = createCloudSessionProjectionView(session)
  projection.lastError = 'Late failure'
  projection.messages = [
    { id: 'system-1', role: 'system', content: 'hidden', createdAt: session.updatedAt },
    { id: 'assistant-1', role: 'assistant', content: 'visible', createdAt: session.updatedAt },
  ]
  const view = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sequence: 7,
      view: projection,
      updatedAt: session.updatedAt,
    },
  })

  assert.deepEqual(view.messages.map((message) => message.content), ['visible'])
  assert.equal(view.errors[0]?.message, 'Late failure')
  assert.equal(view.revision, 7)
  assert.equal(view.lastEventAt, 7)
})

test('shared cloud event list includes session and channel stream events', () => {
  assert.ok(CLOUD_SESSION_EVENT_TYPES.includes('permission.requested'))
  assert.ok(CLOUD_SESSION_EVENT_TYPES.includes('question.asked'))
  assert.ok(CLOUD_SESSION_EVENT_TYPES.includes('channel.delivery'))
  assert.equal(new Set(CLOUD_SESSION_EVENT_TYPES).size, CLOUD_SESSION_EVENT_TYPES.length)
})
