import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'
import { processDurableChannelInbound } from '../channels/channel-inbound-policy.js'
import {
  getDiscordChannel,
  peekDiscordProtocolStack,
  resetDiscordChannelForTest,
  resolveDiscordProtocolStack,
} from '../channels/discord-protocol-stack.js'
import {
  getWhatsAppChannel,
  peekWhatsAppProtocolStack,
  resetWhatsAppChannelForTest,
  resolveWhatsAppProtocolStack,
} from '../channels/whatsapp-protocol-stack.js'
import { discordChannel } from '../channels/discord.js'
import { whatsappChannel } from '../channels/whatsapp.js'
import type { ChannelMessage } from '../channels/provider.js'
import { createChannelClaimCode } from '../channel-claims.js'

describe('JOE-994 Phase 3 discord/whatsapp façades + shared inbound policy', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-phase3-'))

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    delete process.env['OPEN_COWORK_DISCORD_PROTOCOL_STACK']
    delete process.env['OPEN_COWORK_WHATSAPP_PROTOCOL_STACK']
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearConfigCacheForTest()
    clearEventsForTest()
    resetDiscordChannelForTest()
    resetWhatsAppChannelForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPEN_COWORK_DISCORD_PROTOCOL_STACK']
    delete process.env['OPEN_COWORK_WHATSAPP_PROTOCOL_STACK']
    clearConfigCacheForTest()
    clearEventsForTest()
    resetDiscordChannelForTest()
    resetWhatsAppChannelForTest()
  })

  it('defaults Discord and WhatsApp stacks to durable', () => {
    expect(resolveDiscordProtocolStack({}, undefined)).toBe('durable')
    expect(resolveWhatsAppProtocolStack({}, undefined)).toBe('durable')
    expect(getDiscordChannel()).toBe(discordChannel)
    expect(getWhatsAppChannel()).toBe(whatsappChannel)
  })

  it('selects monorepo Discord stack from env', () => {
    process.env['OPEN_COWORK_DISCORD_PROTOCOL_STACK'] = 'monorepo'
    resetDiscordChannelForTest()
    expect(peekDiscordProtocolStack()).toBe('monorepo')
    const adapter = getDiscordChannel()
    expect(adapter).not.toBe(discordChannel)
    expect(adapter.name).toBe('discord')
  })

  it('selects monorepo WhatsApp stack from config', () => {
    updateConfig({ channels: { whatsapp: { protocolStack: 'monorepo' } } } as any)
    resetWhatsAppChannelForTest()
    expect(peekWhatsAppProtocolStack()).toBe('monorepo')
    expect(getWhatsAppChannel()).not.toBe(whatsappChannel)
  })

  it('shared inbound policy works for discord and whatsapp labels', async () => {
    const handled: ChannelMessage[] = []
    await processDurableChannelInbound('discord', {
      provider: 'discord',
      chatId: 'untrusted',
      userId: 'u1',
      text: 'hello',
      timestamp: new Date().toISOString(),
    }, {
      deliver: async (msg) => { handled.push(msg) },
    })
    expect(handled).toEqual([])
    expect(getQueuedEvents().join('\n')).toMatch(/Discord rejected untrusted inbound/i)

    clearEventsForTest()
    const claim = createChannelClaimCode({ provider: 'whatsapp', ttlMs: 60_000 })
    await processDurableChannelInbound('whatsapp', {
      provider: 'whatsapp',
      chatId: 'claim-chat',
      userId: 'u2',
      text: claim.code,
      timestamp: new Date().toISOString(),
    }, {
      deliver: async (msg) => { handled.push(msg) },
    })
    expect(handled).toEqual([])
    expect(getQueuedEvents().join('\n')).toMatch(/WhatsApp claim accepted/i)
  })
})
