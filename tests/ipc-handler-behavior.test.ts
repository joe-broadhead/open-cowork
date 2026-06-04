import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomMcpConfig, DesktopPairingPublicRecord } from '@open-cowork/shared'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers, resolveSafeSaveTextPath, saveTextExportFile } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import {
  decodeCloudArtifactDataUrl,
  registerArtifactHandlers,
  safeArtifactExportFilename,
} from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { normalizeFindTextPattern, registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'
import { registerWorkflowHandlers } from '../apps/desktop/src/main/ipc/workflow-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { registerThreadHandlers } from '../apps/desktop/src/main/ipc/thread-handlers.ts'
import { registerDesktopPairingHandlers } from '../apps/desktop/src/main/ipc/desktop-pairing-handlers.ts'
import { sniffImageMime } from '../apps/desktop/src/main/ipc/app-handler-support.ts'
import { validateCustomSkillConfig } from '../apps/desktop/src/main/ipc/object-validators.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { consumePendingPromptEcho } from '../apps/desktop/src/main/event-task-state.ts'
import { sessionEngine } from '../apps/desktop/src/main/session-engine.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'
import { LOCAL_WORKSPACE_ID, createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import { runtimeState } from '../apps/desktop/src/main/runtime-state.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'

function createBaseContext() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const errors: string[] = []
  const context: IpcHandlerContext = {
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => any) {
        handlers.set(channel, handler)
      },
      on() {},
    },
    workspaceGateway: createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null }),
    desktopPairingService: {
      list: () => [],
      get: () => null,
      create: () => { throw new Error('not stubbed') },
      update: () => { throw new Error('not stubbed') },
      connect: async () => { throw new Error('not stubbed') },
      disconnect: () => { throw new Error('not stubbed') },
      revoke: async () => { throw new Error('not stubbed') },
      pollOnce: async () => { throw new Error('not stubbed') },
      auditLog: () => [],
      observeRuntimeEvent: () => {},
    } as never,
    getMainWindow: () => null,
    normalizeDirectory: () => '/tmp',
    ensureSessionRecord: () => null,
    resolvePrivateArtifactPath: () => ({ root: '/tmp', source: '/tmp/file.txt' }),
    grantProjectDirectory: (directory) => directory,
    resolveGrantedProjectDirectory: (directory) => directory || null,
    resolveContextDirectory: () => null,
    resolveScopedTarget: (target) => ({ ...target, directory: target.directory || null }),
    buildCustomAgentPermission: async () => ({}),
    requestNativeConfirmation: async () => true,
    logHandlerError: (handler, err) => {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${handler}: ${message}`)
    },
    describeDestructiveRequest: () => 'test-target',
    consumeDestructiveConfirmation: () => true,
    reconcileIdleSession: () => {},
    getSessionClient: async () => {
      throw new Error('not stubbed')
    },
    getSessionV2Client: async () => {
      throw new Error('not stubbed')
    },
    listRuntimeTools: async () => [],
    withDiscoveredBuiltInTools: async (tools) => tools,
    listToolsFromMcpEntry: async () => [],
    isLikelyMcpAuthError: () => false,
    authenticateNewRemoteMcpIfNeeded: async () => {},
    approvedSkillImportDirectories: new Map(),
    capabilityToolMethodCache: new Map(),
  }

  return { context, handlers, errors }
}

function writeCredentialDescriptorConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    providers: {
      available: ['acme'],
      defaultProvider: 'acme',
      defaultModel: 'acme/model',
      descriptors: {
        acme: {
          runtime: 'builtin',
          name: 'Acme',
          description: 'Acme provider',
          defaultModel: 'acme/model',
          credentials: [
            { key: 'apiKey', label: 'API key', description: 'Secret API key', secret: true },
            { key: 'projectId', label: 'Project', description: 'Visible project id', secret: false },
          ],
          models: [{ id: 'acme/model', name: 'Acme Model' }],
        },
      },
    },
    mcps: [{
      name: 'github',
      type: 'remote',
      description: 'GitHub',
      authMode: 'api_token',
      url: 'https://mcp.example.test/github',
      credentials: [
        { key: 'token', label: 'Token', description: 'Secret token', secret: true },
        { key: 'host', label: 'Host', description: 'Visible host', secret: false },
      ],
    }],
  }))
}

function desktopPairingRecord(overrides: Partial<DesktopPairingPublicRecord> = {}): DesktopPairingPublicRecord {
  return {
    id: 'pairing-1',
    label: 'Phone Gateway',
    deviceName: 'Phone',
    status: 'disabled',
    enabled: false,
    brokerUrl: 'https://gateway.example.test',
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: null,
    policy: {
      allowRemotePrompts: true,
      allowRemoteAbort: true,
      remoteApprovals: 'local_confirmation',
      remoteQuestions: 'local_confirmation',
      exposeArtifactBodies: false,
      exposeLocalPaths: false,
      exposeLocalMcpDetails: false,
      allowRemoteAttachments: false,
    },
    lastConnectedAt: null,
    lastHeartbeatAt: null,
    lastCommandSequence: 0,
    error: null,
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T09:00:00.000Z',
    revokedAt: null,
    credential: {
      hasToken: true,
      deviceId: 'device-1',
      updatedAt: '2026-05-27T09:00:00.000Z',
    },
    ...overrides,
  }
}

function emptySessionView(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
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

test('desktop-pairing:create requires native confirmation before minting a token', async () => {
  const { context, handlers } = createBaseContext()
  let createCalled = false
  let confirmationDetail = ''
  context.requestNativeConfirmation = async (options) => {
    confirmationDetail = options.detail || ''
    return false
  }
  context.desktopPairingService = {
    ...context.desktopPairingService,
    create: () => {
      createCalled = true
      throw new Error('should not mint token')
    },
  } as never

  registerDesktopPairingHandlers(context)

  await assert.rejects(
    () => handlers.get('desktop-pairing:create')?.({}, {
      label: 'Phone',
      brokerUrl: 'https://gateway.example.test/connect',
      enabled: true,
    }),
    /creation cancelled/,
  )
  assert.equal(createCalled, false)
  assert.match(confirmationDetail, /Broker: https:\/\/gateway\.example\.test/)
  assert.match(confirmationDetail, /Workspaces: local/)
})

test('desktop-pairing:update confirms authority changes but not metadata-only edits', async () => {
  const { context, handlers } = createBaseContext()
  const record = desktopPairingRecord()
  const confirmations: string[] = []
  const updates: unknown[] = []
  context.requestNativeConfirmation = async (options) => {
    confirmations.push(options.detail || '')
    return true
  }
  context.desktopPairingService = {
    ...context.desktopPairingService,
    get: () => record,
    update: (_pairingId: string, input: unknown) => {
      updates.push(input)
      return record
    },
  } as never

  registerDesktopPairingHandlers(context)

  await handlers.get('desktop-pairing:update')?.({}, 'pairing-1', { label: 'New label' })
  assert.equal(confirmations.length, 0)

  await handlers.get('desktop-pairing:update')?.({}, 'pairing-1', {
    enabled: true,
    brokerUrl: 'https://new-gateway.example.test',
    policy: { allowRemotePrompts: false },
  })
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0], /Change: enable remote connection/)
  assert.match(confirmations[0], /Change: broker URL/)
  assert.match(confirmations[0], /allowRemotePrompts: false/)
  assert.equal(updates.length, 2)
})

test('desktop-pairing:connect requires confirmation before enabling a disabled pairing', async () => {
  const { context, handlers } = createBaseContext()
  const record = desktopPairingRecord({ enabled: false })
  let confirmed = false
  let connected = false
  context.requestNativeConfirmation = async () => {
    confirmed = true
    return false
  }
  context.desktopPairingService = {
    ...context.desktopPairingService,
    get: () => record,
    connect: async () => {
      connected = true
      throw new Error('should not connect')
    },
  } as never

  registerDesktopPairingHandlers(context)

  await assert.rejects(
    () => handlers.get('desktop-pairing:connect')?.({}, 'pairing-1'),
    /enable cancelled/,
  )
  assert.equal(confirmed, true)
  assert.equal(connected, false)
})

function installCloudWorkspace(context: IpcHandlerContext, adapter: CloudWorkspaceSessionAdapter) {
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
}

function withPromptProviderConfig() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-prompt-provider-'))
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

test('session:delete refuses to delete without a valid destructive confirmation', async () => {
  const { context, handlers, errors } = createBaseContext()
  let deleteCalled = false

  context.getSessionClient = async () => ({
    client: {
      session: {
        delete: async () => {
          deleteCalled = true
        },
      },
    } as any,
    record: null,
  })
  context.consumeDestructiveConfirmation = () => false

  registerSessionHandlers(context)
  const handler = handlers.get('session:delete')

  assert.ok(handler, 'expected session:delete handler to be registered')
  const result = await handler({}, 'session-1', null)

  assert.equal(result, false)
  assert.equal(deleteCalled, false)
  assert.match(errors[0] || '', /Confirmation required before deleting a thread/)
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

test('session:prompt clears pending prompt echo when dispatch fails', async () => {
  const { context, handlers } = createBaseContext()
  let promptCalled = false
  context.getSessionClient = async () => ({
    client: {
      provider: {
        list: async () => ({
          data: [],
        }),
        auth: async () => ({ data: {} }),
      },
      session: {
        promptAsync: async () => {
          promptCalled = true
          throw new Error('dispatch failed')
        },
      },
    } as any,
    record: null,
  })

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-prompt-failure', 'hello from optimistic prompt'),
    /dispatch failed/i,
  )
  assert.equal(promptCalled, true)
  assert.equal(
    consumePendingPromptEcho('session-prompt-failure', 'hello from optimistic prompt'),
    'hello from optimistic prompt',
  )
})

test('session:prompt forwards an OpenCode model variant when the runtime catalog exposes it', async () => {
  const { providerId, modelId, cleanup } = withPromptProviderConfig()
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-variant'
  const promptPayloads: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: providerId,
                name: 'Acme Provider',
                models: {
                  [modelId]: {
                    name: 'Live Model',
                    variants: {
                      xhigh: {},
                      low: {},
                    },
                  },
                },
              }],
              default: { [providerId]: modelId },
              connected: [providerId],
            },
          }),
          auth: async () => ({ data: {} }),
        },
        session: {
          promptAsync: async (payload: Record<string, unknown>) => {
            promptPayloads.push(payload)
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
    assert.equal(promptPayloads[0]?.variant, 'xhigh')
    assert.deepEqual(promptPayloads[0]?.model, {
      providerID: providerId,
      modelID: modelId,
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

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: providerId,
                name: 'Acme Provider',
                models: {
                  [modelId]: {
                    name: 'Live Model',
                    variants: {
                      low: {},
                      xhigh: { disabled: true },
                    },
                  },
                },
              }],
              default: { [providerId]: modelId },
              connected: [providerId],
            },
          }),
          auth: async () => ({ data: {} }),
        },
        session: {
          promptAsync: async (payload: Record<string, unknown>) => {
            promptPayloads.push(payload)
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
    assert.equal('variant' in promptPayloads[0]!, false)
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

test('workflow mutation handlers reject malformed workflow ids before service calls', async () => {
  const { context, handlers } = createBaseContext()

  registerWorkflowHandlers(context)
  const handler = handlers.get('workflows:run-now')

  assert.ok(handler, 'expected workflows:run-now handler to be registered')
  await assert.rejects(
    () => handler({}, { id: 'workflow-1' }),
    /workflow id to be a string/,
  )
})

test('workflow handlers route cloud workspace operations through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { workflows: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listWorkflows: async () => {
      calls.push('list')
      return { workflows: [], runs: [] }
    },
    getWorkflow: async (workflowId) => {
      calls.push(`get:${workflowId}`)
      return null
    },
    runWorkflow: async (workflowId) => {
      calls.push(`run:${workflowId}`)
      return null
    },
    pauseWorkflow: async (workflowId) => {
      calls.push(`pause:${workflowId}`)
      return null
    },
    resumeWorkflow: async (workflowId) => {
      calls.push(`resume:${workflowId}`)
      return null
    },
    archiveWorkflow: async (workflowId) => {
      calls.push(`archive:${workflowId}`)
      return null
    },
  }
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

  registerWorkflowHandlers(context)

  await handlers.get('workflows:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('workflows:get')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:run-now')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:pause')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:resume')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:archive')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(calls, [
    'list',
    'get:workflow-1',
    'run:workflow-1',
    'pause:workflow-1',
    'resume:workflow-1',
    'archive:workflow-1',
  ])

  context.workspaceGateway.activate({}, 'cloud:test')
  await assert.rejects(
    () => handlers.get('workflows:start-draft')?.({}, undefined),
    /Local workspace/,
  )
})

test('settings:set rejects non-object payloads before saving settings', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('settings:set')

  assert.ok(handler, 'expected settings:set handler to be registered')
  await assert.rejects(
    () => handler({}, null),
    /settings update to be an object/,
  )
})

test('sniffImageMime accepts only image magic bytes', () => {
  assert.equal(sniffImageMime(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png')
  assert.equal(sniffImageMime(Buffer.from('ffd8ffe000104a464946', 'hex')), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('4749463839610000', 'hex')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.from('524946460000000057454250', 'hex')), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('not really an image')), null)
})

test('custom content write handlers reject malformed objects before save paths', async () => {
  const { context, handlers } = createBaseContext()
  let confirmed = false
  context.requestNativeConfirmation = async () => {
    confirmed = true
    return true
  }

  registerCustomContentHandlers(context)
  const addSkill = handlers.get('custom:add-skill')
  const addMcp = handlers.get('custom:add-mcp')

  assert.ok(addSkill, 'expected custom:add-skill handler to be registered')
  assert.ok(addMcp, 'expected custom:add-mcp handler to be registered')
  await assert.rejects(
    () => addSkill({}, []),
    /custom skill to be an object/,
  )
  await assert.rejects(
    () => addMcp({}, 'not-an-object'),
    /custom MCP to be an object/,
  )
  assert.equal(confirmed, false)
})

test('custom skill IPC validation preserves authored content bytes', () => {
  const skillContent = '  Skill body\n\nkeep intentional trailing newline\n'
  const paddedContent = '  keep leading whitespace\nand trailing whitespace  \n'
  const validated = validateCustomSkillConfig({
    scope: 'machine',
    name: 'test-skill',
    content: skillContent,
    files: [
      { path: 'notes.txt', content: paddedContent },
      { path: 'empty.txt', content: '' },
    ],
  })

  assert.equal(validated.content, skillContent)
  assert.equal(validated.files?.[0]?.content, paddedContent)
  assert.equal(validated.files?.[1]?.content, '')
  assert.throws(
    () => validateCustomSkillConfig({ scope: 'machine', name: 'empty-skill', content: '   \n' }),
    /Skill content is required/,
  )
})

test('explorer:file-read returns null for ungranted renderer-supplied directories', async () => {
  const { context, handlers, errors } = createBaseContext()
  context.resolveGrantedProjectDirectory = () => {
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }

  registerExplorerHandlers(context)
  const handler = handlers.get('explorer:file-read')

  assert.ok(handler, 'expected explorer:file-read handler to be registered')
  const result = await handler({}, '/etc/passwd', '/etc')

  assert.equal(result, null)
  assert.match(errors[0] || '', /explorer:directory/)
  assert.match(errors[0] || '', /native directory picker/)
})

test('explorer find-text pattern validation caps costly regex input', () => {
  assert.equal(normalizeFindTextPattern('  TODO  '), 'TODO')
  assert.equal(normalizeFindTextPattern('   '), null)
  assert.throws(() => normalizeFindTextPattern('x'.repeat(513)), /exceeds 512 bytes/)
  assert.throws(() => normalizeFindTextPattern('(a+)+$'), /nested quantifier/)
})

test('artifact:read-attachment rejects private files that were not surfaced by the session', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-unsurfaced-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/secret.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('artifact:read-attachment rejects non-object payloads before artifact resolution', async () => {
  const { context, handlers } = createBaseContext()
  let resolved = false
  context.resolvePrivateArtifactPath = () => {
    resolved = true
    throw new Error('artifact should not be resolved')
  }

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:read-attachment')

  assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-an-object'),
    /artifact request to be an object/,
  )
  assert.equal(resolved, false)
})

test('artifact:read-attachment authorizes the resolved artifact path, not a renderer-supplied alias', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-resolved-source-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'tool_call',
        id: 'write-link',
        name: 'write',
        status: 'complete',
        input: { filePath: '/tmp/open-cowork-private-workspace/link.txt' },
      },
    })
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/link.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('permission:respond can answer a reopened approval using the hydrated session id', async () => {
  const { context, handlers } = createBaseContext()
  const replies: Array<Record<string, unknown>> = []
  let requestedSessionId: string | null = null

  context.getSessionV2Client = async (sessionId) => {
    requestedSessionId = sessionId
    return {
      client: {
        permission: {
          reply: async (payload: Record<string, unknown>) => {
            replies.push(payload)
          },
        },
      } as any,
      record: null,
    }
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')

  assert.ok(handler, 'expected permission:respond handler to be registered')
  await handler({}, 'perm-1', true, 'session-reopened')

  assert.equal(requestedSessionId, 'session-reopened')
  assert.deepEqual(replies, [{
    requestID: 'perm-1',
    reply: 'once',
  }])
})

test('permission:respond routes cloud approvals through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const permissionResponses: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
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
    getSessionView: async () => emptySessionView({
      revision: 10,
      lastEventAt: 10,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    respondToPermission: async (sessionId, permissionId, allowed) => {
      permissionResponses.push({ sessionId, permissionId, allowed })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 301,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')
  assert.ok(handler, 'expected permission:respond handler to be registered')

  await handler({ sender: { id: 301 } }, 'permission-cloud', true, 'cloud-session-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(permissionResponses, [{
    sessionId: 'cloud-session-1',
    permissionId: 'permission-cloud',
    allowed: true,
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})

test('question:reply clears the answered request locally so queued questions advance', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reply-session'
  const replies: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-1',
        questions: [{
          header: 'First',
          question: 'Pick the first answer',
          options: [{ label: 'A', description: 'Alpha' }],
        }],
      },
    })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-2',
        questions: [{
          header: 'Second',
          question: 'Pick the second answer',
          options: [{ label: 'B', description: 'Beta' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 101,
        send: (channel: string, payload: unknown) => {
          if (channel === 'session:view') sentViews.push(payload)
        },
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        question: {
          reply: async (payload: Record<string, unknown>) => {
            replies.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reply')
    assert.ok(handler, 'expected question:reply handler to be registered')

    await handler({}, sessionId, 'question-1', [['A']])

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(replies, [{
      requestID: 'question-1',
      answers: [['A']],
    }])
    assert.equal(view.pendingQuestions.length, 1)
    assert.equal(view.pendingQuestions[0]?.id, 'question-2')
    assert.equal(view.isAwaitingQuestion, true)

    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(sentViews.length > 0, true)
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

test('question:reply routes cloud answers through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const questionReplies: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
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
    getSessionView: async () => emptySessionView({
      revision: 11,
      lastEventAt: 11,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    replyToQuestion: async (sessionId, requestId, answers) => {
      questionReplies.push({ sessionId, requestId, answers })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 302,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reply')
  assert.ok(handler, 'expected question:reply handler to be registered')

  await handler({ sender: { id: 302 } }, 'cloud-session-1', 'question-cloud', [['Yes']], { workspaceId: 'cloud:test' })

  assert.deepEqual(questionReplies, [{
    sessionId: 'cloud-session-1',
    requestId: 'question-cloud',
    answers: [['Yes']],
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})

test('session:file-snippet rejects oversized files before reading snippet contents', async () => {
  const { context, handlers } = createBaseContext()
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-snippet-'))
  try {
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'))
    upsertSessionRecord(toSessionRecord({
      id: 'session-large-snippet',
      title: 'Large snippet',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: root,
    }))

    registerSessionHandlers(context)
    const handler = handlers.get('session:file-snippet')

    assert.ok(handler, 'expected session:file-snippet handler to be registered')
    await assert.rejects(
      () => handler({}, {
        sessionId: 'session-large-snippet',
        filePath: 'large.txt',
        startLine: 1,
        endLine: 2,
      }),
      /too large/,
    )
  } finally {
    clearSessionRegistryCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('question:reply rejects malformed answers before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionV2Client = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reply')
  assert.ok(handler, 'expected question:reply handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-question-bounds', 'question-1', 'not-an-array'),
    /Question answers must be an array/,
  )
  assert.equal(clientRequested, false)
})

test('command:run rejects oversized command names before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('command:run')
  assert.ok(handler, 'expected command:run handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-command-bounds', 'x'.repeat(257)),
    /Command name exceeds 256 bytes/,
  )
  assert.equal(clientRequested, false)
})

test('session:rename rejects empty titles before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:rename')
  assert.ok(handler, 'expected session:rename handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-rename-bounds', '   '),
    /Session title is required/,
  )
  assert.equal(clientRequested, false)
})

test('question:reject clears the rejected request locally', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reject-session'
  const rejects: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-reject',
        questions: [{
          header: 'Reject',
          question: 'Should this be dismissed?',
          options: [{ label: 'Dismiss', description: 'Dismiss it' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 102,
        send: () => {},
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        question: {
          reject: async (payload: Record<string, unknown>) => {
            rejects.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reject')
    assert.ok(handler, 'expected question:reject handler to be registered')

    await handler({}, sessionId, 'question-reject')

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(rejects, [{ requestID: 'question-reject' }])
    assert.equal(view.pendingQuestions.length, 0)
    assert.equal(view.isAwaitingQuestion, false)

    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

test('question:reject routes cloud dismissals through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const questionRejects: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
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
    getSessionView: async () => emptySessionView({
      revision: 12,
      lastEventAt: 12,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    rejectQuestion: async (sessionId, requestId) => {
      questionRejects.push({ sessionId, requestId })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 303,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reject')
  assert.ok(handler, 'expected question:reject handler to be registered')

  await handler({ sender: { id: 303 } }, 'cloud-session-1', 'question-cloud', { workspaceId: 'cloud:test' })

  assert.deepEqual(questionRejects, [{
    sessionId: 'cloud-session-1',
    requestId: 'question-cloud',
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})

test('custom:test-mcp reports OAuth guidance for remote MCP auth errors', async () => {
  const { context, handlers, errors } = createBaseContext()
  const mcp: CustomMcpConfig = {
    name: 'nova',
    type: 'http',
    url: 'https://93.184.216.34/mcp',
    scope: 'machine',
    directory: null,
  }

  context.listToolsFromMcpEntry = async () => {
    throw new Error('401 unauthorized')
  }
  context.isLikelyMcpAuthError = () => true

  registerCustomContentHandlers(context)
  const handler = handlers.get('custom:test-mcp')

  assert.ok(handler, 'expected custom:test-mcp handler to be registered')
  const result = await handler({}, mcp)

  assert.deepEqual(result.methods, [])
  assert.equal(result.ok, false)
  assert.equal(result.authRequired, true)
  assert.match(result.error || '', /require OAuth/i)
  assert.match(result.error || '', /authenticate.*status panel/i)
  assert.match(errors[0] || '', /custom:test-mcp nova/)
})

test('dialog:save-text rejects oversized renderer content before opening a save dialog', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('dialog:save-text')

  assert.ok(handler, 'expected dialog:save-text handler to be registered')
  await assert.rejects(
    () => handler({}, 'agent.cowork-agent.json', 'x'.repeat((2 * 1024 * 1024) + 1)),
    /Save content is too large/,
  )
})

test('chart:render-svg rejects non-object renderer payloads before rendering', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('chart:render-svg')

  assert.ok(handler, 'expected chart:render-svg handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-a-spec'),
    /chart specification to be an object/,
  )
})

test('tool:list rejects malformed options before runtime tool discovery', async () => {
  const { context, handlers } = createBaseContext()
  let runtimeToolListCalled = false
  context.listRuntimeTools = async () => {
    runtimeToolListCalled = true
    return []
  }

  registerCatalogHandlers(context)
  const handler = handlers.get('tool:list')

  assert.ok(handler, 'expected tool:list handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-options'),
    /tool list options to be an object/,
  )
  assert.equal(runtimeToolListCalled, false)
})

test('settings:set rejects unknown and malformed settings payloads before saving', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('settings:set')

  assert.ok(handler, 'expected settings:set handler to be registered')
  await assert.rejects(
    () => handler({}, { unknownSetting: true }),
    /Unknown settings key/,
  )
  await assert.rejects(
    () => handler({}, { providerCredentials: { openai: { apiKey: 42 } } }),
    /Provider credentials\.openai\.apiKey must be a string/,
  )
})

test('settings handlers sync only portable settings for cloud workspaces', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { settings: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    getSetting: async (key) => {
      calls.push(`get:${key}`)
      return {
        key,
        value: { selectedProviderId: 'anthropic', selectedModelId: 'claude-test' },
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    setSetting: async (key, value) => {
      calls.push(`set:${key}:${value.selectedProviderId}`)
      return {
        key,
        value,
        updatedAt: '2026-05-27T10:01:00.000Z',
      }
    },
  }
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

  registerAppHandlers(context)
  const cloudEvent = { sender: { id: 1 } } as never
  context.workspaceGateway.activate(cloudEvent, 'cloud:test')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(cloudEvent, 'openrouter'), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(cloudEvent, 'github'), {})
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(cloudEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(cloudEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})

  const current = await handlers.get('settings:get')?.({}, { workspaceId: 'cloud:test' })
  assert.equal(current.selectedProviderId, 'anthropic')
  assert.deepEqual(current.providerCredentials, {})

  await assert.rejects(
    () => handlers.get('settings:set')?.({}, {
      workspaceId: 'cloud:test',
      providerCredentials: { openai: { apiKey: 'secret' } },
    }),
    /do not sync raw/,
  )

  const updated = await handlers.get('settings:set')?.({}, {
    workspaceId: 'cloud:test',
    selectedProviderId: 'openai',
    selectedModelId: 'gpt-test',
  })
  assert.equal(updated.selectedProviderId, 'openai')
  assert.deepEqual(updated.providerCredentials, {})

  assert.deepEqual(calls, [
    'get:portable-settings',
    'get:portable-settings',
    'set:portable-settings:openai',
  ])
})

test('local credential editor IPC masks secret fields and preserves them on save', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-ipc-masked-credentials-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      CREDENTIAL_MASK,
      clearSettingsCache,
      loadSettings,
      saveSettings,
    } = await import('../apps/desktop/src/main/settings.ts')
    clearSettingsCache()
    saveSettings({
      providerCredentials: {
        acme: { apiKey: 'provider-secret', projectId: 'project-visible' },
      },
      integrationCredentials: {
        github: { token: 'integration-secret', host: 'github.example.test' },
      },
    })

    const { context, handlers } = createBaseContext()
    registerAppHandlers(context)
    const localEvent = { sender: { id: 901 } } as never

    assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(localEvent, 'acme', {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }), {
      apiKey: CREDENTIAL_MASK,
      projectId: 'project-visible',
    })
    assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(localEvent, 'github', {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }), {
      token: CREDENTIAL_MASK,
      host: 'github.example.test',
    })

    saveSettings({
      providerCredentials: {
        acme: { apiKey: CREDENTIAL_MASK, projectId: 'project-updated' },
      },
      integrationCredentials: {
        github: { token: CREDENTIAL_MASK, host: 'github-updated.example.test' },
      },
    })
    const persisted = loadSettings()
    assert.equal(persisted.providerCredentials.acme.apiKey, 'provider-secret')
    assert.equal(persisted.providerCredentials.acme.projectId, 'project-updated')
    assert.equal(persisted.integrationCredentials.github.token, 'integration-secret')
    assert.equal(persisted.integrationCredentials.github.host, 'github-updated.example.test')
  } finally {
    const { clearSettingsCache } = await import('../apps/desktop/src/main/settings.ts')
    clearSettingsCache()
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('provider connection test IPC syncs saved API auth and validates live models', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-ipc-provider-test-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  const authSetCalls: unknown[] = []
  const fakeClient = {
    auth: {
      set: async (input: unknown, options: unknown) => {
        authSetCalls.push({ input, options })
      },
    },
    provider: {
      list: async () => ({
        data: {
          all: [{
            id: 'acme',
            name: 'Acme',
            models: {
              'acme/model': {},
            },
          }],
          connected: [],
        },
      }),
    },
  }

  runtimeState.setClient(fakeClient as Parameters<typeof runtimeState.setClient>[0])
  try {
    const {
      clearSettingsCache,
      saveSettings,
    } = await import('../apps/desktop/src/main/settings.ts')
    clearSettingsCache()
    saveSettings({
      selectedProviderId: 'acme',
      selectedModelId: 'acme/model',
      providerCredentials: {
        acme: { apiKey: 'provider-secret', projectId: 'project-visible' },
      },
    })

    const { context, handlers } = createBaseContext()
    registerAppHandlers(context)
    const handler = handlers.get('provider:test-connection')
    assert.ok(handler, 'expected provider:test-connection handler to be registered')

    assert.deepEqual(await handler({}, 'acme', 'acme/model'), {
      ok: true,
      providerId: 'acme',
      modelId: 'acme/model',
    })
    assert.deepEqual(authSetCalls, [{
      input: {
        providerID: 'acme',
        auth: {
          type: 'api',
          key: 'provider-secret',
          metadata: { source: 'open-cowork' },
        },
      },
      options: { throwOnError: true },
    }])

    await assert.rejects(
      () => handler({}, 'acme', 'missing-model'),
      /missing-model is not available from Acme/,
    )
  } finally {
    const { clearSettingsCache } = await import('../apps/desktop/src/main/settings.ts')
    clearSettingsCache()
    runtimeState.resetAfterStop()
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('credential editor IPC is unavailable from Gateway and Paired Desktop workspaces', async () => {
  const { context, handlers } = createBaseContext()
  const pairing: DesktopPairingPublicRecord = {
    id: 'pairing-credentials',
    label: 'Paired Desktop',
    deviceName: 'Phone',
    status: 'paired_online',
    enabled: true,
    brokerUrl: 'https://gateway.example.test',
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: [],
    policy: {
      allowRemotePrompts: true,
      allowRemoteAbort: true,
      remoteApprovals: 'local_confirmation',
      remoteQuestions: 'local_confirmation',
      exposeArtifactBodies: false,
      exposeLocalPaths: false,
      exposeLocalMcpDetails: false,
      allowRemoteAttachments: false,
    },
    lastConnectedAt: '2026-05-27T10:00:00.000Z',
    lastHeartbeatAt: '2026-05-27T10:01:00.000Z',
    lastCommandSequence: 1,
    error: null,
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T10:01:00.000Z',
    revokedAt: null,
    credential: {
      hasToken: true,
      deviceId: 'device-credentials',
      updatedAt: '2026-05-27T09:00:00.000Z',
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    gatewayRegistry: null,
    gatewayCredentialStore: null,
    desktopPairingProvider: () => [pairing],
    workspaces: [{
      id: 'gateway:test',
      kind: 'gateway',
      authority: 'gateway_standalone',
      label: 'Gateway',
      status: 'online',
      baseUrl: 'https://gateway.example.test/admin',
      lastSyncedAt: null,
    }],
  })

  registerAppHandlers(context)
  const gatewayEvent = { sender: { id: 701 } } as never
  context.workspaceGateway.activate(gatewayEvent, 'gateway:test')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(gatewayEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(gatewayEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})

  const pairedEvent = { sender: { id: 702 } } as never
  context.workspaceGateway.activate(pairedEvent, 'paired-desktop:pairing-credentials')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(pairedEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(pairedEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
})

test('custom MCP IPC rejects malformed nested records before persistence', async () => {
  const { context, handlers } = createBaseContext()

  registerCustomContentHandlers(context)
  const handler = handlers.get('custom:add-mcp')

  assert.ok(handler, 'expected custom:add-mcp handler to be registered')
  await assert.rejects(
    () => handler({}, {
      scope: 'machine',
      name: 'local-tools',
      type: 'stdio',
      command: 'node',
      env: { OPEN_COWORK_TOKEN: 123 },
    }),
    /MCP env\.OPEN_COWORK_TOKEN must be a string/,
  )
})

test('thread object IPC validates query and tag payload shape before store access', async () => {
  const { context, handlers } = createBaseContext()

  registerThreadHandlers(context)
  const search = handlers.get('threads:search')
  const createTag = handlers.get('threads:tags:create')

  assert.ok(search, 'expected threads:search handler to be registered')
  assert.ok(createTag, 'expected threads:tags:create handler to be registered')
  await assert.rejects(
    () => search({}, { statuses: ['not-a-status'] }),
    /Invalid thread status/,
  )
  await assert.rejects(
    () => createTag({}, { color: '#ffffff' }),
    /Tag name must be a string/,
  )
})

test('thread handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { threadIndex: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    searchThreads: async () => {
      calls.push('search')
      return { threads: [], nextCursor: null, totalEstimate: 0 }
    },
    threadFacets: async () => {
      calls.push('facets')
      return { projects: [], providers: [], models: [], agents: [], tools: [], mcps: [], statuses: [], tags: [] }
    },
    listThreadTags: async () => {
      calls.push('tags:list')
      return []
    },
    createThreadTag: async (input) => {
      calls.push(`tags:create:${input.name}`)
      return { id: 'tag-1', name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadTag: async (tagId, input) => {
      calls.push(`tags:update:${tagId}:${input.name}`)
      return { id: tagId, name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadTag: async (tagId) => {
      calls.push(`tags:delete:${tagId}`)
      return true
    },
    applyThreadTags: async (sessionIds, tagIds) => {
      calls.push(`tags:apply:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    removeThreadTags: async (sessionIds, tagIds) => {
      calls.push(`tags:remove:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    listThreadSmartFilters: async () => {
      calls.push('filters:list')
      return []
    },
    createThreadSmartFilter: async (input) => {
      calls.push(`filters:create:${input.name}`)
      return { id: 'filter-1', name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadSmartFilter: async (filterId, input) => {
      calls.push(`filters:update:${filterId}:${input.name}`)
      return { id: filterId, name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadSmartFilter: async (filterId) => {
      calls.push(`filters:delete:${filterId}`)
      return true
    },
  }
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

  registerThreadHandlers(context)

  await handlers.get('threads:search')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:facets')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:create')?.({}, { name: 'Important' }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:update')?.({}, 'tag-1', { name: 'Renamed' }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:apply')?.({}, ['session-1'], ['tag-1'], { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:remove')?.({}, ['session-1'], ['tag-1'], { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:delete')?.({}, 'tag-1', { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:create')?.({}, { name: 'Mine', query: {} }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:update')?.({}, 'filter-1', { name: 'Updated', query: {} }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:delete')?.({}, 'filter-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(calls, [
    'search',
    'facets',
    'tags:list',
    'tags:create:Important',
    'tags:update:tag-1:Renamed',
    'tags:apply:session-1:tag-1',
    'tags:remove:session-1:tag-1',
    'tags:delete:tag-1',
    'filters:list',
    'filters:create:Mine',
    'filters:update:filter-1:Updated',
    'filters:delete:filter-1',
  ])
})

test('artifact handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { artifacts: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listArtifacts: async (sessionId) => {
      calls.push(`list:${sessionId}`)
      return [{
        id: 'artifact-1',
        toolId: 'cloud-artifact',
        toolName: 'cloud.artifact',
        filePath: 'cloud-artifact://artifact-1/result.txt',
        filename: 'result.txt',
        order: 0,
        source: 'cloud',
        cloudArtifactId: 'artifact-1',
        mime: 'text/plain',
      }]
    },
    uploadArtifact: async (input) => {
      calls.push(`upload:${input.sessionId}:${input.filename}`)
      return {
        id: 'artifact-2',
        toolId: 'cloud-artifact',
        toolName: 'cloud.artifact',
        filePath: 'cloud-artifact://artifact-2/upload.txt',
        filename: input.filename,
        order: 0,
        source: 'cloud',
        cloudArtifactId: 'artifact-2',
        mime: input.contentType || undefined,
      }
    },
    readArtifactAttachment: async (sessionId, filePath) => {
      calls.push(`read:${sessionId}:${filePath}`)
      return {
        mime: 'text/plain',
        filename: 'result.txt',
        url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      }
    },
  }
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

  registerArtifactHandlers(context)

  assert.equal((await handlers.get('artifact:list')?.({}, { sessionId: 'session-1', workspaceId: 'cloud:test' }))?.[0]?.cloudArtifactId, 'artifact-1')
  assert.equal((await handlers.get('artifact:upload')?.({}, {
    sessionId: 'session-1',
    workspaceId: 'cloud:test',
    filename: 'upload.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('hello').toString('base64'),
  }))?.cloudArtifactId, 'artifact-2')
  assert.equal((await handlers.get('artifact:read-attachment')?.({}, {
    sessionId: 'session-1',
    workspaceId: 'cloud:test',
    filePath: 'cloud-artifact://artifact-1/result.txt',
  }))?.filename, 'result.txt')
  await assert.rejects(
    () => handlers.get('artifact:reveal')?.({}, {
      sessionId: 'session-1',
      workspaceId: 'cloud:test',
      filePath: 'cloud-artifact://artifact-1/result.txt',
    }),
    /Cloud artifacts cannot be revealed/,
  )

  assert.deepEqual(calls, [
    'list:session-1',
    'upload:session-1:upload.txt',
    'read:session-1:cloud-artifact://artifact-1/result.txt',
  ])
})

test('cloud artifact export helpers validate data URLs and sanitize default filenames', () => {
  assert.deepEqual(
    decodeCloudArtifactDataUrl(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`),
    Buffer.from('hello'),
  )
  assert.deepEqual(
    decodeCloudArtifactDataUrl(`data:text/plain; charset=utf-8;base64,${Buffer.from('hello').toString('base64')}`),
    Buffer.from('hello'),
  )
  assert.throws(
    () => decodeCloudArtifactDataUrl('https://cloud.example.test/artifact.txt'),
    /base64 data URL/,
  )
  assert.throws(
    () => decodeCloudArtifactDataUrl('data:text/plain;base64,not valid base64!'),
    /valid base64/,
  )

  assert.equal(safeArtifactExportFilename('../report.txt'), 'report.txt')
  assert.equal(safeArtifactExportFilename('/tmp/report.txt'), 'report.txt')
  assert.equal(safeArtifactExportFilename(''), 'artifact')
})

