import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { clearSessionRegistryCache, removeSessionRecord, toSessionRecord, updateSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'
import { ThreadIndexService } from '../apps/desktop/src/main/thread-index-service.ts'
import { ThreadIndexStore } from '../apps/desktop/src/main/thread-index-store.ts'

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
    changeSummary: { files: 2, additions: 10, deletions: 1 },
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
