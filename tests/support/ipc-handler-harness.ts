import { createWorkspaceGateway } from '../../apps/desktop/src/main/workspace-gateway.ts'
import type { CloudWorkspaceSessionAdapter } from '../../apps/desktop/src/main/cloud-workspace-adapter.ts'
import type { IpcHandlerContext } from '../../apps/desktop/src/main/ipc/context.ts'
import type { CloudProjectedSessionEventType } from '@open-cowork/shared'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

type IpcInvokeHandler = Parameters<IpcMain['handle']>[1]
type IpcEventListener = Parameters<IpcMain['on']>[1]

export function createIpcMainHarness() {
  const handlers = new Map<string, IpcInvokeHandler>()
  const listeners = new Map<string, IpcEventListener>()
  const ipcMain = {
    handle(channel: string, handler: IpcInvokeHandler) {
      handlers.set(channel, handler)
    },
    on(channel: string, listener: IpcEventListener) {
      listeners.set(channel, listener)
    },
  } as unknown as IpcMain

  return {
    ipcMain,
    handlers,
    listeners,
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({} as IpcMainInvokeEvent, ...args)
    },
    has(channel: string) {
      return handlers.has(channel)
    },
  }
}

export function createIpcHandlerHarness(
  overrides: Partial<Omit<IpcHandlerContext, 'ipcMain'>> = {},
) {
  const ipc = createIpcMainHarness()
  const errors: string[] = []
  const context: IpcHandlerContext = {
    ipcMain: ipc.ipcMain,
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
    suspendRuntimeForSetup: async () => {},
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
    ...overrides,
  }

  return { ...ipc, context, errors }
}

export function installCloudWorkspace(
  context: IpcHandlerContext,
  adapter: CloudWorkspaceSessionAdapter,
) {
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

export function emptySessionView(overrides: Record<string, unknown> = {}) {
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

export function minimalCloudEventPayloadFor(
  type: CloudProjectedSessionEventType,
): Record<string, unknown> {
  switch (type) {
    case 'session.created':
      return { title: 'Projected session' }
    case 'session.imported':
      return {
        sourceFingerprint: 'sha256:source',
        importedAt: '2026-05-28T10:00:00.000Z',
        itemCounts: { messages: 1 },
      }
    case 'session.project_source.bound':
      return { projectSource: { kind: 'snapshot', snapshotId: 'snapshot-1' } }
    case 'prompt.submitted':
      return { messageId: 'user-1', text: 'run checks' }
    case 'assistant.message':
      return { messageId: 'assistant-1', content: 'ok' }
    case 'tool.call':
      return { id: 'tool-1', name: 'bash', status: 'running' }
    case 'task.run':
      return { id: 'task-1', title: 'Task', status: 'running' }
    case 'permission.requested':
      return { permissionId: 'permission-1', tool: 'bash', description: 'Approve' }
    case 'permission.resolved':
      return { permissionId: 'permission-1', allowed: true }
    case 'question.asked':
      return { requestId: 'question-1', questions: [{ question: 'Continue?' }] }
    case 'question.resolved':
      return { requestId: 'question-1', answers: ['Yes'] }
    case 'todos.updated':
      return { todos: [{ id: 'todo-1', content: 'Ship it' }] }
    case 'cost.updated':
      return { cost: 0.01, tokens: { input: 1, output: 2 } }
    case 'artifact.created':
      return { artifactId: 'artifact-1', filename: 'result.txt' }
    case 'artifact.updated':
      return { artifactId: 'artifact-1', filename: 'result.txt', status: 'available' }
    case 'session.status':
      return { statusType: 'running' }
    case 'session.idle':
      return {}
    case 'session.aborted':
      return { reason: 'user' }
    case 'runtime.error':
      return { message: 'Runtime failed' }
  }
}
