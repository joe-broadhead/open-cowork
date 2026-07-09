import { normalizeStoredSessionRecord } from '@open-cowork/runtime-host/session-registry-utils'
import test from 'node:test'
import assert from 'node:assert/strict'

test('normalizeStoredSessionRecord keeps Cowork-managed records and drops external ones', () => {
  const normalizeDirectory = (value: string) => value
  const toDisplayDirectory = (value: string) => value === '/runtime-home' ? null : value

  const managed = normalizeStoredSessionRecord({
    id: 'ses_managed',
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    managedByCowork: true,
  }, normalizeDirectory, toDisplayDirectory)

  const external = normalizeStoredSessionRecord({
    id: 'ses_external',
    opencodeDirectory: '/external',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }, normalizeDirectory, toDisplayDirectory)

  assert.deepEqual(managed, {
    id: 'ses_managed',
    title: undefined,
    directory: null,
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    providerId: null,
    modelId: null,
    composerAgentName: null,
    composerModelId: null,
    composerReasoningVariant: null,
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    kind: 'interactive',
    workflowId: null,
    runId: null,
    managedByCowork: true,
  })
  assert.equal(external, null)
})

test('normalizeStoredSessionRecord preserves session usage agent breakdowns', () => {
  const record = normalizeStoredSessionRecord({
    id: 'ses_summary',
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    managedByCowork: true,
    summary: {
      messages: 3,
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      taskRuns: 2,
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      agentBreakdown: [{
        agent: 'business-analyst',
        taskRuns: 2,
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      }],
    },
  }, (value) => value, () => null)

  assert.deepEqual(record?.summary?.agentBreakdown, [{
    agent: 'business-analyst',
    taskRuns: 2,
    cost: 0.25,
    tokens: { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  }])
})

test('normalizeStoredSessionRecord preserves synthetic diff summary provenance', () => {
  const record = normalizeStoredSessionRecord({
    id: 'ses_changes',
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    managedByCowork: true,
    changeSummary: {
      files: 2,
      additions: 10,
      deletions: 1,
      source: 'mixed',
      synthetic: true,
    },
  }, (value) => value, () => null)

  assert.deepEqual(record?.changeSummary, {
    files: 2,
    additions: 10,
    deletions: 1,
    source: 'mixed',
    synthetic: true,
  })
})
