import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  channelTelemetryBindingConfigured,
  channelTelemetryFailureOutcome,
  channelTelemetryStack,
} from '../channel-telemetry.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'

const TELEMETRY_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'OPEN_COWORK_TELEGRAM_PROTOCOL_STACK',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'OPEN_COWORK_WHATSAPP_PROTOCOL_STACK',
  'OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL',
  'OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET',
  'OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED',
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'OPEN_COWORK_DISCORD_PROTOCOL_STACK',
  'OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL',
  'OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET',
] as const

describe('channel stack telemetry binding state', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-channel-telemetry-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    for (const key of TELEMETRY_ENV_KEYS) delete process.env[key]
    clearConfigCacheForTest()
  })

  afterEach(() => {
    for (const key of TELEMETRY_ENV_KEYS) delete process.env[key]
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('distinguishes selected stack and complete binding configuration', () => {
    expect(channelTelemetryStack('telegram')).toBe('durable-native')
    expect(channelTelemetryBindingConfigured('telegram', 'durable-native')).toBe(false)
    expect(channelTelemetryBindingConfigured('whatsapp', 'durable-native')).toBe(false)
    expect(channelTelemetryBindingConfigured('discord', 'durable-native')).toBe(false)

    process.env['TELEGRAM_BOT_TOKEN'] = 'telegram-token'
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'access-token'
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = 'phone-number'
    process.env['WHATSAPP_VERIFY_TOKEN'] = 'verify-token'
    process.env['WHATSAPP_APP_SECRET'] = 'app-secret'
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-token'
    process.env['DISCORD_PUBLIC_KEY'] = 'discord-public-key'

    expect(channelTelemetryBindingConfigured('telegram', 'durable-native')).toBe(true)
    expect(channelTelemetryBindingConfigured('whatsapp', 'durable-native')).toBe(true)
    expect(channelTelemetryBindingConfigured('discord', 'durable-native')).toBe(true)
  })

  it('requires bridge credentials when monorepo bridge stacks are selected', () => {
    updateConfig({
      channels: {
        whatsapp: { protocolStack: 'monorepo' },
        discord: { enabled: true, protocolStack: 'monorepo' },
      },
    } as any)

    expect(channelTelemetryStack('whatsapp')).toBe('monorepo-provider')
    expect(channelTelemetryStack('discord')).toBe('monorepo-provider')
    expect(channelTelemetryBindingConfigured('whatsapp', 'monorepo-provider')).toBe(false)
    expect(channelTelemetryBindingConfigured('discord', 'monorepo-provider')).toBe(false)

    process.env['OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL'] = 'https://bridge.example.test/whatsapp'
    process.env['OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET'] = 'whatsapp-secret'
    process.env['OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL'] = 'https://bridge.example.test/discord'
    process.env['OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET'] = 'discord-secret'

    expect(channelTelemetryBindingConfigured('whatsapp', 'monorepo-provider')).toBe(true)
    expect(channelTelemetryBindingConfigured('discord', 'monorepo-provider')).toBe(true)
  })

  it('applies the common bounded classifier to durable inbound failures', () => {
    const cases = [
      { name: '429', error: Object.assign(new Error('limited'), { status: 429 }), outcome: 'retry' },
      { name: '5xx', error: Object.assign(new Error('unavailable'), { statusCode: 503 }), outcome: 'retry' },
      { name: 'network', error: Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }), outcome: 'retry' },
      { name: '4xx', error: Object.assign(new Error('bad request'), { status: 400 }), outcome: 'error' },
    ] as const

    for (const scenario of cases) {
      expect(channelTelemetryFailureOutcome(scenario.error), scenario.name).toBe(scenario.outcome)
    }
  })
})
