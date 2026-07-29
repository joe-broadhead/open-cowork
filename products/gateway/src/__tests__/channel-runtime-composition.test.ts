import { Readable } from 'node:stream'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerHarness = vi.hoisted(() => ({
  health: {
    telegram: false,
    discord: false,
    whatsapp: false,
  },
  sends: [] as Array<{ provider: string; chatId: string; text: string }>,
}))

vi.mock('@open-cowork/gateway-provider-telegram', () => ({
  TelegramProvider: class MockTelegramProvider {
    readonly capabilities = { maxTextLength: 4096 }

    async start() {}
    async stop() {}
    health() {
      return { ok: providerHarness.health.telegram }
    }
    async sendText(target: { chatId: string }, text: string) {
      providerHarness.sends.push({ provider: 'telegram', chatId: target.chatId, text })
      return { messageId: 'mock-telegram-message' }
    }
    async setTyping() {}
  },
}))

vi.mock('@open-cowork/gateway-provider-discord', () => ({
  DiscordProvider: class MockDiscordProvider {
    readonly capabilities = { maxTextLength: 2000 }

    async start() {}
    async stop() {}
    health() {
      return { ok: providerHarness.health.discord }
    }
    async sendText(target: { chatId: string }, text: string) {
      providerHarness.sends.push({ provider: 'discord', chatId: target.chatId, text })
      return { messageId: 'mock-discord-message' }
    }
  },
}))

vi.mock('@open-cowork/gateway-provider-whatsapp', () => ({
  WhatsAppProvider: class MockWhatsAppProvider {
    readonly capabilities = { maxTextLength: 4096 }

    async start() {}
    async stop() {}
    health() {
      return { ok: providerHarness.health.whatsapp }
    }
    async sendText(target: { chatId: string }, text: string) {
      providerHarness.sends.push({ provider: 'whatsapp', chatId: target.chatId, text })
      return { messageId: 'mock-whatsapp-message' }
    }
  },
}))

import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { dispatchRoute } from '../daemon-router.js'
import { systemRoutes } from '../daemon-routes/system.js'
import {
  composedChannelTelemetryStack,
  createDaemonChannelComposition,
} from '../channels/runtime-composition.js'
import { resetDiscordChannelForTest } from '../channels/discord-protocol-stack.js'
import { resetTelegramChannelForTest } from '../channels/telegram-protocol-stack.js'
import { resetWhatsAppChannelForTest } from '../channels/whatsapp-protocol-stack.js'
import {
  clearRuntimeMetricsForTest,
  renderPrometheusMetrics,
} from '../runtime-metrics.js'
import { clearCurrentDaemonLeadershipForTest } from '../daemon-leadership.js'

const CHANNEL_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'OPEN_COWORK_TELEGRAM_PROTOCOL_STACK',
  'OPEN_COWORK_WHATSAPP_PROTOCOL_STACK',
  'OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL',
  'OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET',
  'OPEN_COWORK_DISCORD_PROTOCOL_STACK',
  'OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL',
  'OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET',
  'OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED',
] as const

