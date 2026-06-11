import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileCloudWorkspaceRegistry } from '../apps/desktop/src/main/cloud-workspace-registry.ts'
import { FileCloudWorkspaceCredentialStore } from '../apps/desktop/src/main/cloud-workspace-credentials.ts'
import { FileGatewayWorkspaceRegistry } from '../apps/desktop/src/main/gateway-workspace-registry.ts'
import { FileGatewayWorkspaceCredentialStore } from '../apps/desktop/src/main/gateway-workspace-credentials.ts'
import type { GatewayWorkspaceStatusAdapter } from '../apps/desktop/src/main/gateway-workspace-adapter.ts'
import {
  LOCAL_WORKSPACE_ID,
  createWorkspaceGateway,
  readWorkspaceIdOption,
} from '../apps/desktop/src/main/workspace-gateway.ts'
import {
  cloudWorkspaceCacheKey,
  type CloudWorkspaceSessionAdapter,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import type { CloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import type { DesktopPairingPublicRecord, WorkspaceApiSupport } from '@open-cowork/shared'

function event(senderId: number) {
  return { sender: { id: senderId } } as never
}

function encryptedStorage() {
  return {
    mode: 'encrypted' as const,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8'),
  }
}

function recordingCloudCache(removedWorkspaceIds: string[]): CloudWorkspaceCache {
  return {
    mode: 'full',
    listSessions: () => null,
    getSessionInfo: () => null,
    getSessionView: () => null,
    getEventCursor: () => null,
    setEventCursor: () => {},
    resetEventCursor: () => {},
    getWorkflowList: () => null,
    upsertWorkflowList: () => {},
    listSettings: () => null,
    getSetting: () => null,
    upsertSettings: () => {},
    upsertSetting: () => {},
    listArtifacts: () => null,
    upsertArtifactList: () => {},
    upsertSessionList: () => {},
    upsertSessionInfo: () => {},
    upsertSessionView: () => {},
    removeWorkspace: (workspaceId) => {
      removedWorkspaceIds.push(workspaceId)
    },
  }
}

function supportStatus(support: WorkspaceApiSupport[], api: string) {
  const entry = support.find((candidate) => candidate.api === api)
  assert.ok(entry, `missing support entry for ${api}`)
  return entry
}

test('workspace gateway exposes local workspace by default', () => {
  const gateway = createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null })
  const workspaces = gateway.list(event(1))

  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0]?.id, LOCAL_WORKSPACE_ID)
  assert.equal(workspaces[0]?.kind, 'local')
  assert.equal(workspaces[0]?.authority, 'desktop_local')
  assert.equal(workspaces[0]?.status, 'online')
  assert.equal(workspaces[0]?.active, true)
})

test('workspace gateway honors disabled cloud desktop config', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-disabled-cloud-')), 'cloud-workspaces.json')
  const registry = new FileCloudWorkspaceRegistry(path)
  registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' })
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: null,
    cloudDesktop: {
      enabled: false,
      allowUserAddedConnections: true,
      preconfiguredConnections: [],
      requireManagedOrg: false,
      cacheMode: 'full',
      cacheEncryptionFallback: 'metadata-only',
    },
  })

  assert.deepEqual(gateway.list(event(1)).map((workspace) => workspace.id), [LOCAL_WORKSPACE_ID])
  assert.throws(
    () => gateway.addCloud(event(1), { baseUrl: 'https://other-cloud.example.test' }),
    /disabled by this build configuration/,
  )
})

test('workspace gateway supports managed preconfigured cloud orgs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-managed-cloud-')), 'cloud-workspaces.json')
  const registry = new FileCloudWorkspaceRegistry(path)
  registry.upsert({ baseUrl: 'https://managed.example.test', label: 'Persisted Managed' })
  registry.upsert({ baseUrl: 'https://unmanaged.example.test', label: 'Unmanaged' })
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: null,
    cloudDesktop: {
      enabled: true,
      allowUserAddedConnections: true,
      preconfiguredConnections: [{ baseUrl: 'https://managed.example.test', label: 'Managed Cloud' }],
      requireManagedOrg: true,
      cacheMode: 'metadata-only',
      cacheEncryptionFallback: 'disabled',
    },
  })

  const workspaces = gateway.list(event(1))
  const managed = workspaces.find((workspace) => workspace.baseUrl === 'https://managed.example.test')
  assert.equal(workspaces.some((workspace) => workspace.baseUrl === 'https://unmanaged.example.test'), false)
  assert.equal(managed?.label, 'Managed Cloud')
  assert.equal(managed?.status, 'auth_required')
  assert.throws(
    () => gateway.addCloud(event(1), { baseUrl: 'https://other-cloud.example.test' }),
    /User-added cloud workspaces are disabled/,
  )
  assert.equal(managed ? gateway.remove(event(1), managed.id) : true, false)
})

test('workspace gateway tracks active workspace per sender', () => {
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'disabled',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
  })

  gateway.activate(event(1), 'cloud:test')

  assert.equal(gateway.list(event(1)).find((workspace) => workspace.id === 'cloud:test')?.active, true)
  assert.equal(gateway.list(event(2)).find((workspace) => workspace.id === LOCAL_WORKSPACE_ID)?.active, true)
})

