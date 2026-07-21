/**
 * Workspace session port contract (audit 2026-07-21 P2-8 / JOE-921, JOE-970).
 *
 * Drives assertWorkspaceSessionPort + exerciseWorkspaceSessionPort against:
 * - CloudWorkspaceAdapter (shipped cloud path)
 * - createMemoryWorkspaceSessionPort (local-path fixture)
 * so method skew fails closed — not partial-mock theater.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CloudWorkspaceAdapter,
  createCloudWorkspaceAdapter,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import {
  assertWorkspaceSessionPort,
  createMemoryWorkspaceSessionPort,
  exerciseWorkspaceSessionPort,
  WORKSPACE_SESSION_PORT_CORE_METHODS,
  WORKSPACE_SESSION_PORT_EXTENDED_METHODS,
  WORKSPACE_SESSION_PORT_FULL_METHODS,
  WORKSPACE_SESSION_PORT_INTERACTION_METHODS,
  type WorkspaceSessionPort,
} from '../apps/desktop/src/main/workspace-session-port.ts'
import type { CloudTransportAdapter } from '@open-cowork/cloud-server/transport-adapter'
import {
  createWorkspaceGateway,
} from '../apps/desktop/src/main/workspace-gateway.ts'
import { emptySessionView } from '@open-cowork/shared'

function portTransport(): CloudTransportAdapter {
  type CloudSessionRecord = {
    tenantId: string
    userId: string
    sessionId: string
    opencodeSessionId: string
    profileName: string
    status: string
    title: string
    createdAt: string
    updatedAt: string
    projectSource: null
  }
  const sessions = new Map<string, CloudSessionRecord>([[
    'session-1',
    {
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      opencodeSessionId: 'opencode-session-1',
      profileName: 'default',
      status: 'idle',
      title: 'Hello',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      projectSource: null,
    },
  ]])
  let createCount = 0
  const sessionRecord = (sessionId: string, title = 'Hello'): CloudSessionRecord => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId,
    opencodeSessionId: `opencode-${sessionId}`,
    profileName: 'default',
    status: 'idle',
    title,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    projectSource: null,
  })

  return {
    getConfig: async () => ({
      role: 'web',
      profileName: 'default',
      features: { sessions: true },
      allowedAgents: ['data-analyst'],
      allowedTools: ['read'],
      allowedMcps: [],
    }),
    getWorkspace: async () => ({
      tenantId: 'tenant-1',
      tenantName: 'Tenant',
      orgId: 'org-1',
      orgName: 'Org',
      userId: 'user-1',
      accountId: 'account-1',
      email: 'user@example.test',
      role: 'owner',
      profileName: 'default',
      policy: {
        features: {},
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
        localFiles: 'disabled',
        localStdioMcps: 'disabled',
        machineRuntimeConfig: 'disabled',
      },
    }),
    getRuntimeStatus: async () => ({
      role: 'web',
      profileName: 'default',
      ready: true,
      details: {},
    }),
    listSessions: async () => [...sessions.values()],
    createSession: async () => {
      createCount += 1
      const sessionId = `session-created-${createCount}`
      const session = sessionRecord(sessionId, 'New')
      sessions.set(sessionId, session)
      return { session, projection: null }
    },
    getSession: async (sessionId: string) => {
      const session = sessions.get(sessionId) ?? sessionRecord(sessionId)
      return {
        session,
        projection: {
          tenantId: 'tenant-1',
          sessionId,
          sequence: 1,
          updatedAt: '2026-05-27T10:00:00.000Z',
          view: emptySessionView(),
        },
      }
    },
    promptSession: async () => {},
    abortSession: async () => {},
    replyToQuestion: async () => {},
    rejectQuestion: async () => {},
    respondToPermission: async () => {},
    listWorkflows: async () => ({ workflows: [], nextCursor: null }),
    getWorkflow: async () => null,
    runWorkflow: async () => null,
    pauseWorkflow: async () => null,
    resumeWorkflow: async () => null,
    archiveWorkflow: async () => null,
    importSession: async (input) => {
      const session = sessionRecord('session-import-1', input.title)
      sessions.set(session.sessionId, session)
      return {
        session,
        projection: {
          tenantId: 'tenant-1',
          sessionId: session.sessionId,
          sequence: 1,
          updatedAt: '2026-05-27T10:00:00.000Z',
          view: emptySessionView(),
        },
      }
    },
    listArtifacts: async () => [],
    uploadArtifact: async (_sessionId, input) => ({
      id: 'art-1',
      toolId: 'upload',
      toolName: 'upload',
      filePath: input.filename,
      filename: input.filename,
      order: 1,
      source: 'cloud' as const,
      createdAt: '2026-05-27T10:00:00.000Z',
    }),
    readArtifactAttachment: async () => ({
      mime: 'text/plain',
      url: 'data:text/plain;base64,aGVsbG8=',
      filename: 'contract.txt',
      chart: null,
    }),
  }
}

const connection = {
  id: 'cloud:port-test',
  baseUrl: 'https://cloud.example.test',
  label: 'Port Test Cloud',
  createdAt: '2026-05-27T10:00:00.000Z',
  updatedAt: '2026-05-27T10:00:00.000Z',
  lastSyncedAt: null,
}

test('assertWorkspaceSessionPort rejects incomplete objects', () => {
  assert.throws(() => assertWorkspaceSessionPort({}), /missing method/)
  assert.throws(() => assertWorkspaceSessionPort({ listSessions: async () => [] }), /missing method/)
  assert.throws(
    () => assertWorkspaceSessionPort({
      policy: async () => ({
        features: {},
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
        localFiles: 'enabled',
        localStdioMcps: 'enabled',
        machineRuntimeConfig: 'enabled',
      }),
      listSessions: async () => [],
      createSession: async () => ({ id: 'x', createdAt: '', updatedAt: '' }),
      getSessionInfo: async () => null,
      getSessionView: async () => emptySessionView(),
      promptSession: async () => {},
      abortSession: async () => {},
    }, { mode: 'full' }),
    /missing method/,
  )
})

test('port method inventories are non-empty and full contains core + interaction + extended', () => {
  assert.ok(WORKSPACE_SESSION_PORT_CORE_METHODS.length >= 7)
  assert.ok(WORKSPACE_SESSION_PORT_INTERACTION_METHODS.length >= 9)
  assert.ok(WORKSPACE_SESSION_PORT_EXTENDED_METHODS.includes('importSession'))
  assert.ok(WORKSPACE_SESSION_PORT_EXTENDED_METHODS.includes('listArtifacts'))
  assert.equal(
    WORKSPACE_SESSION_PORT_FULL_METHODS.length,
    WORKSPACE_SESSION_PORT_CORE_METHODS.length
      + WORKSPACE_SESSION_PORT_INTERACTION_METHODS.length
      + WORKSPACE_SESSION_PORT_EXTENDED_METHODS.length,
  )
  for (const method of WORKSPACE_SESSION_PORT_CORE_METHODS) {
    assert.ok(WORKSPACE_SESSION_PORT_FULL_METHODS.includes(method))
  }
})

test('CloudWorkspaceAdapter instance satisfies full WorkspaceSessionPort contract', async () => {
  const adapter = new CloudWorkspaceAdapter({
    connection,
    transport: portTransport(),
    cache: null,
  })
  assertWorkspaceSessionPort(adapter, { mode: 'full' })
  const result = await exerciseWorkspaceSessionPort(adapter)
  assert.equal(result.methodCount, WORKSPACE_SESSION_PORT_FULL_METHODS.length)
  assert.ok(result.sessionId)
})

test('memory local fixture satisfies full WorkspaceSessionPort contract (parity peer)', async () => {
  const local = createMemoryWorkspaceSessionPort()
  assertWorkspaceSessionPort(local, { mode: 'full' })
  const result = await exerciseWorkspaceSessionPort(local)
  assert.equal(result.methodCount, WORKSPACE_SESSION_PORT_FULL_METHODS.length)
  const sessions = await local.listSessions()
  assert.ok(sessions.some((entry) => entry.id === result.sessionId))
})

test('cloud and memory ports both pass the same exercise runner (parity)', async () => {
  const cloud = new CloudWorkspaceAdapter({
    connection,
    transport: portTransport(),
    cache: null,
  })
  const memory = createMemoryWorkspaceSessionPort()
  const cloudResult = await exerciseWorkspaceSessionPort(cloud)
  const memoryResult = await exerciseWorkspaceSessionPort(memory)
  assert.equal(cloudResult.methodCount, memoryResult.methodCount)
  assert.equal(cloudResult.methodCount, WORKSPACE_SESSION_PORT_FULL_METHODS.length)
})

test('createCloudWorkspaceAdapter factory returns a WorkspaceSessionPort instance', () => {
  const adapter = createCloudWorkspaceAdapter(connection, 'token', { cache: null })
  assertWorkspaceSessionPort(adapter, { mode: 'full' })
  assert.equal(typeof adapter.listSessions, 'function')
  assert.equal(typeof adapter.promptSession, 'function')
  assert.equal(typeof adapter.listWorkflows, 'function')
  assert.equal(typeof adapter.importSession, 'function')
  assert.equal(typeof adapter.listArtifacts, 'function')
  assert.equal(typeof adapter.sync, 'function')
})

test('workspace-gateway cloudSessionPort returns WorkspaceSessionPort from factory', async () => {
  const adapter = new CloudWorkspaceAdapter({
    connection,
    transport: portTransport(),
    cache: null,
  })
  assertWorkspaceSessionPort(adapter)

  const credentials = {
    getUsableAccessToken: () => 'token',
    get: () => ({ accessToken: 'token', refreshToken: null, expiresAt: null }),
    save: () => {},
    clear: () => {},
  }

  const gateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: credentials as never,
    cloudDesktop: {
      enabled: true,
      cacheMode: 'memory',
      cacheEncryptionFallback: 'disable',
      preconfiguredConnections: [],
      requireManagedOrg: false,
    } as never,
    workspaces: [{
      id: connection.id,
      kind: 'cloud',
      label: connection.label,
      status: 'online',
      baseUrl: connection.baseUrl,
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  const port = await gateway.cloudSessionPort({ sender: { id: 1 } }, connection.id)
  assertWorkspaceSessionPort(port)
  assert.equal(port, adapter)
  const sessions = await port.listSessions()
  assert.equal(sessions[0]?.id, 'session-1')
  await port.promptSession('session-1', { text: 'via-gateway-port' })
  // Prefer port methods for extended dual-path ops (JOE-967 call-site preference).
  assert.equal(typeof (port as WorkspaceSessionPort).importSession, 'function')
  assert.equal(typeof (port as WorkspaceSessionPort).listArtifacts, 'function')
})
