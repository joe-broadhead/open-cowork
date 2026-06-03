import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  DesktopPairingAuditEvent,
  DesktopPairingCommand,
  DesktopPairingCommandClaimRequest,
  DesktopPairingCommandClaimResult,
  DesktopPairingCommandResult,
  DesktopPairingCreateInput,
  DesktopPairingRecord,
  DesktopPairingRemoteEvent,
  SessionInfo,
} from '@open-cowork/shared'
import { DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED } from '../packages/shared/src/desktop-pairing.ts'
import {
  DesktopPairingService,
  type DesktopPairingCommandExecutor,
} from '../apps/desktop/src/main/desktop-pairing/service.ts'
import type {
  DesktopPairingStore,
} from '../apps/desktop/src/main/desktop-pairing/store.ts'
import type {
  DesktopPairingCredentialInput,
  DesktopPairingCredentialRecord,
  DesktopPairingCredentialStore,
} from '../apps/desktop/src/main/desktop-pairing/credentials.ts'
import type {
  DesktopPairingTransport,
  DesktopPairingTransportContext,
} from '../apps/desktop/src/main/desktop-pairing/transport.ts'

class MemoryPairingStore implements DesktopPairingStore {
  records = new Map<string, DesktopPairingRecord>()
  audit: DesktopPairingAuditEvent[] = []

  list() {
    return [...this.records.values()]
  }

  get(pairingId: string) {
    return this.records.get(pairingId) || null
  }

  save(record: DesktopPairingRecord) {
    this.records.set(record.id, { ...record })
    return this.records.get(record.id)!
  }

  remove(pairingId: string) {
    return this.records.delete(pairingId)
  }

  listAudit(pairingId?: string | null, limit = 100) {
    return this.audit
      .filter((entry) => !pairingId || entry.pairingId === pairingId)
      .slice(-limit)
      .reverse()
  }

  appendAudit(event: DesktopPairingAuditEvent) {
    this.audit.push(event)
    return event
  }
}

class MemoryCredentialStore implements DesktopPairingCredentialStore {
  records = new Map<string, DesktopPairingCredentialRecord>()

  get(pairingId: string) {
    return this.records.get(pairingId) || null
  }

  listMetadata() {
    return [...this.records.values()].map((record) => ({
      pairingId: record.pairingId,
      deviceId: record.deviceId,
      hasToken: true,
      updatedAt: record.updatedAt,
    }))
  }

  save(input: DesktopPairingCredentialInput, now = new Date()) {
    const record = { ...input, updatedAt: now.toISOString() }
    this.records.set(input.pairingId, record)
    return record
  }

  remove(pairingId: string) {
    return this.records.delete(pairingId)
  }
}

class MemoryTransport implements DesktopPairingTransport {
  commands: DesktopPairingCommand[] = []
  claims: DesktopPairingCommandClaimRequest[] = []
  acks: Array<{ commandId: string; result: DesktopPairingCommandResult; leaseToken?: string | null }> = []
  failures: Array<{ commandId: string; result: DesktopPairingCommandResult; leaseToken?: string | null }> = []
  events: DesktopPairingRemoteEvent[] = []
  revoked = false
  failNextAck = false
  failNextPublish = false

  async heartbeat() {}

  async claimCommands(_context: DesktopPairingTransportContext, request: DesktopPairingCommandClaimRequest): Promise<DesktopPairingCommandClaimResult> {
    this.claims.push(request)
    return { commands: this.commands.filter((command) => command.sequence > request.afterSequence) }
  }

  async ackCommand(_context: DesktopPairingTransportContext, commandId: string, result: DesktopPairingCommandResult, leaseToken?: string | null) {
    if (this.failNextAck) {
      this.failNextAck = false
      throw new Error('ack network failed')
    }
    this.acks.push({ commandId, result, leaseToken })
  }

  async failCommand(_context: DesktopPairingTransportContext, commandId: string, result: DesktopPairingCommandResult, leaseToken?: string | null) {
    this.failures.push({ commandId, result, leaseToken })
  }

  async publishEvents(_context: DesktopPairingTransportContext, events: DesktopPairingRemoteEvent[]) {
    if (this.failNextPublish) {
      this.failNextPublish = false
      throw new Error('publish network failed')
    }
    this.events.push(...events)
  }

  async revoke() {
    this.revoked = true
  }
}

function session(id = 'session-1'): SessionInfo {
  return {
    id,
    title: 'Local /tmp/open-cowork-project thread',
    directory: '/tmp/open-cowork-project',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  }
}

