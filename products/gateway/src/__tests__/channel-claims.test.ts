import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { acceptChannelClaimFromMessage, createChannelClaimCode } from '../channel-claims.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, setWorkDbLeadershipEpochProvider } from '../work-store.js'
import { isTrustedChannelActor } from '../security.js'
import type { ChannelMessage } from '../channels/provider.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'

describe('channel claims', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-claims-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    setWorkDbLeadershipEpochProvider(undefined)
    clearCurrentDaemonLeadershipForTest()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('heals an already-trusted Discord DM rule by merging the claimant into userIds', () => {
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'dm-channel-1' }], telegram: [], whatsapp: [] } } } as any)
    // Discord channel ids never equal author ids, so the legacy rule strands the operator.
    expect(isTrustedChannelActor({ provider: 'discord', chatId: 'dm-channel-1', userId: 'author-9' }, getConfig()).allowed).toBe(false)
    const claim = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })

    const result = acceptChannelClaimFromMessage(message('discord', 'dm-channel-1', 'author-9', claim.code))

    expect(result.status).toBe('accepted')
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'dm-channel-1', userIds: ['author-9'] }])
    expect(isTrustedChannelActor({ provider: 'discord', chatId: 'dm-channel-1', userId: 'author-9' }, getConfig()).allowed).toBe(true)
  })

  it('merges claimant user ids idempotently without duplicates or losing existing actors', () => {
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'dm-channel-1', userIds: ['author-9'] }], telegram: [], whatsapp: [] } } } as any)

    const repeat = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })
    expect(acceptChannelClaimFromMessage(message('discord', 'dm-channel-1', 'author-9', repeat.code)).status).toBe('accepted')
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'dm-channel-1', userIds: ['author-9'] }])

    const second = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })
    expect(acceptChannelClaimFromMessage(message('discord', 'dm-channel-1', 'author-10', second.code)).status).toBe('accepted')
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'dm-channel-1', userIds: ['author-9', 'author-10'] }])
  })

  it('does not record an unknown sender id as a trusted actor', () => {
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'dm-channel-2' }], telegram: [], whatsapp: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })

    const result = acceptChannelClaimFromMessage(message('discord', 'dm-channel-2', 'unknown', claim.code))

    expect(result.status).toBe('accepted')
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'dm-channel-2' }])
  })

  it('keeps replay protection for claim codes re-sent to a trusted target', () => {
    updateConfig({ security: { channelAllowlists: { discord: [{ chatId: 'dm-channel-1' }], telegram: [], whatsapp: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })

    expect(acceptChannelClaimFromMessage(message('discord', 'dm-channel-1', 'author-9', claim.code)).status).toBe('accepted')
    const replay = acceptChannelClaimFromMessage(message('discord', 'dm-channel-1', 'attacker-1', claim.code))

    expect(replay).toMatchObject({ status: 'denied', reason: 'replay' })
    expect(getConfig().security.channelAllowlists.discord).toEqual([{ chatId: 'dm-channel-1', userIds: ['author-9'] }])
  })

  it('does not change channel trust after losing writer leadership', () => {
    const dbPath = path.join(testDir, 'gateway.db')
    const claim = createChannelClaimCode({ provider: 'discord', ttlMs: 60_000 })
    let now = 1_000
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'claim-a', instanceId: 'claim-a:1', leaseMs: 10_000, now: () => now })
    expect(writer.acquireOrRenew().canWrite).toBe(true)
    setCurrentDaemonLeadership(writer)
    setWorkDbLeadershipEpochProvider(() => writer.captureEpoch())
    now += 10_001
    const successor = createDaemonLeadership({ filePath: dbPath, daemonId: 'claim-b', instanceId: 'claim-b:1', leaseMs: 10_000, now: () => now })
    expect(successor.acquireOrRenew().canWrite).toBe(true)

    expect(() => acceptChannelClaimFromMessage(message('discord', 'new-target', 'author-9', claim.code))).toThrow('writer leadership is required')
    expect(getConfig().security.channelAllowlists.discord).toEqual([])
  })

  function message(provider: string, chatId: string, userId: string, text: string): ChannelMessage {
    return { provider, chatId, userId, text, attachments: [], timestamp: new Date().toISOString() }
  }
})
