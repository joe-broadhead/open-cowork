import { ThreadIndexStore } from '@open-cowork/runtime-host/thread-index/thread-index-store'
import { ThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { clearSessionRegistryCache, removeSessionRecord, toSessionRecord, updateSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionView } from '@open-cowork/shared'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
function emptySessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
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
    ...overrides,
  }
}

function withThreadIndexService(name: string, run: (service: ThreadIndexService) => void) {
  const root = mkdtempSync(join(tmpdir(), `open-cowork-thread-service-${name}-`))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const store = new ThreadIndexStore(join(root, 'thread-index.sqlite'))
  const service = new ThreadIndexService(store)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = root
    clearConfigCaches()
    clearSessionRegistryCache()
    run(service)
  } finally {
    service.dispose()
    store.close()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(root, { recursive: true, force: true })
  }
}

test('thread index service reconciles registry rows and removes orphans', () => withThreadIndexService('reconcile', (service) => {
  const first = upsertSessionRecord(toSessionRecord({
    id: 'session-a',
    title: 'Revenue workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/revenue',
    providerId: 'openrouter',
    modelId: 'openrouter/sonnet',
    changeSummary: { files: 2, additions: 10, deletions: 1, source: 'mixed', synthetic: true },
  }))
  const second = upsertSessionRecord(toSessionRecord({
    id: 'session-b',
    title: 'Archived debug',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
    opencodeDirectory: '/workspace/debug',
    providerId: 'codex',
    modelId: 'codex/gpt-5',
  }))
  assert.ok(first)
  assert.ok(second)
  service.reconcileThreadIndexFromRegistry()

  let result = service.search({ limit: 10 })
  assert.equal(result.threads.length, 2)
  assert.equal(result.threads[0]!.providerId, 'codex')
  assert.equal(result.threads[1]!.changeSummary?.files, 2)
  assert.equal(result.threads[1]!.changeSummary?.source, 'mixed')
  assert.equal(result.threads[1]!.changeSummary?.synthetic, true)

  const renamed = updateSessionRecord('session-a', { title: 'Renamed revenue', updatedAt: '2026-01-05T00:00:00.000Z' })
  assert.ok(renamed)
  service.upsertThreadFromSessionRecord(renamed)
  result = service.search({ text: 'renamed' })
  assert.equal(result.threads.length, 1)
  assert.equal(result.threads[0]!.sessionId, 'session-a')

  removeSessionRecord('session-b')
  service.reconcileThreadIndexFromRegistry()
  result = service.search({})
  assert.deepEqual(result.threads.map((thread) => thread.sessionId), ['session-a'])
}))

test('thread index service stores actual metadata and suggestion-only categories from session views', () => withThreadIndexService('metadata', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-meta',
    title: 'Weekly chart report',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    providerId: 'openrouter',
    modelId: 'openrouter/sonnet',
  }))
  assert.ok(record)
  service.upsertThreadFromSessionRecord(record, {
    messages: [{ id: 'm1', role: 'user', content: 'make chart', order: 1 }],
    toolCalls: [{ id: 'tool-1', name: 'charts.create', input: {}, status: 'complete', order: 2 }],
    taskRuns: [{
      id: 'task-1',
      title: 'Research task',
      agent: 'research',
      status: 'complete',
      sourceSessionId: 'child-1',
      content: '',
      transcript: [],
      toolCalls: [{ id: 'tool-2', name: 'web.search', input: {}, status: 'complete', order: 3 }],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0.12,
      sessionTokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 4,
    }],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0.2,
    sessionTokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  })

  const result = service.search({ text: 'reporting' })
  assert.equal(result.threads.length, 1)
  const thread = result.threads[0]!
  assert.deepEqual(thread.actualAgents, [{ name: 'research', count: 1 }])
  assert.equal(thread.actualTools.some((tool) => tool.name === 'charts.create'), true)
  assert.equal(thread.suggestions.some((suggestion) => suggestion.label === 'reporting'), true)
  assert.equal(thread.tags.length, 0, 'suggestions do not become user tags')
  assert.equal(thread.usage.messages, 1)
  assert.equal(thread.usage.taskRuns, 1)
  assert.equal(thread.usage.tokens.input, 11)
}))

