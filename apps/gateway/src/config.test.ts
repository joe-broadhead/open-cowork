import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadGatewayConfig,
  redactGatewayConfig,
  redactGatewayEnv,
  resolveGatewayConfig as resolveGatewayConfigBase,
} from '../dist/index.js'

const cloudEnv = {
  OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
}

const operatorEnv = {
  ...cloudEnv,
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

test('gateway config requires providers unless the local fake provider is explicitly enabled', () => {
  assert.throws(() => resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test/',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'ocgw_secret_token',
    OPEN_COWORK_GATEWAY_PORT: '0',
  }), /At least one gateway provider/)

  assert.throws(() => resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test/',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'ocgw_secret_token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
  }), /operator endpoints require/)

  const config = resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test/',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'ocgw_secret_token',
    OPEN_COWORK_GATEWAY_PORT: '0',
    OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
    OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS: 'true',
  })

  assert.equal(config.cloud.baseUrl, 'https://cloud.example.test')
  assert.equal(config.cloud.serviceToken, 'ocgw_secret_token')
  assert.equal(config.cloud.allowInsecureHttp, false)
  assert.equal(config.server.host, '127.0.0.1')
  assert.equal(config.server.port, 0)
  assert.equal(config.server.adminToken, null)
  assert.equal(config.server.allowLoopbackOperatorBypass, true)
  assert.equal(config.productMode, 'cloud_channel')
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

test('gateway config separates product mode from deployment mode', () => {
  const cloudChannel = resolveGatewayConfig({
    productMode: 'cloud_channel',
    mode: 'managed',
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  })

  assert.equal(cloudChannel.productMode, 'cloud_channel')
  assert.equal(cloudChannel.mode, 'managed')

  const envCloudChannel = resolveGatewayConfig({
    mode: 'self-host',
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PRODUCT_MODE: 'cloud_channel',
  })
  assert.equal(envCloudChannel.productMode, 'cloud_channel')

  assert.throws(() => resolveGatewayConfigBase({}, {
    OPEN_COWORK_GATEWAY_PRODUCT_MODE: 'standalone',
  }), /Standalone Team Gateway app/)
  assert.throws(() => resolveGatewayConfigBase({}, {
    OPEN_COWORK_GATEWAY_PRODUCT_MODE: 'hybrid',
  }), /reserved for a later/)
  assert.throws(() => resolveGatewayConfigBase({}, {
    OPEN_COWORK_GATEWAY_PRODUCT_MODE: 'cloud',
  }), /Unsupported gateway productMode/)
  assert.throws(() => resolveGatewayConfigBase({
    productMode: 'cloud' as never,
  }, cloudEnv), /Unsupported gateway productMode/)
})

test('gateway config loads explicit provider credentials and redacts secrets', () => {
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://127.0.0.1:9000',
      serviceToken: 'service-token-1234567890',
    },
    mode: 'managed',
    server: {
      adminToken: 'admin-token',
    },
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
  }, {
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-1234567890',
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
  assert.equal(providers[0]?.settings.deliveryUrl, 'https://webhook.example.test/out?token=[redacted]')
  assert.equal(providers[0]?.settings.workspacePath, '/Users/[redacted]')
})

test('gateway config resolves public branding from config and env JSON', () => {
  const config = resolveGatewayConfig({
    branding: {
      productName: 'Config Cowork',
      shortName: 'CC',
      supportUrl: 'https://support.config.example/cowork',
    },
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON: JSON.stringify({
      productName: 'Acme Cowork',
      managedOrgConnectionLabels: {
        gatewayToken: 'Acme Gateway token',
      },
    }),
    OPEN_COWORK_GATEWAY_BRAND_SHORT_NAME: 'AC',
  })

  assert.equal(config.branding.productName, 'Acme Cowork')
  assert.equal(config.branding.shortName, 'AC')
  assert.equal(config.branding.supportUrl, 'https://support.config.example/cowork')
  assert.equal(config.branding.managedOrgConnectionLabels?.desktopToken, 'Desktop token')
  assert.equal(config.branding.managedOrgConnectionLabels?.gatewayToken, 'Acme Gateway token')
})

