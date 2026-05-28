import test from 'node:test'
import assert from 'node:assert/strict'

import type { CloudGateway } from '../dist/index.js'
import {
  createGatewayHttpServer,
  createGatewayProviderRegistry,
  createGatewayRuntime,
  resolveGatewayConfig,
} from '../dist/index.js'

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
    async prompt(input) {
      prompted.push(input.text)
      return { binding: { bindingId: input.bindingId } as never, command: { commandId: 'cmd-1' } as never, processed: 1 }
    },
    async abortSession() { return { command: { commandId: 'cmd-abort' } as never, processed: 1, view: {} as never } },
    async respondToPermission() { return { command: { commandId: 'cmd-permission' } as never, processed: 1 } },
    async replyToQuestion() { return { command: { commandId: 'cmd-question' } as never, processed: 1 } },
    async rejectQuestion() { return { command: { commandId: 'cmd-reject' } as never, processed: 1 } },
    async createChannelInteraction() { return { interaction: { interactionId: 'interaction-1' } as never, plaintextToken: 'token-1' } },
    async resolveChannelInteraction() { return { interaction: {}, command: { commandId: 'cmd-interaction' } as never, processed: 1 } },
    subscribeSessionEvents() { return { close() {} } },
    subscribeDeliveries() { return { close() {} } },
    async updateCursor() { return null },
    async ackDelivery() { return null },
  }
  const config = resolveGatewayConfig({
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
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-1234567890',
    OPEN_COWORK_GATEWAY_PORT: '0',
  })
  const runtime = createGatewayRuntime(config, cloud, undefined, { subscribeDeliveries: false })
  await runtime.start()
  const http = createGatewayHttpServer(config, runtime)
  const url = await http.listen()

  try {
    const health = await readJson(await fetch(`${url}/health`))
    assert.equal(health.ok, true)

    const ready = await readJson(await fetch(`${url}/ready`))
    assert.equal(ready.ok, true)

    const metrics = await fetch(`${url}/metrics`)
    assert.equal(metrics.status, 200)
    assert.match(await metrics.text(), /open_cowork_gateway_providers 1/)

    const diagnostics = await readJson(await fetch(`${url}/diagnostics`))
    assert.equal((diagnostics.config as { cloud: { serviceToken: string } }).cloud.serviceToken, 'serv...[redacted]...7890')
    const diagnosticProvider = ((diagnostics.config as { providers: Array<{
      credentials: Record<string, string>
      settings: Record<string, string>
    }> }).providers)[0]
    assert.equal(diagnosticProvider?.credentials.apiKey, 'prov...[redacted]...7890')
    assert.equal(diagnosticProvider?.settings.callbackSecret, 'prov...[redacted]...7890')
    assert.equal(diagnosticProvider?.settings.deliveryUrl, 'https://example.test/deliver?token=%5Bredacted%5D')

    const webhook = await fetch(`${url}/webhooks/fake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ship it', chatId: 'chat-1', userId: 'user-1' }),
    })
    assert.equal(webhook.status, 202)
    assert.deepEqual(prompted, ['ship it'])
  } finally {
    await http.close()
    await runtime.stop()
  }
})

test('gateway provider registry wires fake, Telegram, and webhook providers', () => {
  const registry = createGatewayProviderRegistry(resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
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
  }))

  assert.deepEqual(registry.registrations.map((registration) => ({
    id: registration.config.id,
    kind: registration.config.kind,
    provider: registration.provider.id,
  })), [{
    id: 'fake',
    kind: 'fake',
    provider: 'cli',
  }, {
    id: 'telegram',
    kind: 'telegram',
    provider: 'telegram',
  }, {
    id: 'webhook',
    kind: 'webhook',
    provider: 'webhook',
  }])
})

async function readJson(response: Response) {
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  return JSON.parse(await response.text()) as Record<string, unknown>
}
