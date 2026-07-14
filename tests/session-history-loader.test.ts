import type { ProjectedHistoryItem } from '@open-cowork/runtime-host/session-history-projector'
import { createBoundedChildSnapshotLoader, createSessionHistoryService } from '@open-cowork/runtime-host/session-history-loader'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionView } from '@open-cowork/shared'

type SessionMock = {
  messages?: (input: { sessionID: string }) => Promise<{ data: unknown[] }>
  todo?: (input: { sessionID: string }) => Promise<{ data: unknown[] }>
  status?: () => Promise<{ data: Record<string, unknown> }>
  get?: (input: { sessionID: string }) => Promise<{ data: unknown }>
  children?: (input: { sessionID: string }) => Promise<{ data: unknown[] }>
  list?: (input: { directory?: string; limit?: number; order?: string; cursor?: string }) => Promise<{ data: unknown[] }>
  diff?: (...args: any[]) => Promise<unknown>
  update?: (...args: any[]) => Promise<unknown>
}

function createNativeHistoryClient(session: SessionMock, rootSessionId: string) {
  const listAllSessions = async (input: { directory?: string; limit?: number; order?: string; cursor?: string }) => {
    if (session.list) return (await session.list(input)).data
    if (!session.children) return []
    const seen = new Set<string>()
    const result: unknown[] = []
    const queue = [rootSessionId]
    while (queue.length > 0) {
      const parent = queue.shift()
      if (!parent || seen.has(parent)) continue
      seen.add(parent)
      const children = (await session.children({ sessionID: parent })).data
      for (const value of children) {
        result.push(value)
        const id = (value as { id?: unknown })?.id
        if (typeof id === 'string') queue.push(id)
      }
    }
    return result
  }

  return {
    session,
    v2: {
      session: {
        messages: async (input: { sessionID: string }) => ({
          data: {
            data: session.messages ? (await session.messages(input)).data : [],
            cursor: {},
          },
        }),
        active: async () => ({ data: { data: session.status ? (await session.status()).data : {} } }),
        get: async (input: { sessionID: string }) => ({
          data: { data: session.get ? (await session.get(input)).data : null },
        }),
        list: async (input: { directory?: string; limit?: number; order?: string; cursor?: string }) => ({
          data: { data: await listAllSessions(input), cursor: {} },
        }),
      },
    },
  } as any
}

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

test('bounded child snapshot loader prefetches without exceeding the concurrency cap', async () => {
  let active = 0
  let maxActive = 0
  const completed: string[] = []
  const loader = createBoundedChildSnapshotLoader({
    ids: ['child-1', 'child-2', 'child-3', 'child-4', 'child-5'],
    concurrency: 2,
    load: async (id) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      completed.push(id)
      return { messages: [{ id }], todos: [] }
    },
  })

  loader.prefetch()
  const snapshots = await Promise.all([
    loader.load('child-1'),
    loader.load('child-2'),
    loader.load('child-3'),
    loader.load('child-4'),
    loader.load('child-5'),
  ])

  assert.equal(maxActive, 2)
  assert.deepEqual(snapshots.map((snapshot) => snapshot.messages[0]), [
    { id: 'child-1' },
    { id: 'child-2' },
    { id: 'child-3' },
    { id: 'child-4' },
    { id: 'child-5' },
  ])
  assert.deepEqual(completed.sort(), ['child-1', 'child-2', 'child-3', 'child-4', 'child-5'])
})

test('bounded child snapshot prefetch handles early rejections while preserving load errors', async () => {
  const loader = createBoundedChildSnapshotLoader({
    ids: ['child-1'],
    concurrency: 1,
    load: async () => {
      throw new Error('child unavailable')
    },
  })

  loader.prefetch()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(
    loader.load('child-1'),
    /child unavailable/,
  )
})