function executor(): DesktopPairingCommandExecutor & { prompts: unknown[] } {
  const prompts: unknown[] = []
  return {
    prompts,
    async createSession() {
      return session('created-session')
    },
    async prompt(input) {
      prompts.push(input)
      return session(input.sessionId)
    },
    async abort() {},
    async respondPermission() {},
    async replyQuestion() {},
    async rejectQuestion() {},
    async listSessions() {
      return [session()]
    },
  }
}

function service(input: {
  transport?: MemoryTransport
  executor?: DesktopPairingCommandExecutor
  create?: DesktopPairingCreateInput
} = {}) {
  const store = new MemoryPairingStore()
  const credentialStore = new MemoryCredentialStore()
  const transport = input.transport || new MemoryTransport()
  let counter = 0
  const created = new DesktopPairingService({
    store,
    credentialStore,
    transportFactory: () => transport,
    executor: input.executor || executor(),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
    idFactory: () => `id-${++counter}`,
    tokenFactory: () => 'token-secret',
    pollIntervalMs: 60_000,
  })
  const pairing = created.create({
    label: 'Phone',
    brokerUrl: 'http://localhost:8787',
    enabled: false,
    allowedWorkspaceIds: ['local'],
    ...input.create,
  })
  return { service: created, store, credentialStore, transport, pairing }
}

test('desktop pairing creates revocable metadata without exposing stored token', () => {
  const { service: pairingService, pairing, credentialStore } = service()

  assert.equal(pairing.pairingToken, 'token-secret')
  assert.equal(pairing.record.credential.hasToken, true)
  assert.equal(pairing.record.credential.deviceId?.startsWith('desktop_device_'), true)
  assert.equal(pairing.record.status, 'disabled')
  assert.equal(credentialStore.get(pairing.record.id)?.token, 'token-secret')

  const listed = pairingService.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.credential.hasToken, true)
  assert.equal('token' in (listed[0]?.credential || {}), false)
  assert.equal(pairingService.auditLog(pairing.record.id).some((entry) => entry.action === 'pairing.created'), true)
})

test('desktop pairing claims a remote prompt with lease, executes locally, acks, and redacts results', async () => {
  const runner = executor()
  const transport = new MemoryTransport()
  const { service: pairingService, pairing } = service({ transport, executor: runner })
  transport.commands.push({
    id: 'cmd-1',
    kind: 'prompt',
    pairingId: pairing.record.id,
    workspaceId: 'local',
    sessionId: 'session-1',
    payload: { text: 'inspect /tmp/open-cowork-project', agent: 'build' },
    sequence: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    lease: {
      leasedBy: 'desktop',
      leaseToken: 'lease-1',
      leaseExpiresAt: '2026-06-01T12:01:00.000Z',
    },
  })

  await pairingService.connect(pairing.record.id)

  assert.equal(runner.prompts.length, 1)
  assert.equal(transport.acks.length, 1)
  assert.equal(transport.acks[0]?.leaseToken, 'lease-1')
  assert.equal(transport.acks[0]?.result.session?.directory, null)
  assert.equal(transport.acks[0]?.result.session?.title, 'Local [local-path] thread')
  assert.equal(transport.acks[0]?.result.projectionFence, null)
  assert.deepEqual(transport.acks[0]?.result.projectionFenceStatus, DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED)
  assert.equal(pairingService.get(pairing.record.id)?.lastCommandSequence, 1)
  assert.equal(pairingService.auditLog(pairing.record.id).some((entry) => entry.action === 'command.completed'), true)
})

test('desktop pairing advances command sequence after local execution when ack delivery fails', async () => {
  const runner = executor()
  const transport = new MemoryTransport()
  const { service: pairingService, pairing } = service({ transport, executor: runner })
  transport.failNextAck = true
  transport.commands.push({
    id: 'cmd-ack-fails',
    kind: 'prompt',
    pairingId: pairing.record.id,
    workspaceId: 'local',
    sessionId: 'session-1',
    payload: { text: 'run once' },
    sequence: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
  })

  await pairingService.connect(pairing.record.id)
  await pairingService.pollOnce(pairing.record.id)

  assert.equal(runner.prompts.length, 1)
  assert.equal(pairingService.get(pairing.record.id)?.lastCommandSequence, 1)
  assert.equal(pairingService.get(pairing.record.id)?.status, 'paired_online')
  assert.equal(pairingService.auditLog(pairing.record.id).some((entry) => entry.action === 'pairing.offline'), true)
})

