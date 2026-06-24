import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import {
  WebhookCircuitOpenError,
  WebhookDeliveryPolicyError,
} from '@open-cowork/gateway-provider-webhook'
import type { CloudGateway } from '../dist/index.js'
import {
  createGatewayDaemon,
  createGatewayHttpServer,
  createGatewayProviderRegistry,
  createGatewayRuntime,
  resolveGatewayConfig as resolveGatewayConfigBase,
} from '../dist/index.js'

const cloudEnv = {
  OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
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

function signedWebhookHeaders(rawBody: string, sharedSecret: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'content-type': 'application/json',
    'x-open-cowork-gateway-webhook-timestamp': timestamp,
    'x-open-cowork-gateway-webhook-signature': `v1=${createHmac('sha256', sharedSecret).update(`v1:${timestamp}:${rawBody}`).digest('hex')}`,
  }
}

test('gateway daemon default cloud client uses the resolved config instead of process env', () => {
  const previousBaseUrl = process.env.OPEN_COWORK_CLOUD_BASE_URL
  const previousServiceToken = process.env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN
  const config = resolveGatewayConfigBase({
    server: {
      port: 0,
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://configured-cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'configured-service-token',
  })
  try {
    delete process.env.OPEN_COWORK_CLOUD_BASE_URL
    delete process.env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN
    const daemon = createGatewayDaemon(config)
    assert.equal(daemon.config.cloud.baseUrl, 'https://configured-cloud.example.test')
    assert.equal(daemon.config.cloud.serviceToken, 'configured-service-token')
  } finally {
    if (previousBaseUrl === undefined) delete process.env.OPEN_COWORK_CLOUD_BASE_URL
    else process.env.OPEN_COWORK_CLOUD_BASE_URL = previousBaseUrl
    if (previousServiceToken === undefined) delete process.env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN
    else process.env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN = previousServiceToken
  }
})

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

test('gateway daemon exposes health, readiness, metrics, diagnostics, and fake webhook', async () => {
  const prompted: string[] = []
  const cloud: CloudGateway = {
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
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async readArtifactAttachment() { return { filename: 'artifact.txt', mime: 'text/plain', url: 'data:text/plain;base64,b2s=' } },
    artifactUrl() { return 'https://cloud.example.test/api/sessions/session-1/artifacts/artifact-1' },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
  }
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
      credentials: {
        apiKey: 'provider-api-key-1234567890',
      },
      settings: {
        callbackSecret: 'provider-callback-secret-1234567890',
        deliveryUrl: 'https://example.test/deliver?token=provider-token-1234567890',
        workspacePath: '/home/alice/acme-private',
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-1234567890',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const health = await readJson(await fetch(`${url}/health`))
    assert.equal(health.ok, true)
    assert.equal((health.branding as { productName: string }).productName, 'Open Cowork Cloud')
    assert.equal(health.cloudBaseUrl, 'https://cloud.example.test')

    const ready = await readJson(await fetch(`${url}/ready`))
    assert.equal(ready.ok, true)
    assert.equal((ready.branding as { productName: string }).productName, 'Open Cowork Cloud')

    const adminHeaders = { authorization: 'Bearer admin-token' }
    const metrics = await fetch(`${url}/metrics`, { headers: adminHeaders })
    assert.equal(metrics.status, 200)
    const metricsText = await metrics.text()
    assert.match(metricsText, /open_cowork_gateway_providers 1/)
    assert.match(metricsText, /open_cowork_gateway_session_streams 0/)
    assert.match(metricsText, /open_cowork_gateway_webhook_requests_total 0/)

    const diagnostics = await readJson(await fetch(`${url}/diagnostics`, { headers: adminHeaders }))
    assert.equal((diagnostics.config as { cloud: { serviceToken: string } }).cloud.serviceToken, 'serv...[redacted]...7890')
    const diagnosticProvider = ((diagnostics.config as { providers: Array<{
      credentials: Record<string, string>
      settings: Record<string, string>
    }> }).providers)[0]
    assert.equal(diagnosticProvider?.credentials.apiKey, 'prov...[redacted]...7890')
    assert.equal(diagnosticProvider?.settings.callbackSecret, 'prov...[redacted]...7890')
    assert.equal(diagnosticProvider?.settings.deliveryUrl, 'https://example.test/deliver?token=[redacted]')
    assert.equal(diagnosticProvider?.settings.workspacePath, '/home/[redacted]')

    const webhook = await fetch(`${url}/webhooks/fake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ship it', chatId: 'chat-1', userId: 'user-1' }),
    })
    assert.equal(webhook.status, 202)
    assert.deepEqual(prompted, ['ship it'])
    assert.equal(runtime.metrics.webhookRequests, 1)
    assert.equal(runtime.metrics.providerMetrics.fake?.webhookRequests, 1)
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway runtime claims provider events before prompting and skips duplicate claims', async () => {
  const prompted: Array<{ text: string, commandId?: string | null }> = []
  const claims: Array<{ providerEventId: string, providerInstanceId: string, eventType: string }> = []
  const completed: Array<{ eventId: string, status: string }> = []
  const seen = new Set<string>()
  const cloud: CloudGateway = {
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
          session: { sessionId: 'session-1' },
          projection: null,
        },
      } as never
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt(input) {
      prompted.push({ text: input.text, commandId: input.commandId })
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: 'cmd-1' } as never, processed: 1 }
    },
    async claimProviderEvent(input) {
      claims.push({
        providerEventId: input.providerEventId,
        providerInstanceId: input.providerInstanceId,
        eventType: input.eventType,
      })
      const key = `${input.providerInstanceId}:${input.eventType}:${input.providerEventId}`
      if (seen.has(key)) {
        return {
          event: providerEventRecord({ ...input, status: 'processed' }),
          claimed: false,
          duplicate: true,
        }
      }
      seen.add(key)
      return {
        event: providerEventRecord(input),
        claimed: true,
        duplicate: false,
      }
    },
    async completeProviderEvent(eventId, input) {
      completed.push({ eventId, status: input.status })
      return providerEventRecord({
        provider: 'cli',
        providerInstanceId: 'fake',
        providerEventId: eventId,
        eventType: 'message',
        claimedBy: input.claimedBy,
        status: input.status,
      })
    },
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
    artifactUrl() { return 'https://cloud.example.test/api/sessions/session-1/artifacts/artifact-1' },
  }
  const config = resolveGatewayConfig({
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })

  await runtime.start()
  try {
    await runtime.providers.emitFake('fake', { id: 'provider-event-1', text: 'ship it', chatId: 'chat-1', userId: 'user-1' })
    await runtime.providers.emitFake('fake', { id: 'provider-event-1', text: 'ship it again', chatId: 'chat-1', userId: 'user-1' })

    assert.deepEqual(prompted, [{ text: 'ship it', commandId: 'event-fake-provider-event-1-message' }])
    assert.deepEqual(claims, [
      { providerEventId: 'provider-event-1', providerInstanceId: 'fake', eventType: 'message' },
      { providerEventId: 'provider-event-1', providerInstanceId: 'fake', eventType: 'message' },
    ])
    assert.deepEqual(completed, [
      { eventId: 'event-fake-provider-event-1-message', status: 'processed' },
    ])
    assert.equal(runtime.metrics.incomingMessages, 2)
    assert.equal(runtime.metrics.promptedMessages, 1)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime does not make an already prompted provider event retryable when completion fails', async () => {
  const prompted: Array<{ text: string, commandId?: string | null }> = []
  const completed: Array<{ eventId: string, status: string }> = []
  const seen = new Set<string>()
  const cloud: CloudGateway = {
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
          session: { sessionId: 'session-1' },
          projection: null,
        },
      } as never
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt(input) {
      prompted.push({ text: input.text, commandId: input.commandId })
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: input.commandId || 'cmd-1' } as never, processed: 1 }
    },
    async claimProviderEvent(input) {
      const key = `${input.providerInstanceId}:${input.eventType}:${input.providerEventId}`
      if (seen.has(key)) {
        return {
          event: providerEventRecord({ ...input, status: 'processing' }),
          claimed: false,
          duplicate: true,
        }
      }
      seen.add(key)
      return {
        event: providerEventRecord(input),
        claimed: true,
        duplicate: false,
      }
    },
    async completeProviderEvent(eventId, input) {
      completed.push({ eventId, status: input.status })
      if (input.status === 'processed') throw new Error('provider event completion unavailable')
      return providerEventRecord({
        provider: 'fake',
        providerInstanceId: 'fake',
        providerEventId: eventId,
        eventType: 'message',
        claimedBy: input.claimedBy,
        status: input.status,
      })
    },
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
    artifactUrl() { return 'https://cloud.example.test/api/sessions/session-1/artifacts/artifact-1' },
  }
  const config = resolveGatewayConfig({
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })

  await runtime.start()
  try {
    await assert.rejects(
      () => runtime.providers.emitFake('fake', { id: 'provider-event-1', text: 'ship it', chatId: 'chat-1', userId: 'user-1' }),
      /provider event completion unavailable/,
    )
    await runtime.providers.emitFake('fake', { id: 'provider-event-1', text: 'ship it again', chatId: 'chat-1', userId: 'user-1' })

    assert.deepEqual(prompted, [{ text: 'ship it', commandId: 'event-fake-provider-event-1-message' }])
    assert.deepEqual(completed, [
      { eventId: 'event-fake-provider-event-1-message', status: 'processed' },
    ])
    assert.equal(runtime.metrics.promptedMessages, 1)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime marks claimed provider events failed when prompting fails', async () => {
  const completed: Array<{ status: string, retryable?: boolean, lastError?: string | null }> = []
  const cloud: CloudGateway = {
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
          session: { sessionId: 'session-1' },
          projection: null,
        },
      } as never
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt() {
      throw new Error('OpenCode prompt unavailable')
    },
    async claimProviderEvent(input) {
      return {
        event: providerEventRecord(input),
        claimed: true,
        duplicate: false,
      }
    },
    async completeProviderEvent(_eventId, input) {
      completed.push({
        status: input.status,
        retryable: input.retryable,
        lastError: input.lastError,
      })
      return providerEventRecord({
        provider: 'cli',
        providerInstanceId: 'fake',
        providerEventId: 'provider-event-1',
        eventType: 'message',
        claimedBy: input.claimedBy,
        status: input.status,
      })
    },
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
    artifactUrl() { return 'https://cloud.example.test/api/sessions/session-1/artifacts/artifact-1' },
  }
  const config = resolveGatewayConfig({
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })

  await runtime.start()
  try {
    await assert.rejects(
      () => runtime.providers.emitFake('fake', { id: 'provider-event-1', text: 'ship it', chatId: 'chat-1', userId: 'user-1' }),
      /OpenCode prompt unavailable/,
    )
    assert.deepEqual(completed, [{
      status: 'failed',
      retryable: false,
      lastError: 'OpenCode prompt unavailable',
    }])
    assert.equal(runtime.metrics.promptedMessages, 0)
    assert.equal(runtime.metrics.errors, 1)
  } finally {
    await runtime.stop()
  }
})

test('gateway webhook replay stays durable across runtime restarts through Cloud provider event claims', async () => {
  const prompted: string[] = []
  const claims: Array<{ providerEventId: string, providerInstanceId: string, eventType: string }> = []
  const seen = new Set<string>()
  const cloud: CloudGateway = {
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
          session: { sessionId: 'session-1' },
          projection: null,
        },
      } as never
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt(input) {
      prompted.push(input.text)
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: 'cmd-1' } as never, processed: 1 }
    },
    async claimProviderEvent(input) {
      claims.push({
        providerEventId: input.providerEventId,
        providerInstanceId: input.providerInstanceId,
        eventType: input.eventType,
      })
      const key = `${input.providerInstanceId}:${input.eventType}:${input.providerEventId}`
      if (seen.has(key)) {
        return {
          event: providerEventRecord({ ...input, status: 'processed' }),
          claimed: false,
          duplicate: true,
        }
      }
      seen.add(key)
      return {
        event: providerEventRecord(input),
        claimed: true,
        duplicate: false,
      }
    },
    async completeProviderEvent(eventId, input) {
      return providerEventRecord({
        provider: 'webhook',
        providerInstanceId: 'webhook',
        providerEventId: eventId,
        eventType: 'message',
        claimedBy: input.claimedBy,
        status: input.status,
      })
    },
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
    artifactUrl() { return 'https://cloud.example.test/api/sessions/session-1/artifacts/artifact-1' },
  }
  const config = resolveGatewayConfig({
    providers: [{
      id: 'webhook',
      kind: 'webhook',
      channelBindingId: 'webhook-binding',
      credentials: {
        sharedSecret: 'webhook-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/outbound',
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const body = JSON.stringify({
    id: 'signed-provider-event-1',
    target: { chatId: 'chat-1' },
    sender: { userId: 'user-1' },
    text: 'ship it',
  })
  const headers = signedWebhookHeaders(body, 'webhook-secret')

  async function postThroughFreshRuntime() {
    const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
    await runtime.start()
    const http = createGatewayHttpServer(config, runtime)
    const url = await http.listen()
    try {
      const response = await fetch(`${url}/webhooks/webhook`, {
        method: 'POST',
        headers,
        body,
      })
      assert.equal(response.status, 202)
    } finally {
      await http.close()
      await runtime.stop()
    }
  }

  await postThroughFreshRuntime()
  await postThroughFreshRuntime()

  assert.deepEqual(prompted, ['ship it'])
  assert.deepEqual(claims, [
    { providerEventId: 'signed-provider-event-1', providerInstanceId: 'webhook', eventType: 'message' },
    { providerEventId: 'signed-provider-event-1', providerInstanceId: 'webhook', eventType: 'message' },
  ])
})

test('gateway diagnostics redact provider health errors', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token-1234567890',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS: 'true',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  runtime.providers.registrations[0].provider.health = () => ({
    ok: false,
    error: 'failed Bearer provider-token-1234567890 for alice@example.test at /Users/alice/acme?token=secret',
  })
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const diagnostics = await readJson(await fetch(`${url}/diagnostics`))
    const text = JSON.stringify(diagnostics)
    assert.equal(text.includes('provider-token-1234567890'), false)
    assert.equal(text.includes('alice@example.test'), false)
    assert.equal(text.includes('/Users/alice'), false)
    assert.match(text, /Bearer \[redacted\]/)
    assert.equal(((diagnostics.metrics as { providerMetrics: Record<string, { state: string }> }).providerMetrics.fake)?.state, 'unhealthy')
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway diagnostics are disabled by default in managed mode', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    mode: 'managed',
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const response = await fetch(`${url}/diagnostics`)
    assert.equal(response.status, 404)
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway loopback operator bypass rejects proxied-looking requests', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS: 'true',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const local = await fetch(`${url}/diagnostics`)
    assert.equal(local.status, 200)

    const proxied = await readJson(await fetch(`${url}/diagnostics`, {
      headers: {
        'x-forwarded-host': 'gateway.example.test',
        'x-forwarded-proto': 'https',
      },
    }))
    assert.equal(proxied.error, 'Gateway admin authorization is required.')
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway operator endpoints require the admin token when configured', async () => {
  const calls: string[] = []
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
    async listDeliveries() {
      calls.push('list')
      return []
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
    OPEN_COWORK_GATEWAY_METRICS_ENABLED: 'true',
    OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED: 'true',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    for (const path of ['/metrics', '/diagnostics', '/deliveries']) {
      const missing = await fetch(`${url}${path}`)
      assert.equal(missing.status, 401, `${path} rejects missing token`)

      const wrong = await fetch(`${url}${path}`, {
        headers: { authorization: 'Bearer wrong-token' },
      })
      assert.equal(wrong.status, 401, `${path} rejects wrong token`)
    }
    assert.deepEqual(calls, [])

    const metrics = await fetch(`${url}/metrics`, {
      headers: { authorization: 'Bearer admin-token' },
    })
    assert.equal(metrics.status, 200)
    const diagnostics = await fetch(`${url}/diagnostics`, {
      headers: { 'x-open-cowork-gateway-admin-token': 'admin-token' },
    })
    assert.equal(diagnostics.status, 200)
    const diagnosticsBody = await readJson(diagnostics)
    assert.deepEqual(diagnosticsBody.deliveryOperator, {
      scope: 'configured-channel-bindings',
      channelBindingIds: ['fake-binding'],
      listAllowed: true,
      retryAllowed: false,
      deadLetterAllowed: false,
      disabledReason: 'Cloud delivery retry is not available. Cloud delivery dead-letter is not available.',
    })
    const deliveries = await fetch(`${url}/deliveries`, {
      headers: { authorization: 'Bearer admin-token' },
    })
    assert.equal(deliveries.status, 200)
    assert.deepEqual(calls, ['list'])
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway provider registry wires fake, first-party, bridge, and CLI providers', () => {
  const registry = createGatewayProviderRegistry(resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }, {
      id: 'telegram',
      kind: 'telegram',
      channelBindingId: 'telegram-binding',
      credentials: {
        botToken: '123456:test-token',
        webhookSecret: 'telegram-secret',
      },
      settings: {
        mode: 'webhook',
        publicBaseUrl: 'https://gateway.example.test',
      },
    }, {
      id: 'slack',
      kind: 'slack',
      channelBindingId: 'slack-binding',
      credentials: {
        botToken: 'xoxb-slack-token',
        signingSecret: 'slack-signing-secret',
      },
    }, {
      id: 'email',
      kind: 'email',
      channelBindingId: 'email-binding',
      credentials: {
        inboundSecret: 'email-inbound-secret',
      },
      settings: {
        from: 'agent@example.test',
        smtpHost: 'smtp.example.test',
      },
    }, {
      id: 'webhook',
      kind: 'webhook',
      channelBindingId: 'webhook-binding',
      credentials: {
        sharedSecret: 'webhook-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/outbound',
      },
    }, {
      id: 'webhook-internal',
      kind: 'webhook',
      channelBindingId: 'webhook-internal-binding',
      credentials: {
        sharedSecret: 'webhook-internal-secret',
      },
      settings: {
        deliveryUrl: 'https://10.1.2.3/outbound',
        allowPrivateDelivery: true,
      },
    }, {
      id: 'discord',
      kind: 'discord',
      channelBindingId: 'discord-binding',
      credentials: {
        sharedSecret: 'discord-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/discord',
      },
    }, {
      id: 'whatsapp',
      kind: 'whatsapp',
      channelBindingId: 'whatsapp-binding',
      credentials: {
        sharedSecret: 'whatsapp-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/whatsapp',
      },
    }, {
      id: 'signal',
      kind: 'signal',
      channelBindingId: 'signal-binding',
      credentials: {
        sharedSecret: 'signal-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/signal',
      },
    }, {
      id: 'cli',
      kind: 'cli',
      channelBindingId: 'cli-binding',
      credentials: {
        sharedSecret: 'cli-secret',
      },
      settings: {
        deliveryUrl: 'http://127.0.0.1:8844/cli',
      },
    }],
  }))

  assert.deepEqual(registry.registrations.map((registration) => ({
    id: registration.config.id,
    kind: registration.config.kind,
    provider: registration.provider.id,
    providerKind: registration.provider.kind,
  })), [{
    id: 'fake',
    kind: 'fake',
    provider: 'cli',
    providerKind: 'cli',
  }, {
    id: 'telegram',
    kind: 'telegram',
    provider: 'telegram',
    providerKind: 'telegram',
  }, {
    id: 'slack',
    kind: 'slack',
    provider: 'slack',
    providerKind: 'slack',
  }, {
    id: 'email',
    kind: 'email',
    provider: 'email',
    providerKind: 'email',
  }, {
    id: 'webhook',
    kind: 'webhook',
    provider: 'webhook',
    providerKind: 'webhook',
  }, {
    id: 'webhook-internal',
    kind: 'webhook',
    provider: 'webhook-internal',
    providerKind: 'webhook',
  }, {
    id: 'discord',
    kind: 'discord',
    provider: 'discord',
    providerKind: 'discord',
  }, {
    id: 'whatsapp',
    kind: 'whatsapp',
    provider: 'whatsapp',
    providerKind: 'whatsapp',
  }, {
    id: 'signal',
    kind: 'signal',
    provider: 'signal',
    providerKind: 'signal',
  }, {
    id: 'cli',
    kind: 'cli',
    provider: 'cli',
    providerKind: 'cli',
  }])
  assert.equal(registry.registrations.find((entry) => entry.config.kind === 'whatsapp')?.provider.capabilities.inlineButtons, true)
  assert.equal(registry.registrations.find((entry) => entry.config.kind === 'signal')?.provider.capabilities.inlineButtons, false)
})

test('gateway provider registry keeps same-kind provider instances isolated', () => {
  const registry = createGatewayProviderRegistry(resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'webhook-ci',
      kind: 'webhook',
      channelBindingId: 'webhook-ci-binding',
      credentials: { sharedSecret: 'ci-secret' },
      settings: { deliveryUrl: 'https://bridge.example.test/ci' },
    }, {
      id: 'webhook-prod',
      kind: 'webhook',
      channelBindingId: 'webhook-prod-binding',
      credentials: { sharedSecret: 'prod-secret' },
      settings: { deliveryUrl: 'https://bridge.example.test/prod' },
    }],
  }))

  assert.deepEqual(registry.registrations.map((registration) => ({
    id: registration.config.id,
    kind: registration.provider.kind,
    provider: registration.provider.id,
  })), [{
    id: 'webhook-ci',
    kind: 'webhook',
    provider: 'webhook-ci',
  }, {
    id: 'webhook-prod',
    kind: 'webhook',
    provider: 'webhook-prod',
  }])
  assert.equal(registry.get('webhook-ci')?.provider.id, 'webhook-ci')
  assert.equal(registry.get('webhook-prod')?.provider.id, 'webhook-prod')
})

test('gateway daemon accepts signed Slack webhook verification payloads', async () => {
  const config = resolveGatewayConfig({
    providers: [{
      id: 'slack',
      kind: 'slack',
      channelBindingId: 'slack-binding',
      credentials: {
        botToken: 'xoxb-slack-token',
        signingSecret: 'slack-signing-secret',
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const payload = JSON.stringify({ type: 'url_verification', challenge: 'slack-challenge' })
    const body = `payload=${encodeURIComponent(payload)}`
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v0=${createHmac('sha256', 'slack-signing-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`
    const response = await readJson(await fetch(`${url}/webhooks/slack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    }))

    assert.equal(response.challenge, 'slack-challenge')
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway readiness hides provider inventory unless admin-authorized on public deployments', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      publicBaseUrl: 'https://gateway.example.test',
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER: 'true',
    OPEN_COWORK_GATEWAY_PORT: '0',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const publicReady = await readJson(await fetch(`${url}/ready`))
    assert.equal(publicReady.ok, true)
    assert.equal(Object.prototype.hasOwnProperty.call(publicReady, 'providers'), false)

    const adminReady = await readJson(await fetch(`${url}/ready`, {
      headers: { authorization: 'Bearer admin-token' },
    }))
    assert.equal(adminReady.ok, true)
    assert.equal(Array.isArray(adminReady.providers), true)
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway webhooks fail closed without leaking provider auth errors', async () => {
  const config = resolveGatewayConfig({
    providers: [{
      id: 'webhook',
      kind: 'webhook',
      channelBindingId: 'webhook-binding',
      credentials: {
        sharedSecret: 'webhook-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/outbound',
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const unsigned = await readJson(await fetch(`${url}/webhooks/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { chatId: 'chat-1' },
        sender: { userId: 'user-1' },
        text: 'hello',
      }),
    }))
    assert.equal(unsigned.error, 'Gateway webhook authorization failed.')

    const unsignedStatus = await fetch(`${url}/webhooks/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { chatId: 'chat-1' },
        sender: { userId: 'user-1' },
        text: 'hello',
      }),
    })
    assert.equal(unsignedStatus.status, 401)

    const malformed = await fetch(`${url}/webhooks/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken"',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await readJson(malformed)).error, 'Gateway webhook body must be valid JSON or form-encoded payload.')

    const unknown = await fetch(`${url}/webhooks/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(unknown.status, 404)
    assert.equal((await readJson(unknown)).error, 'Gateway webhook provider was not found.')
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway rejects oversized webhook bodies before provider dispatch', async () => {
  const prompted: string[] = []
  const cloud: CloudGateway = {
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
          session: { sessionId: 'session-1' },
          projection: null,
        },
      } as never
    },
    async findSessionByThread() { return null },
    async getSession() { return { session: { sessionId: 'session-1' }, projection: null } as never },
    async prompt(input) {
      prompted.push(input.text)
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: 'cmd-1' } as never, processed: 1 }
    },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return { ok: false, reason: 'not_found' } },
    async ackDelivery() { return null },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
      maxRequestBodyBytes: 1024,
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    const response = await fetch(`${url}/webhooks/fake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(2048), chatId: 'chat-1', userId: 'user-1' }),
    })
    assert.equal(response.status, 413)
    assert.equal((await readJson(response)).error, 'Gateway request body exceeds the configured limit.')
    assert.deepEqual(prompted, [])
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway webhooks apply a source rate limit before provider dispatch', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${url}/webhooks/missing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 404)
    }
    const blocked = await fetch(`${url}/webhooks/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '60')
    assert.equal((await readJson(blocked)).error, 'Too many Gateway webhook requests. Try again later.')
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway webhook source limits honor trusted proxy client addresses', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
    OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS: 'true',
    OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    const firstClientHeaders = {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10, 127.0.0.2',
    }
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${url}/webhooks/missing`, {
        method: 'POST',
        headers: firstClientHeaders,
        body: '{}',
      })
      assert.equal(response.status, 404)
    }
    const blocked = await fetch(`${url}/webhooks/missing`, {
      method: 'POST',
      headers: firstClientHeaders,
      body: '{}',
    })
    assert.equal(blocked.status, 429)

    const nextClient = await fetch(`${url}/webhooks/missing`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.11, 127.0.0.2',
      },
      body: '{}',
    })
    assert.equal(nextClient.status, 404)
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway webhook source limits ignore spoofed proxy headers from untrusted peers', async () => {
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
    OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS: 'true',
    OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${url}/webhooks/missing`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
        },
        body: '{}',
      })
      assert.equal(response.status, 404)
    }
    const blocked = await fetch(`${url}/webhooks/missing`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.11',
      },
      body: '{}',
    })
    assert.equal(blocked.status, 429)
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway daemon exposes admin delivery backlog controls', async () => {
  const calls: string[] = []
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
    async listDeliveries(input) {
      calls.push(`list:${input.deliveryId || ''}:${input.status || ''}:${input.channelBindingId}`)
      if (input.deliveryId && input.deliveryId !== `delivery-${input.channelBindingId}`) return []
      return [deliveryRecord({
        deliveryId: `delivery-${input.channelBindingId}`,
        channelBindingId: input.channelBindingId,
      })]
    },
    async retryDelivery(deliveryId: string) {
      calls.push(`retry:${deliveryId}`)
      return deliveryRecord({ deliveryId })
    },
    async deadLetterDelivery(deliveryId: string, input) {
      calls.push(`dead:${deliveryId}:${input?.lastError}`)
      return deliveryRecord({ deliveryId })
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }, {
      id: 'fake-secondary',
      kind: 'fake',
      channelBindingId: 'secondary-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()
  const auth = { authorization: 'Bearer admin-token' }

  try {
    const listed = await readJson(await fetch(`${url}/deliveries?status=failed`, { headers: auth }))
    assert.equal(Array.isArray(listed.deliveries), true)
    assert.deepEqual((listed.deliveries as Array<{ deliveryId: string }>).map((delivery) => delivery.deliveryId), [
      'delivery-fake-binding',
      'delivery-secondary-binding',
    ])
    const filtered = await readJson(await fetch(`${url}/deliveries?status=failed&channelBindingId=secondary-binding`, { headers: auth }))
    assert.deepEqual((filtered.deliveries as Array<{ deliveryId: string }>).map((delivery) => delivery.deliveryId), [
      'delivery-secondary-binding',
    ])
    const unrelated = await readJson(await fetch(`${url}/deliveries?status=failed&channelBindingId=unconfigured-binding`, { headers: auth }))
    assert.deepEqual(unrelated.deliveries, [])
    const blockedRetry = await fetch(`${url}/deliveries/delivery-unconfigured/retry`, { method: 'POST', headers: auth })
    assert.equal(blockedRetry.status, 404)
    const retried = await readJson(await fetch(`${url}/deliveries/delivery-fake-binding/retry`, { method: 'POST', headers: auth }))
    assert.equal((retried.delivery as { deliveryId: string }).deliveryId, 'delivery-fake-binding')
    const dead = await readJson(await fetch(`${url}/deliveries/delivery-fake-binding/dead-letter`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ lastError: 'operator stop' }),
    }))
    assert.equal((dead.delivery as { deliveryId: string }).deliveryId, 'delivery-fake-binding')
    assert.deepEqual(calls, [
      'list::failed:fake-binding',
      'list::failed:secondary-binding',
      'list::failed:secondary-binding',
      'list:delivery-unconfigured::fake-binding',
      'list:delivery-unconfigured::secondary-binding',
      'list:delivery-fake-binding::fake-binding',
      'list:delivery-fake-binding::secondary-binding',
      'retry:delivery-fake-binding',
      'list:delivery-fake-binding::fake-binding',
      'list:delivery-fake-binding::secondary-binding',
      'dead:delivery-fake-binding:operator stop',
    ])
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway daemon rejects delivery admin controls without the admin token', async () => {
  const calls: string[] = []
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
    async listDeliveries() {
      calls.push('list')
      return []
    },
    async retryDelivery(deliveryId: string) {
      calls.push(`retry:${deliveryId}`)
      return deliveryRecord({ deliveryId })
    },
    async deadLetterDelivery(deliveryId: string) {
      calls.push(`dead:${deliveryId}`)
      return deliveryRecord({ deliveryId })
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PORT: '0',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime, cloud)
  const url = await http.listen()

  try {
    const listed = await readJson(await fetch(`${url}/deliveries`))
    assert.equal(listed.error, 'Gateway admin authorization is required.')

    const retried = await readJson(await fetch(`${url}/deliveries/delivery-1/retry`, { method: 'POST' }))
    assert.equal(retried.error, 'Gateway admin authorization is required.')

    const dead = await readJson(await fetch(`${url}/deliveries/delivery-1/dead-letter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastError: 'operator stop' }),
    }))
    assert.equal(dead.error, 'Gateway admin authorization is required.')
    assert.deepEqual(calls, [])
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway runtime subscribes only to enabled configured channel bindings', async () => {
  let subscribed: { channelBindingIds?: readonly string[] } | null = null
  const cloud = {
    subscribeDeliveries(input: { channelBindingIds?: readonly string[] }) {
      subscribed = input
      return { close() {} }
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }, {
      id: 'fake-secondary',
      kind: 'fake',
      channelBindingId: 'secondary-binding',
    }, {
      id: 'fake-disabled',
      kind: 'fake',
      enabled: false,
      channelBindingId: 'disabled-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  })
  const runtime = createGatewayRuntime(config, cloud)

  await runtime.start()
  try {
    assert.deepEqual(subscribed?.channelBindingIds, ['fake-binding', 'secondary-binding'])
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime propagates stable Cloud delivery ids to provider sends', async () => {
  let onDelivery: ((delivery: unknown) => void) | null = null
  const acks: Array<{ deliveryId: string, input: Record<string, unknown> }> = []
  const cloud = {
    subscribeDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      onDelivery = input.onDelivery
      return { close() {} }
    },
    async ackDelivery(deliveryId: string, input: Record<string, unknown>) {
      acks.push({ deliveryId, input })
      return { deliveryId, ...input } as never
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  })
  const runtime = createGatewayRuntime(config, cloud)
  const provider = runtime.providers.get('fake')?.provider as {
    capabilities: { maxTextLength: number }
    sent: Array<{ text?: string, options?: { deliveryId?: string } }>
  } | undefined
  assert.ok(provider)

  await runtime.start()
  try {
    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-single', payload: { text: 'short' } }))
    await waitFor(() => acks.length === 1)
    assert.equal(provider.sent[0]?.options?.deliveryId, 'delivery-single')
    assert.equal(acks[0]?.input.status, 'sent')

    provider.capabilities.maxTextLength = 100
    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-chunked', payload: { text: 'x'.repeat(205) } }))
    await waitFor(() => acks.length === 2)
    assert.deepEqual(provider.sent.slice(1).map((entry) => entry.options?.deliveryId), [
      'delivery-chunked:chunk:1',
      'delivery-chunked:chunk:2',
      'delivery-chunked:chunk:3',
    ])
    assert.equal(provider.sent.slice(1).every((entry) => (entry.text?.length ?? 0) <= 100), true)
    assert.equal(acks[1]?.input.status, 'sent')
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime retries transient deliveries and marks permanent failures dead', async () => {
  let onDelivery: ((delivery: unknown) => void) | null = null
  const acks: Array<{ deliveryId: string, input: Record<string, unknown> }> = []
  const cloud = {
    subscribeDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      onDelivery = input.onDelivery
      return { close() {} }
    },
    async ackDelivery(deliveryId: string, input: Record<string, unknown>) {
      acks.push({ deliveryId, input })
      return { deliveryId, ...input } as never
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  })
  const runtime = createGatewayRuntime(config, cloud)
  const provider = runtime.providers.get('fake')?.provider
  assert.ok(provider)
  const originalSendText = provider.sendText.bind(provider)
  const failures = [
    new Error('provider temporarily down token=super-secret-token'),
    new Error('invalid target token=super-secret-token'),
  ]
  provider.sendText = async (...args) => {
    const failure = failures.shift()
    if (failure) throw failure
    return originalSendText(...args)
  }

  await runtime.start()
  try {
    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-1', attemptCount: 1 }))
    await waitFor(() => acks.length === 1)
    assert.equal(acks[0]?.input.status, 'failed')
    assert.equal(typeof acks[0]?.input.nextAttemptAt, 'string')
    assert.doesNotMatch(String(acks[0]?.input.lastError), /super-secret-token/)

    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-2', attemptCount: 1 }))
    await waitFor(() => acks.length === 2)
    assert.equal(acks[1]?.input.status, 'dead')
    assert.equal(acks[1]?.input.nextAttemptAt, null)
    assert.doesNotMatch(String(acks[1]?.input.lastError), /super-secret-token/)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime treats webhook circuit failures as retryable and URL policy failures as permanent', async () => {
  let onDelivery: ((delivery: unknown) => void) | null = null
  const acks: Array<{ deliveryId: string, input: Record<string, unknown> }> = []
  const cloud = {
    subscribeDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      onDelivery = input.onDelivery
      return { close() {} }
    },
    async ackDelivery(deliveryId: string, input: Record<string, unknown>) {
      acks.push({ deliveryId, input })
      return { deliveryId, ...input } as never
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  })
  const runtime = createGatewayRuntime(config, cloud)
  const provider = runtime.providers.get('fake')?.provider
  assert.ok(provider)
  const failures = [
    new WebhookCircuitOpenError(5000),
    new WebhookDeliveryPolicyError('Webhook delivery URL resolved to a private or reserved address'),
  ]
  provider.sendText = async () => {
    const failure = failures.shift()
    if (failure) throw failure
    throw new Error('test exhausted failures')
  }

  await runtime.start()
  try {
    const beforeCircuitMs = Date.now()
    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-circuit', attemptCount: 1 }))
    await waitFor(() => acks.length === 1)
    assert.equal(acks[0]?.input.status, 'failed')
    assert.equal(typeof acks[0]?.input.nextAttemptAt, 'string')
    const nextAttemptMs = Date.parse(String(acks[0]?.input.nextAttemptAt))
    assert.ok(nextAttemptMs - beforeCircuitMs >= 4900)
    assert.match(String(acks[0]?.input.lastError), /circuit is open/)

    onDelivery?.(deliveryRecord({ deliveryId: 'delivery-policy', attemptCount: 1 }))
    await waitFor(() => acks.length === 2)
    assert.equal(acks[1]?.input.status, 'dead')
    assert.equal(acks[1]?.input.nextAttemptAt, null)
    assert.match(String(acks[1]?.input.lastError), /private or reserved address/)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime drains in-flight deliveries before provider shutdown', async () => {
  let onDelivery: ((delivery: unknown) => void) | null = null
  const acks: Array<{ deliveryId: string, input: Record<string, unknown> }> = []
  const cloud = {
    subscribeDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      onDelivery = input.onDelivery
      return { close() {} }
    },
    async ackDelivery(deliveryId: string, input: Record<string, unknown>) {
      acks.push({ deliveryId, input })
      return { deliveryId, ...input } as never
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  })
  const runtime = createGatewayRuntime(config, cloud)
  const provider = runtime.providers.get('fake')?.provider
  assert.ok(provider)
  const originalSendText = provider.sendText.bind(provider)
  let releaseSend: (() => void) | null = null
  provider.sendText = async (...args) => {
    await new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    return originalSendText(...args)
  }

  await runtime.start()
  onDelivery?.(deliveryRecord({ deliveryId: 'delivery-drain', attemptCount: 1 }))
  await waitFor(() => runtime.metrics.deliveriesReceived === 1)
  let stopped = false
  const stopPromise = runtime.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stopped, false)
  assert.equal(acks.length, 0)

  releaseSend?.()
  await stopPromise
  assert.equal(stopped, true)
  assert.equal(acks[0]?.deliveryId, 'delivery-drain')
  assert.equal(acks[0]?.input.status, 'sent')
})

