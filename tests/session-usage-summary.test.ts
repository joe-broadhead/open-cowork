import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionView } from '@open-cowork/shared'
import {
  buildSessionUsageSummary,
  createDashboardTimeRange,
  isRecordInDashboardRange,
  mergeAgentBreakdowns,
  sumSessionUsageSummaries,
} from '../apps/desktop/src/main/session-usage-summary.ts'

function makeView(): SessionView {
  return {
    messages: [
      { id: 'm1', role: 'user', content: 'hello', order: 1 },
      { id: 'm2', role: 'assistant', content: 'hi', order: 2 },
      { id: 'm3', role: 'assistant', content: 'done', order: 3 },
    ],
    toolCalls: [
      { id: 'tool-1', name: 'websearch', input: {}, status: 'complete', order: 4 },
    ],
    taskRuns: [
      {
        id: 'task-1',
        title: 'Task',
        agent: 'research',
        status: 'complete',
        sourceSessionId: null,
        content: '',
        transcript: [],
        toolCalls: [
          { id: 'tool-2', name: 'webfetch', input: {}, status: 'complete', order: 5 },
          { id: 'tool-3', name: 'read', input: {}, status: 'complete', order: 6 },
        ],
        compactions: [],
        todos: [],
        error: null,
        sessionCost: 0.25,
        sessionTokens: {
          input: 100,
          output: 50,
          reasoning: 25,
          cacheRead: 10,
          cacheWrite: 0,
        },
        order: 4,
      },
    ],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0.25,
    sessionTokens: {
      input: 100,
      output: 50,
      reasoning: 25,
      cacheRead: 10,
      cacheWrite: 0,
    },
    lastInputTokens: 100,
    contextState: 'measured',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: Date.now(),
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

test('buildSessionUsageSummary derives message, tool, cost, and token totals from a session view', () => {
  const summary = buildSessionUsageSummary(makeView())

  assert.deepEqual(summary, {
    messages: 3,
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 3,
    taskRuns: 1,
    cost: 0.25,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 25,
      cacheRead: 10,
      cacheWrite: 0,
    },
    agentBreakdown: [
      {
        agent: 'research',
        taskRuns: 1,
        cost: 0.25,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 25,
          cacheRead: 10,
          cacheWrite: 0,
        },
      },
    ],
  })
})

test('createDashboardTimeRange creates bounded recent windows and unbounded all-time windows', () => {
  const now = new Date('2026-04-16T12:00:00.000Z')

  const last7d = createDashboardTimeRange('last7d', now)
  assert.equal(last7d.label, 'Last 7 days')
  assert.equal(last7d.endAt, now.toISOString())
  assert.equal(last7d.startAt, '2026-04-09T12:00:00.000Z')

  const ytd = createDashboardTimeRange('ytd', now)
  assert.equal(ytd.startAt, '2026-01-01T00:00:00.000Z')

  const all = createDashboardTimeRange('all', now)
  assert.equal(all.startAt, null)
})

test('isRecordInDashboardRange filters by updatedAt against the selected range', () => {
  const range = createDashboardTimeRange('last30d', new Date('2026-04-16T12:00:00.000Z'))
  const baseRecord = {
    id: 'ses_123',
    title: 'Test',
    directory: null,
    opencodeDirectory: '/tmp/project',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-04-10T10:00:00.000Z',
    providerId: null,
    modelId: null,
    summary: null,
    managedByCowork: true as const,
  }

  assert.equal(isRecordInDashboardRange(baseRecord, range), true)
  assert.equal(isRecordInDashboardRange({ ...baseRecord, updatedAt: '2026-03-01T00:00:00.000Z' }, range), false)
})

test('sumSessionUsageSummaries aggregates threads, costs, messages, and tokens', () => {
  const total = sumSessionUsageSummaries([
    buildSessionUsageSummary(makeView()),
    {
      messages: 1,
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0.1,
      tokens: {
        input: 10,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 5,
      },
    },
  ])

  assert.deepEqual(total, {
    threads: 2,
    messages: 4,
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 3,
    taskRuns: 1,
    cost: 0.35,
    tokens: {
      input: 110,
      output: 50,
      reasoning: 25,
      cacheRead: 10,
      cacheWrite: 5,
    },
  })
})

test('mergeAgentBreakdowns aggregates by agent across sessions and sorts by cost descending', () => {
  const summaries = [
    {
      ...buildSessionUsageSummary(makeView()),
    },
    {
      ...buildSessionUsageSummary(makeView()),
      agentBreakdown: [
        { agent: 'research', taskRuns: 2, cost: 0.4, tokens: { input: 200, output: 120, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        { agent: 'charts', taskRuns: 1, cost: 0.05, tokens: { input: 30, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
  ]

  const merged = mergeAgentBreakdowns(summaries)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].agent, 'research')
  assert.equal(merged[0].taskRuns, 3)          // 1 from first session + 2 from second
  assert.equal(merged[0].cost, 0.65)           // 0.25 + 0.4
  assert.equal(merged[1].agent, 'charts')
  assert.equal(merged[1].taskRuns, 1)
  assert.equal(merged[1].cost, 0.05)
})

test('mergeAgentBreakdowns returns an empty list when no summaries have task runs', () => {
  const merged = mergeAgentBreakdowns([
    { messages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, taskRuns: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
  ])
  assert.deepEqual(merged, [])
})