test('desktop pairing polls are single-flight and do not overwrite newer store state', async () => {
  const transport = new MemoryTransport()
  const { service: pairingService, pairing, store } = service({ transport })
  store.save({
    ...store.get(pairing.record.id)!,
    enabled: true,
    status: 'paired_offline',
  })

  let releaseClaim: (() => void) | null = null
  const claimStarted = new Promise<void>((resolve) => {
    releaseClaim = resolve
  })
  let claimEntered: (() => void) | null = null
  const enteredClaim = new Promise<void>((resolve) => {
    claimEntered = resolve
  })
  transport.claimCommands = async (_context, request) => {
    transport.claims.push(request)
    claimEntered?.()
    await claimStarted
    return { commands: [] }
  }

  const firstPoll = pairingService.pollOnce(pairing.record.id)
  const secondPoll = pairingService.pollOnce(pairing.record.id)
  await enteredClaim
  assert.equal(transport.claims.length, 1)

  store.save({
    ...store.get(pairing.record.id)!,
    lastCommandSequence: 41,
  })
  releaseClaim?.()
  const [firstSnapshot, secondSnapshot] = await Promise.all([firstPoll, secondPoll])

  assert.equal(firstSnapshot.lastCommandSequence, 41)
  assert.deepEqual(secondSnapshot, firstSnapshot)
  assert.equal(pairingService.get(pairing.record.id)?.lastCommandSequence, 41)
})

test('desktop pairing poll does not re-enable or execute after concurrent disable', async () => {
  const runner = executor()
  const transport = new MemoryTransport()
  const { service: pairingService, pairing, store } = service({ transport, executor: runner })
  store.save({
    ...store.get(pairing.record.id)!,
    enabled: true,
    status: 'paired_offline',
  })
  const command: DesktopPairingCommand = {
    id: 'cmd-1',
    kind: 'prompt',
    pairingId: pairing.record.id,
    workspaceId: 'local',
    sessionId: 'session-1',
    payload: { text: 'should not run' },
    sequence: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
  }
  transport.claimCommands = async (_context, request) => {
    transport.claims.push(request)
    store.save({
      ...store.get(pairing.record.id)!,
      enabled: false,
      status: 'disabled',
    })
    return { commands: [command] }
  }

  const snapshot = await pairingService.pollOnce(pairing.record.id)

  assert.equal(snapshot.status, 'disabled')
  assert.equal(pairingService.get(pairing.record.id)?.enabled, false)
  assert.equal(runner.prompts.length, 0)
  assert.equal(transport.acks.length, 0)
})

test('desktop pairing treats accepted-event delivery as best effort', async () => {
  const runner = executor()
  const transport = new MemoryTransport()
  const { service: pairingService, pairing } = service({ transport, executor: runner })
  transport.failNextPublish = true
  transport.commands.push({
    id: 'cmd-publish-fails',
    kind: 'prompt',
    pairingId: pairing.record.id,
    workspaceId: 'local',
    sessionId: 'session-1',
    payload: { text: 'still run' },
    sequence: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
  })

  await pairingService.connect(pairing.record.id)

  assert.equal(runner.prompts.length, 1)
  assert.equal(transport.acks.length, 1)
  assert.equal(pairingService.get(pairing.record.id)?.lastCommandSequence, 1)
})

test('desktop pairing blocks non-local workspace commands and remote approvals by default', async () => {
  const transport = new MemoryTransport()
  const { service: pairingService, pairing } = service({ transport })
  transport.commands.push(
    {
      id: 'cmd-cloud',
      kind: 'status',
      pairingId: pairing.record.id,
      workspaceId: 'cloud:test',
      sequence: 1,
      createdAt: '2026-06-01T12:00:00.000Z',
    },
    {
      id: 'cmd-approval',
      kind: 'permission.respond',
      pairingId: pairing.record.id,
      workspaceId: 'local',
      sessionId: 'session-1',
      payload: { permissionId: 'perm-1', allowed: true },
      sequence: 2,
      createdAt: '2026-06-01T12:00:01.000Z',
    },
  )

  await pairingService.connect(pairing.record.id)

  assert.equal(transport.failures.length, 2)
  assert.equal(transport.failures[0]?.result.status, 'blocked_by_policy')
  assert.equal(transport.failures[0]?.result.projectionFence, null)
  assert.deepEqual(transport.failures[0]?.result.projectionFenceStatus, DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED)
  assert.equal(transport.failures[1]?.result.status, 'requires_local_confirmation')
  assert.equal(transport.failures[1]?.result.projectionFence, null)
  assert.deepEqual(transport.failures[1]?.result.projectionFenceStatus, DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED)
  assert.equal(pairingService.auditLog(pairing.record.id).some((entry) => entry.action === 'command.blocked'), true)
})

