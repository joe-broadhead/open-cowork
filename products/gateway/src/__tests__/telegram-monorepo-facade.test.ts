import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { createChannelClaimCode } from '../channel-claims.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'
import { processDurableTelegramInbound } from '../channels/telegram-inbound-policy.js'
import {
  getTelegramChannel,
  peekTelegramProtocolStack,
  resetTelegramChannelForTest,
  resolveTelegramProtocolStack,
} from '../channels/telegram-protocol-stack.js'
import { __telegramMonorepoTest } from '../channels/telegram-monorepo-adapter.js'
import { telegramChannel } from '../channels/telegram.js'
import type { ChannelMessage } from '../channels/provider.js'
import type { IncomingChannelMessage } from '@open-cowork/gateway-channel'

describe('JOE-994 Phase 2 telegram monorepo façade', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-telegram-facade-'))

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    delete process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK']
    delete process.env['TELEGRAM_PROTOCOL_STACK']
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearConfigCacheForTest()
    clearEventsForTest()
    resetTelegramChannelForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK']
    delete process.env['TELEGRAM_PROTOCOL_STACK']
    clearConfigCacheForTest()
    clearEventsForTest()
    resetTelegramChannelForTest()
  })

  it('defaults protocol stack to durable for rollback safety', () => {
    expect(resolveTelegramProtocolStack({}, undefined)).toBe('durable')
    expect(peekTelegramProtocolStack()).toBe('durable')
    expect(getTelegramChannel()).toBe(telegramChannel)
  })

  it('selects monorepo stack from env override', () => {
    process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] = 'monorepo'
    resetTelegramChannelForTest()
    expect(resolveTelegramProtocolStack(process.env)).toBe('monorepo')
    const adapter = getTelegramChannel()
    expect(adapter).not.toBe(telegramChannel)
    expect(adapter.name).toBe('telegram')
    expect(adapter.capabilities.provider).toBe('telegram')
  })

  it('selects monorepo stack from config when env unset', () => {
    updateConfig({ channels: { telegram: { protocolStack: 'monorepo' } } } as any)
    resetTelegramChannelForTest()
    expect(peekTelegramProtocolStack()).toBe('monorepo')
    expect(getTelegramChannel()).not.toBe(telegramChannel)
  })

  it('env durable forces legacy even when config says monorepo', () => {
    updateConfig({ channels: { telegram: { protocolStack: 'monorepo' } } } as any)
    process.env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] = 'durable'
    resetTelegramChannelForTest()
    expect(peekTelegramProtocolStack()).toBe('durable')
    expect(getTelegramChannel()).toBe(telegramChannel)
  })

  it('maps monorepo IncomingChannelMessage onto Durable ChannelMessage', () => {
    const incoming: IncomingChannelMessage = {
      id: 'in-1',
      providerEventId: 'upd-9',
      providerMessageId: '42',
      provider: 'telegram',
      target: { provider: 'telegram', chatId: 'chat-7', threadId: 'topic-1', userId: null, messageId: null },
      sender: { providerUserId: 'user-3', username: 'alice' },
      text: '/status',
      rawText: '/status',
      isCommand: true,
      command: 'status',
      commandArgs: '',
      attachments: [{ filename: 'note.txt', mimeType: 'text/plain', providerFileId: 'file-1' }],
      receivedAt: new Date('2026-07-24T00:00:00.000Z'),
      raw: {},
    }
    const mapped = __telegramMonorepoTest.mapIncomingToDurableMessage(incoming)
    expect(mapped).toEqual({
      provider: 'telegram',
      chatId: 'chat-7',
      threadId: 'topic-1',
      messageId: '42',
      userId: 'user-3',
      text: '/status',
      attachments: [{ name: 'note.txt', url: '', mimeType: 'text/plain' }],
      timestamp: '2026-07-24T00:00:00.000Z',
    })
  })

  it('shared inbound policy rejects untrusted free text and accepts claim codes', async () => {
    const handled: ChannelMessage[] = []
    const untrusted: ChannelMessage = {
      provider: 'telegram',
      chatId: 'untrusted-chat',
      userId: 'u1',
      text: 'hello free text',
      timestamp: new Date().toISOString(),
    }
    await processDurableTelegramInbound(untrusted, {
      deliver: async (msg) => { handled.push(msg) },
    })
    expect(handled).toEqual([])
    expect(getQueuedEvents().join('\n')).toMatch(/rejected untrusted inbound/i)

    clearEventsForTest()
    const claim = createChannelClaimCode({ provider: 'telegram', ttlMs: 60_000 })
    const claimMsg: ChannelMessage = {
      provider: 'telegram',
      chatId: 'claim-chat',
      userId: 'u2',
      text: claim.code,
      timestamp: new Date().toISOString(),
    }
    await processDurableTelegramInbound(claimMsg, {
      deliver: async (msg) => { handled.push(msg) },
    })
    expect(handled).toEqual([])
    expect(getQueuedEvents().join('\n')).toMatch(/claim accepted/i)
  })
})
