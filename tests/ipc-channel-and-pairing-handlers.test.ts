import { createCoordinationProject, getCoordinationWatch, setCoordinationDatabaseForTests } from '@open-cowork/runtime-host/coordination/coordination-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type DesktopPairingPublicRecord } from '@open-cowork/shared'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerWorkspaceHandlers } from '../apps/desktop/src/main/ipc/workspace-handlers.ts'
import { registerDesktopPairingHandlers } from '../apps/desktop/src/main/ipc/desktop-pairing-handlers.ts'
import { registerChannelHandlers, resetDesktopChannelServiceForTests } from '../apps/desktop/src/main/ipc/channel-handlers.ts'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { createIpcHandlerHarness as createBaseContext } from './support/ipc-handler-harness.ts'

test('channel IPC bridge round-trips bindings, people, provider status, watches, and redacts secrets', async () => {
  const db = new DatabaseSync(':memory:')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-channels-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  resetDesktopChannelServiceForTests()
  setCoordinationDatabaseForTests(db)
  try {
    const { context, handlers } = createBaseContext()
    registerChannelHandlers(context)
    const event = { sender: { id: 799 } }
    const suffix = `test-${Date.now()}`
    const provider = `telegram-${suffix}`

    const providers = handlers.get('channels:providers') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const createAgent = handlers.get('channels:agents:create') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const updateAgent = handlers.get('channels:agents:update') as (event: unknown, agentId: unknown, input: unknown) => Promise<Record<string, unknown> | null>
    const listAgents = handlers.get('channels:agents:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const connectBinding = handlers.get('channels:bindings:connect') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const updateBinding = handlers.get('channels:bindings:update') as (event: unknown, bindingId: unknown, input: unknown) => Promise<Record<string, unknown> | null>
    const listBindings = handlers.get('channels:bindings:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const disconnectBinding = handlers.get('channels:bindings:disconnect') as (event: unknown, bindingId: unknown, options?: unknown) => Promise<Record<string, unknown> | null>
    const resolvePerson = handlers.get('channels:people:resolve') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const listPeople = handlers.get('channels:people:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const createWatch = handlers.get('channels:watches:create') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const updateWatch = handlers.get('channels:watches:update') as (event: unknown, watchId: unknown, input: unknown) => Promise<Record<string, unknown> | null>
    const listWatches = handlers.get('channels:watches:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const pauseWatch = handlers.get('channels:watches:pause') as (event: unknown, watchId: unknown, options?: unknown) => Promise<Record<string, unknown> | null>
    const resumeWatch = handlers.get('channels:watches:resume') as (event: unknown, watchId: unknown, options?: unknown) => Promise<Record<string, unknown> | null>
    const deleteWatch = handlers.get('channels:watches:delete') as (event: unknown, watchId: unknown, options?: unknown) => Promise<boolean>

    const initialTelegramProvider = (await providers(event)).find((entry) => entry.id === 'telegram')
    assert.equal(initialTelegramProvider?.status, 'available')
    assert.equal(initialTelegramProvider?.connected, false)

    const agent = await createAgent(event, {
      agentId: `agent-${suffix}`,
      name: 'Telegram reviewer',
      profileName: 'reviewer',
    })
    assert.equal(agent.agentId, `agent-${suffix}`)

    const updatedAgent = await updateAgent(event, agent.agentId, { name: 'Telegram reviewer updated' })
    assert.equal(updatedAgent?.name, 'Telegram reviewer updated')
    assert.equal((await listAgents(event, { limit: 20 })).some((entry) => entry.agentId === agent.agentId), true)

    const binding = await connectBinding(event, {
      bindingId: `binding-${suffix}`,
      agentId: agent.agentId,
      provider,
      displayName: 'Telegram production channel',
      externalWorkspaceId: `workspace-${suffix}`,
      credentialRef: 'env:TELEGRAM_BOT_TOKEN',
      settings: {
        room: 'engineering',
        token: 'fixture-token-value',
        nested: {
          authorization: 'fixture-authorization-value',
          apiKey: 'fixture-api-key-value',
        },
      },
    })
    assert.equal(binding.bindingId, `binding-${suffix}`)
    assert.equal(binding.credentialRefConfigured, true)
    assert.equal(binding.credentialRefKind, 'env')
    assert.equal('credentialRef' in binding, false)
    assert.equal((binding.settings as Record<string, unknown>).room, 'engineering')
    assert.equal((binding.settings as Record<string, unknown>).token, '[redacted]')
    assert.equal(((binding.settings as Record<string, unknown>).nested as Record<string, unknown>).authorization, '[redacted]')
    assert.equal(((binding.settings as Record<string, unknown>).nested as Record<string, unknown>).apiKey, '[redacted]')
    assert.equal(JSON.stringify(binding).includes('TELEGRAM_BOT_TOKEN'), false)
    assert.equal(JSON.stringify(binding).includes('fixture-api-key-value'), false)

    const connectedTelegramProvider = (await providers(event)).find((entry) => entry.id === 'telegram')
    assert.equal(connectedTelegramProvider?.status, 'connected')
    assert.equal(connectedTelegramProvider?.connected, true)
    assert.equal(Number(connectedTelegramProvider?.activeBindingCount) >= 1, true)

    const updatedBinding = await updateBinding(event, binding.bindingId, {
      displayName: 'Telegram engineering channel',
      settings: {
        room: 'engineering',
        secret: 'still-hidden',
      },
    })
    assert.equal(updatedBinding?.displayName, 'Telegram engineering channel')
    assert.equal(((updatedBinding?.settings || {}) as Record<string, unknown>).secret, '[redacted]')

    const listedBindings = await listBindings(event, { agentId: agent.agentId, limit: 20 })
    assert.equal(listedBindings.some((entry) => entry.bindingId === binding.bindingId), true)
    assert.equal(JSON.stringify(listedBindings).includes('still-hidden'), false)

    const person = await resolvePerson(event, {
      provider,
      channelBindingId: binding.bindingId,
      externalWorkspaceId: `workspace-${suffix}`,
      externalUserId: `user-${suffix}`,
      role: 'approver',
      status: 'active',
      metadata: {
      displayName: 'Ada',
        token: 'fixture-token-value',
        note: 'token: fixture-redaction-value',
      },
    })
    assert.equal(person.role, 'approver')
    assert.equal((person.metadata as Record<string, unknown>).displayName, 'Ada')
    assert.equal((person.metadata as Record<string, unknown>).token, '[redacted]')
    assert.equal((person.metadata as Record<string, unknown>).note, 'token:[redacted]')
    assert.equal(JSON.stringify(person).includes('fixture-redaction-value'), false)

    const people = await listPeople(event, { provider, limit: 20 })
    assert.equal(people.some((entry) => entry.identityId === person.identityId && entry.role === 'approver'), true)

    const project = createCoordinationProject({
      title: `Channel IPC ${suffix}`,
      objective: 'Prove channel watch CRUD through desktop IPC.',
    }, { id: `project-${suffix}` })

    const watch = await createWatch(event, {
      target: { kind: 'project', id: project.id },
      events: ['task.moved'],
      channel: {
        provider,
        agentId: String(agent.agentId),
        channelBindingId: String(binding.bindingId),
        target: { chatId: `chat-${suffix}` },
      },
      recipient: { role: 'approver', identityId: String(person.identityId) },
    })
    assert.equal(watch.kind, 'watch')
    assert.equal(watch.status, 'active')
    assert.equal((watch.channel as Record<string, unknown>).channelBindingId, binding.bindingId)

    const listedWatches = await listWatches(event, { targetKind: 'project', targetId: project.id })
    assert.equal(listedWatches.some((entry) => entry.id === watch.id), true)

    const updatedWatch = await updateWatch(event, watch.id, { events: ['task.review_ready'], cursor: 'cursor-1' })
    assert.deepEqual(updatedWatch?.events, ['task.review_ready'])
    assert.equal(updatedWatch?.cursor, 'cursor-1')

    const pausedWatch = await pauseWatch(event, watch.id)
    assert.equal(pausedWatch?.status, 'paused')
    const resumedWatch = await resumeWatch(event, watch.id)
    assert.equal(resumedWatch?.status, 'active')
    assert.equal(await deleteWatch(event, watch.id), true)
    assert.equal(getCoordinationWatch(String(watch.id)), null)

    const disconnected = await disconnectBinding(event, binding.bindingId)
    assert.equal(disconnected?.status, 'disabled')
    assert.equal(JSON.stringify(disconnected).includes('TELEGRAM_BOT_TOKEN'), false)
    const availableTelegramProvider = (await providers(event)).find((entry) => entry.id === 'telegram')
    assert.equal(availableTelegramProvider?.connected, false)
  } finally {
    setCoordinationDatabaseForTests(null)
    resetDesktopChannelServiceForTests()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
    db.close()
  }
})

test('channel IPC bridge reloads desktop-local channel bindings from durable app data', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-channel-persist-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  resetDesktopChannelServiceForTests()
  try {
    const first = createBaseContext()
    registerChannelHandlers(first.context)
    const event = { sender: { id: 800 } }
    const createAgent = first.handlers.get('channels:agents:create') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const connectBinding = first.handlers.get('channels:bindings:connect') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const agent = await createAgent(event, {
      agentId: 'persistent-agent',
      name: 'Persistent channel agent',
      profileName: 'reviewer',
    })
    await connectBinding(event, {
      bindingId: 'persistent-binding',
      agentId: agent.agentId,
      provider: 'slack',
      displayName: 'Persistent Slack',
      credentialRef: 'env:SLACK_BOT_TOKEN',
      settings: { room: 'launch', token: 'super-secret-token' },
    })

    resetDesktopChannelServiceForTests()

    const second = createBaseContext()
    registerChannelHandlers(second.context)
    const listAgents = second.handlers.get('channels:agents:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const listBindings = second.handlers.get('channels:bindings:list') as (event: unknown, options?: unknown) => Promise<Array<Record<string, unknown>>>
    const agents = await listAgents(event, { limit: 20 })
    const bindings = await listBindings(event, { agentId: 'persistent-agent', limit: 20 })

    assert.equal(agents.some((entry) => entry.agentId === 'persistent-agent'), true)
    const binding = bindings.find((entry) => entry.bindingId === 'persistent-binding')
    assert.equal(binding?.displayName, 'Persistent Slack')
    assert.equal(binding?.credentialRefConfigured, true)
    assert.equal(binding?.credentialRefKind, 'env')
    assert.equal(JSON.stringify(binding).includes('SLACK_BOT_TOKEN'), false)
    assert.equal(JSON.stringify(binding).includes('super-secret-token'), false)
  } finally {
    resetDesktopChannelServiceForTests()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

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

test('Gateway unreadable credential reset requires an action-bound destructive confirmation', async () => {
  const { context, handlers } = createBaseContext()
  let resetCalls = 0
  const requests: unknown[] = []
  context.workspaceGateway.resetUnreadableGatewayCredentials = () => {
    resetCalls += 1
    return true
  }
  context.consumeDestructiveConfirmation = (request, token) => {
    requests.push(request)
    return token === 'confirmed-gateway-reset'
  }

  registerWorkspaceHandlers(context)
  const handler = handlers.get('workspace:reset-gateway-credentials')
  assert.ok(handler, 'expected Gateway credential recovery handler to be registered')

  await assert.rejects(
    () => handler({}, null),
    /requires explicit confirmation/,
  )
  assert.equal(resetCalls, 0)
  assert.equal(await handler({}, 'confirmed-gateway-reset'), true)
  assert.equal(resetCalls, 1)
  assert.deepEqual(requests, [
    { action: 'gateway.credentials.reset' },
    { action: 'gateway.credentials.reset' },
  ])
})
