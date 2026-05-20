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
    listPendingPermissions: async () => ({
      data: [
        {
          id: 'perm-1',
          sessionID: 'session-1',
          permission: 'bash',
          metadata: { command: 'pwd' },
        },
        {
          id: 'perm-2',
          sessionID: 'grandchild-1',
          permission: 'write',
          tool: 'write',
          metadata: { path: 'notes.md' },
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
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  const result = await service.loadSessionHistory('session-1')

  assert.equal(result.items, projectedItems)
  assert.equal(result.questions.length, 2)
  assert.equal(result.approvals.length, 2)
  assert.equal(result.questions[0]?.questions[0]?.options[0]?.label, 'A')
  assert.equal(result.questions[1]?.sourceSessionId, 'grandchild-1')
  assert.equal(result.questions[1]?.questions[0]?.question, 'Need deeper context')
  assert.deepEqual(result.approvals[0], {
    id: 'perm-1',
    sessionId: 'session-1',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Permission requested for bash',
  })
  assert.deepEqual(result.approvals[1], {
    id: 'perm-2',
    sessionId: 'session-1',
    taskRunId: 'child:grandchild-1',
    tool: 'write',
    input: { path: 'notes.md' },
    description: 'Sub-Agent: write',
  })
  assert.deepEqual(updates[0], {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
  })
})

test('createSessionHistoryService replaces SDK default titles from first user message', async () => {
  const updates: Array<Record<string, unknown>> = []
  const sdkTitleUpdates: Array<Record<string, unknown>> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async () => ({
            data: [{
              info: { id: 'user-message-1', role: 'user', time: { created: 1 } },
              parts: [
                { id: 'user-text-1', type: 'text', text: 'Please compare the Q2 launch risks and summarize the blockers.' },
              ],
            }],
          }),
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({
            data: {
              id: 'session-title-fallback',
              title: 'New Session - 2026-05-19T12:07:39.243Z',
              time: { created: 1, updated: 2 },
            },
          }),
          update: async (input: Record<string, unknown>) => {
            sdkTitleUpdates.push(input)
            return { data: {} }
          },
        },
      },
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
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
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  await service.loadSessionHistory('session-title-fallback')

  assert.deepEqual(sdkTitleUpdates, [{
    sessionID: 'session-title-fallback',
    title: 'Please compare the Q2 launch risks and summarize the blockers.',
  }])
  assert.equal(updates[0]?.title, 'Please compare the Q2 launch risks and summarize the blockers.')
})

test('createSessionHistoryService skips internal Cowork prompts for fallback titles', async () => {
  const updates: Array<Record<string, unknown>> = []
  const sdkTitleUpdates: Array<Record<string, unknown>> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: 'internal-message', role: 'user', time: { created: 1 } },
                parts: [
                  {
                    id: 'internal-text',
                    type: 'text',
                    text: '[[OPEN_COWORK_INTERNAL_TEAM_CONTEXT]] Hidden workflow orchestration prompt.',
                  },
                ],
              },
              {
                info: { id: 'user-message', role: 'user', time: { created: 2 } },
                parts: [
                  {
                    id: 'user-text',
                    type: 'text',
                    text: 'Write a clear migration plan for the reporting pipeline.',
                  },
                ],
              },
            ],
          }),
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({
            data: {
              id: 'session-internal-title-fallback',
              title: 'New session',
              time: { created: 1, updated: 2 },
            },
          }),
          update: async (input: Record<string, unknown>) => {
            sdkTitleUpdates.push(input)
            return { data: {} }
          },
        },
      },
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
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
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  await service.loadSessionHistory('session-internal-title-fallback')

  assert.deepEqual(sdkTitleUpdates, [{
    sessionID: 'session-internal-title-fallback',
    title: 'Write a clear migration plan for the reporting pipeline.',
  }])
  assert.equal(updates[0]?.title, 'Write a clear migration plan for the reporting pipeline.')
})

test('createSessionHistoryService preserves product-owned workflow titles before prompt fallback', async () => {
  const updates: Array<Record<string, unknown>> = []
  const sdkTitleUpdates: Array<Record<string, unknown>> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async () => ({
            data: [{
              info: { id: 'workflow-prompt', role: 'user', time: { created: 1 } },
              parts: [
                { id: 'workflow-text', type: 'text', text: 'Help the user create and schedule a workflow.' },
              ],
            }],
          }),
          todo: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({
            data: {
              id: 'workflow-draft-session',
              title: 'New session',
              time: { created: 1, updated: 2 },
            },
          }),
          update: async (input: Record<string, unknown>) => {
            sdkTitleUpdates.push(input)
            return { data: {} }
          },
        },
      },
      questionClient: {},
      record: {
        title: 'New workflow draft',
      },
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
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
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  await service.loadSessionHistory('workflow-draft-session')

  assert.deepEqual(sdkTitleUpdates, [{
    sessionID: 'workflow-draft-session',
    title: 'New workflow draft',
  }])
  assert.equal(updates[0]?.title, 'New workflow draft')
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
    listPendingPermissions: async () => ({ data: [] }),
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
      setPendingApprovals: () => {},
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
    listPendingPermissions: async () => ({ data: [] }),
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
      setPendingApprovals: () => {},
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

test('createSessionHistoryService can hydrate root history before child transcripts', async () => {
  const view = createEmptySessionView()
  const calls = {
    children: 0,
    childSnapshot: 0,
    diff: 0,
    setHistory: 0,
  }
  const updates: Array<Record<string, unknown>> = []

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== 'session-progressive') calls.childSnapshot += 1
            return { data: [] }
          },
          todo: async () => ({ data: [] }),
          children: async () => {
            calls.children += 1
            return { data: [{ id: 'child-1', title: 'Analyst', parentID: 'session-progressive', time: { created: 1 } }] }
          },
          diff: async () => {
            calls.diff += 1
            return { data: [] }
          },
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
        },
      },
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
    projectSessionHistory: async (input) => {
      assert.deepEqual(input.children, [])
      return []
    },
    getCachedModelId: () => '',
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
      setSessionFromHistory: () => {
        calls.setHistory += 1
      },
      setPendingQuestions: () => {},
      setPendingApprovals: () => {},
      getSessionView: () => view,
    },
  })

  const result = await service.syncSessionView('session-progressive', {
    activate: true,
    progressive: true,
  })

  assert.equal(result, view)
  assert.equal(calls.children, 0)
  assert.equal(calls.childSnapshot, 0)
  assert.equal(calls.diff, 0)
  assert.equal(calls.setHistory, 1)
  assert.deepEqual(updates[0], {
    summary: {
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
    },
  })
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
      listPendingPermissions: async () => ({ data: [] }),
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
        setPendingApprovals: () => {},
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