test('gateway config ignores unsafe public branding URLs', () => {
  const config = resolveGatewayConfig({
    branding: {
      productName: 'Config Cowork',
      supportUrl: 'https://support.config.example/cowork',
    },
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON: JSON.stringify({
      logoUrl: 'http://assets.example.test/logo.png',
      supportUrl: 'javascript:alert(1)',
      privacyUrl: 'mailto:privacy@example.test',
    }),
  })

  assert.equal(config.branding.logoUrl, undefined)
  assert.equal(config.branding.supportUrl, 'https://support.config.example/cowork')
  assert.equal(config.branding.privacyUrl, '')
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
    server: {
      adminToken: 'admin-token',
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
    server: {
      adminToken: 'admin-token',
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
  assert.throws(() => resolveGatewayConfigBase({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  }), /serviceToken|SERVICE_TOKEN/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    providers: [{
      kind: 'teams' as never,
      channelBindingId: 'teams-binding',
    }],
  }), /Unsupported/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'http://cloud.example.test',
  }), /HTTPS|ALLOW_INSECURE_HTTP/)

  assert.equal(resolveGatewayConfig({
    cloud: {
      baseUrl: 'http://cloud.example.test',
      serviceToken: 'service-token',
      allowInsecureHttp: true,
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'http://cloud.example.test',
    OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP: 'true',
  }).cloud.baseUrl, 'http://cloud.example.test')
})

test('gateway config accepts signed bridge providers without cloud control-plane changes', () => {
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'whatsapp-prod',
      kind: 'whatsapp',
      channelBindingId: 'whatsapp-binding',
      credentials: {
        sharedSecret: 'whatsapp-secret',
      },
      settings: {
        deliveryUrl: 'https://bridge.example.test/whatsapp',
      },
    }, {
      id: 'cli-local',
      kind: 'cli',
      channelBindingId: 'cli-binding',
      credentials: {
        sharedSecret: 'cli-secret',
      },
      settings: {
        deliveryUrl: 'http://127.0.0.1:8844/cli',
      },
    }],
  })

  assert.deepEqual(config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    channelBindingId: provider.channelBindingId,
    deliveryUrl: provider.settings.deliveryUrl,
  })), [{
    id: 'whatsapp-prod',
    kind: 'whatsapp',
    channelBindingId: 'whatsapp-binding',
    deliveryUrl: 'https://bridge.example.test/whatsapp',
  }, {
    id: 'cli-local',
    kind: 'cli',
    channelBindingId: 'cli-binding',
    deliveryUrl: 'http://127.0.0.1:8844/cli',
  }])
})

test('gateway config fails closed for incomplete bridge providers', () => {
  const base = {
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
  }

  assert.throws(() => resolveGatewayConfig({
    ...base,
    providers: [{
      kind: 'discord',
      channelBindingId: 'discord-binding',
      settings: {
        deliveryUrl: 'https://bridge.example.test/discord',
      },
    }],
  }), /credential sharedSecret/)

  assert.throws(() => resolveGatewayConfig({
    ...base,
    providers: [{
      kind: 'signal',
      channelBindingId: 'signal-binding',
      credentials: {
        sharedSecret: 'signal-secret',
      },
    }],
  }), /setting deliveryUrl/)
})

test('gateway config rejects unsafe public admin, fake, and webhook ingress defaults', () => {
  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      host: '0.0.0.0',
      adminToken: 'admin-token',
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
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
  }), /fake provider cannot be exposed/)

  assert.doesNotThrow(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      host: '0.0.0.0',
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }, {
    OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER: 'true',
  }))

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
    server: {
      host: '127.0.0.1',
      publicBaseUrl: 'https://gateway.example.test',
    },
    providers: [{
      kind: 'telegram',
      channelBindingId: 'telegram',
      credentials: { botToken: 'telegram-token' },
    }],
  }), /operator endpoints require OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'replace-with-random-admin-token',
    },
    providers: [{
      kind: 'telegram',
      channelBindingId: 'telegram',
      credentials: { botToken: 'telegram-token' },
    }],
  }), /admin token is still a placeholder/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'webhook',
      channelBindingId: 'webhook',
      settings: { deliveryUrl: 'https://bridge.example.test/out' },
    }],
  }), /sharedSecret/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'whatsapp',
      channelBindingId: 'whatsapp',
      settings: { deliveryUrl: 'https://bridge.example.test/whatsapp' },
    }],
  }), /sharedSecret/)

  assert.throws(() => resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      publicBaseUrl: 'https://gateway.example.test',
      adminToken: 'admin-token',
    },
    providers: [{
      kind: 'cli',
      channelBindingId: 'cli',
    }],
  }), /CLI provider is local-only/)
})

