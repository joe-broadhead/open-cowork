import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_PROJECTED_SESSION_EVENT_TYPES } from '@open-cowork/shared'
import type { BrowserWindow } from 'electron'
import {
  createSessionScopedMessageState,
  handleMessagePartDeltaEvent,
} from '../apps/desktop/src/main/event-message-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { consumePendingPromptEcho } from '../apps/desktop/src/main/event-task-state.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
import { LOCAL_WORKSPACE_ID, createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import {
  createIpcHandlerHarness as createBaseContext,
  emptySessionView,
  installCloudWorkspace,
  minimalCloudEventPayloadFor,
} from './support/ipc-handler-harness.ts'

function withPromptProviderConfig() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-prompt-provider-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const providerId = 'acme-provider'
  const modelId = 'live-model'

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: [providerId],
      defaultProvider: providerId,
      defaultModel: modelId,
      descriptors: {
        [providerId]: {
          runtime: 'builtin',
          name: 'Acme Provider',
          description: 'Acme provider',
          credentials: [],
          models: [
            { id: modelId, name: 'Live Model' },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  return {
    providerId,
    modelId,
    cleanup() {
      if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
      else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
      clearConfigCaches()
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

test('classic session mutations fail closed when the SDK returns an HTTP error response', async () => {
  const { context, handlers, errors } = createBaseContext()
  const optionsByMutation = new Map<string, Record<string, unknown> | undefined>()
  const failingMutation = (name: string) => async (
    _input: unknown,
    options?: Record<string, unknown>,
  ) => {
    optionsByMutation.set(name, options)
    if (options?.throwOnError === true) throw new Error(`${name} rejected`)
    return { error: { message: `${name} rejected` } }
  }

  context.getSessionClient = async () => ({
    client: {
      session: {
        unshare: failingMutation('unshare'),
        update: failingMutation('rename'),
        delete: failingMutation('delete'),
        command: failingMutation('command'),
      },
    } as any,
    record: null,
  })
  context.ensureSessionRecord = () => ({ id: 'session-mutation-errors' }) as never

  registerSessionHandlers(context)

  assert.equal(await handlers.get('session:unshare')?.({}, 'session-mutation-errors'), false)
  assert.equal(await handlers.get('session:rename')?.({}, 'session-mutation-errors', 'Renamed'), false)
  assert.equal(await handlers.get('command:run')?.({}, 'session-mutation-errors', 'review'), false)
  assert.equal(await handlers.get('session:delete')?.({}, 'session-mutation-errors', 'confirmed'), false)
  assert.deepEqual(Object.fromEntries(optionsByMutation), {
    unshare: { throwOnError: true },
    rename: { throwOnError: true },
    command: { throwOnError: true },
    delete: { throwOnError: true },
  })
  assert.equal(errors.filter((entry) => /rejected/.test(entry)).length, 4)
})

test('session id handlers reject malformed ids before session lookup', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = 0
  let registryRequested = 0

  context.getSessionClient = async () => {
    clientRequested += 1
    throw new Error('runtime should not be reached')
  }
  context.ensureSessionRecord = () => {
    registryRequested += 1
    return null
  }

  registerSessionHandlers(context)

  const cases: Array<{ channel: string; args: unknown[] }> = [
    { channel: 'session:activate', args: ['   '] },
    { channel: 'session:get', args: ['   '] },
    { channel: 'session:abort', args: ['   '] },
    { channel: 'session:abort-task', args: ['   ', 'child-session'] },
    { channel: 'session:abort-task', args: ['root-session', '   '] },
    { channel: 'session:fork', args: ['   '] },
    { channel: 'session:export', args: ['   '] },
    { channel: 'session:share', args: ['   '] },
    { channel: 'session:unshare', args: ['   '] },
    { channel: 'session:summarize', args: ['   '] },
    { channel: 'session:revert', args: ['   '] },
    { channel: 'session:unrevert', args: ['   '] },
    { channel: 'session:children', args: ['   '] },
    { channel: 'session:diff', args: ['   '] },
    { channel: 'session:delete', args: ['   ', 'token'] },
  ]

  for (const { channel, args } of cases) {
    const handler = handlers.get(channel)
    assert.ok(handler, `expected ${channel} handler to be registered`)
    await assert.rejects(async () => handler({}, ...args), /Session id/)
  }

  assert.equal(clientRequested, 0)
  assert.equal(registryRequested, 0)
})

test('session:children scopes native discovery to the recorded OpenCode directory', async () => {
  const { context, handlers } = createBaseContext()
  const listInputs: Array<Record<string, unknown>> = []
  context.getSessionClient = async () => ({
    client: {
      v2: {
        session: {
          list: async (input: Record<string, unknown>) => {
            listInputs.push(input)
            return {
              data: {
                data: [
                  { id: 'child-1', parentID: 'root-session' },
                  { id: 'unrelated', parentID: 'other-session' },
                ],
                cursor: {},
              },
            }
          },
        },
      },
    } as any,
    record: { opencodeDirectory: '/workspace/project' } as never,
  })

  registerSessionHandlers(context)
  const handler = handlers.get('session:children')
  assert.ok(handler, 'expected session:children handler to be registered')

  const children = await handler({}, 'root-session')

  assert.deepEqual(children.map((entry: { id: string }) => entry.id), ['child-1'])
  assert.equal(listInputs.length, 1)
  assert.equal(listInputs[0]?.directory, '/workspace/project')
})

test('session:prompt rejects oversized text before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'x'.repeat(1_000_001)),
    /Prompt text exceeds 1000000 bytes/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt rejects malformed argument tuples before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 123, 'hello'),
    /session id to be a string/,
  )
  assert.equal(clientRequested, false)
})

test('session handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => {
      calls.push('list')
      return [{
        id: 'cloud-session-1',
        title: 'Cloud thread',
        directory: null,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }]
    },
    createSession: async () => {
      calls.push('create')
      return {
        id: 'cloud-session-2',
        title: 'New cloud thread',
        directory: null,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    getSessionInfo: async (sessionId) => {
      calls.push(`get:${sessionId}`)
      return {
        id: sessionId,
        title: 'Cloud thread',
        directory: null,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    getSessionView: async (sessionId) => {
      calls.push(`activate:${sessionId}`)
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
      }
    },
    promptSession: async (sessionId, input) => {
      calls.push(`prompt:${sessionId}:${input.text}:${input.agent}`)
    },
    abortSession: async (sessionId) => {
      calls.push(`abort:${sessionId}`)
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => ({
        workspaceId: 'cloud:test',
        accessToken: 'cloud-access-token',
        refreshToken: null,
        expiresAt: '2030-05-27T12:00:00.000Z',
        tokenType: 'Bearer',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => ({
        workspaceId: 'cloud:test',
        accessToken: 'cloud-access-token',
        refreshToken: null,
        expiresAt: '2030-05-27T12:00:00.000Z',
        tokenType: 'Bearer',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerSessionHandlers(context)

  assert.equal((await handlers.get('session:list')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.id, 'cloud-session-1')
  assert.equal((await handlers.get('session:create')?.({}, undefined, { workspaceId: 'cloud:test' }))?.id, 'cloud-session-2')
  await assert.rejects(
    () => handlers.get('session:create')?.({}, '/Users/joe/project', { workspaceId: 'cloud:test' }),
    /Local project directories/,
  )
  assert.equal((await handlers.get('session:get')?.({}, 'cloud-session-1', { workspaceId: 'cloud:test' }))?.id, 'cloud-session-1')
  assert.equal((await handlers.get('session:activate')?.({}, 'cloud-session-1', { workspaceId: 'cloud:test' }))?.messages.length, 0)
  await handlers.get('session:prompt')?.({}, 'cloud-session-1', 'hello', [], 'data-analyst', { workspaceId: 'cloud:test' })
  await handlers.get('session:abort')?.({}, 'cloud-session-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(calls, [
    'list',
    'create',
    'get:cloud-session-1',
    'activate:cloud-session-1',
    'prompt:cloud-session-1:hello:data-analyst',
    'abort:cloud-session-1',
  ])
})

test('cloud session SSE publishes authoritative cloud projections instead of local views', async () => {
  const { context, handlers } = createBaseContext()
  const sentViews: unknown[] = []
  const sentPatches: unknown[] = []
  const sentNotifications: unknown[] = []
  let subscribedEventHandler: ((event: any) => void) | null = null
  let projectionFetches = 0
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      projectionFetches += 1
      return {
        messages: [{
          id: 'cloud-projected-message',
          role: 'assistant',
          segments: [{ id: 'segment-1', kind: 'text', text: 'from cloud projection' }],
          attachments: [],
          createdAt: 1,
        }],
        toolCalls: [],
        taskRuns: [],
        compactions: [],
        pendingApprovals: [{
          id: 'permission-1',
          taskRunId: null,
          tool: 'read',
          description: 'Read file',
          input: {},
          sourceSessionId: 'cloud-session-1',
        }],
        pendingQuestions: [],
        errors: [],
        todos: [],
        executionPlan: [],
        sessionCost: 0,
        sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        lastInputTokens: 0,
        contextState: 'running',
        compactionCount: 0,
        lastCompactedAt: null,
        activeAgent: null,
        lastItemWasTool: false,
        revision: 43,
        lastEventAt: 43,
        isGenerating: true,
        isAwaitingPermission: true,
        isAwaitingQuestion: false,
      }
    },
    promptSession: async () => {},
    abortSession: async () => {},
    subscribeSessionEvents: (_sessionId, input) => {
      subscribedEventHandler = input.onEvent
      return { close: () => {} }
    },
  }
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 202,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
        if (channel === 'session:patch') sentPatches.push(payload)
        if (channel === 'runtime:notification') sentNotifications.push(payload)
      },
    },
  } as any)
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => null,
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => {
        throw new Error('not used')
      },
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerSessionHandlers(context)
  const invokeEvent = { sender: { id: 202 } }
  context.workspaceGateway.activate(invokeEvent, 'cloud:test')
  await handlers.get('session:activate')?.(invokeEvent, 'cloud-session-1')
  assert.ok(subscribedEventHandler, 'expected cloud session event subscription')
  projectionFetches = 0

  subscribedEventHandler({
    type: 'permission.requested',
    sessionId: 'cloud-session-1',
    sequence: 42,
    payload: {
      permissionId: 'permission-1',
      tool: 'read',
      description: 'Read file',
    },
  })
  subscribedEventHandler({
    type: 'session.status',
    sessionId: 'cloud-session-1',
    sequence: 43,
    payload: { statusType: 'running' },
  })

  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(sentViews.length, 1)
  assert.equal(projectionFetches, 1)
  assert.equal(sentPatches.length, 0)
  assert.equal(sentNotifications.length, 0)
  assert.deepEqual(sentViews[0], {
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  })

  context.workspaceGateway.activate(invokeEvent, LOCAL_WORKSPACE_ID)
  subscribedEventHandler({
    type: 'assistant.message',
    sessionId: 'cloud-session-1',
    sequence: 44,
    payload: { messageId: 'm2', content: 'inactive event' },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(sentViews.length, 1)
})

test('cloud session SSE refreshes projected events and rehydrates snapshot-required retention gaps', async () => {
  const { context, handlers } = createBaseContext()
  const sentViews: unknown[] = []
  let subscribedEventHandler: ((event: any) => void) | null = null
  let latestProjectionRevision = 0
  let projectionFetches = 0
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      projectionFetches += 1
      return emptySessionView({
        revision: latestProjectionRevision,
        lastEventAt: latestProjectionRevision,
      })
    },
    promptSession: async () => {},
    abortSession: async () => {},
    subscribeSessionEvents: (_sessionId, input) => {
      subscribedEventHandler = input.onEvent
      return { close: () => {} }
    },
  }
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 205,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  installCloudWorkspace(context, adapter)

  registerSessionHandlers(context)
  const invokeEvent = { sender: { id: 205 } }
  context.workspaceGateway.activate(invokeEvent, 'cloud:test')
  await handlers.get('session:activate')?.(invokeEvent, 'cloud-session-projection-contract')
  assert.ok(subscribedEventHandler, 'expected cloud session event subscription')
  projectionFetches = 0
  sentViews.length = 0

  for (const type of CLOUD_PROJECTED_SESSION_EVENT_TYPES) {
    latestProjectionRevision += 1
    subscribedEventHandler({
      type,
      sessionId: 'cloud-session-projection-contract',
      sequence: latestProjectionRevision,
      payload: minimalCloudEventPayloadFor(type),
    })
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(
      sentViews.length,
      latestProjectionRevision,
      `${type} should publish the durable cloud projection`,
    )
    assert.deepEqual(sentViews[sentViews.length - 1], {
      sessionId: 'cloud-session-projection-contract',
      workspaceId: 'cloud:test',
      view: emptySessionView({
        revision: latestProjectionRevision,
        lastEventAt: latestProjectionRevision,
      }),
    })
  }

  const fetchesAfterProjectedEvents = projectionFetches
  const staleAfterSequence = latestProjectionRevision
  latestProjectionRevision += 10
  subscribedEventHandler({
    type: 'snapshot.required',
    sessionId: 'cloud-session-projection-contract',
    sequence: staleAfterSequence,
    payload: {
      reason: 'event_retention_gap',
      afterSequence: staleAfterSequence,
      earliestSequence: staleAfterSequence + 5,
      latestSequence: latestProjectionRevision,
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(sentViews.length, CLOUD_PROJECTED_SESSION_EVENT_TYPES.length + 1)
  assert.equal(projectionFetches, fetchesAfterProjectedEvents + 1)
  assert.deepEqual(sentViews[sentViews.length - 1], {
    sessionId: 'cloud-session-projection-contract',
    workspaceId: 'cloud:test',
    view: emptySessionView({
      revision: latestProjectionRevision,
      lastEventAt: latestProjectionRevision,
    }),
  })
})

test('cloud session SSE waits for projection revision to catch up before publishing full views', async () => {
  const { context, handlers, errors } = createBaseContext()
  const sentViews: unknown[] = []
  let subscribedEventHandler: ((event: any) => void) | null = null
  let projectionFetches = 0
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      projectionFetches += 1
      return emptySessionView({
        revision: projectionFetches === 1 ? 9 : 10,
        lastEventAt: projectionFetches === 1 ? 9 : 10,
      })
    },
    promptSession: async () => {},
    abortSession: async () => {},
    subscribeSessionEvents: (_sessionId, input) => {
      subscribedEventHandler = input.onEvent
      return { close: () => {} }
    },
  }
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 204,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  installCloudWorkspace(context, adapter)

  registerSessionHandlers(context)
  const invokeEvent = { sender: { id: 204 } }
  context.workspaceGateway.activate(invokeEvent, 'cloud:test')
  await handlers.get('session:activate')?.(invokeEvent, 'cloud-session-stale')
  assert.ok(subscribedEventHandler, 'expected cloud session event subscription')
  projectionFetches = 0

  subscribedEventHandler({
    type: 'assistant.message',
    sessionId: 'cloud-session-stale',
    sequence: 10,
    payload: { messageId: 'm1', content: 'fresh stream event' },
  })

  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(sentViews.length, 0)
  assert.equal(errors.some((entry) => entry.includes('behind event sequence 10')), true)

  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(projectionFetches, 2)
  assert.equal(sentViews.length, 1)
  assert.deepEqual(sentViews[0], {
    sessionId: 'cloud-session-stale',
    workspaceId: 'cloud:test',
    view: emptySessionView({ revision: 10, lastEventAt: 10 }),
  })
})

test('cloud projection refresh errors back off repeated full-view fetches', async () => {
  const { context, handlers, errors } = createBaseContext()
  let subscribedEventHandler: ((event: any) => void) | null = null
  let projectionFetches = 0
  let failProjectionRefresh = false
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      projectionFetches += 1
      if (failProjectionRefresh) throw new Error('temporary projection outage')
      return emptySessionView({ revision: 1, lastEventAt: 1 })
    },
    promptSession: async () => {},
    abortSession: async () => {},
    subscribeSessionEvents: (_sessionId, input) => {
      subscribedEventHandler = input.onEvent
      return { close: () => {} }
    },
  }
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 203,
      send: () => {},
    },
  } as any)
  installCloudWorkspace(context, adapter)

  registerSessionHandlers(context)
  const invokeEvent = { sender: { id: 203 } }
  context.workspaceGateway.activate(invokeEvent, 'cloud:test')
  await handlers.get('session:activate')?.(invokeEvent, 'cloud-session-backoff')
  assert.ok(subscribedEventHandler, 'expected cloud session event subscription')
  projectionFetches = 0
  failProjectionRefresh = true

  subscribedEventHandler({
    type: 'permission.requested',
    sessionId: 'cloud-session-backoff',
    sequence: 10,
    payload: { permissionId: 'permission-1', tool: 'read' },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(projectionFetches, 1)
  assert.equal(errors.some((entry) => entry.includes('temporary projection outage')), true)

  subscribedEventHandler({
    type: 'session.status',
    sessionId: 'cloud-session-backoff',
    sequence: 11,
    payload: { statusType: 'running' },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(projectionFetches, 1)
})

test('session:prompt rejects too many attachments before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }
  const attachments = Array.from({ length: 11 }, (_, index) => ({
    mime: 'image/png',
    url: `data:image/png;base64,${index}`,
    filename: `image-${index}.png`,
  }))

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'hello', attachments),
    /Prompt attachments exceed 10 files/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt rejects non-data attachment URLs before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'hello', [{
      mime: 'image/png',
      url: 'file:///Users/example/private.png',
      filename: 'private.png',
    }]),
    /URL must be a base64 data URL/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt dispatch failure does not suppress a later matching runtime text event', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-failure'
  const promptText = 'hello from optimistic prompt'
  let promptCalled = false
  context.getSessionClient = async () => ({
    client: {
      v2: {
        provider: {
          list: async () => ({ data: { data: [] } }),
        },
        model: {
          list: async () => ({ data: { data: [] } }),
        },
        session: {
          get: async () => ({ data: { data: { id: sessionId, agent: 'build', model: null } } }),
          switchAgent: async () => {},
          switchModel: async () => {},
          prompt: async () => {
            promptCalled = true
            throw new Error('dispatch failed')
          },
        },
      },
    } as any,
    record: null,
  })

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, sessionId, promptText),
    /dispatch failed/i,
  )
  assert.equal(promptCalled, true)

  const projectedEvents: unknown[] = []
  handleMessagePartDeltaEvent(
    {} as BrowserWindow,
    (_win, event) => projectedEvents.push(event),
    {
      sessionID: sessionId,
      delta: promptText,
      part: { type: 'text' },
    },
    createSessionScopedMessageState(),
  )

  assert.deepEqual(projectedEvents, [{
    type: 'text',
    sessionId,
    data: {
      type: 'text',
      mode: 'append',
      content: promptText,
      taskRunId: null,
      sourceSessionId: sessionId,
      messageId: null,
      partId: null,
    },
  }])
})