test('workspace gateway keeps local desktop actions local-only', () => {
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'disabled',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
  })

  assert.equal(gateway.assertLocalWorkspace(event(1)).id, LOCAL_WORKSPACE_ID)
  assert.throws(
    () => gateway.assertLocalWorkspace(event(1), 'cloud:test'),
    /only available in the Local workspace/,
  )
})

test('workspace gateway marks local desktop-only capabilities as local supported', async () => {
  const gateway = createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null })
  const support = await gateway.supportMatrix(event(1), LOCAL_WORKSPACE_ID)

  assert.equal(supportStatus(support, 'sessions.fileSnippet').status, 'supported')
  assert.equal(supportStatus(support, 'sessions.fileSnippet').context?.authority, 'desktop_local')
  assert.equal(supportStatus(support, 'sessions.fileSnippet').context?.runtimeAuthority, 'desktop_local')
  assert.equal(supportStatus(support, 'sessions.fileSnippet').context?.ownership.sessions, 'desktop_local_store')
  assert.equal(supportStatus(support, 'sessions.fileSnippet').context?.pathExposure, 'local_private')
  assert.equal(supportStatus(support, 'sessions.diff').status, 'supported')
  assert.equal(supportStatus(support, 'artifacts.reveal').status, 'supported')
  assert.equal(supportStatus(support, 'artifacts.reveal').context?.artifacts.reveal, 'local_filesystem')
  assert.equal(supportStatus(support, 'localFiles').status, 'supported')
  assert.equal(supportStatus(support, 'localStdioMcps').status, 'supported')
  assert.equal(supportStatus(support, 'machineRuntimeConfig').status, 'supported')
  assert.equal(supportStatus(support, 'localFiles').verdict?.allowed, true)
  assert.equal(supportStatus(support, 'coordination.projects').status, 'supported')
  assert.equal(supportStatus(support, 'coordination.tasks').status, 'supported')
  assert.equal(supportStatus(support, 'coordination.runs').status, 'supported')
  assert.equal(supportStatus(support, 'coordination.schedules').status, 'supported')
  assert.equal(supportStatus(support, 'coordination.watches').status, 'supported')
  assert.equal(supportStatus(support, 'coordination.delegation').status, 'supported')
})

test('workspace gateway registers cloud connections without enabling unauthenticated execution', async () => {
  const gateway = createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null })
  const workspace = gateway.addCloud(event(1), { baseUrl: 'https://cloud.example.test/api/', label: 'Acme' })

  assert.equal(workspace.kind, 'cloud')
  assert.equal(workspace.authority, 'cloud_worker')
  assert.equal(workspace.label, 'Acme')
  assert.equal(workspace.status, 'auth_required')
  assert.equal(workspace.baseUrl, 'https://cloud.example.test/api')
  assert.equal(gateway.policy(event(1), workspace.id).localFiles, 'disabled')
  const support = await gateway.supportMatrix(event(1), workspace.id)
  assert.equal(support.find((entry) => entry.api === 'sessions.prompt')?.status, 'blocked_by_policy')
  assert.equal(support.find((entry) => entry.api === 'sessions.prompt')?.context?.authority, 'cloud_worker')
  assert.equal(supportStatus(support, 'coordination.watches').status, 'deferred')
  assert.equal(support.find((entry) => entry.api === 'sessions.prompt')?.context?.runtimeAuthority, 'cloud_worker')
  assert.equal(support.find((entry) => entry.api === 'sessions.prompt')?.context?.ownership.sessions, 'cloud_control_plane')
  assert.equal(support.find((entry) => entry.api === 'localFiles')?.status, 'not_supported')
  assert.equal(support.find((entry) => entry.api === 'localFiles')?.context?.pathExposure, 'not_exposed')
  assert.equal(support.find((entry) => entry.api === 'artifacts.reveal')?.status, 'not_supported')
  assert.equal(support.find((entry) => entry.api === 'artifacts.reveal')?.context?.artifacts.reveal, 'none')
  await assert.rejects(() => gateway.sync(event(1), workspace.id), /Sign in|not available/)
})