test('capability handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { capabilities: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listCapabilityTools: async () => {
      calls.push('tools')
      return [{
        id: 'read',
        name: 'Read',
        description: 'Read files',
        kind: 'built-in',
        source: 'builtin',
        patterns: ['read'],
        agentNames: ['build'],
      }]
    },
    getCapabilityTool: async (toolId) => {
      calls.push(`tool:${toolId}`)
      return {
        id: toolId,
        name: 'Read',
        description: 'Read files',
        kind: 'built-in',
        source: 'builtin',
        patterns: ['read'],
        agentNames: ['build'],
      }
    },
    listCapabilitySkills: async () => {
      calls.push('skills')
      return [{
        name: 'analysis',
        label: 'Analysis',
        description: 'Analyze data',
        source: 'builtin',
        toolIds: ['read'],
        agentNames: ['data-analyst'],
      }]
    },
    getCapabilitySkillBundle: async (skillName) => {
      calls.push(`bundle:${skillName}`)
      return {
        name: skillName,
        source: 'builtin',
        content: '# Analysis',
        files: [{ path: 'examples/report.md' }],
      }
    },
    readCapabilitySkillBundleFile: async (skillName, filePath) => {
      calls.push(`file:${skillName}:${filePath}`)
      return 'report example'
    },
  }
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

  registerCatalogHandlers(context)

  assert.equal((await handlers.get('capabilities:tools')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.id, 'read')
  assert.equal((await handlers.get('capabilities:tool')?.({}, 'read', { workspaceId: 'cloud:test' }))?.name, 'Read')
  assert.equal((await handlers.get('capabilities:skills')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analysis')
  assert.equal((await handlers.get('capabilities:skill-bundle')?.({}, 'analysis', { workspaceId: 'cloud:test' }))?.name, 'analysis')
  assert.equal(await handlers.get('capabilities:skill-bundle-file')?.({}, 'analysis', 'examples/report.md', { workspaceId: 'cloud:test' }), 'report example')

  assert.deepEqual(calls, [
    'tools',
    'tool:read',
    'skills',
    'bundle:analysis',
    'file:analysis:examples/report.md',
  ])
})

test('custom content handlers sync portable cloud metadata and block local-only content', async () => {
  const { context, handlers } = createBaseContext()
  const settings = new Map<string, Record<string, unknown>>()
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { customMcps: true, customSkills: true, agents: true },
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
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listCapabilityTools: async () => [{
      id: 'read',
      name: 'Read',
      description: 'Read files',
      kind: 'built-in',
      source: 'builtin',
      patterns: ['read'],
      agentNames: ['build'],
    }],
    listCapabilitySkills: async () => [{
      name: 'analysis',
      label: 'Analysis',
      description: 'Analyze data',
      source: 'builtin',
      toolIds: ['read'],
      agentNames: ['build'],
    }],
    getSetting: async (key) => ({
      key,
      value: settings.get(key) || { items: [] },
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    setSetting: async (key, value) => {
      settings.set(key, value)
      return {
        key,
        value,
        updatedAt: '2026-05-27T10:01:00.000Z',
      }
    },
  }
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

  registerCustomContentHandlers(context)
  registerCatalogHandlers(context)

  assert.equal(await handlers.get('custom:add-mcp')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'remote_docs',
    type: 'http',
    url: 'https://mcp.example.test',
  }), true)
  assert.equal((await handlers.get('custom:list-mcps')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'remote_docs')
  await assert.rejects(
    () => handlers.get('custom:add-mcp')?.({}, {
      workspaceId: 'cloud:test',
      scope: 'machine',
      name: 'local_shell',
      type: 'stdio',
      command: 'node',
    }),
    /Local stdio MCPs stay in the Local workspace/,
  )

  assert.equal(await handlers.get('custom:add-skill')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analysis',
    content: '# Analysis\n\nUse the read tool.',
    toolIds: ['read'],
  }), true)
  assert.equal((await handlers.get('custom:list-skills')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analysis')

  assert.equal(await handlers.get('agents:create')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
    description: 'Analyze data',
    instructions: 'Use the analysis skill.',
    skillNames: ['analysis'],
    toolIds: ['read'],
    enabled: true,
    color: 'primary',
  }), true)
  assert.equal((await handlers.get('agents:list')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analyst')
  assert.equal((await handlers.get('agents:catalog')?.({}, { workspaceId: 'cloud:test' }))?.tools[0]?.id, 'read')
  assert.equal(await handlers.get('agents:remove')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
  }, 'confirm'), true)
})

