import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createChannelClaimCode } from '../channel-claims.js'
import { discordChannel, buildDiscordMessagePayload, getDiscordReadiness } from '../channels/discord.js'
import { buildChannelConnectorRegistry } from '../channel-connectors.js'
import { progressCard, runResultCard } from '../channels/renderer.js'
import type { ChannelMessage } from '../channels/provider.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, listWorkEvents } from '../work-store.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'
import {
  assertNativeActionIdentifiersMatchFallback,
  fallbackActionIdentifiers,
  richCardFixture,
} from './helpers/adapter-fixtures.js'

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-discord-test-'))

afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

describe('discord alpha adapter', () => {
  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearEventsForTest()
    vi.unstubAllGlobals()
  })

  afterEach(async () => {
    await discordChannel.stop()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
    delete process.env['DISCORD_BOT_TOKEN']
    delete process.env['DISCORD_PUBLIC_KEY']
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearConfigCacheForTest()
    clearEventsForTest()
  })

  it('is disabled unless the private alpha flag is explicit', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(discordChannel.isEnabled()).toBe(false)
    expect(getDiscordReadiness()).toMatchObject({
      configured: false,
      enabled: false,
      ready: false,
      summary: 'Discord alpha credentials are not configured; adapter disabled.',
    })
    await expect(discordChannel.sendMessage('channel-1', 'hello')).rejects.toThrow('alpha channel is disabled')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(discordChannel.capabilities.notes?.join(' ')).toContain('Disabled')
  })

  it('reports redacted startup and readiness failures without exposing Discord secrets', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-secret-token'
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'token=discord-secret-token rejected' }), { status: 401 })))

    await discordChannel.start()

    const combined = `${consoleSpy.mock.calls.flat().join('\n')}\n${getQueuedEvents().join('\n')}`
    expect(getDiscordReadiness()).toMatchObject({
      configured: true,
      enabled: true,
      botTokenConfigured: true,
      publicKeyConfigured: false,
      ready: false,
    })
    expect(combined).toContain('Discord startup failed')
    expect(combined).toContain('Discord public key is missing')
    expect(combined).toContain('<redacted')
    expect(combined).not.toContain('discord-secret-token')
  })

  it('sends plain messages only after alpha enablement and bot configuration', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-secret-token'
    const calls: Array<{ url: string; body: any; authorization: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')),
        authorization: String((init?.headers as Record<string, string>)?.['Authorization'] || ''),
      })
      return new Response('{}', { status: 200 })
    }))

    await discordChannel.sendMessage('channel-1', 'hello from gateway', { threadId: 'thread-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/thread-1/messages')
    expect(calls[0]!.body).toEqual({ content: 'hello from gateway' })
    expect(calls[0]!.authorization).toBe('Bot discord-secret-token')
  })

  it('renders embeds and components with the same action identifiers as fallback text', () => {
    const payload = buildDiscordMessagePayload(richCardFixture)
    const nativeIds = extractDiscordActionIdentifiers(payload.components)

    expect(payload.embeds?.[0].title).toBe('Adapter contract card')
    expect(JSON.stringify(payload.embeds)).toContain('JOE-83')
    expect(nativeIds).toEqual(fallbackActionIdentifiers(richCardFixture))
    assertNativeActionIdentifiersMatchFallback(nativeIds, richCardFixture)
  })

  it('falls back to markdown when Discord rejects a rich send', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-secret-token'
    const calls: Array<{ body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body || '{}')) })
      return new Response(calls.length === 1 ? 'embed rejected' : '{}', { status: calls.length === 1 ? 400 : 200 })
    }))

    await discordChannel.sendStructuredMessage?.('channel-1', richCardFixture)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.embeds?.[0].title).toBe('Adapter contract card')
    expect(calls[0]!.body.components).toBeDefined()
    expect(calls[1]!.body).toEqual(expect.objectContaining({ content: expect.stringContaining('## Adapter contract card') }))
    expect(calls[1]!.body.components).toBeUndefined()
    expect(getQueuedEvents().join('\n')).toContain('Discord rich send degraded')
  })

  it('handles signed component interactions through shared trust checks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:44:16.000Z'))
    const keys = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex')
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_PUBLIC_KEY'] = publicKey
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'channel-1' }] } } } as any)
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => { handled.push(message) })

    const body = JSON.stringify({
      type: 3,
      id: 'interaction-1',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1' } },
      data: { custom_id: '/gate approve gate_contract_1 once' },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')

    await expect(discordChannel.handleInteraction(body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    })).resolves.toMatchObject({ status: 200, body: { type: 4 } })
    await flushDiscordDispatch()

    expect(handled).toEqual([expect.objectContaining({
      provider: 'discord',
      chatId: 'channel-1',
      messageId: 'interaction-1',
      userId: 'user-1',
      text: '/gate approve gate_contract_1 once',
      timestamp: '2026-06-15T12:44:16.000Z',
    })])
  })

  it('rejects replayed Discord interactions outside the signed timestamp window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:44:16.000Z'))
    const keys = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex')
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_PUBLIC_KEY'] = publicKey
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'channel-1' }] } } } as any)
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => { handled.push(message) })

    const body = JSON.stringify({
      type: 3,
      id: 'interaction-old',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1' } },
      data: { custom_id: '/gate approve gate_contract_1 once' },
    })
    const timestamp = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000))
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')

    await expect(discordChannel.handleInteraction(body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    })).resolves.toMatchObject({ status: 401 })
    expect(handled).toEqual([])
  })

  it('acks signed interactions before the Gateway command handler completes', async () => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex')
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_PUBLIC_KEY'] = publicKey
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'channel-1' }] } } } as any)
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => {
      handled.push(message)
      return new Promise(() => {})
    })

    const body = JSON.stringify({
      type: 3,
      id: 'interaction-slow',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1' } },
      data: { custom_id: '/status' },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')
    const response = await Promise.race([
      discordChannel.handleInteraction(body, {
        'x-signature-ed25519': signature,
        'x-signature-timestamp': timestamp,
      }),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 25)),
    ])
    await flushDiscordDispatch()

    expect(response).toMatchObject({ status: 200, body: { type: 4 } })
    expect(handled).toEqual([expect.objectContaining({ messageId: 'interaction-slow', text: '/status' })])
  })

  it('preserves Discord thread targets so channel allowlists can scope project/session routing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:44:16.000Z'))
    const keys = generateKeyPairSync('ed25519')
    const publicKey = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex')
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_PUBLIC_KEY'] = publicKey
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'parent-channel', threadId: 'thread-1' }] } } } as any)
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => { handled.push(message) })

    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: { id: 'message-thread-1', channel_id: 'parent-channel', thread_id: 'thread-1', author: { id: 'user-1' }, content: '/project status', timestamp: '2026-06-16T10:00:00.000Z' },
    })).resolves.toBe(1)

    const body = JSON.stringify({
      type: 3,
      id: 'interaction-thread-1',
      channel_id: 'thread-1',
      channel: { id: 'thread-1', parent_id: 'parent-channel' },
      member: { user: { id: 'user-2' } },
      data: { custom_id: '/status task_discord_alpha' },
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')
    await expect(discordChannel.handleInteraction(body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    })).resolves.toMatchObject({ status: 200, body: { type: 4 } })

    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: { id: 'message-thread-2', channel_id: 'parent-channel', thread_id: 'other-thread', author: { id: 'user-1' }, content: '/project status', timestamp: '2026-06-16T10:00:01.000Z' },
    })).resolves.toBe(0)
    await flushDiscordDispatch()

    expect(handled).toEqual([
      expect.objectContaining({ provider: 'discord', chatId: 'parent-channel', threadId: 'thread-1', messageId: 'message-thread-1', text: '/project status' }),
      expect.objectContaining({ provider: 'discord', chatId: 'parent-channel', threadId: 'thread-1', messageId: 'interaction-thread-1', text: '/status task_discord_alpha' }),
    ])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Discord rejected untrusted inbound: discord:target:')
    expect(queued).not.toContain('parent-channel:other-thread')
  })

  it('accepts a Discord claim code for a normalized thread target without dispatching private content', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    updateConfig({ security: { channelAllowlists: { discord: [], telegram: [], whatsapp: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => { handled.push(message) })

    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: {
        id: 'claim-message-1',
        channel_id: 'thread-claim',
        channel: { id: 'thread-claim', parent_id: 'parent-claim' },
        author: { id: 'user-1' },
        content: claim.code,
        timestamp: '2026-06-16T10:00:00.000Z',
      },
    })).resolves.toBe(1)

    expect(handled).toEqual([])
    // The claiming sender is recorded as the trusted actor for the new target so
    // the same principal can send free text under the strict per-sender default.
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'parent-claim', threadId: 'thread-claim', userIds: ['user-1'] }])
    expect(getQueuedEvents().join('\n')).toContain('Discord claim accepted: discord:target:')
    expect(getQueuedEvents().join('\n')).not.toContain('parent-claim')
    expect(getQueuedEvents().join('\n')).not.toContain('thread-claim')
  })

  it('allows Discord setup commands before trust but keeps stateful commands blocked', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'trusted-channel' }], telegram: [], whatsapp: [] } } } as any)
    const handled: string[] = []
    discordChannel.onMessage(async message => { handled.push(message.text) })

    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: { id: 'message-help', channel_id: 'other-channel', author: { id: 'user-1' }, content: '/help', timestamp: '2026-06-16T10:00:00.000Z' },
    })).resolves.toBe(1)
    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: { id: 'message-status', channel_id: 'other-channel', author: { id: 'user-1' }, content: '/status', timestamp: '2026-06-16T10:00:01.000Z' },
    })).resolves.toBe(0)

    expect(handled).toEqual(['/help'])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Discord rejected untrusted inbound: discord:target:')
    expect(queued).not.toContain('other-channel')
    const serializedEvents = JSON.stringify(listWorkEvents(20))
    expect(serializedEvents).not.toContain('/help')
    expect(serializedEvents).not.toContain('/status')
  })

  it('renders fixture-backed delegated progress and final receipts to a trusted Discord thread', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-secret-token'
    process.env['DISCORD_PUBLIC_KEY'] = '11'.repeat(32)
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'parent-channel', threadId: 'thread-1' }] } } } as any)
    const calls: Array<{ url: string; body: any; authorization: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')),
        authorization: String((init?.headers as Record<string, string>)?.['Authorization'] || ''),
      })
      return new Response('{}', { status: 200 })
    }))

    await discordChannel.sendStructuredMessage?.('parent-channel', progressCard({
      title: 'Delegated Work Progress',
      status: 'running',
      summary: 'JOE-123 Discord alpha fixture proof is running.',
      currentStep: 'verify',
      percent: 50,
      facts: [
        { label: 'Task', value: 'task_discord_alpha' },
        { label: 'Run', value: 'run_discord_alpha' },
        { label: 'Delegation', value: 'delegation_discord_alpha' },
      ],
      nextAction: 'No operator action required.',
    }), { threadId: 'thread-1' })

    await discordChannel.sendStructuredMessage?.('parent-channel', runResultCard({
      title: 'Delegated Work Completed',
      status: 'completed',
      runId: 'run_discord_alpha',
      stage: 'verify',
      summary: 'Fixture-backed Discord alpha proof completed without sensitive transcript content.',
      metrics: [
        { label: 'Task', value: 'task_discord_alpha' },
        { label: 'Delegation', value: 'delegation_discord_alpha' },
        { label: 'Outcome', value: 'done' },
      ],
      nextAction: 'Review outcome in the parent OpenCode session.',
    }), { threadId: 'thread-1' })

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.url)).toEqual([
      'https://discord.com/api/v10/channels/thread-1/messages',
      'https://discord.com/api/v10/channels/thread-1/messages',
    ])
    expect(calls.every(call => call.authorization === 'Bot discord-secret-token')).toBe(true)
    expect(calls[0]!.body.embeds?.[0]).toMatchObject({ title: 'Delegated Work Progress', color: 0x5865f2 })
    expect(JSON.stringify(calls[0]!.body.embeds)).toContain('task_discord_alpha')
    expect(JSON.stringify(calls[0]!.body.embeds)).toContain('50%')
    expect(calls[1]!.body.embeds?.[0]).toMatchObject({ title: 'Delegated Work Completed', color: 0x5865f2 })
    expect(JSON.stringify(calls[1]!.body.embeds)).toContain('run_discord_alpha')
    expect(JSON.stringify(calls[1]!.body.embeds)).toContain('Outcome')
  })

  it('rejects unsigned interactions and untrusted gateway message events', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_PUBLIC_KEY'] = '00'.repeat(32)
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'trusted-channel' }] } } } as any)
    const handled: ChannelMessage[] = []
    discordChannel.onMessage(async message => { handled.push(message) })

    await expect(discordChannel.handleInteraction('{"type":1}', {})).resolves.toMatchObject({ status: 401 })
    await expect(discordChannel.handleGatewayEvent({
      t: 'MESSAGE_CREATE',
      d: { id: 'message-1', channel_id: 'other-channel', author: { id: 'user-1' }, content: '/status', timestamp: '2026-06-15T12:00:00.000Z' },
    })).resolves.toBe(0)

    expect(handled).toHaveLength(0)
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Discord rejected untrusted inbound: discord:target:')
    expect(queued).not.toContain('other-channel')
    const audit = listWorkEvents(20).find(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')
    expect(audit).toMatchObject({
      subjectId: expect.stringContaining('discord:target:'),
      payload: {
        actor: 'discord',
        source: expect.stringContaining('discord:target:'),
        operation: 'channel.inbound',
        target: expect.stringContaining('discord:target:'),
        result: 'denied',
        details: expect.objectContaining({
          provider: 'discord',
          reason: 'untrusted_target',
          evidence: 'provider-native',
          redacted: true,
        }),
      },
    })
    const serializedEvents = JSON.stringify(listWorkEvents(20))
    expect(serializedEvents).not.toContain('other-channel')
    expect(serializedEvents).not.toContain('/status')
  })

  it('maps Discord verifier readiness to the documented signed interaction route only', () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'true'
    process.env['DISCORD_BOT_TOKEN'] = 'discord-secret-token'
    process.env['DISCORD_PUBLIC_KEY'] = '11'.repeat(32)
    updateConfig({
      security: {
        publicWebhookMode: true,
        channelAllowlists: { discord: [{ chatId: 'trusted-channel' }] },
      },
      channels: { discord: { enabled: true } },
    } as any)

    const discord = buildChannelConnectorRegistry({}).connectors.find(c => c.provider === 'discord')!

    expect(discord.callback).toMatchObject({
      required: true,
      routeExposure: 'public_webhook_mode',
      challenge: 'not_applicable',
      signature: 'ready',
    })
    expect(discord.callback.routeChecks).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/webhooks/discord',
        documentedPublicRoute: true,
        publicWebhookExempt: true,
        requiredCapability: 'webhook',
      }),
    ])
    expect(discord.callback.routeChecks.map(route => `${route.method} ${route.path}`)).toEqual(['POST /webhooks/discord'])
    expect(discord.callback.verifier.publicWebhookRoutesOnly).toBe(true)
    expect(JSON.stringify(discord)).not.toContain('discord-secret-token')
  })
})

function extractDiscordActionIdentifiers(components: any[] | undefined): string[] {
  return (components || [])
    .flatMap(row => row.components || [])
    .map(button => button.custom_id || button.url || '')
    .filter(Boolean)
}

async function flushDiscordDispatch(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