test('workspace gateway registers standalone Gateway workspaces without treating them as Cloud', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-workspace-'))
  const registry = new FileGatewayWorkspaceRegistry(join(root, 'gateway-workspaces.json'))
  const credentials = new FileGatewayWorkspaceCredentialStore({
    path: join(root, 'gateway-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  let syncCalls = 0
  const gatewayAdapter: GatewayWorkspaceStatusAdapter = {
    health: async () => ({ ok: true, productMode: 'standalone' }),
    ready: async () => ({ ok: true }),
    sync: async () => { syncCalls += 1 },
  }
  const workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    gatewayRegistry: registry,
    gatewayCredentialStore: credentials,
    gatewayAdapterFactory: () => gatewayAdapter,
  })

  const workspace = workspaceGateway.addGateway(event(1), {
    baseUrl: 'https://gateway.example.test/admin/',
    label: 'Private Gateway',
    token: 'gateway-token',
  })

  assert.equal(workspace.kind, 'gateway')
  assert.equal(workspace.authority, 'gateway_standalone')
  assert.equal(workspace.status, 'online')
  assert.equal(workspace.baseUrl, 'https://gateway.example.test/admin')
  assert.equal(Object.values(workspace as Record<string, unknown>).includes('gateway-token'), false)
  assert.equal(credentials.getToken(workspace.id), 'gateway-token')
  assert.equal(registry.list()[0]?.label, 'Private Gateway')

  const support = await workspaceGateway.supportMatrix(event(1), workspace.id)
  assert.equal(supportStatus(support, 'sessions.list').status, 'deferred')
  assert.equal(supportStatus(support, 'sessions.list').context?.authority, 'gateway_standalone')
  assert.equal(supportStatus(support, 'sessions.list').context?.runtimeAuthority, 'gateway_standalone')
  assert.equal(supportStatus(support, 'sessions.list').context?.ownership.sessions, 'gateway_control_plane')
  assert.equal(supportStatus(support, 'localFiles').status, 'not_supported')
  assert.equal(supportStatus(support, 'localFiles').context?.pathExposure, 'redacted_remote')
  assert.equal(supportStatus(support, 'artifacts.reveal').status, 'not_supported')
  assert.equal(supportStatus(support, 'artifacts.reveal').context?.artifacts.reveal, 'none')
  await assert.rejects(() => workspaceGateway.listCloudSessions(event(1), workspace.id), /Cloud workspace/)

  const result = await workspaceGateway.sync(event(1), workspace.id)

  assert.equal(result.ok, true)
  assert.equal(syncCalls, 1)
  assert.equal(registry.list()[0]?.lastSyncedAt, result.syncedAt)
  assert.equal(workspaceGateway.list(event(1)).find((entry) => entry.id === workspace.id)?.lastSyncedAt, result.syncedAt)
})

test('gateway workspace registry enforces safe metadata-only URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-workspace-url-'))
  const path = join(root, 'gateway-workspaces.json')
  writeFileSync(path, JSON.stringify([{
    baseUrl: 'https://gateway.example.test/admin/?token=secret#frag',
    label: 'Persisted Gateway',
    token: 'should-not-surface',
    accessToken: 'should-not-surface',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }]))
  const registry = new FileGatewayWorkspaceRegistry(path)

  const [persisted] = registry.list()

  assert.equal(persisted?.baseUrl, 'https://gateway.example.test/admin')
  assert.equal(Object.hasOwn(persisted as object, 'token'), false)
  assert.equal(Object.hasOwn(persisted as object, 'accessToken'), false)
  assert.throws(() => registry.upsert({ baseUrl: 'http://gateway.example.test' }), /https/)

  const local = registry.upsert({ baseUrl: 'http://127.0.0.1:8790/?token=secret#frag', label: 'Local Gateway' })

  assert.equal(local.baseUrl, 'http://127.0.0.1:8790')
  assert.doesNotMatch(readFileSync(path, 'utf-8'), /should-not-surface|token=secret/)
})

test('workspace gateway projects local Desktop pairings as read-only paired workspaces', async () => {
  const pairing: DesktopPairingPublicRecord = {
    id: 'pairing-1',
    label: 'Phone Gateway',
    deviceName: 'Phone',
    status: 'paired_online',
    enabled: true,
    brokerUrl: 'https://gateway.example.test',
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: ['session-1'],
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
    lastCommandSequence: 7,
    error: null,
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T10:01:00.000Z',
    revokedAt: null,
    credential: {
      hasToken: true,
      deviceId: 'device-1',
      updatedAt: '2026-05-27T09:00:00.000Z',
    },
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    gatewayRegistry: null,
    gatewayCredentialStore: null,
    desktopPairingProvider: () => [pairing],
  })

  const paired = gateway.list(event(1)).find((workspace) => workspace.id === 'paired-desktop:pairing-1')
  assert.equal(paired?.kind, 'paired_desktop')
  assert.equal(paired?.authority, 'desktop_paired')
  assert.equal(paired?.status, 'online')
  assert.equal(paired?.profileName, '1 allowed session')
  assert.equal(gateway.activate(event(1), 'paired-desktop:pairing-1').active, true)
  assert.equal(gateway.activeWorkspaceId(event(1)), 'paired-desktop:pairing-1')

  const support = await gateway.supportMatrix(event(1), 'paired-desktop:pairing-1')
  assert.equal(supportStatus(support, 'sessions.prompt').status, 'deferred')
  assert.equal(supportStatus(support, 'sessions.prompt').context?.authority, 'desktop_paired')
  assert.equal(supportStatus(support, 'sessions.prompt').context?.runtimeAuthority, 'desktop_local')
  assert.equal(supportStatus(support, 'sessions.prompt').context?.pairingState, 'paired_online')
  assert.equal(supportStatus(support, 'localFiles').status, 'not_supported')
  await assert.rejects(() => gateway.listCloudSessions(event(1), 'paired-desktop:pairing-1'), /Cloud workspace/)
})

