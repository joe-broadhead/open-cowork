import test from 'node:test'
import assert from 'node:assert/strict'

import type { CloudGateway } from '../dist/index.js'
import {
  createGatewayHttpServer,
  createGatewayProviderRegistry,
  createGatewayRuntime,
  resolveGatewayConfig as resolveGatewayConfigBase,
} from '../dist/index.js'

const cloudEnv = {
  OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
}

function resolveGatewayConfig(
  raw: Parameters<typeof resolveGatewayConfigBase>[0] = {},
  env: Parameters<typeof resolveGatewayConfigBase>[1] = {},
) {
  return resolveGatewayConfigBase(raw, {
    ...cloudEnv,
    ...env,
  })
}

function twoFakeProviderConfig() {
  return resolveGatewayConfig({
    server: { adminToken: 'admin-token' },
    providers: [{
      id: 'fake-bad',
      kind: 'fake',
      channelBindingId: 'fake-bad-binding',
    }, {
      id: 'fake-good',
      kind: 'fake',
      channelBindingId: 'fake-good-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
  })
}

function failProviderStart(
  registry: ReturnType<typeof createGatewayProviderRegistry>,
  id: string,
  message = 'provider start failed with secret-token-1234567890',
) {
  const registration = registry.get(id)
  assert.ok(registration, `expected provider ${id}`)
  registration.provider.start = async () => {
    throw new Error(message)
  }
}

function providerEventRecord(input: {
  provider: string
  providerInstanceId: string
  externalWorkspaceId?: string | null
  providerEventId: string
  eventType: 'message' | 'command' | 'interaction'
  claimedBy?: string | null
  status?: 'processing' | 'processed' | 'failed'
}) {
  return {
    eventId: `event-${input.providerInstanceId}-${input.providerEventId}-${input.eventType}`,
    orgId: 'tenant-1',
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    externalWorkspaceId: input.externalWorkspaceId || null,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    status: input.status || 'processing',
    claimedBy: input.claimedBy || null,
    claimExpiresAt: input.claimedBy ? new Date(Date.now() + 30_000).toISOString() : null,
    attemptCount: 1,
    retryable: true,
    lastError: null,
    metadata: {},
    processedAt: input.status === 'processed' ? new Date().toISOString() : null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as never
}

function fakeCloud(prompted: string[] = []): CloudGateway {
  return {
    async resolveIdentity(input) {
      return {
        identityId: `identity-${input.externalUserId}`,
        orgId: 'tenant-1',
        provider: input.provider,
        externalWorkspaceId: input.externalWorkspaceId || null,
        externalUserId: input.externalUserId,
        accountId: null,
        role: 'member',
        status: 'active',
        metadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async bindSession(input) {
      return {
        binding: {
          bindingId: 'session-binding-1',
          orgId: 'tenant-1',
          agentId: 'agent-1',
          channelBindingId: input.channelBindingId,
          provider: input.provider,
          externalWorkspaceId: input.externalWorkspaceId || null,
          externalThreadId: input.externalThreadId,
          externalChatId: input.externalChatId,
          sessionId: 'session-1',
          lastEventSequence: 0,
          lastWorkspaceSequence: 0,
          lastChatMessageId: null,
          status: 'active',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        session: {
          session: {
            tenantId: 'tenant-1',
            userId: 'user-1',
            sessionId: 'session-1',
            opencodeSessionId: 'oc-session-1',
            profileName: 'full',
            status: 'idle',
            title: 'Fake',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          projection: null,
        },
      }
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt(input) {
      prompted.push(input.text)
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: 'cmd-1' } as never, processed: 1 }
    },
    async claimProviderEvent(input) {
      return {
        event: providerEventRecord(input),
        claimed: true,
        duplicate: false,
      }
    },
    async completeProviderEvent(eventId, input) {
      return providerEventRecord({
        provider: 'fake',
        providerInstanceId: 'fake',
        providerEventId: eventId,
        eventType: 'message',
        claimedBy: input.claimedBy,
        status: input.status,
      })
    },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
  } as CloudGateway
}

test('provider registry isolates one provider startup failure and starts the rest', async () => {
  const registry = createGatewayProviderRegistry(twoFakeProviderConfig())
  failProviderStart(registry, 'fake-bad')

  await registry.start(async () => {})

  const failed = registry.get('fake-bad')
  const healthy = registry.get('fake-good')
  assert.equal(failed?.started, false)
  assert.equal(failed?.healthy, false)
  assert.match(failed?.lastError || '', /provider start failed/)
  assert.equal(healthy?.started, true)
  assert.equal(healthy?.healthy, true)
  assert.equal(healthy?.lastError, null)
})

test('provider registry treats Telegram webhook setup failure as provider-local', async () => {
  const config = resolveGatewayConfig({
    providers: [{
      id: 'telegram-bad',
      kind: 'telegram',
      channelBindingId: 'telegram-binding',
      credentials: {
        botToken: 'telegram-token',
        webhookSecret: 'telegram-webhook-secret',
      },
      settings: {
        mode: 'webhook',
        publicBaseUrl: 'https://gateway.example.test',
      },
    }, {
      id: 'fake-good',
      kind: 'fake',
      channelBindingId: 'fake-good-binding',
    }],
  })
  const registry = createGatewayProviderRegistry(config)
  const telegram = registry.get('telegram-bad')
  assert.ok(telegram)
  telegram.provider.start = async () => {}
  ;(telegram.provider as { configureWebhook?: () => Promise<void> }).configureWebhook = async () => {
    throw new Error('Telegram setWebhook failed')
  }

  await registry.start(async () => {})

  assert.equal(registry.get('telegram-bad')?.started, false)
  assert.equal(registry.get('telegram-bad')?.healthy, false)
  assert.match(registry.get('telegram-bad')?.lastError || '', /setWebhook failed/)
  assert.equal(registry.get('fake-good')?.started, true)
  assert.equal(registry.get('fake-good')?.healthy, true)
})

test('gateway runtime is ready when at least one provider starts and records failed providers', async () => {
  const config = twoFakeProviderConfig()
  const registry = createGatewayProviderRegistry(config)
  failProviderStart(registry, 'fake-bad')
  const runtime = createGatewayRuntime(config, fakeCloud(), registry, { subscribeDeliveries: false })

  await runtime.start()
  try {
    assert.equal(runtime.ready(), true)
    assert.equal(runtime.metrics.providerMetrics['fake-bad']?.state, 'failed')
    assert.equal(runtime.metrics.providerMetrics['fake-good']?.state, 'healthy')
    assert.match(runtime.providers.get('fake-bad')?.lastError || '', /provider start failed/)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime is not ready when every provider fails startup', async () => {
  const config = resolveGatewayConfig({
    providers: [{
      id: 'fake-bad',
      kind: 'fake',
      channelBindingId: 'fake-bad-binding',
    }],
  })
  const registry = createGatewayProviderRegistry(config)
  failProviderStart(registry, 'fake-bad')
  const runtime = createGatewayRuntime(config, fakeCloud(), registry, { subscribeDeliveries: false })

  await runtime.start()
  try {
    assert.equal(runtime.ready(), false)
    assert.equal(runtime.metrics.providerMetrics['fake-bad']?.state, 'failed')
  } finally {
    await runtime.stop()
  }
})

test('gateway webhook routes fail closed for failed providers while healthy providers serve', async () => {
  const prompted: string[] = []
  const config = twoFakeProviderConfig()
  const registry = createGatewayProviderRegistry(config)
  failProviderStart(registry, 'fake-bad')
  const runtime = createGatewayRuntime(config, fakeCloud(prompted), registry, { subscribeDeliveries: false })

  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()
  try {
    const failedResponse = await fetch(`${url}/webhooks/fake-bad`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bad-event-1', text: 'do not process' }),
    })
    assert.equal(failedResponse.status, 502)

    const healthyResponse = await fetch(`${url}/webhooks/fake-good`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'good-event-1', text: 'ship it', chatId: 'chat-1', userId: 'user-1' }),
    })
    assert.equal(healthyResponse.status, 202)
    assert.deepEqual(prompted, ['ship it'])
  } finally {
    await http.close()
    await runtime.stop()
  }
})
