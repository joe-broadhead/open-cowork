import test from 'node:test'
import assert from 'node:assert/strict'

import {
  redactGatewayConfig,
  redactGatewayEnv,
  resolveGatewayConfig,
} from '../dist/index.js'

test('gateway config requires providers unless the local fake provider is explicitly enabled', () => {
  assert.throws(() => resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test/',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'ocgw_secret_token',
    OPEN_COWORK_GATEWAY_PORT: '0',
  }), /At least one gateway provider/)

  const config = resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test/',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'ocgw_secret_token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
  })

  assert.equal(config.cloud.baseUrl, 'https://cloud.example.test')
  assert.equal(config.cloud.serviceToken, 'ocgw_secret_token')
  assert.equal(config.cloud.allowInsecureHttp, false)
  assert.equal(config.server.host, '127.0.0.1')
  assert.equal(config.server.port, 0)
  assert.equal(config.server.adminToken, null)
  assert.equal(config.mode, 'self-host')
  assert.deepEqual(config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    channelBindingId: provider.channelBindingId,
  })), [{
    id: 'fake',
    kind: 'fake',
    channelBindingId: 'fake-binding',
  }])
})

test('gateway config loads explicit provider credentials and redacts secrets', () => {
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://127.0.0.1:9000',
      serviceToken: 'service-token-1234567890',
    },
    mode: 'managed',
    logging: {
      level: 'debug',
    },
    providers: [{
      id: 'telegram-prod',
      kind: 'telegram',
      channelBindingId: 'telegram-binding',
      credentials: {
        botToken: 'telegram-token-1234567890',
        webhookSecret: 'telegram-secret-1234567890',
        apiKey: 'telegram-api-key-1234567890',
      },
      settings: {
        mode: 'webhook',
        publicBaseUrl: 'https://gateway.example.test',
        deliveryUrl: 'https://webhook.example.test/out?token=provider-token-1234567890',
        callbackSecret: 'provider-secret-1234567890',
        privateKey: 'provider-private-key-1234567890',
        workspacePath: '/Users/alice/acme-private',
      },
    }],
  })

  assert.equal(config.mode, 'managed')
  assert.equal(config.providers[0]?.credentials.botToken, 'telegram-token-1234567890')

  const redacted = redactGatewayConfig(config)
  assert.deepEqual((redacted.cloud as Record<string, unknown>).serviceToken, 'serv...[redacted]...7890')
  const providers = redacted.providers as Array<{ credentials: Record<string, unknown>, settings: Record<string, unknown> }>
  assert.equal(providers[0]?.credentials.botToken, 'tele...[redacted]...7890')
  assert.equal(providers[0]?.credentials.webhookSecret, 'tele...[redacted]...7890')
  assert.equal(providers[0]?.credentials.apiKey, 'tele...[redacted]...7890')
  assert.equal(providers[0]?.settings.callbackSecret, 'prov...[redacted]...7890')
  assert.equal(providers[0]?.settings.privateKey, 'prov...[redacted]...7890')
  assert.equal(providers[0]?.settings.deliveryUrl, 'https://webhook.example.test/out?token=%5Bredacted%5D')
  assert.equal(providers[0]?.settings.workspacePath, '/Users/[redacted]')
})

test('gateway env redaction catches token and secret names', () => {
  const redacted = redactGatewayEnv({
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'token-1234567890',
    OPEN_COWORK_GATEWAY_MODE: 'self-host',
    OPEN_COWORK_GATEWAY_PROVIDERS: '[{"credentials":{"botToken":"telegram-token-1234567890"}}]',
    CUSTOM_PASSWORD_VALUE: 'password-1234567890',
  })
  assert.equal(redacted.OPEN_COWORK_GATEWAY_SERVICE_TOKEN, 'toke...[redacted]...7890')
  assert.equal(redacted.OPEN_COWORK_GATEWAY_MODE, 'self-host')
  assert.equal(redacted.CUSTOM_PASSWORD_VALUE, 'pass...[redacted]...7890')
  assert.equal(redacted.OPEN_COWORK_GATEWAY_PROVIDERS?.includes('telegram-token'), false)
  assert.match(redacted.OPEN_COWORK_GATEWAY_PROVIDERS || '', /\[redacted\]/)
})

test('gateway diagnostics default to self-host only unless explicitly enabled', () => {
  const managed = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    mode: 'managed',
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  })
  assert.equal(managed.diagnostics.enabled, false)

  const explicitlyEnabled = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    mode: 'managed',
    diagnostics: {
      enabled: true,
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  })
  assert.equal(explicitlyEnabled.diagnostics.enabled, true)
})

test('gateway config rejects missing cloud auth and unsupported providers', () => {
  assert.throws(() => resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  }), /serviceToken|SERVICE_TOKEN/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    providers: [{
      kind: 'email' as never,
      channelBindingId: 'email-binding',
    }],
  }), /roadmap|not implemented|Unsupported/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://cloud.example.test',
      serviceToken: 'service-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }), /HTTPS|ALLOW_INSECURE_HTTP/)

  assert.equal(resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://cloud.example.test',
      serviceToken: 'service-token',
      allowInsecureHttp: true,
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).cloud.baseUrl, 'http://cloud.example.test')
})

test('gateway config rejects unsafe public admin, fake, and webhook ingress defaults', () => {
  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      host: '0.0.0.0',
    },
    metrics: {
      enabled: false,
    },
    diagnostics: {
      enabled: false,
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }), /fake provider cannot be exposed/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      host: '0.0.0.0',
    },
    metrics: {
      enabled: true,
    },
    providers: [{
      kind: 'telegram',
      channelBindingId: 'telegram',
      credentials: { botToken: 'telegram-token' },
    }],
  }), /ADMIN_TOKEN/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    providers: [{
      kind: 'webhook',
      channelBindingId: 'webhook',
      settings: { deliveryUrl: 'https://bridge.example.test/out' },
    }],
  }), /sharedSecret/)
})
