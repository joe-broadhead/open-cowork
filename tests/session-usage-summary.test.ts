import { buildSessionUsageSummary } from '@open-cowork/runtime-host/session-usage-summary'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionView } from '@open-cowork/shared'
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