test('createSessionHistoryService discovers the full child graph from one native session list', async () => {
  const rootSessionId = 'session-wide'
  const projectDirectory = '/workspace/project-wide'
  const childCount = 16
  const childrenByParent = new Map<string, Array<Record<string, unknown>>>()
  const directChildren = Array.from({ length: childCount }, (_, index) => ({
    id: `child-${index}`,
    title: `Child ${index}`,
    parentID: rootSessionId,
    time: { created: index + 1, updated: index + 1 },
  }))
  childrenByParent.set(rootSessionId, directChildren)
  for (const child of directChildren) {
    const childId = String(child.id)
    childrenByParent.set(childId, [{
      id: `${childId}-grandchild`,
      title: `${childId} grandchild`,
      parentID: childId,
      time: { created: 100, updated: 100 },
    }])
    childrenByParent.set(`${childId}-grandchild`, [])
  }

  let listCalls = 0
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
          list: async (input) => {
            listCalls += 1
            assert.equal(input.directory, projectDirectory)
            return { data: Array.from(childrenByParent.values()).flat() }
          },
      }, rootSessionId),
      questionClient: { id: 'question-client' },
      record: { opencodeDirectory: projectDirectory } as never,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
    projectSessionHistory: async (input) => {
      assert.deepEqual(input.children, [])
      return []
    },
    getCachedModelId: () => 'cached-model',
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
      isHydrated: () => false,
      activateSession: () => {},
      setSessionFromHistory: () => {},
      setPendingQuestions: () => {},
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  const result = await service.loadSessionHistory(rootSessionId, { includeChildTranscripts: false })

  assert.equal(listCalls, 1)
  assert.equal(result.childGraphComplete, true)
  assert.equal(result.childLineage.length, childCount * 2)
  assert.equal(new Set(result.childLineage.map((child) => child.id)).size, childCount * 2)
})

test('createSessionHistoryService preserves the final message in histories longer than one safety window', async () => {
  const messageCount = 300
  const nativeMessages = Array.from({ length: messageCount }, (_, index) => ({
    id: `assistant-${index}`,
    type: 'assistant',
    time: { created: index + 1, completed: index + 1 },
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-5' },
    content: [{ type: 'text', id: `text-${index}`, text: `answer-${index}` }],
  }))
  let projectedMessageCount = 0
  let projectedFinalMessage: Record<string, unknown> | null = null

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
        messages: async () => ({ data: nativeMessages }),
        todo: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        get: async () => ({ data: null }),
        list: async () => ({ data: [] }),
      }, 'long-session'),
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
    projectSessionHistory: async (input) => {
      projectedMessageCount = input.rootMessages.length
      projectedFinalMessage = input.rootMessages.at(-1) as Record<string, unknown> | null
      return []
    },
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
      isHydrated: () => false,
      activateSession: () => {},
      setSessionFromHistory: () => {},
      setPendingQuestions: () => {},
      setPendingApprovals: () => {},
      getSessionView: () => createEmptySessionView(),
    },
  })

  await service.loadSessionHistory('long-session')

  assert.equal(projectedMessageCount, messageCount)
  assert.equal(projectedFinalMessage?.id, `assistant-${messageCount - 1}`)
  assert.equal(
    ((projectedFinalMessage?.parts as Array<Record<string, unknown>> | undefined)?.[0]?.text),
    `answer-${messageCount - 1}`,
  )
})

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
      client: createNativeHistoryClient({
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
      }, 'session-1'),
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
    sourceSessionId: 'session-1',
    taskRunId: null,
    tool: 'bash',
    input: { command: 'pwd' },
    description: 'Permission requested for bash',
  })
  assert.deepEqual(result.approvals[1], {
    id: 'perm-2',
    sessionId: 'session-1',
    sourceSessionId: 'grandchild-1',
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
  const sdkTitleUpdateOptions: Array<Record<string, unknown> | undefined> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
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
          update: async (input: Record<string, unknown>, options?: Record<string, unknown>) => {
            sdkTitleUpdates.push(input)
            sdkTitleUpdateOptions.push(options)
            return { data: {} }
          },
      }, 'session-title-fallback'),
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
  assert.deepEqual(sdkTitleUpdateOptions, [{ throwOnError: true }])
  assert.equal(updates[0]?.title, 'Please compare the Q2 launch risks and summarize the blockers.')
})

test('createSessionHistoryService preserves product-owned workflow titles before prompt fallback', async () => {
  const updates: Array<Record<string, unknown>> = []
  const sdkTitleUpdates: Array<Record<string, unknown>> = []
  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
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
      }, 'workflow-draft-session'),
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
        client: createNativeHistoryClient({
            messages: async () => ({ data: [] }),
            todo: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            diff: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            get: async () => ({ data: null }),
        }, 'session-2'),
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
      client: createNativeHistoryClient({
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
      }, 'session-3'),
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

