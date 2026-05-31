import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ChannelCapabilities } from '@open-cowork/gateway-channel'

import {
  createGatewayProviderRegistry,
  GATEWAY_PROVIDER_READINESS_MATRIX,
  resolveGatewayConfig,
} from '../dist/index.js'

const capabilityKeys: Array<keyof ChannelCapabilities> = [
  'threads',
  'messageEditing',
  'inlineButtons',
  'fileUploads',
  'fileDownloads',
  'typingIndicator',
  'maxTextLength',
  'preferredParseMode',
  'maxButtonsPerMessage',
  'maxButtonRowsPerMessage',
  'maxButtonTokenBytes',
  'maxFileBytes',
  'supportsEphemeralResponses',
]

test('gateway provider readiness matrix covers every provider tier', () => {
  const entries = [...GATEWAY_PROVIDER_READINESS_MATRIX]
  assert.deepEqual(entries.map((entry) => entry.kind).sort(), [
    'cli',
    'discord',
    'email',
    'fake',
    'signal',
    'slack',
    'telegram',
    'webhook',
    'whatsapp',
  ])
  assert.deepEqual(entries.filter((entry) => entry.tier === 1).map((entry) => entry.kind).sort(), ['email', 'slack', 'telegram'])
  assert.deepEqual(entries.filter((entry) => entry.tier === 2).map((entry) => entry.kind).sort(), ['cli', 'webhook'])
  assert.deepEqual(entries.filter((entry) => entry.tier === 3).map((entry) => entry.kind).sort(), ['discord', 'signal', 'whatsapp'])
  assert.deepEqual(entries.filter((entry) => entry.tier === 'demo').map((entry) => entry.kind), ['fake'])

  for (const entry of entries) {
    assert.ok(entry.displayName, `${entry.kind} has display name`)
    assert.ok(entry.intendedUse, `${entry.kind} has intended use`)
    assert.ok(entry.authRequirements.length > 0, `${entry.kind} has auth requirements`)
    assert.ok(entry.ingressModes.length > 0, `${entry.kind} has ingress modes`)
    assert.ok(entry.rateLimitBehavior, `${entry.kind} has rate-limit behavior`)
    assert.ok(entry.liveSmoke, `${entry.kind} has live smoke instructions`)
    assert.ok(entry.localContractTests.length > 0, `${entry.kind} has local contract tests`)
    for (const testPath of entry.localContractTests.filter((candidatePath) => candidatePath.endsWith('.ts'))) {
      assert.ok(existsSync(fileURLToPath(new URL(`../../../${testPath}`, import.meta.url))), `${entry.kind} test path exists: ${testPath}`)
    }
  }
})

test('gateway provider readiness matrix matches actual provider capabilities and docs', () => {
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
      credentials: { botToken: 'telegram-token' },
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
    }],
  }))
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/gateway-provider-readiness.md', import.meta.url)), 'utf8')
  assert.match(doc, /Provider Readiness Matrix/)

  for (const entry of GATEWAY_PROVIDER_READINESS_MATRIX) {
    const registration = registry.registrations.find((candidate) => candidate.config.kind === entry.kind)
    assert.ok(registration, `provider registry has ${entry.kind}`)
    assert.deepEqual(pickCapabilities(registration.provider.capabilities), entry.capabilities, `${entry.kind} capabilities match matrix`)
    assert.match(doc, new RegExp('`' + entry.kind + '`'), `docs include ${entry.kind}`)
    assert.match(doc, new RegExp(`Tier ${entry.tier}`), `docs include tier ${entry.tier}`)
    for (const path of entry.localContractTests) {
      assert.match(doc, new RegExp(escapeRegExp(path)), `docs include ${entry.kind} test ${path}`)
    }
  }
})

function pickCapabilities(capabilities: ChannelCapabilities) {
  const picked: Partial<ChannelCapabilities> = {}
  for (const key of capabilityKeys) {
    if (capabilities[key] !== undefined) {
      picked[key] = capabilities[key] as never
    }
  }
  return picked
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
