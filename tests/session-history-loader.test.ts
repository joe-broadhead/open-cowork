import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionView } from '@open-cowork/shared'
import type { ProjectedHistoryItem } from '../apps/desktop/src/main/session-history-projector.ts'
import { createSessionHistoryService } from '../apps/desktop/src/main/session-history-loader.ts'

function createEmptySessionView(): SessionView {
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
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

test('createSessionHistoryService loads questions and updates provider/model from projected history', async () => {
  const updates: Array<Record<string, unknown>> = []
  const projectedItems: ProjectedHistoryItem[] = [
    {
      id: 'assistant-1',
      timestamp: new Date().toISOString(),
      sequence: 1,
      providerId: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    },
  ]

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === 'session-1') {
              return { data: [{ id: 'child-1', title: 'Child run', parentID: 'session-1', time: { created: 1, updated: 2 } }] }
            }
            if (sessionID === 'child-1') {
              return { data: [{ id: 'grandchild-1', title: 'Grandchild run', parentID: 'child-1', time: { created: 3, updated: 4 } }] }
            }
            return { data: [] }
          },
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
        },
      },
      questionClient: { id: 'question-client' },
      record: null,
    }),
    listPendingQuestions: async () => ({
      data: [
        {
          id: 'question-1',
          sessionID: 'session-1',
          questions: [{
            header: 'Need a choice',
            question: 'Pick one',
            options: [{ label: 'A', description: 'Alpha' }],
          }],
          tool: { messageID: 'message-1', callID: 'call-1' },
        },
        {
          id: 'question-2',
          sessionID: 'grandchild-1',
          questions: [{
            header: 'Nested clarification',
            question: 'Need deeper context',
            options: [{ label: 'B', description: 'Beta' }],
          }],
          tool: { messageID: 'message-2', callID: 'call-2' },
        },
      ],
    }),
    projectSessionHistory: async (input) => {
      assert.equal(input.cachedModelId, 'cached-model')
      assert.equal(input.children.length, 2)
      assert.deepEqual(input.children.map((child) => ({ id: child.id, parent: child.parentSessionId })), [
        { id: 'child-1', parent: 'session-1' },
        { id: 'grandchild-1', parent: 'child-1' },
      ])
      return projectedItems
    },
    getCachedModelId: () => 'cached-model',
    updateSessionRecord: (_sessionId, patch) => {
      updates.push(patch)
      return null
    },
    buildSessionUsageSummary: () => ({
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }),
    sessionEngine: {
      isHydrated: () => false,
      activateSession: () => {},
      setSessionFromHistory: () => {},
      setPendingQuestions: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  const result = await service.loadSessionHistory('session-1')

  assert.equal(result.items, projectedItems)
  assert.equal(result.questions.length, 2)
  assert.equal(result.questions[0]?.questions[0]?.options[0]?.label, 'A')
  assert.equal(result.questions[1]?.sourceSessionId, 'grandchild-1')
  assert.equal(result.questions[1]?.questions[0]?.question, 'Need deeper context')
  assert.deepEqual(updates[0], {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
  })
})

test('createSessionHistoryService honors activate:false during warm syncs', async () => {
  const view = createEmptySessionView()
  const calls = {
    activated: 0,
    setHistory: 0,
    setQuestions: 0,
    getSessionClient: 0,
  }
  const updates: Array<Record<string, unknown>> = []

  const service = createSessionHistoryService({
    getSessionClient: async () => {
      calls.getSessionClient += 1
      return {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            todo: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            diff: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            get: async () => ({ data: null }),
          },
        },
        questionClient: {},
        record: null,
      }
    },
    listPendingQuestions: async () => ({ data: [] }),
    projectSessionHistory: async () => [],
    getCachedModelId: () => '',
    updateSessionRecord: (_sessionId, patch) => {
      updates.push(patch)
      return null
    },
    buildSessionUsageSummary: () => ({
      messages: 1,
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }),
    sessionEngine: {
      isHydrated: () => true,
      activateSession: () => {
        calls.activated += 1
      },
      setSessionFromHistory: () => {
        calls.setHistory += 1
      },
      setPendingQuestions: () => {
        calls.setQuestions += 1
      },
      getSessionView: () => view,
    },
  })

  const result = await service.syncSessionView('session-2', { activate: false })

  assert.equal(result, view)
  assert.equal(calls.activated, 0)
  assert.equal(calls.setHistory, 0)
  assert.equal(calls.setQuestions, 0)
  assert.equal(calls.getSessionClient, 1)
  assert.deepEqual(updates[0], {
    summary: {
      messages: 1,
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    changeSummary: null,
  })
})

test('createSessionHistoryService forwards forced refresh syncs without caller-managed merge flags', async () => {
  const calls: Array<Record<string, unknown>> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
        },
      },
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    projectSessionHistory: async () => [],
    getCachedModelId: () => '',
    updateSessionRecord: () => null,
    buildSessionUsageSummary: () => ({
      messages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }),
    sessionEngine: {
      isHydrated: () => true,
      activateSession: () => {},
      setSessionFromHistory: (_sessionId, _items, options) => {
        calls.push(options || {})
      },
      setPendingQuestions: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  await service.syncSessionView('session-3', {
    force: true,
    activate: false,
  })

  assert.deepEqual(calls, [{
    force: true,
  }])
})

test('createSessionHistoryService synthesizes changeSummary for write-only session artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-sync-summary-'))
  try {
    const reportPath = join(root, 'report.md')
    writeFileSync(reportPath, '# Report\n\nHello\n')

    const updates: Array<Record<string, unknown>> = []
    const view: SessionView = {
      ...createEmptySessionView(),
      toolCalls: [
        {
          id: 'tool-1',
          name: 'write',
          input: { filePath: reportPath },
          status: 'complete',
          order: 1,
        },
      ],
    }

    const service = createSessionHistoryService({
      getSessionClient: async () => ({
        client: {
          session: {
            messages: async () => ({ data: [] }),
            todo: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            diff: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            get: async () => ({ data: null }),
          },
        },
        questionClient: {},
        record: {
          opencodeDirectory: root,
        },
      }),
      listPendingQuestions: async () => ({ data: [] }),
      projectSessionHistory: async () => [],
      getCachedModelId: () => '',
      updateSessionRecord: (_sessionId, patch) => {
        updates.push(patch)
        return null
      },
      buildSessionUsageSummary: () => ({
        messages: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 1,
        taskRuns: 0,
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
      sessionEngine: {
        isHydrated: () => true,
        activateSession: () => {},
        setSessionFromHistory: () => {},
        setPendingQuestions: () => {},
        getSessionView: () => view,
      },
    })

    await service.syncSessionView('session-4', { activate: false })

    assert.deepEqual(updates[0], {
      summary: {
        messages: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 1,
        taskRuns: 0,
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      changeSummary: {
        additions: 3,
        deletions: 0,
        files: 1,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
