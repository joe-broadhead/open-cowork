import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { __daemonTest } from '../daemon.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, listAlerts, listWorkEvents } from '../work-store.js'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'

describe('daemon channel trust gate', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-daemon-channel-gate-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:test-token'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    updateConfig({
      security: {
        channelAllowlists: { telegram: [{ chatId: 'trusted-chat', userIds: ['trusted-user'] }], whatsapp: [], discord: [] },
      },
    } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
  })

  it('admits only safe setup commands before channel trust', () => {
    expect(__daemonTest.channelInboundTrustDecision(message('/start')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('/help')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('/commands')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('/whereami')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('/status')).allowed).toBe(false)
    expect(__daemonTest.channelInboundTrustDecision(message('hello')).allowed).toBe(false)
    expect(__daemonTest.channelInboundTrustDecision(message('hello'))).toEqual({ allowed: false, reason: 'untrusted_target' })
  })

  it('admits trusted-actor messages after the channel target is trusted', () => {
    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'trusted-chat', 'trusted-user')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('/status', 'trusted-chat', 'trusted-user')).allowed).toBe(true)
  })

  it('rejects free text from an untrusted actor inside a trusted target', () => {
    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'trusted-chat', 'other-member'))).toEqual({ allowed: false, reason: 'untrusted_actor' })
    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'trusted-chat'))).toEqual({ allowed: false, reason: 'untrusted_actor' })
    // Non-privileged slash commands stay target-gated; privileged commands run the
    // per-sender preflight in channel-commands.
    expect(__daemonTest.channelInboundTrustDecision(message('/status', 'trusted-chat', 'other-member')).allowed).toBe(true)
  })

  it('keeps the single-operator DM flow working when the sender matches the chat id', () => {
    updateConfig({
      security: {
        channelAllowlists: { telegram: [{ chatId: 'dm-chat' }], whatsapp: [], discord: [] },
      },
    } as any)

    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'dm-chat', 'dm-chat')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'dm-chat', 'someone-else'))).toEqual({ allowed: false, reason: 'untrusted_actor' })
  })

  it('records a redacted denial audit for untrusted-actor free text like untrusted-target denials', () => {
    const decision = __daemonTest.channelInboundTrustDecision(message('please run rm -rf for me', 'trusted-chat', 'other-member'))
    expect(decision).toEqual({ allowed: false, reason: 'untrusted_actor' })

    appendChannelInboundDenialAudit({ provider: 'telegram', chatId: 'trusted-chat', reason: decision.reason })

    const audit = listWorkEvents(10).find(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')
    expect(audit).toMatchObject({
      payload: expect.objectContaining({
        result: 'denied',
        target: expect.stringContaining('telegram:target:'),
        details: expect.objectContaining({ reason: 'untrusted_actor', redacted: true }),
      }),
    })
    const serialized = JSON.stringify(listWorkEvents(10))
    expect(serialized).not.toContain('trusted-chat')
    expect(serialized).not.toContain('rm -rf')
  })

  it('restores target-only free text trust with security.trustTargetMembersForFreeText', () => {
    updateConfig({ security: { trustTargetMembersForFreeText: true } } as any)

    expect(__daemonTest.channelInboundTrustDecision(message('hello', 'trusted-chat', 'other-member')).allowed).toBe(true)
    expect(__daemonTest.channelInboundTrustDecision(message('hello')).allowed).toBe(false)
  })

  it('raises a startup alert for actor-less allowlist rules with no DM fallback', () => {
    updateConfig({
      security: {
        channelAllowlists: {
          telegram: [
            { chatId: '-100777888999' }, // group-shaped, no actors: stranded
            { chatId: '424242' }, // DM-shaped: sender-matches-chat fallback applies
          ],
          whatsapp: [{ chatId: 'wa-dm-target' }], // DM-shaped: fallback applies
          discord: [
            { chatId: 'discord-channel-1' }, // channel id never equals author id: stranded
            { chatId: 'discord-channel-2', userIds: ['author-1'] }, // healed rule
          ],
        },
      },
    } as any)

    const flagged = __daemonTest.recordChannelAllowlistActorGapAlerts(getConfig())

    expect(flagged).toBe(2)
    const alerts = listAlerts({ status: 'open', source: 'security.channel_allowlists' })
    expect(alerts).toHaveLength(2)
    for (const alert of alerts) {
      expect(alert.nextAction).toContain('claim')
      expect(alert.nextAction).toContain('security.trustTargetMembersForFreeText')
    }
    const serialized = JSON.stringify(alerts)
    expect(serialized).not.toContain('-100777888999')
    expect(serialized).not.toContain('discord-channel-1')

    // Re-running dedupes on the alert key instead of stacking new alerts.
    expect(__daemonTest.recordChannelAllowlistActorGapAlerts(getConfig())).toBe(2)
    expect(listAlerts({ status: 'open', source: 'security.channel_allowlists' })).toHaveLength(2)

    // The documented escape hatch clears the lockout, so no alert is raised.
    updateConfig({ security: { trustTargetMembersForFreeText: true } } as any)
    expect(__daemonTest.recordChannelAllowlistActorGapAlerts(getConfig())).toBe(0)
  })

  it('records redacted channel command receipt evidence', () => {
    const msg = { ...message('/status secret-token-value', 'trusted-chat'), messageId: 'provider-message-123', threadId: 'topic-1' }
    const command = { name: 'status', args: ['secret-token-value'], rest: 'secret-token-value' }

    __daemonTest.recordChannelCommandEvent('channel.command.received', msg, command)
    __daemonTest.recordChannelCommandEvent('channel.command.replied', msg, command, { delivery: 'message', replyLength: 123 })

    const events = listWorkEvents(10)
    expect(events.filter(event => event.type === 'channel.command.received')).toHaveLength(1)
    expect(events.filter(event => event.type === 'channel.command.replied')).toHaveLength(1)
    expect(events.find(event => event.type === 'channel.command.replied')).toMatchObject({
      subjectId: 'telegram:status',
      payload: expect.objectContaining({
        provider: 'telegram',
        command: 'status',
        target: expect.stringContaining('telegram:target:'),
        messageKey: expect.any(String),
        thread: 'present',
        delivery: 'message',
        replyLength: 123,
      }),
    })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('trusted-chat')
    expect(serialized).not.toContain('provider-message-123')
    expect(serialized).not.toContain('secret-token-value')
    expect(serialized).not.toContain('/status')
  })

  function message(text: string, chatId = 'untrusted-chat', userId?: string) {
    return { provider: 'telegram', chatId, userId, text }
  }
})