test('createSessionHistoryService hydrates root history after loading child ids but before child transcripts', async () => {
  const view = createEmptySessionView()
  const calls = {
    children: 0,
    childSnapshot: 0,
    diff: 0,
    seedLineage: 0,
    setHistory: 0,
  }
  const syncOrder: string[] = []
  let writtenQuestions: SessionView['pendingQuestions'] = []
  let writtenApprovals: Array<Omit<SessionView['pendingApprovals'][number], 'order'>> = []
  const updates: Array<Record<string, unknown>> = []

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== 'session-progressive') calls.childSnapshot += 1
            return { data: [] }
          },
          todo: async () => ({ data: [] }),
          children: async ({ sessionID }: { sessionID: string }) => {
            calls.children += 1
            return {
              data: sessionID === 'session-progressive'
                ? [{ id: 'child-1', title: 'Analyst', parentID: 'session-progressive', time: { created: 1 } }]
                : [],
            }
          },
          diff: async () => {
            calls.diff += 1
            return { data: [] }
          },
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
      }, 'session-progressive'),
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({
      data: [{
        id: 'question-child',
        sessionID: 'child-1',
        questions: [{
          header: 'Child question',
          question: 'Need child context?',
          options: [{ label: 'Yes', description: 'Continue' }],
        }],
        tool: { messageID: 'message-child', callID: 'call-child' },
      }],
    }),
    listPendingPermissions: async () => ({
      data: [{
        id: 'approval-child',
        sessionID: 'child-1',
        permission: 'bash',
        tool: 'bash',
        metadata: { command: 'pwd' },
      }],
    }),
    projectSessionHistory: async (input) => {
      assert.deepEqual(input.children, [])
      return []
    },
    getCachedModelId: () => '',
    updateSessionRecord: (_sessionId, patch) => {
      updates.push(patch)
      return null
    },
    seedChildSessionLineage: (rootSessionId, children) => {
      calls.seedLineage += 1
      syncOrder.push('seedLineage')
      assert.equal(rootSessionId, 'session-progressive')
      assert.deepEqual(children, [{
        id: 'child-1',
        parentSessionId: 'session-progressive',
        title: 'Analyst',
        agent: null,
        status: 'queued',
        startedAt: '1970-01-01T00:16:40.000Z',
        finishedAt: null,
      }])
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
        syncOrder.push('setHistory')
      },
      setPendingQuestions: (_sessionId, questions) => {
        writtenQuestions = questions
      },
      setPendingApprovals: (_sessionId, approvals) => {
        writtenApprovals = approvals
      },
      getSessionView: () => view,
    },
  })

  const result = await service.syncSessionView('session-progressive', {
    activate: true,
    progressive: true,
  })

  assert.equal(result, view)
  assert.equal(calls.children, 2)
  assert.equal(calls.childSnapshot, 0)
  assert.equal(calls.diff, 0)
  assert.equal(calls.seedLineage, 1)
  assert.equal(calls.setHistory, 1)
  assert.deepEqual(syncOrder, ['seedLineage', 'setHistory'])
  assert.equal(writtenQuestions[0]?.sourceSessionId, 'child-1')
  assert.equal(writtenApprovals[0]?.taskRunId, 'child:child-1')
  assert.equal(service.isSessionPartiallyHydrated('session-progressive'), true)
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