test('thread index service does not add persisted agent summaries on top of live views', () => withThreadIndexService('agent-dedup', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-agent-dedup',
    title: 'Delegated analysis',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    summary: {
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      taskRuns: 2,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      agentBreakdown: [{
        agent: 'business-analyst',
        taskRuns: 2,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  }))
  assert.ok(record)

  service.upsertThreadFromSessionRecord(record, {
    messages: [{ id: 'm1', role: 'user', content: 'delegate twice', order: 1 }],
    toolCalls: [],
    taskRuns: ['task-1', 'task-2'].map((id, index) => ({
      id,
      title: `Analysis ${index + 1}`,
      agent: 'business-analyst',
      status: 'complete',
      sourceSessionId: `child-${index + 1}`,
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: index + 2,
    })),
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
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
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  })

  const result = service.search({ text: 'analysis' })
  assert.equal(result.threads.length, 1)
  assert.deepEqual(result.threads[0]?.actualAgents, [{ name: 'business-analyst', count: 2 }])
  assert.equal(result.threads[0]?.usage.taskRuns, 2)
}))

test('thread index service clears persisted agents when a live view has no task runs', () => withThreadIndexService('agent-clear', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-agent-clear',
    title: 'Analysis without delegation',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    summary: {
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      taskRuns: 1,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      agentBreakdown: [{
        agent: 'business-analyst',
        taskRuns: 1,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  }))
  assert.ok(record)

  service.upsertThreadFromSessionRecord(record, {
    messages: [{ id: 'm1', role: 'user', content: 'delegate once', order: 1 }],
    toolCalls: [],
    taskRuns: [{
      id: 'task-1',
      title: 'Analysis',
      agent: 'business-analyst',
      status: 'complete',
      sourceSessionId: 'child-1',
      content: '',
      transcript: [],
      toolCalls: [],
      compactions: [],
      todos: [],
      error: null,
      sessionCost: 0,
      sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      order: 2,
    }],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
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
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  })
  assert.deepEqual(
    service.search({ text: 'analysis' }).threads[0]?.actualAgents,
    [{ name: 'business-analyst', count: 1 }],
  )

  service.upsertThreadFromSessionRecord(record, {
    messages: [{ id: 'm1', role: 'user', content: 'analyze locally', order: 1 }],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
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
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  })

  const result = service.search({ text: 'analysis' })
  assert.equal(result.threads.length, 1)
  assert.deepEqual(result.threads[0]?.actualAgents, [])
  assert.equal(result.threads[0]?.usage.taskRuns, 0)
  assert.equal(service.search({ agents: ['business-analyst'] }).threads.length, 0)
}))

test('thread index service preserves persisted agents for unhydrated empty views', () => withThreadIndexService('agent-unhydrated', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-agent-unhydrated',
    title: 'Historical analysis',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    summary: {
      messages: 4,
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      taskRuns: 2,
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      agentBreakdown: [{
        agent: 'business-analyst',
        taskRuns: 2,
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  }))
  assert.ok(record)

  service.upsertThreadFromSessionRecord(record, emptySessionView())

  const result = service.search({ agents: ['business-analyst'] })
  assert.equal(result.threads.length, 1)
  assert.deepEqual(result.threads[0]?.actualAgents, [{ name: 'business-analyst', count: 2 }])
  assert.equal(result.threads[0]?.usage.taskRuns, 2)
}))