function deliveryRecord(overrides: Partial<{
  deliveryId: string
  attemptCount: number
  channelBindingId: string
  payload: Record<string, unknown>
}> = {}) {
  return {
    deliveryId: overrides.deliveryId || 'delivery-1',
    orgId: 'tenant-1',
    agentId: 'agent-1',
    channelBindingId: overrides.channelBindingId || 'fake-binding',
    sessionBindingId: null,
    provider: 'cli',
    target: {
      externalChatId: 'chat-1',
      externalThreadId: 'thread-1',
    },
    eventType: 'workflow.completed',
    payload: overrides.payload ?? { text: 'delivery text' },
    status: 'claimed',
    attemptCount: overrides.attemptCount ?? 1,
    claimedBy: 'gateway:test',
    lastClaimedBy: 'gateway:test',
    claimExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    nextAttemptAt: new Date(0).toISOString(),
    lastError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function readJson(response: Response) {
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  return JSON.parse(await response.text()) as Record<string, unknown>
}

test('gateway runtime is not ready when the cloud delivery subscription fails', async () => {
  const handlers: { onError?: () => void } = {}
  const cloud = {
    subscribeDeliveries(input: { onError?: () => void }) {
      handlers.onError = input.onError
      return { close() {} }
    },
  } as unknown as CloudGateway
  const config = resolveGatewayConfig({
    server: { adminToken: 'admin-token' },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
      credentials: { apiKey: 'provider-api-key-1234567890' },
      settings: {
        callbackSecret: 'provider-callback-secret-1234567890',
        deliveryUrl: 'https://example.test/deliver?token=provider-token-1234567890',
        workspacePath: '/home/alice/acme-private',
      },
    }],
  }, { OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token', OPEN_COWORK_GATEWAY_PORT: '0' })

  const runtime = createGatewayRuntime(config, cloud)
  await runtime.start()
  try {
    assert.equal(runtime.ready(), true)
    // A broken cloud delivery pipe makes the gateway not-ready even with healthy providers.
    handlers.onError?.()
    assert.equal(runtime.ready(), false)
    // Restarting re-establishes a clean subscription and readiness.
    await runtime.stop()
    await runtime.start()
    assert.equal(runtime.ready(), true)
  } finally {
    await runtime.stop()
  }
})