test('gateway config inherits public URL for Telegram webhook mode', () => {
  const inherited = resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PUBLIC_URL: 'https://gateway.example.test',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_MODE: 'webhook',
    OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
  })
  assert.equal(inherited.providers[0]?.settings.publicBaseUrl, 'https://gateway.example.test')

  const providerSpecific = resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PUBLIC_URL: 'https://gateway.example.test',
    OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL: 'https://telegram-gateway.example.test',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_MODE: 'webhook',
    OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
  })
  assert.equal(providerSpecific.providers[0]?.settings.publicBaseUrl, 'https://telegram-gateway.example.test')
})

test('gateway config fails closed for unsafe Telegram webhook setup', () => {
  assert.throws(() => resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PUBLIC_URL: 'https://gateway.example.test',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_MODE: 'webhook',
  }), /webhookSecret/)

  assert.throws(() => resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_MODE: 'webhook',
    OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
  }), /publicBaseUrl|PUBLIC_URL/)

  assert.throws(() => resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_PUBLIC_URL: 'http://gateway.example.test',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_MODE: 'webhook',
    OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
  }), /HTTPS/)
})

test('gateway config loads Slack, email, Telegram, webhook, bridge, and CLI providers from env together', () => {
  const config = resolveGatewayConfig({}, {
    ...operatorEnv,
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN: 'slack-token',
    OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET: 'slack-signing-secret',
    OPEN_COWORK_GATEWAY_SLACK_TEAM_ID: 'T123',
    OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET: 'email-inbound-secret',
    OPEN_COWORK_GATEWAY_EMAIL_FROM: 'agent@example.test',
    OPEN_COWORK_GATEWAY_EMAIL_SMTP_HOST: 'smtp.example.test',
    OPEN_COWORK_GATEWAY_EMAIL_SMTP_PORT: '587',
    OPEN_COWORK_GATEWAY_EMAIL_SMTP_USERNAME: 'agent@example.test',
    OPEN_COWORK_GATEWAY_EMAIL_SMTP_PASSWORD: 'smtp-password',
    OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES: '2097152',
    OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL: 'https://bridge.example.test/out',
    OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET: 'webhook-secret',
    OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES: '2097152',
    OPEN_COWORK_GATEWAY_DISCORD_DELIVERY_URL: 'https://bridge.example.test/discord',
    OPEN_COWORK_GATEWAY_DISCORD_SHARED_SECRET: 'discord-secret',
    OPEN_COWORK_GATEWAY_WHATSAPP_DELIVERY_URL: 'https://bridge.example.test/whatsapp',
    OPEN_COWORK_GATEWAY_WHATSAPP_SHARED_SECRET: 'whatsapp-secret',
    OPEN_COWORK_GATEWAY_SIGNAL_DELIVERY_URL: 'https://bridge.example.test/signal',
    OPEN_COWORK_GATEWAY_SIGNAL_SHARED_SECRET: 'signal-secret',
    OPEN_COWORK_GATEWAY_CLI_ENABLED: 'true',
  })

  assert.deepEqual(config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    channelBindingId: provider.channelBindingId,
  })), [{
    id: 'telegram',
    kind: 'telegram',
    channelBindingId: 'telegram',
  }, {
    id: 'slack',
    kind: 'slack',
    channelBindingId: 'slack',
  }, {
    id: 'email',
    kind: 'email',
    channelBindingId: 'email',
  }, {
    id: 'webhook',
    kind: 'webhook',
    channelBindingId: 'webhook',
  }, {
    id: 'discord',
    kind: 'discord',
    channelBindingId: 'discord',
  }, {
    id: 'whatsapp',
    kind: 'whatsapp',
    channelBindingId: 'whatsapp',
  }, {
    id: 'signal',
    kind: 'signal',
    channelBindingId: 'signal',
  }, {
    id: 'cli',
    kind: 'cli',
    channelBindingId: 'cli',
  }])
  assert.equal(config.providers.find((provider) => provider.kind === 'slack')?.externalWorkspaceId, 'T123')
  assert.equal(config.providers.find((provider) => provider.kind === 'email')?.settings.smtpHost, 'smtp.example.test')
  assert.equal(config.providers.find((provider) => provider.kind === 'email')?.settings.maxAttachmentBytes, '2097152')
  assert.equal(config.providers.find((provider) => provider.kind === 'webhook')?.settings.maxAttachmentBytes, '2097152')
  assert.equal(config.providers.find((provider) => provider.kind === 'discord')?.credentials.sharedSecret, 'discord-secret')
})

