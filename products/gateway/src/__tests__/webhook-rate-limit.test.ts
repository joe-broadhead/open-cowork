import { afterEach, describe, expect, it } from 'vitest'
import {
  DURABLE_WEBHOOK_RATE_LIMIT,
  claimInboundWebhookRateLimit,
  clearInboundWebhookRateLimitForTest,
  inboundWebhookRateKey,
  noteInboundWebhookAuthFailure,
} from '../channels/webhook-rate-limit.js'

describe('Durable inbound webhook rate limit', () => {
  afterEach(() => {
    clearInboundWebhookRateLimitForTest()
  })

  it('claims within the window then rate-limits', () => {
    const key = 'whatsapp:test-client'
    const nowMs = 1_700_000_000_000
    for (let i = 0; i < DURABLE_WEBHOOK_RATE_LIMIT.maxRequests; i++) {
      expect(claimInboundWebhookRateLimit(key, nowMs).ok).toBe(true)
    }
    const limited = claimInboundWebhookRateLimit(key, nowMs)
    expect(limited.ok).toBe(false)
    if (!limited.ok) expect(limited.retryAfterMs).toBeGreaterThan(0)
  })

  it('backs off after repeated auth failures', () => {
    const key = 'discord:attacker'
    const nowMs = 1_700_000_000_000
    for (let i = 0; i < DURABLE_WEBHOOK_RATE_LIMIT.maxAuthFailures; i++) {
      expect(noteInboundWebhookAuthFailure(key, nowMs).ok).toBe(true)
    }
    const blocked = claimInboundWebhookRateLimit(key, nowMs)
    expect(blocked.ok).toBe(false)
  })

  it('builds stable rate keys from socket remote address', () => {
    expect(inboundWebhookRateKey('whatsapp', { socket: { remoteAddress: '203.0.113.10' } })).toBe('whatsapp:203.0.113.10')
  })

  it('ignores spoofed X-Forwarded-For unless the socket peer is a trusted proxy', () => {
    // Untrusted peer: client-supplied XFF must not mint a new bucket identity.
    expect(inboundWebhookRateKey('discord', {
      socket: { remoteAddress: '203.0.113.50' },
      headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.50' },
    }, { trustedProxyCidrs: [] })).toBe('discord:203.0.113.50')

    // Trusted proxy peer: walk the chain to the client hop.
    expect(inboundWebhookRateKey('discord', {
      socket: { remoteAddress: '10.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1' },
    }, { trustedProxyCidrs: ['10.0.0.0/8'] })).toBe('discord:198.51.100.2')
  })
})