test('workspace gateway keeps host paths, local stdio MCPs, and machine config out of cloud support', async () => {
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-cloud-boundary-')), 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  credentials.save({
    workspaceId: 'cloud:test',
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: {
        sessions: true,
        threadIndex: true,
        workflows: true,
        artifacts: true,
        settings: true,
        customAgents: true,
        customSkills: true,
        customMcps: true,
        agents: true,
      },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'enabled',
      localStdioMcps: 'allowlisted',
      machineRuntimeConfig: 'allowlisted',
    }),
    listSessions: async () => [],
    createSession: async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    getSessionInfo: async () => null,
    getSessionView: async () => ({
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
    }),
    promptSession: async () => undefined,
    abortSession: async () => undefined,
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials,
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  const support = await gateway.supportMatrix(event(1), 'cloud:test')

  assert.equal(supportStatus(support, 'sessions.prompt').status, 'supported')
  assert.equal(supportStatus(support, 'sessions.fileSnippet').status, 'not_supported')
  assert.match(supportStatus(support, 'sessions.fileSnippet').verdict?.reason || '', /local host paths/)
  assert.equal(supportStatus(support, 'sessions.diff').status, 'not_supported')
  assert.equal(supportStatus(support, 'localFiles').status, 'not_supported')
  assert.match(supportStatus(support, 'localFiles').verdict?.reason || '', /implicitly upload local files/)
  assert.equal(supportStatus(support, 'localStdioMcps').status, 'not_supported')
  assert.match(supportStatus(support, 'localStdioMcps').verdict?.reason || '', /local stdio MCPs/)
  assert.equal(supportStatus(support, 'machineRuntimeConfig').status, 'not_supported')
  assert.match(supportStatus(support, 'machineRuntimeConfig').verdict?.reason || '', /machine-native runtime config/)
  assert.equal(supportStatus(support, 'artifacts.reveal').status, 'not_supported')
  assert.match(supportStatus(support, 'artifacts.reveal').verdict?.reason || '', /local filesystem/)
})

test('workspace gateway loads and removes persisted cloud connections', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-gateway-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  const removedCacheWorkspaceIds: string[] = []
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'cloud-access-token',
    refreshToken: 'cloud-refresh-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudCache: recordingCloudCache(removedCacheWorkspaceIds),
  })

  const workspace = gateway.list(event(1)).find((entry) => entry.id === persisted.id)
  assert.equal(workspace?.kind, 'cloud')
  assert.equal(workspace?.status, 'online')
  assert.equal(workspace?.label, 'Acme')

  assert.equal(gateway.remove(event(1), persisted.id), true)
  assert.equal(registry.list().length, 0)
  assert.equal(credentials.get(persisted.id), null)
  assert.deepEqual(removedCacheWorkspaceIds, [cloudWorkspaceCacheKey(persisted)])
})