test('gateway config supports multiple instance ids for one provider kind', () => {
  const config = resolveGatewayConfig({
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
  }, operatorEnv)

  assert.deepEqual(config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    channelBindingId: provider.channelBindingId,
  })), [{
    id: 'webhook-ci',
    kind: 'webhook',
    channelBindingId: 'webhook-ci-binding',
  }, {
    id: 'webhook-prod',
    kind: 'webhook',
    channelBindingId: 'webhook-prod-binding',
  }])

  assert.throws(() => resolveGatewayConfig({
    providers: [{
      id: 'webhook-ci',
      kind: 'webhook',
      channelBindingId: 'webhook-ci-a',
      credentials: { sharedSecret: 'ci-secret' },
      settings: { deliveryUrl: 'https://bridge.example.test/ci' },
    }, {
      id: 'webhook-ci',
      kind: 'webhook',
      channelBindingId: 'webhook-ci-b',
      credentials: { sharedSecret: 'ci-secret' },
      settings: { deliveryUrl: 'https://bridge.example.test/ci' },
    }],
  }, operatorEnv), /Duplicate gateway provider id webhook-ci/)
  assert.throws(() => resolveGatewayConfig({
    providers: [{
      id: 'bad id',
      kind: 'webhook',
      channelBindingId: 'webhook-ci',
      credentials: { sharedSecret: 'ci-secret' },
      settings: { deliveryUrl: 'https://bridge.example.test/ci' },
    }],
  }, operatorEnv), /safe legacy provider id/)
})

