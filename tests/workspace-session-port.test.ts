/**
 * Workspace session port contract (audit 2026-07-21 P2-8).
 *
 * Drives the shipped assertWorkspaceSessionPort against real adapter instances
 * from createCloudWorkspaceAdapter / CloudWorkspaceAdapter — not source-string theater.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CloudWorkspaceAdapter,
  createCloudWorkspaceAdapter,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import {
  assertWorkspaceSessionPort,
  type WorkspaceSessionPort,
} from '../apps/desktop/src/main/workspace-session-port.ts'
import type { CloudTransportAdapter } from '@open-cowork/cloud-server/transport-adapter'
import {
  createWorkspaceGateway,
} from '../apps/desktop/src/main/workspace-gateway.ts'

function portTransport(): CloudTransportAdapter {
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
    listSessions: async () => [{
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
    }],
    createSession: async () => ({
      session: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-2',
        opencodeSessionId: 'opencode-session-2',
        profileName: 'default',
        status: 'idle',
        title: 'New',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
        projectSource: null,
      },
      projection: null,
    }),
    // getSession is the transport surface used by CloudWorkspaceAdapter.getSessionView
    getSession: async (sessionId: string) => ({
      session: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId,
        opencodeSessionId: `opencode-${sessionId}`,
        profileName: 'default',
        status: 'idle',
        title: 'Hello',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
        projectSource: null,
      },
      projection: {
        tenantId: 'tenant-1',
        sessionId,
        sequence: 1,
        updatedAt: '2026-05-27T10:00:00.000Z',
        view: {
          sessionId,
          title: 'Hello',
          status: 'idle',
          profileName: 'default',
          isGenerating: false,
          messages: [],
          toolCalls: [],
          todos: [],
          pendingApprovals: [],
          pendingQuestions: [],
          artifacts: [],
        },
      },
    }),
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
})

test('CloudWorkspaceAdapter instance satisfies WorkspaceSessionPort (shipped class)', async () => {
  const adapter = new CloudWorkspaceAdapter({
    connection,
    transport: portTransport(),
    cache: null,
  })
  assertWorkspaceSessionPort(adapter)
  // Drive real port methods on the shipped instance.
  const port: WorkspaceSessionPort = adapter
  const policy = await port.policy()
  assert.equal(policy.localFiles, 'disabled')
  const sessions = await port.listSessions()
  assert.equal(sessions[0]?.id, 'session-1')
  const created = await port.createSession()
  assert.equal(created.id, 'session-2')
  const view = await port.getSessionView('session-1')
  assert.ok(view)
  assert.ok(Array.isArray(view.messages))
  await port.promptSession('session-1', { text: 'hi' })
  await port.abortSession('session-1')
  await port.replyToQuestion('session-1', 'q1', ['a'])
  await port.rejectQuestion('session-1', 'q1')
  await port.respondToPermission('session-1', 'p1', false)
  const workflows = await port.listWorkflows()
  assert.ok(Array.isArray(workflows.workflows) || workflows !== null)
  await port.getWorkflow('wf-1')
  await port.runWorkflow('wf-1')
  await port.pauseWorkflow('wf-1')
  await port.resumeWorkflow('wf-1')
  await port.archiveWorkflow('wf-1')
})

test('createCloudWorkspaceAdapter factory returns a WorkspaceSessionPort instance', () => {
  // Factory uses real transport default only when not overridden; construct via
  // class with mock transport then re-assert the factory path with a stub that
  // still goes through assertWorkspaceSessionPort.
  const adapter = createCloudWorkspaceAdapter(connection, 'token', { cache: null })
  // Without a mock transport the HTTP client is real — still must implement port methods.
  assertWorkspaceSessionPort(adapter)
  assert.equal(typeof adapter.listSessions, 'function')
  assert.equal(typeof adapter.promptSession, 'function')
  assert.equal(typeof adapter.listWorkflows, 'function')
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
  // Drive a prompt through the port surface returned by workspace-gateway.
  await port.promptSession('session-1', { text: 'via-gateway-port' })
})