test('artifact IPC validates request shape before resolving private paths', async () => {
  const { context, handlers } = createBaseContext()
  let resolveCalled = false
  context.resolvePrivateArtifactPath = () => {
    resolveCalled = true
    return { root: '/tmp', source: '/tmp/file.txt' }
  }

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:export')

  assert.ok(handler, 'expected artifact:export handler to be registered')
  await assert.rejects(
    () => handler({}, { sessionId: 'session-1', filePath: '' }),
    /Artifact path is required/,
  )
  assert.equal(resolveCalled, false)
})

test('chart:save-artifact rejects unknown sessions before writing chart bytes', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('chart:save-artifact')

  assert.ok(handler, 'expected chart:save-artifact handler to be registered')
  await assert.rejects(
    () => handler({}, {
      sessionId: 'fake-session',
      toolCallId: 'tool-1',
      toolName: 'charts.create_bar',
      dataUrl: 'data:image/png;base64,AAAA',
    }),
    /existing session/,
  )
})

test('dialog:save-text path policy keeps exports as non-sensitive json files', () => {
  assert.equal(resolveSafeSaveTextPath('/tmp/agent'), '/tmp/agent.json')
  assert.equal(resolveSafeSaveTextPath('/tmp/agent.cowork-agent.json'), '/tmp/agent.cowork-agent.json')
  assert.throws(
    () => resolveSafeSaveTextPath('/tmp/agent.md'),
    /must use a \.json extension/,
  )
  assert.throws(
    () => resolveSafeSaveTextPath('/Users/example/.ssh/config'),
    /sensitive configuration path/,
  )
})

test('dialog:save-text writes private export files atomically', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-save-text-'))
  try {
    const outputPath = join(tempRoot, 'agent.cowork-agent.json')
    saveTextExportFile(outputPath, '{"ok":true}\n')

    assert.equal(readFileSync(outputPath, 'utf-8'), '{"ok":true}\n')
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