test('gateway config loads the shared open-cowork config gateway section with allowlisted env placeholders', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-config-'))
  try {
    const configPath = join(tempRoot, 'open-cowork.config.json')
    writeFileSync(configPath, JSON.stringify({
      allowedEnvPlaceholders: [
        'ACME_TELEGRAM_BOT_TOKEN',
        'ACME_TELEGRAM_WEBHOOK_SECRET',
      ],
      gateway: {
        branding: {
          productName: 'Acme Cowork',
          shortName: 'AC',
          supportUrl: 'https://support.acme.example/cowork',
        },
        cloud: {
          baseUrl: 'https://ignored-file-cloud.example',
          serviceToken: 'ignored-file-service-token',
        },
        server: {
          host: '127.0.0.1',
          port: 0,
        },
        providers: [{
          id: 'acme-telegram',
          kind: 'telegram',
          channelBindingId: 'acme-telegram',
          credentials: {
            botToken: '{env:ACME_TELEGRAM_BOT_TOKEN}',
            webhookSecret: '{env:ACME_TELEGRAM_WEBHOOK_SECRET}',
          },
          settings: {
            mode: 'webhook',
            publicBaseUrl: 'https://cowork-gateway.acme.example',
          },
        }],
      },
    }))

    const config = loadGatewayConfig({
      ...operatorEnv,
      OPEN_COWORK_CONFIG_PATH: configPath,
      OPEN_COWORK_CLOUD_BASE_URL: 'https://cowork.acme.example',
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-from-env',
      ACME_TELEGRAM_BOT_TOKEN: 'telegram-token-from-central-config',
      ACME_TELEGRAM_WEBHOOK_SECRET: 'telegram-secret-from-central-config',
    })

    assert.equal(config.branding.productName, 'Acme Cowork')
    assert.equal(config.cloud.baseUrl, 'https://cowork.acme.example')
    assert.equal(config.cloud.serviceToken, 'service-token-from-env')
    assert.equal(config.providers[0]?.id, 'acme-telegram')
    assert.equal(config.providers[0]?.credentials.botToken, 'telegram-token-from-central-config')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('gateway config overlays provider env credentials onto shared provider bindings', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-config-'))
  try {
    const configPath = join(tempRoot, 'open-cowork.config.json')
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        cloud: {
          baseUrl: 'https://cowork.acme.example',
          serviceToken: 'service-token-from-shared-config',
          allowInsecureHttp: true,
        },
        timeouts: {
          cloudRequestMs: 100,
          webhookDeliveryMs: 1234,
        },
        providers: [{
          id: 'acme-telegram',
          kind: 'telegram',
          channelBindingId: 'acme-telegram',
          settings: {
            mode: 'webhook',
            publicBaseUrl: 'https://cowork-gateway.acme.example',
          },
        }],
      },
    }))

    const config = loadGatewayConfig({
      ...operatorEnv,
      OPEN_COWORK_CONFIG_PATH: configPath,
      OPEN_COWORK_CLOUD_BASE_URL: 'https://cowork.acme.example',
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-from-env',
      OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS: '45000',
      OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN: 'telegram-token-from-env',
      OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET: 'telegram-secret-from-env',
    })

    assert.equal(config.providers.length, 1)
    assert.equal(config.providers[0]?.id, 'acme-telegram')
    assert.equal(config.providers[0]?.channelBindingId, 'acme-telegram')
    assert.equal(config.providers[0]?.credentials.botToken, 'telegram-token-from-env')
    assert.equal(config.providers[0]?.credentials.webhookSecret, 'telegram-secret-from-env')
    assert.equal(config.providers[0]?.settings.mode, 'webhook')
    assert.equal(config.providers[0]?.settings.publicBaseUrl, 'https://cowork-gateway.acme.example')
    assert.equal(config.cloud.allowInsecureHttp, false)
    assert.equal(config.timeouts.cloudRequestMs, 45_000)
    assert.equal(config.timeouts.webhookDeliveryMs, 1234)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('gateway config lets explicit config path override config directory gateway settings', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-config-'))
  try {
    const dirRoot = join(tempRoot, 'dir')
    const pathRoot = join(tempRoot, 'path')
    const dirConfig = join(dirRoot, 'open-cowork.config.json')
    const pathConfig = join(pathRoot, 'open-cowork.config.json')
    mkdirSync(dirRoot)
    mkdirSync(pathRoot)
    writeFileSync(dirConfig, JSON.stringify({
      gateway: {
        branding: { productName: 'Directory Cowork' },
        cloud: {
          baseUrl: 'https://directory.acme.example',
          serviceToken: 'directory-token',
        },
        providers: [{ kind: 'fake', channelBindingId: 'directory-fake' }],
      },
    }))
    writeFileSync(pathConfig, JSON.stringify({
      gateway: {
        branding: { productName: 'Explicit Cowork' },
        cloud: {
          baseUrl: 'https://explicit.acme.example',
          serviceToken: 'explicit-token',
        },
        providers: [{ kind: 'fake', channelBindingId: 'explicit-fake' }],
      },
    }))

    const config = loadGatewayConfig({
      ...operatorEnv,
      OPEN_COWORK_CONFIG_DIR: dirRoot,
      OPEN_COWORK_CONFIG_PATH: pathConfig,
      OPEN_COWORK_CLOUD_BASE_URL: 'https://env.acme.example',
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-from-env',
      OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
    })

    assert.equal(config.branding.productName, 'Explicit Cowork')
    assert.equal(config.cloud.baseUrl, 'https://env.acme.example')
    assert.equal(config.providers[0]?.channelBindingId, 'explicit-fake')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('gateway config discovers JSONC shared config files from config directories', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-config-'))
  try {
    const configPath = join(tempRoot, 'config.jsonc')
    writeFileSync(configPath, `{
      // downstream config can use comments and trailing commas
      "allowedEnvPlaceholders": [],
      "gateway": {
        "branding": {
          "productName": "JSONC Cowork",
        },
        "cloud": {
          "baseUrl": "https://cowork.acme.example",
          "serviceToken": "ignored-file-service-token",
        },
        "providers": [{
          "kind": "fake",
          "channelBindingId": "fake-binding",
        }],
      },
    }`)

    const config = loadGatewayConfig({
      ...operatorEnv,
      OPEN_COWORK_CONFIG_DIR: tempRoot,
      OPEN_COWORK_CLOUD_BASE_URL: 'https://cowork.acme.example',
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token-from-env',
      OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
    })

    assert.equal(config.branding.productName, 'JSONC Cowork')
    assert.equal(config.cloud.serviceToken, 'service-token-from-env')
    assert.equal(config.providers[0]?.kind, 'fake')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('gateway config rejects unallowlisted shared config env placeholders', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-config-'))
  try {
    const configPath = join(tempRoot, 'open-cowork.config.json')
    writeFileSync(configPath, JSON.stringify({
      allowedEnvPlaceholders: [],
      gateway: {
        cloud: {
          baseUrl: 'https://cowork.acme.example',
        },
        providers: [{
          kind: 'fake',
          channelBindingId: 'fake-binding',
          credentials: {
            botToken: '{env:ACME_TELEGRAM_BOT_TOKEN}',
          },
        }],
      },
    }))

    assert.throws(() => loadGatewayConfig({
      OPEN_COWORK_CONFIG_PATH: configPath,
      OPEN_COWORK_CLOUD_BASE_URL: 'https://cowork.acme.example',
      OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
      ACME_TELEGRAM_BOT_TOKEN: 'telegram-token',
    }), /ACME_TELEGRAM_BOT_TOKEN is not allowlisted/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