test('workspace gateway routes online cloud session calls through the cloud adapter', async () => {
  const calls: string[] = []
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-route-')), 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  credentials.save({
    workspaceId: 'cloud:test',
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: ['data-analyst'],
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
      calls.push(`view:${sessionId}`)
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
    listWorkflows: async () => {
      calls.push('workflows:list')
      return { workflows: [], runs: [] }
    },
    getWorkflow: async (workflowId) => {
      calls.push(`workflows:get:${workflowId}`)
      return null
    },
    runWorkflow: async (workflowId) => {
      calls.push(`workflows:run:${workflowId}`)
      return null
    },
    pauseWorkflow: async (workflowId) => {
      calls.push(`workflows:pause:${workflowId}`)
      return null
    },
    resumeWorkflow: async (workflowId) => {
      calls.push(`workflows:resume:${workflowId}`)
      return null
    },
    archiveWorkflow: async (workflowId) => {
      calls.push(`workflows:archive:${workflowId}`)
      return null
    },
    searchThreads: async () => {
      calls.push('threads:search')
      return { threads: [], nextCursor: null, totalEstimate: 0 }
    },
    threadFacets: async () => {
      calls.push('threads:facets')
      return { projects: [], providers: [], models: [], agents: [], tools: [], mcps: [], statuses: [], tags: [] }
    },
    listThreadTags: async () => {
      calls.push('threads:tags:list')
      return []
    },
    createThreadTag: async (input) => {
      calls.push(`threads:tags:create:${input.name}`)
      return { id: 'tag-1', name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadTag: async (tagId, input) => {
      calls.push(`threads:tags:update:${tagId}:${input.name}`)
      return { id: tagId, name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadTag: async (tagId) => {
      calls.push(`threads:tags:delete:${tagId}`)
      return true
    },
    applyThreadTags: async (sessionIds, tagIds) => {
      calls.push(`threads:tags:apply:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    removeThreadTags: async (sessionIds, tagIds) => {
      calls.push(`threads:tags:remove:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    listThreadSmartFilters: async () => {
      calls.push('threads:filters:list')
      return []
    },
    createThreadSmartFilter: async (input) => {
      calls.push(`threads:filters:create:${input.name}`)
      return { id: 'filter-1', name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadSmartFilter: async (filterId, input) => {
      calls.push(`threads:filters:update:${filterId}:${input.name}`)
      return { id: filterId, name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadSmartFilter: async (filterId) => {
      calls.push(`threads:filters:delete:${filterId}`)
      return true
    },
    listArtifacts: async (sessionId) => {
      calls.push(`artifacts:list:${sessionId}`)
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
      calls.push(`artifacts:upload:${input.sessionId}:${input.filename}`)
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
      calls.push(`artifacts:read:${sessionId}:${filePath}`)
      return {
        mime: 'text/plain',
        filename: 'result.txt',
        url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      }
    },
    listCapabilityTools: async () => {
      calls.push('capabilities:tools')
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
      calls.push(`capabilities:tool:${toolId}`)
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
      calls.push('capabilities:skills')
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
      calls.push(`capabilities:skill-bundle:${skillName}`)
      return {
        name: skillName,
        source: 'builtin',
        content: '# Analysis',
        files: [{ path: 'examples/report.md' }],
      }
    },
    readCapabilitySkillBundleFile: async (skillName, filePath) => {
      calls.push(`capabilities:skill-file:${skillName}:${filePath}`)
      return 'report example'
    },
    listSettings: async () => {
      calls.push('settings:list')
      return [{
        key: 'portable-settings',
        value: { selectedProviderId: 'anthropic' },
        updatedAt: '2026-05-27T10:00:00.000Z',
      }]
    },
    getSetting: async (key) => {
      calls.push(`settings:get:${key}`)
      return {
        key,
        value: { selectedProviderId: 'anthropic' },
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    setSetting: async (key, value) => {
      calls.push(`settings:set:${key}:${value.selectedProviderId}`)
      return {
        key,
        value,
        updatedAt: '2026-05-27T10:01:00.000Z',
      }
    },
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials,
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

  const support = await gateway.supportMatrix(event(1), 'cloud:test')
  assert.equal(support.find((entry) => entry.api === 'sessions.prompt')?.status, 'supported')
  assert.equal(support.find((entry) => entry.api === 'workflows.run')?.status, 'blocked_by_policy')
  assert.equal(support.find((entry) => entry.api === 'sessions.fileSnippet')?.status, 'not_supported')

  assert.deepEqual(await gateway.listCloudSessions(event(1), 'cloud:test'), [{
    id: 'cloud-session-1',
    title: 'Cloud thread',
    directory: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  assert.equal((await gateway.createCloudSession(event(1), 'cloud:test')).id, 'cloud-session-2')
  assert.equal((await gateway.getCloudSessionInfo(event(1), 'cloud-session-1', 'cloud:test'))?.id, 'cloud-session-1')
  assert.equal((await gateway.getCloudSessionView(event(1), 'cloud-session-1', 'cloud:test')).messages.length, 0)
  await gateway.promptCloudSession(event(1), 'cloud-session-1', { text: 'hello', agent: 'data-analyst' }, 'cloud:test')
  await gateway.abortCloudSession(event(1), 'cloud-session-1', 'cloud:test')
  await gateway.listCloudWorkflows(event(1), 'cloud:test')
  await gateway.getCloudWorkflow(event(1), 'workflow-1', 'cloud:test')
  await gateway.runCloudWorkflow(event(1), 'workflow-1', 'cloud:test')
  await gateway.pauseCloudWorkflow(event(1), 'workflow-1', 'cloud:test')
  await gateway.resumeCloudWorkflow(event(1), 'workflow-1', 'cloud:test')
  await gateway.archiveCloudWorkflow(event(1), 'workflow-1', 'cloud:test')
  await gateway.searchCloudThreads(event(1), {}, 'cloud:test')
  await gateway.cloudThreadFacets(event(1), {}, 'cloud:test')
  await gateway.listCloudThreadTags(event(1), 'cloud:test')
  await gateway.createCloudThreadTag(event(1), { name: 'Important' }, 'cloud:test')
  await gateway.updateCloudThreadTag(event(1), 'tag-1', { name: 'Renamed' }, 'cloud:test')
  await gateway.applyCloudThreadTags(event(1), ['cloud-session-1'], ['tag-1'], 'cloud:test')
  await gateway.removeCloudThreadTags(event(1), ['cloud-session-1'], ['tag-1'], 'cloud:test')
  await gateway.deleteCloudThreadTag(event(1), 'tag-1', 'cloud:test')
  await gateway.listCloudThreadSmartFilters(event(1), 'cloud:test')
  await gateway.createCloudThreadSmartFilter(event(1), { name: 'Mine', query: {} }, 'cloud:test')
  await gateway.updateCloudThreadSmartFilter(event(1), 'filter-1', { name: 'Updated', query: {} }, 'cloud:test')
  await gateway.deleteCloudThreadSmartFilter(event(1), 'filter-1', 'cloud:test')
  assert.equal((await gateway.listCloudArtifacts(event(1), 'cloud-session-1', 'cloud:test'))[0]?.cloudArtifactId, 'artifact-1')
  assert.equal((await gateway.uploadCloudArtifact(event(1), {
    sessionId: 'cloud-session-1',
    filename: 'upload.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('hello').toString('base64'),
  }, 'cloud:test')).cloudArtifactId, 'artifact-2')
  assert.equal((await gateway.readCloudArtifactAttachment(event(1), 'cloud-session-1', 'cloud-artifact://artifact-1/result.txt', 'cloud:test')).filename, 'result.txt')
  assert.equal((await gateway.listCloudCapabilityTools(event(1), 'cloud:test'))[0]?.id, 'read')
  assert.equal((await gateway.getCloudCapabilityTool(event(1), 'read', 'cloud:test'))?.name, 'Read')
  assert.equal((await gateway.listCloudCapabilitySkills(event(1), 'cloud:test'))[0]?.name, 'analysis')
  assert.equal((await gateway.getCloudCapabilitySkillBundle(event(1), 'analysis', 'cloud:test'))?.name, 'analysis')
  assert.equal(await gateway.readCloudCapabilitySkillBundleFile(event(1), 'analysis', 'examples/report.md', 'cloud:test'), 'report example')
  assert.equal((await gateway.listCloudSettings(event(1), 'cloud:test'))[0]?.key, 'portable-settings')
  assert.equal((await gateway.getCloudSetting(event(1), 'portable-settings', 'cloud:test'))?.value.selectedProviderId, 'anthropic')
  assert.equal((await gateway.setCloudSetting(event(1), 'portable-settings', { selectedProviderId: 'openai' }, 'cloud:test')).value.selectedProviderId, 'openai')

  assert.deepEqual(calls, [
    'list',
    'create',
    'get:cloud-session-1',
    'view:cloud-session-1',
    'prompt:cloud-session-1:hello:data-analyst',
    'abort:cloud-session-1',
    'workflows:list',
    'workflows:get:workflow-1',
    'workflows:run:workflow-1',
    'workflows:pause:workflow-1',
    'workflows:resume:workflow-1',
    'workflows:archive:workflow-1',
    'threads:search',
    'threads:facets',
    'threads:tags:list',
    'threads:tags:create:Important',
    'threads:tags:update:tag-1:Renamed',
    'threads:tags:apply:cloud-session-1:tag-1',
    'threads:tags:remove:cloud-session-1:tag-1',
    'threads:tags:delete:tag-1',
    'threads:filters:list',
    'threads:filters:create:Mine',
    'threads:filters:update:filter-1:Updated',
    'threads:filters:delete:filter-1',
    'artifacts:list:cloud-session-1',
    'artifacts:upload:cloud-session-1:upload.txt',
    'artifacts:read:cloud-session-1:cloud-artifact://artifact-1/result.txt',
    'capabilities:tools',
    'capabilities:tool:read',
    'capabilities:skills',
    'capabilities:skill-bundle:analysis',
    'capabilities:skill-file:analysis:examples/report.md',
    'settings:list',
    'settings:get:portable-settings',
    'settings:set:portable-settings:openai',
  ])
})

test('workspace gateway cloud sync refreshes adapter snapshot and persists sync time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-sync-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' })
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
  let syncCalls = 0
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
    sync: async () => { syncCalls += 1 },
    listSessions: async () => [],
    createSession: async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    getSessionInfo: async () => null,
    getSessionView: async () => ({
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
    }),
    promptSession: async () => undefined,
    abortSession: async () => undefined,
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudAdapterFactory: () => adapter,
  })

  const result = await gateway.sync(event(1), persisted.id)

  assert.equal(syncCalls, 1)
  assert.equal(result.ok, true)
  assert.equal(registry.list().find((entry) => entry.id === persisted.id)?.lastSyncedAt, result.syncedAt)
  assert.equal(gateway.list(event(1)).find((workspace) => workspace.id === persisted.id)?.lastSyncedAt, result.syncedAt)
})

test('workspace gateway subscribes cloud workspace events once per sender', async () => {
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-events-')), 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  credentials.save({
    workspaceId: 'cloud:test',
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
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
    listSessions: async () => [],
    createSession: async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    getSessionInfo: async () => null,
    getSessionView: async () => ({
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
    }),
    promptSession: async () => undefined,
    abortSession: async () => undefined,
    subscribeWorkspaceEvents: (input) => {
      calls.push(`subscribe:${input.afterSequence ?? 'cached'}`)
      input.onEvent({
        eventId: 'event-1',
        sequence: 1,
        sessionId: 'cloud-session-1',
        type: 'session.created',
        payload: {},
      })
      return { close() { calls.push('close') } }
    },
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials,
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
  let events = 0

  await gateway.subscribeCloudWorkspaceEvents(event(1), {
    workspaceId: 'cloud:test',
    onEvent: () => { events += 1 },
  })
  await gateway.subscribeCloudWorkspaceEvents(event(1), {
    workspaceId: 'cloud:test',
    onEvent: () => { events += 1 },
  })
  await gateway.subscribeCloudWorkspaceEvents(event(2), {
    workspaceId: 'cloud:test',
    afterSequence: 5,
    onEvent: () => { events += 1 },
  })
  gateway.remove(event(1), 'cloud:test')

  assert.equal(events, 2)
  assert.deepEqual(calls, ['subscribe:cached', 'subscribe:5', 'close', 'close'])
})

test('workspace gateway closes inactive cloud subscriptions on workspace switch', async () => {
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-switch-events-')), 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  for (const workspaceId of ['cloud:one', 'cloud:two']) {
    credentials.save({
      workspaceId,
      accessToken: 'cloud-access-token',
      expiresAt: '2030-05-27T12:00:00.000Z',
    })
  }
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
    listSessions: async () => [],
    createSession: async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    getSessionInfo: async () => null,
    getSessionView: async () => ({
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
    }),
    promptSession: async () => undefined,
    abortSession: async () => undefined,
    subscribeWorkspaceEvents: () => ({ close() { calls.push('close') } }),
    subscribeSessionEvents: () => ({ close() { calls.push('session-close') } }),
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials,
    workspaces: [
      {
        id: 'cloud:one',
        kind: 'cloud',
        label: 'Cloud One',
        status: 'online',
        baseUrl: 'https://one.example.test',
        lastSyncedAt: null,
      },
      {
        id: 'cloud:two',
        kind: 'cloud',
        label: 'Cloud Two',
        status: 'online',
        baseUrl: 'https://two.example.test',
        lastSyncedAt: null,
      },
    ],
    cloudAdapterFactory: () => adapter,
  })

  gateway.activate(event(1), 'cloud:one')
  await gateway.subscribeCloudWorkspaceEvents(event(1), {
    workspaceId: 'cloud:one',
    onEvent: () => {},
  })
  await gateway.subscribeCloudSessionEvents(event(1), 'same-session-id', {
    workspaceId: 'cloud:one',
    onEvent: () => {},
  })
  gateway.activate(event(2), 'cloud:one')
  gateway.activate(event(1), 'cloud:two')

  assert.deepEqual(calls, [])

  gateway.activate(event(2), 'cloud:two')

  assert.deepEqual(calls, ['session-close', 'close'])
})

test('workspace gateway drops failed cloud event subscriptions before retry', async () => {
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-workspace-event-retry-')), 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  credentials.save({
    workspaceId: 'cloud:test',
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  })
  type WorkspaceSubscriptionInput = Parameters<NonNullable<CloudWorkspaceSessionAdapter['subscribeWorkspaceEvents']>>[0]
  type SessionSubscriptionInput = Parameters<NonNullable<CloudWorkspaceSessionAdapter['subscribeSessionEvents']>>[1]
  const calls: string[] = []
  const errors: string[] = []
  const workspaceInputs: WorkspaceSubscriptionInput[] = []
  const sessionInputs: SessionSubscriptionInput[] = []
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
    createSession: async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    getSessionInfo: async () => null,
    getSessionView: async () => ({
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
    }),
    promptSession: async () => undefined,
    abortSession: async () => undefined,
    subscribeWorkspaceEvents: (input) => {
      calls.push('workspace:subscribe')
      workspaceInputs.push(input)
      return { close() { calls.push('workspace:close') } }
    },
    subscribeSessionEvents: (sessionId, input) => {
      calls.push(`session:subscribe:${sessionId}`)
      sessionInputs.push(input)
      return { close() { calls.push(`session:close:${sessionId}`) } }
    },
  }
  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials,
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

  await gateway.subscribeCloudWorkspaceEvents(event(1), {
    workspaceId: 'cloud:test',
    onEvent: () => {},
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)) },
  })
  workspaceInputs[0]?.onError?.(new Error('workspace 401'))
  await gateway.subscribeCloudWorkspaceEvents(event(1), {
    workspaceId: 'cloud:test',
    onEvent: () => {},
  })
  await gateway.subscribeCloudSessionEvents(event(1), 'cloud-session-1', {
    workspaceId: 'cloud:test',
    onEvent: () => {},
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)) },
  })
  sessionInputs[0]?.onError?.(new Error('session 401'))
  await gateway.subscribeCloudSessionEvents(event(1), 'cloud-session-1', {
    workspaceId: 'cloud:test',
    onEvent: () => {},
  })

  assert.deepEqual(calls, [
    'workspace:subscribe',
    'workspace:close',
    'workspace:subscribe',
    'session:subscribe:cloud-session-1',
    'session:close:cloud-session-1',
    'session:subscribe:cloud-session-1',
  ])
  assert.deepEqual(errors, ['workspace 401', 'session 401'])
})