test('desktop pairing enforces allowed session ids across status, creation, and event projection', async () => {
  const transport = new MemoryTransport()
  const scopedExecutor = executor()
  scopedExecutor.listSessions = async () => [session('session-1'), session('session-2')]
  const { service: pairingService, pairing, store } = service({
    transport,
    executor: scopedExecutor,
    create: { allowedSessionIds: ['session-1'] },
  })
  transport.commands.push(
    {
      id: 'cmd-status',
      kind: 'status',
      pairingId: pairing.record.id,
      workspaceId: 'local',
      sequence: 1,
      createdAt: '2026-06-01T12:00:00.000Z',
    },
    {
      id: 'cmd-create',
      kind: 'create_session',
      pairingId: pairing.record.id,
      workspaceId: 'local',
      sequence: 2,
      createdAt: '2026-06-01T12:00:01.000Z',
    },
  )

  await pairingService.connect(pairing.record.id)

  assert.equal(transport.acks[0]?.result.sessions?.length, 1)
  assert.equal(transport.acks[0]?.result.sessions?.[0]?.id, 'session-1')
  assert.equal(transport.failures[0]?.commandId, 'cmd-create')
  assert.equal(transport.failures[0]?.result.status, 'blocked_by_policy')

  store.save({ ...store.get(pairing.record.id)!, enabled: true, status: 'paired_online' })
  pairingService.observeRuntimeEvent({ type: 'message', sessionId: 'session-2', data: { text: 'blocked' } })
  pairingService.observeRuntimeEvent({ type: 'message', sessionId: 'session-1', data: { text: 'allowed' } })

  assert.equal(transport.events.filter((event) => event.type === 'session.event').length, 1)
  assert.equal(transport.events.find((event) => event.type === 'session.event')?.sessionId, 'session-1')
})

test('desktop pairing publishes remote-safe runtime events and redacts secrets, paths, and local mcp details', async () => {
  const transport = new MemoryTransport()
  const { service: pairingService, pairing, store } = service({ transport })
  store.save({ ...store.get(pairing.record.id)!, enabled: true, status: 'paired_online' })

  pairingService.observeRuntimeEvent({
    type: 'tool_call',
    sessionId: 'session-1',
    data: {
      type: 'tool_call',
      name: 'local tool',
      input: {
        path: '/tmp/open-cowork-project/file.ts',
        apiKey: 'secret',
        command: 'node server.js',
      },
    },
  })

  assert.equal(transport.events.length, 1)
  assert.deepEqual(transport.events[0]?.payload?.data, {
    type: 'tool_call',
    name: 'local tool',
    input: {
      path: '[local-path]',
      apiKey: '[secret-redacted]',
      command: '[local-mcp-detail-redacted]',
    },
  })
})

test('desktop pairing revocation removes local credential even when remote is reachable', async () => {
  const transport = new MemoryTransport()
  const { service: pairingService, pairing, credentialStore } = service({ transport })

  const status = await pairingService.revoke(pairing.record.id)

  assert.equal(status.status, 'revoked')
  assert.equal(credentialStore.get(pairing.record.id), null)
  assert.equal(transport.revoked, true)
})

test('remote revoke command cannot resurrect a revoked pairing after ack', async () => {
  const transport = new MemoryTransport()
  const { service: pairingService, pairing, credentialStore } = service({ transport })
  transport.commands.push({
    id: 'cmd-revoke',
    kind: 'revoke_pairing',
    pairingId: pairing.record.id,
    workspaceId: 'local',
    sequence: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    lease: {
      leasedBy: 'desktop',
      leaseToken: 'lease-revoke',
      leaseExpiresAt: '2026-06-01T12:01:00.000Z',
    },
  })

  await pairingService.connect(pairing.record.id)

  assert.equal(pairingService.get(pairing.record.id)?.status, 'revoked')
  assert.equal(pairingService.get(pairing.record.id)?.lastCommandSequence, 1)
  assert.equal(credentialStore.get(pairing.record.id), null)
  assert.equal(transport.acks[0]?.leaseToken, 'lease-revoke')
})