test('session:prompt forwards an OpenCode model variant when the runtime catalog exposes it', async () => {
  const { providerId, modelId, cleanup } = withPromptProviderConfig()
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-variant'
  const promptPayloads: Array<Record<string, unknown>> = []
  const switchModelPayloads: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        v2: {
          provider: {
            list: async () => ({
              data: { data: [{
                id: providerId,
                name: 'Acme Provider',
              }] },
            }),
          },
          model: {
            list: async () => ({
              data: { data: [{
                id: modelId,
                providerID: providerId,
                name: 'Live Model',
                capabilities: { tools: true, input: ['text'], output: ['text'] },
                cost: [],
                variants: [{ id: 'xhigh' }, { id: 'low' }],
                time: { released: 0 },
                status: 'active',
                enabled: true,
                limit: { context: 128_000, output: 16_000 },
              }] },
            }),
          },
          session: {
            get: async () => ({ data: { data: { id: sessionId, agent: 'build', model: null } } }),
            switchAgent: async () => {},
            switchModel: async (payload: Record<string, unknown>) => {
              switchModelPayloads.push(payload)
            },
            prompt: async (payload: Record<string, unknown>) => {
              promptPayloads.push(payload)
              return { data: { data: { id: 'input-1', sessionID: sessionId } } }
            },
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('session:prompt')
    assert.ok(handler, 'expected session:prompt handler to be registered')

    await handler({}, sessionId, 'analyze with more reasoning', undefined, 'build', { variant: 'xhigh' })

    assert.equal(promptPayloads.length, 1)
    assert.deepEqual(switchModelPayloads, [{
      sessionID: sessionId,
      model: {
        providerID: providerId,
        id: modelId,
        variant: 'xhigh',
      },
    }])
    assert.deepEqual(promptPayloads[0], {
      sessionID: sessionId,
      prompt: { text: 'analyze with more reasoning' },
      delivery: 'queue',
      resume: true,
    })
  } finally {
    consumePendingPromptEcho(sessionId, 'analyze with more reasoning')
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
    cleanup()
  }
})

test('session:prompt ignores disabled model variants before runtime dispatch', async () => {
  const { providerId, modelId, cleanup } = withPromptProviderConfig()
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-invalid-variant'
  const promptPayloads: Array<Record<string, unknown>> = []
  const switchModelPayloads: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        v2: {
          provider: {
            list: async () => ({
              data: { data: [{
                id: providerId,
                name: 'Acme Provider',
              }] },
            }),
          },
          model: {
            list: async () => ({
              data: { data: [{
                id: modelId,
                providerID: providerId,
                name: 'Live Model',
                capabilities: { tools: true, input: ['text'], output: ['text'] },
                cost: [],
                variants: [{ id: 'low' }, { id: 'xhigh', disabled: true }],
                time: { released: 0 },
                status: 'active',
                enabled: true,
                limit: { context: 128_000, output: 16_000 },
              }] },
            }),
          },
          session: {
            get: async () => ({ data: { data: { id: sessionId, agent: 'build', model: null } } }),
            switchAgent: async () => {},
            switchModel: async (payload: Record<string, unknown>) => {
              switchModelPayloads.push(payload)
            },
            prompt: async (payload: Record<string, unknown>) => {
              promptPayloads.push(payload)
              return { data: { data: { id: 'input-2', sessionID: sessionId } } }
            },
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('session:prompt')
    assert.ok(handler, 'expected session:prompt handler to be registered')

    await handler({}, sessionId, 'try a stale reasoning variant', undefined, 'build', { variant: 'xhigh' })

    assert.equal(promptPayloads.length, 1)
    assert.deepEqual(switchModelPayloads, [{
      sessionID: sessionId,
      model: {
        providerID: providerId,
        id: modelId,
      },
    }])
  } finally {
    consumePendingPromptEcho(sessionId, 'try a stale reasoning variant')
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
    cleanup()
  }
})

test('session:create rejects renderer-supplied project directories without a native-picker grant', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.normalizeDirectory = () => {
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:create')

  assert.ok(handler, 'expected session:create handler to be registered')
  await assert.rejects(
    () => handler({}, '/etc'),
    /native directory picker/,
  )
  assert.equal(clientRequested, false)
})