test('workspace gateway marks persisted cloud workspaces online when a usable token exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-token-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'cloud-access-token',
    expiresAt: '2030-05-27T12:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))
  let adapterToken: string | null | undefined
  const removedCacheWorkspaceIds: string[] = []
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudCache: recordingCloudCache(removedCacheWorkspaceIds),
    cloudAdapterFactory: (_connection, accessToken) => {
      adapterToken = accessToken
      return {
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
        createSession: async () => ({
          id: 'session-1',
          title: 'Cloud session',
          directory: null,
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        getSessionInfo: async () => null,
        getSessionView: async () => ({
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
        }),
        promptSession: async () => {},
        abortSession: async () => {},
      }
    },
  })

  const workspace = gateway.list(event(1)).find((entry) => entry.id === persisted.id)
  assert.equal(workspace?.status, 'online')
  await gateway.createCloudSession(event(1), persisted.id)
  assert.equal(adapterToken, 'cloud-access-token')
  gateway.logout(event(1), persisted.id)
  assert.equal(credentials.get(persisted.id), null)
  assert.equal(gateway.list(event(1)).find((entry) => entry.id === persisted.id)?.status, 'auth_required')
  assert.deepEqual(removedCacheWorkspaceIds, [])
})

test('workspace gateway login stores cloud tokens without exposing them in workspace info', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-login-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudLogin: async (connection) => {
      assert.equal(connection.id, persisted.id)
      return {
        accessToken: 'access-token-1',
        refreshToken: 'refresh-token-1',
        expiresAt: '2030-05-27T12:00:00.000Z',
        tenantId: 'tenant-1',
        userId: 'user-1',
        profileName: 'default',
      }
    },
  })

  const workspace = await gateway.login(event(1), persisted.id)

  assert.equal(workspace.status, 'online')
  assert.equal(workspace.tenantId, 'tenant-1')
  assert.equal(workspace.userId, 'user-1')
  assert.equal(workspace.profileName, 'default')
  assert.equal(Object.values(workspace as Record<string, unknown>).includes('access-token-1'), false)
  assert.equal(credentials.get(persisted.id)?.accessToken, 'access-token-1')
  assert.equal(registry.list()[0]?.tenantId, 'tenant-1')
})