test('thread index service preserves metadata rows during status-only view refreshes', () => withThreadIndexService('status-only-metadata', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-status-only',
    title: 'Historical chart analysis',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    summary: {
      messages: 4,
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      taskRuns: 1,
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      agentBreakdown: [{
        agent: 'business-analyst',
        taskRuns: 1,
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  }))
  assert.ok(record)

  service.upsertThreadFromSessionRecord(record, {
    ...emptySessionView({ revision: 1, lastEventAt: Date.now() }),
    messages: [{ id: 'm1', role: 'user', content: 'make a chart', order: 1 }],
    toolCalls: [{ id: 'tool-1', name: 'charts.create', input: {}, status: 'complete', order: 2 }],
    taskRuns: [],
  })
  assert.deepEqual(
    service.search({ text: 'charts.create' }).threads[0]?.actualTools,
    [{ name: 'charts.create', mcpName: 'charts', count: 1 }],
  )

  service.upsertThreadFromSessionRecord(record, emptySessionView({
    revision: 2,
    lastEventAt: Date.now(),
    isGenerating: true,
  }))

  const result = service.search({ agents: ['business-analyst'], tools: ['charts.create'] })
  assert.equal(result.threads.length, 1)
  assert.deepEqual(result.threads[0]?.actualAgents, [{ name: 'business-analyst', count: 1 }])
  assert.deepEqual(result.threads[0]?.actualTools, [{ name: 'charts.create', mcpName: 'charts', count: 1 }])
  assert.equal(result.threads[0]?.status, 'running')
  assert.equal(result.threads[0]?.usage.taskRuns, 1)
}))

test('thread index service preserves view-derived tools during record-only updates', () => withThreadIndexService('partial-metadata', (service) => {
  const record = upsertSessionRecord(toSessionRecord({
    id: 'session-partial',
    title: 'Weekly chart report',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    opencodeDirectory: '/workspace/analytics',
    providerId: 'openrouter',
    modelId: 'openrouter/sonnet',
  }))
  assert.ok(record)
  service.upsertThreadFromSessionRecord(record, {
    messages: [],
    toolCalls: [{ id: 'tool-1', name: 'charts.create', input: {}, status: 'complete', order: 1 }],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
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
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  })

  const renamed = updateSessionRecord('session-partial', {
    title: 'Renamed weekly chart report',
    updatedAt: '2026-01-03T00:00:00.000Z',
  })
  assert.ok(renamed)
  service.upsertThreadFromSessionRecord(renamed)

  const result = service.search({ text: 'charts.create' })
  assert.equal(result.threads.length, 1)
  const thread = result.threads[0]!
  assert.equal(thread.title, 'Renamed weekly chart report')
  assert.deepEqual(thread.actualTools, [{ name: 'charts.create', mcpName: 'charts', count: 1 }])
  assert.equal(thread.suggestions.some((suggestion) => suggestion.label === 'reporting'), true)
}))

test('thread index service skips no-op reindexes but still writes on real changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-thread-service-noop-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  // Count how many times the projection is actually written so we can prove that re-running a
  // refresh for an unchanged record performs no write (the streamed-event debounce hot path).
  let writes = 0
  class CountingStore extends ThreadIndexStore {
    override upsertThreadWithSuggestions(...args: Parameters<ThreadIndexStore['upsertThreadWithSuggestions']>) {
      writes += 1
      return super.upsertThreadWithSuggestions(...args)
    }
  }
  const store = new CountingStore(join(root, 'thread-index.sqlite'))
  const service = new ThreadIndexService(store)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = root
    clearConfigCaches()
    clearSessionRegistryCache()

    const record = upsertSessionRecord(toSessionRecord({
      id: 'session-noop',
      title: 'Initial title',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      opencodeDirectory: '/workspace/noop',
      providerId: 'openrouter',
      modelId: 'openrouter/sonnet',
    }))
    assert.ok(record)

    service.upsertThreadFromSessionRecord(record)
    assert.equal(writes, 1)

    // Same record state → identical projection signature → no write.
    service.upsertThreadFromSessionRecord(record)
    service.upsertThreadFromSessionRecord(record)
    assert.equal(writes, 1)

    // A real change (renamed thread) writes exactly once more, then re-settles to no-op.
    const renamed = updateSessionRecord('session-noop', { title: 'Renamed title', updatedAt: '2026-01-03T00:00:00.000Z' })
    assert.ok(renamed)
    service.upsertThreadFromSessionRecord(renamed)
    assert.equal(writes, 2)
    service.upsertThreadFromSessionRecord(renamed)
    assert.equal(writes, 2)

    // Removing the thread drops its signature, so a re-add writes again rather than being skipped.
    service.removeThread('session-noop')
    service.upsertThreadFromSessionRecord(renamed)
    assert.equal(writes, 3)

    assert.equal(service.search({ text: 'renamed' }).threads.length, 1)
  } finally {
    service.dispose()
    store.close()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(root, { recursive: true, force: true })
  }
})