describe.sequential('Durable channel runtime composition telemetry', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-channel-runtime-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    for (const key of CHANNEL_ENV_KEYS) delete process.env[key]
    providerHarness.health.telegram = false
    providerHarness.health.discord = false
    providerHarness.health.whatsapp = false
    providerHarness.sends.length = 0
    clearConfigCacheForTest()
    clearRuntimeMetricsForTest()
    clearCurrentDaemonLeadershipForTest()
    resetProtocolSelections()
  })

  afterEach(() => {
    for (const key of CHANNEL_ENV_KEYS) delete process.env[key]
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    vi.unstubAllGlobals()
    clearConfigCacheForTest()
    clearRuntimeMetricsForTest()
    clearCurrentDaemonLeadershipForTest()
    resetProtocolSelections()
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('refreshes degraded, healthy, and stopped monorepo bindings on each metrics scrape', async () => {
    selectAllMonorepoStacks()
    const composition = createDaemonChannelComposition()
    await Promise.all([
      composition.telegramChannel.start(),
      composition.discordChannel.start(),
      composition.whatsappChannel.start(),
    ])

    const degraded = await scrapeMetrics(composition.channels)
    for (const provider of ['telegram', 'discord', 'whatsapp']) {
      expect(metricValue(degraded, 'open_cowork_channel_bindings', {
        provider_kind: provider,
        stack: 'monorepo-provider',
        status: 'configured',
      })).toBe(1)
      expect(metricValue(degraded, 'open_cowork_channel_bindings', {
        provider_kind: provider,
        stack: 'monorepo-provider',
        status: 'active',
      })).toBe(0)
    }

    providerHarness.health.telegram = true
    providerHarness.health.discord = true
    providerHarness.health.whatsapp = true
    const healthy = await scrapeMetrics(composition.channels)
    for (const provider of ['telegram', 'discord', 'whatsapp']) {
      expect(metricValue(healthy, 'open_cowork_channel_bindings', {
        provider_kind: provider,
        stack: 'monorepo-provider',
        status: 'active',
      })).toBe(1)
    }

    await Promise.all([
      composition.telegramChannel.stop(),
      composition.discordChannel.stop(),
      composition.whatsappChannel.stop(),
    ])
    const stopped = await scrapeMetrics(composition.channels)
    for (const provider of ['telegram', 'discord', 'whatsapp']) {
      expect(metricValue(stopped, 'open_cowork_channel_bindings', {
        provider_kind: provider,
        stack: 'monorepo-provider',
        status: 'active',
      })).toBe(0)
    }
  })

  it('emits private-safe attempt and terminal evidence through actual native and monorepo selections', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'private-telegram-token'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] = 'durable'
    resetTelegramChannelForTest()
    const native = createDaemonChannelComposition()
    await native.telegramChannel.sendMessage('private-native-chat', 'private native body')

    process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] = 'monorepo'
    resetTelegramChannelForTest()
    providerHarness.health.telegram = true
    const monorepo = createDaemonChannelComposition()
    await monorepo.telegramChannel.start()
    await monorepo.telegramChannel.sendMessage('private-monorepo-chat', 'private monorepo body')
    await monorepo.telegramChannel.stop()

    const metrics = renderPrometheusMetrics()
    for (const stack of ['durable-native', 'monorepo-provider']) {
      expect(metricValue(metrics, 'open_cowork_channel_messages_total', {
        direction: 'outbound',
        outcome: 'attempt',
        provider_kind: 'telegram',
        stack,
      })).toBe(1)
      expect(metricValue(metrics, 'open_cowork_channel_messages_total', {
        direction: 'outbound',
        outcome: 'success',
        provider_kind: 'telegram',
        stack,
      })).toBe(1)
      expect(metricValue(metrics, 'open_cowork_channel_operation_latency_ms_count', {
        direction: 'outbound',
        outcome: 'success',
        provider_kind: 'telegram',
        stack,
      })).toBe(1)
    }
    expect(providerHarness.sends).toEqual([{
      provider: 'telegram',
      chatId: 'private-monorepo-chat',
      text: 'private monorepo body',
    }])
    expect(metrics).not.toMatch(
      /private-native-chat|private-monorepo-chat|private native body|private monorepo body|private-telegram-token/,
    )
  })

  it('keeps telemetry bound to the composed adapter until restart', async () => {
    process.env['OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL'] = 'https://bridge.example.test/whatsapp'
    process.env['OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET'] = 'whatsapp-secret'
    updateConfig({
      channels: {
        whatsapp: { protocolStack: 'monorepo' },
      },
    } as any)
    const composition = createDaemonChannelComposition()

    expect(composedChannelTelemetryStack(
      'whatsapp',
      composition.whatsappChannel,
    )).toBe('monorepo-provider')

    updateConfig({
      channels: {
        whatsapp: { protocolStack: 'durable' },
      },
    } as any)

    const metrics = await scrapeMetrics(composition.channels)
    expect(composedChannelTelemetryStack(
      'whatsapp',
      composition.whatsappChannel,
    )).toBe('monorepo-provider')
    expect(metricValue(metrics, 'open_cowork_channel_bindings', {
      provider_kind: 'whatsapp',
      stack: 'monorepo-provider',
      status: 'configured',
    })).toBe(1)
    expect(metrics).not.toContain(
      'open_cowork_channel_bindings{provider_kind="whatsapp",stack="durable-native"',
    )
  })
})

function selectAllMonorepoStacks(): void {
  process.env['TELEGRAM_BOT_TOKEN'] = 'telegram-token'
  process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] = 'monorepo'
  process.env['OPEN_COWORK_WHATSAPP_PROTOCOL_STACK'] = 'monorepo'
  process.env['OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL'] = 'https://bridge.example.test/whatsapp'
  process.env['OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET'] = 'whatsapp-secret'
  process.env['OPEN_COWORK_DISCORD_PROTOCOL_STACK'] = 'monorepo'
  process.env['OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL'] = 'https://bridge.example.test/discord'
  process.env['OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET'] = 'discord-secret'
  process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
  resetProtocolSelections()
}

function resetProtocolSelections(): void {
  resetTelegramChannelForTest()
  resetDiscordChannelForTest()
  resetWhatsAppChannelForTest()
}

async function scrapeMetrics(channels: Map<string, any>): Promise<string> {
  const req = Readable.from([]) as any
  req.method = 'GET'
  req.headers = {}
  const response = await dispatchRoute(systemRoutes(), {
    req,
    url: new URL('/metrics', 'http://127.0.0.1:4097'),
    client: {},
    channels,
  })
  expect(response).toMatchObject({
    status: 200,
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  })
  return String(response?.body)
}

function metricValue(
  metrics: string,
  name: string,
  labels: Record<string, string>,
): number | undefined {
  const prefix = `${name}{`
  const line = metrics.split('\n').find((candidate) =>
    candidate.startsWith(prefix)
    && Object.entries(labels).every(([key, value]) =>
      candidate.includes(`${key}="${value}"`),
    ))
  if (!line) return undefined
  return Number(line.slice(line.lastIndexOf(' ') + 1))
}