test('workspace gateway refreshes expired cloud tokens before adapter calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-refresh-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token-1',
    expiresAt: '2026-05-27T10:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))
  let adapterToken: string | null | undefined
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudRefresh: async (_connection, refreshToken) => {
      assert.equal(refreshToken, 'refresh-token-1')
      return {
        accessToken: 'fresh-access-token',
        refreshToken: 'refresh-token-2',
        expiresAt: '2030-05-27T12:00:00.000Z',
        tenantId: 'tenant-1',
        userId: 'user-1',
      }
    },
    cloudAdapterFactory: (_connection, accessToken) => {
      adapterToken = accessToken
      return {
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
        createSession: async () => ({
          id: 'session-1',
          title: 'Cloud session',
          directory: null,
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        getSessionInfo: async () => null,
        getSessionView: async () => ({
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
        }),
        promptSession: async () => {},
        abortSession: async () => {},
      }
    },
  })

  assert.equal(gateway.list(event(1)).find((entry) => entry.id === persisted.id)?.status, 'online')

  const syncResult = await gateway.sync(event(1), persisted.id)

  assert.equal(syncResult.ok, true)
  assert.equal(adapterToken, 'fresh-access-token')
  assert.equal(credentials.get(persisted.id)?.accessToken, 'fresh-access-token')
  assert.equal(credentials.get(persisted.id)?.refreshToken, 'refresh-token-2')
  assert.equal(gateway.list(event(1)).find((entry) => entry.id === persisted.id)?.status, 'online')
})