test('createSessionHistoryService preserves existing child pending state when child graph refresh fails', async () => {
  const existingQuestion: SessionView['pendingQuestions'][number] = {
    id: 'question-child-existing',
    sessionId: 'session-incomplete-graph',
    sourceSessionId: 'child-missing',
    questions: [{
      header: 'Existing child question',
      question: 'Still waiting?',
      options: [{ label: 'Keep waiting', description: 'Preserve child prompt' }],
    }],
  }
  const existingApproval: SessionView['pendingApprovals'][number] = {
    id: 'approval-child-existing',
    sessionId: 'session-incomplete-graph',
    taskRunId: 'child:child-missing',
    tool: 'bash',
    input: { command: 'pnpm test' },
    description: 'Sub-Agent: bash',
    order: 7,
  }
  const staleRootApproval: SessionView['pendingApprovals'][number] = {
    id: 'approval-root-resolved',
    sessionId: 'session-incomplete-graph',
    sourceSessionId: null,
    taskRunId: null,
    tool: 'bash',
    input: { command: 'echo resolved' },
    description: 'Resolved root approval',
    order: 8,
  }
  const view: SessionView = {
    ...createEmptySessionView(),
    pendingQuestions: [existingQuestion],
    pendingApprovals: [existingApproval, staleRootApproval],
  }
  let writtenQuestions: SessionView['pendingQuestions'] = []
  let writtenApprovals: Array<Omit<SessionView['pendingApprovals'][number], 'order'>> = []
  let childrenCalls = 0

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          children: async () => {
            childrenCalls += 1
            throw new Error('child graph unavailable')
          },
          diff: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
      }, 'session-incomplete-graph'),
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({
      data: [{
        id: 'question-root',
        sessionID: 'session-incomplete-graph',
        questions: [{
          header: 'Root question',
          question: 'Proceed?',
          options: [{ label: 'Yes', description: 'Continue root work' }],
        }],
      }],
    }),
    listPendingPermissions: async () => ({
      data: [{
        id: 'approval-root',
        sessionID: 'session-incomplete-graph',
        permission: 'bash',
        tool: 'bash',
        metadata: { command: 'pwd' },
      }],
    }),
    projectSessionHistory: async (input) => {
      assert.deepEqual(input.children, [])
      return []
    },
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
      isHydrated: () => false,
      activateSession: () => {},
      setSessionFromHistory: () => {},
      setPendingQuestions: (_sessionId, questions) => {
        writtenQuestions = questions
      },
      setPendingApprovals: (_sessionId, approvals) => {
        writtenApprovals = approvals
      },
      getSessionView: () => view,
    },
  })

  await service.syncSessionView('session-incomplete-graph', {
    activate: true,
    progressive: true,
  })

  assert.equal(childrenCalls, 1)
  assert.deepEqual(writtenQuestions.map((question) => question.id), [
    'question-root',
    'question-child-existing',
  ])
  assert.deepEqual(writtenApprovals.map((approval) => approval.id), [
    'approval-root',
    'approval-child-existing',
  ])
  assert.equal(writtenApprovals.some((approval) => approval.id === staleRootApproval.id), false)
  assert.equal('order' in (writtenApprovals[1] || {}), false)
  assert.equal(service.isSessionPartiallyHydrated('session-incomplete-graph'), true)

  await service.syncSessionView('session-incomplete-graph', {
    force: true,
    activate: false,
  })

  assert.equal(childrenCalls, 2)
  assert.deepEqual(writtenQuestions.map((question) => question.id), [
    'question-root',
    'question-child-existing',
  ])
  assert.deepEqual(writtenApprovals.map((approval) => approval.id), [
    'approval-root',
    'approval-child-existing',
  ])
  assert.equal(service.isSessionPartiallyHydrated('session-incomplete-graph'), true)
})

test('createSessionHistoryService keeps partial hydration retryable until a full sync succeeds', async () => {
  const view = createEmptySessionView()
  const calls = {
    children: 0,
    setHistory: 0,
  }
  const projectedChildren: string[][] = []
  let hydrated = false

  const service = createSessionHistoryService({
    getSessionClient: async () => ({
      client: createNativeHistoryClient({
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
          children: async ({ sessionID }: { sessionID: string }) => {
            calls.children += 1
            return {
              data: sessionID === 'session-partial'
                ? [{ id: 'child-1', title: 'Analyst', parentID: 'session-partial', time: { created: 1 } }]
                : [],
            }
          },
          diff: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          get: async () => ({ data: null }),
      }, 'session-partial'),
      questionClient: {},
      record: null,
    }),
    listPendingQuestions: async () => ({ data: [] }),
    listPendingPermissions: async () => ({ data: [] }),
    projectSessionHistory: async (input) => {
      projectedChildren.push(input.children.map((child) => child.id))
      return []
    },
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
      isHydrated: () => hydrated,
      activateSession: () => {},
      setSessionFromHistory: () => {
        calls.setHistory += 1
        hydrated = true
      },
      setPendingQuestions: () => {},
      setPendingApprovals: () => {},
      getSessionView: () => view,
    },
  })

  await service.syncSessionView('session-partial', {
    activate: true,
    progressive: true,
  })
  assert.equal(service.isSessionPartiallyHydrated('session-partial'), true)
  assert.equal(calls.setHistory, 1)
  assert.equal(calls.children, 2)
  assert.deepEqual(projectedChildren, [[]])

  await service.syncSessionView('session-partial', {
    activate: true,
    progressive: true,
  })
  assert.equal(service.isSessionPartiallyHydrated('session-partial'), true)
  assert.equal(calls.setHistory, 1)
  assert.equal(calls.children, 2)
  assert.deepEqual(projectedChildren, [[]])

  await service.syncSessionView('session-partial', {
    force: true,
    activate: false,
  })
  assert.equal(service.isSessionPartiallyHydrated('session-partial'), false)
  assert.equal(calls.setHistory, 2)
  assert.equal(calls.children, 4)
  assert.deepEqual(projectedChildren, [[], ['child-1']])
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
        client: createNativeHistoryClient({
            messages: async () => ({ data: [] }),
            todo: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            diff: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            get: async () => ({ data: null }),
        }, 'session-4'),
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
        source: 'synthetic',
        synthetic: true,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
