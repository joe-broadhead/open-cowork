import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

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
    async updateCursor() { return null },
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
  } finally {
    await http.close()
    await runtime.stop()
  }
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
    async updateCursor() { return null },
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

test('gateway daemon exposes admin delivery backlog controls', async () => {
  const calls: string[] = []
  const cloud = {
    subscribeDeliveries() { return { close() {} } },
    async listDeliveries(input) {
      calls.push(`list:${input.status}`)
      return [deliveryRecord({ deliveryId: 'delivery-1' })]
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
    const retried = await readJson(await fetch(`${url}/deliveries/delivery-1/retry`, { method: 'POST', headers: auth }))
    assert.equal((retried.delivery as { deliveryId: string }).deliveryId, 'delivery-1')
    const dead = await readJson(await fetch(`${url}/deliveries/delivery-1/dead-letter`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ lastError: 'operator stop' }),
    }))
    assert.equal((dead.delivery as { deliveryId: string }).deliveryId, 'delivery-1')
    assert.deepEqual(calls, ['list:failed', 'retry:delivery-1', 'dead:delivery-1:operator stop'])
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
}> = {}) {
  return {
    deliveryId: overrides.deliveryId || 'delivery-1',
    orgId: 'tenant-1',
    agentId: 'agent-1',
    channelBindingId: 'fake-binding',
    sessionBindingId: null,
    provider: 'cli',
    target: {
      externalChatId: 'chat-1',
      externalThreadId: 'thread-1',
    },
    eventType: 'workflow.completed',
    payload: { text: 'delivery text' },
    status: 'claimed',
    attemptCount: overrides.attemptCount ?? 1,
    claimedBy: 'gateway:test',
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