test('workspace gateway preserves cloud credentials on transient refresh failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-refresh-transient-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token-1',
    expiresAt: '2026-05-27T10:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))
  let adapterCalls = 0
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudRefresh: async () => {
      throw new Error('fetch failed')
    },
    cloudAdapterFactory: () => {
      adapterCalls += 1
      throw new Error('adapter should not be created without a usable access token')
    },
  })

  await assert.rejects(() => gateway.sync(event(1), persisted.id), /offline or unavailable/)

  const stored = credentials.get(persisted.id)
  assert.equal(adapterCalls, 0)
  assert.equal(stored?.accessToken, 'expired-access-token')
  assert.equal(stored?.refreshToken, 'refresh-token-1')
  assert.equal(gateway.list(event(1)).find((entry) => entry.id === persisted.id)?.status, 'offline')
})

test('workspace gateway clears cloud credentials on refresh auth failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-workspace-refresh-auth-'))
  const registry = new FileCloudWorkspaceRegistry(join(root, 'cloud-workspaces.json'))
  const credentials = new FileCloudWorkspaceCredentialStore({
    path: join(root, 'cloud-workspace-credentials.json'),
    secretStorage: encryptedStorage(),
  })
  const persisted = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'Acme' }, new Date('2026-05-27T10:00:00.000Z'))
  credentials.save({
    workspaceId: persisted.id,
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token-1',
    expiresAt: '2026-05-27T10:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))
  const gateway = createWorkspaceGateway({
    cloudRegistry: registry,
    cloudCredentialStore: credentials,
    cloudRefresh: async () => {
      throw new Error('invalid_grant')
    },
    cloudAdapterFactory: () => {
      throw new Error('adapter should not be created without a usable access token')
    },
  })

  await assert.rejects(() => gateway.sync(event(1), persisted.id), /Sign in to this cloud workspace/)

  assert.equal(credentials.get(persisted.id), null)
  assert.equal(gateway.list(event(1)).find((entry) => entry.id === persisted.id)?.status, 'auth_required')
})

test('workspace option reader accepts optional workspace id only from objects', () => {
  assert.equal(readWorkspaceIdOption(undefined), null)
  assert.equal(readWorkspaceIdOption({ variant: 'fast' }), null)
  assert.equal(readWorkspaceIdOption({ workspaceId: ' local ' }), 'local')
  assert.throws(() => readWorkspaceIdOption('local'), /must be an object/)
})
