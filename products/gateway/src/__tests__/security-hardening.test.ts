import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertHttpBindAllowed,
  estimateTokenEntropyBits,
  evaluateExposedHttpGuard,
  evaluateHttpRequestSecurity,
  exposedHttpGuardKeys,
  isStrongToken,
  recordExposedHttpAuthResult,
  resetExposedHttpGuardsForTest,
  resolveHttpClientAddress,
  type ExposedHttpGuardConfig,
} from '../security.js'
import type { SecurityConfig } from '../config.js'

const STRONG_TOKEN = 'Xk7pQ2rL9wMv3ZtB6nD4hJ8sF1aY0cG'

function baseSecurity(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    httpHost: '127.0.0.1',
    allowNonLocalHttp: false,
    publicWebhookMode: false,
    unsafeAllowNoAuth: false,
    capabilityScopedLoopback: true,
    requireNonMcpDestructiveApproval: true,
    trustTargetMembersForFreeText: false,
    unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false },
    channelAllowlists: { telegram: [], whatsapp: [], discord: [] },
    exposedHttp: {
      requireStrongToken: true,
      minTokenLength: 16,
      minTokenEntropyBits: 48,
      trustedProxyCidrs: [],
      rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 120, maxTrackedClients: 4096 },
      authLockout: { enabled: true, maxConsecutiveFailures: 5, lockoutMs: 60_000 },
    },
    ...overrides,
  }
}

const guardConfig = (overrides: Partial<ExposedHttpGuardConfig> = {}): ExposedHttpGuardConfig => ({
  rateLimit: { enabled: true, windowMs: 1000, maxRequests: 3, maxTrackedClients: 4 },
  authLockout: { enabled: true, maxConsecutiveFailures: 3, lockoutMs: 5000 },
  ...overrides,
})

describe('SEC1 token entropy floor', () => {
  it('scores entropy monotonically and rejects short/repetitive tokens', () => {
    expect(estimateTokenEntropyBits('aaaaaaaaaaaaaaaa')).toBe(0)
    expect(isStrongToken('short')).toBe(false)
    expect(isStrongToken('aaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(isStrongToken(STRONG_TOKEN)).toBe(true)
    // The historical fixture-style tokens still clear the default floor.
    expect(isStrongToken('http-secret-token')).toBe(true)
  })

  it('rejects daemon startup in exposed mode when the token is weak', () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'weak'
    expect(() => assertHttpBindAllowed(baseSecurity({ httpHost: '0.0.0.0', allowNonLocalHttp: true })))
      .toThrow(/too short or low-entropy/)
  })

  it('accepts a strong exposed token and honors requireStrongToken=false', () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = STRONG_TOKEN
    expect(() => assertHttpBindAllowed(baseSecurity({ httpHost: '0.0.0.0', allowNonLocalHttp: true }))).not.toThrow()

    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'weak'
    const relaxed = baseSecurity({ httpHost: '0.0.0.0', allowNonLocalHttp: true })
    relaxed.exposedHttp!.requireStrongToken = false
    expect(() => assertHttpBindAllowed(relaxed)).not.toThrow()
  })

  it('refuses process start when unsafeAllowNoAuth is combined with non-local bind', () => {
    // Audit 2026-07-21 P2-3: readiness fail is insufficient — startup must refuse.
    expect(() => assertHttpBindAllowed(baseSecurity({
      httpHost: '0.0.0.0',
      allowNonLocalHttp: true,
      unsafeAllowNoAuth: true,
    }))).toThrow(/unsafeAllowNoAuth/)
  })

  afterEach(() => { delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] })
})

describe('SEC1 exposed HTTP guard', () => {
  beforeEach(() => resetExposedHttpGuardsForTest())
  afterEach(() => resetExposedHttpGuardsForTest())

  it('rate limits a client after the sliding window is exhausted, with Retry-After', () => {
    const config = guardConfig()
    const now = 1_000_000
    for (let i = 0; i < 3; i++) expect(evaluateExposedHttpGuard('1.2.3.4', config, now).allowed).toBe(true)
    const limited = evaluateExposedHttpGuard('1.2.3.4', config, now)
    expect(limited).toMatchObject({ allowed: false, reason: 'rate_limited' })
    expect((limited as any).retryAfterSeconds).toBeGreaterThan(0)
    // A different client is independent.
    expect(evaluateExposedHttpGuard('5.6.7.8', config, now).allowed).toBe(true)
    // The window slides: once past windowMs the earlier hits expire.
    expect(evaluateExposedHttpGuard('1.2.3.4', config, now + 1001).allowed).toBe(true)
  })

  it('locks out a client after consecutive auth failures and resets on success', () => {
    const config = guardConfig()
    const now = 2_000_000
    for (let i = 0; i < 3; i++) {
      expect(evaluateExposedHttpGuard('9.9.9.9', config, now).allowed).toBe(true)
      recordExposedHttpAuthResult('9.9.9.9', false, config, now)
    }
    const locked = evaluateExposedHttpGuard('9.9.9.9', config, now)
    expect(locked).toMatchObject({ allowed: false, reason: 'locked_out' })
    // After the lockout window a successful auth clears the counter.
    expect(evaluateExposedHttpGuard('9.9.9.9', config, now + 5001).allowed).toBe(true)
    recordExposedHttpAuthResult('9.9.9.9', true, config, now + 5001)
    // Fresh failures start from zero: two failures do not re-lock.
    recordExposedHttpAuthResult('9.9.9.9', false, config, now + 6000)
    recordExposedHttpAuthResult('9.9.9.9', false, config, now + 6000)
    expect(evaluateExposedHttpGuard('9.9.9.9', config, now + 6000).allowed).toBe(true)
  })

  it('bounds memory by evicting least-recently-seen clients', () => {
    const config = guardConfig({ rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 100, maxTrackedClients: 2 } })
    const now = 3_000_000
    evaluateExposedHttpGuard('a', config, now)
    evaluateExposedHttpGuard('b', config, now)
    evaluateExposedHttpGuard('c', config, now) // evicts 'a'
    // 'a' was evicted, so its window restarts fresh (no accumulated state).
    for (let i = 0; i < 100; i++) evaluateExposedHttpGuard('a', config, now)
    expect(evaluateExposedHttpGuard('a', config, now).allowed).toBe(false)
  })

  it('isolates credential lockouts for clients sharing an address', () => {
    const config = guardConfig()
    const now = 4_000_000
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = STRONG_TOKEN
    try {
      const attacker = exposedHttpGuardKeys('203.0.113.9', 'Bearer invalid-attacker-token')
      const operator = exposedHttpGuardKeys('203.0.113.9', `Bearer ${STRONG_TOKEN}`)
      for (let i = 0; i < 3; i++) recordExposedHttpAuthResult(attacker, false, config, now)
      expect(evaluateExposedHttpGuard(attacker, config, now)).toMatchObject({ allowed: false, reason: 'locked_out' })
      expect(evaluateExposedHttpGuard(operator, config, now).allowed).toBe(true)
    } finally {
      delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    }
  })
})

describe('SEC1 trusted proxy address derivation', () => {
  it('ignores forwarding headers from untrusted peers', () => {
    expect(resolveHttpClientAddress({
      remoteAddress: '198.51.100.10',
      xForwardedFor: '203.0.113.7',
      trustedProxyCidrs: ['10.0.0.0/8'],
    })).toBe('198.51.100.10')
  })

  it('separates clients behind a trusted reverse proxy', () => {
    const input = { remoteAddress: '10.1.2.3', trustedProxyCidrs: ['10.0.0.0/8'] }
    expect(resolveHttpClientAddress({ ...input, xForwardedFor: '203.0.113.7' })).toBe('203.0.113.7')
    expect(resolveHttpClientAddress({ ...input, forwarded: 'for=203.0.113.8;proto=https' })).toBe('203.0.113.8')
  })

  it('walks trusted proxy hops right-to-left and stops at the first untrusted hop', () => {
    expect(resolveHttpClientAddress({
      remoteAddress: '10.0.0.3',
      xForwardedFor: '192.0.2.99, 203.0.113.4, 10.0.0.2',
      trustedProxyCidrs: ['10.0.0.0/8'],
    })).toBe('203.0.113.4')
  })

  it('normalizes IPv4-mapped socket addresses before matching trusted proxies', () => {
    expect(resolveHttpClientAddress({
      remoteAddress: '::ffff:10.0.0.5',
      xForwardedFor: '203.0.113.11',
      trustedProxyCidrs: ['10.0.0.0/8'],
    })).toBe('203.0.113.11')
  })
})

describe('SEC3 capability-scoped loopback', () => {
  const localReadInput = { host: 'localhost', origin: 'http://localhost', remoteAddress: '127.0.0.1', method: 'GET', pathname: '/gateway/health' }
  const localWriteInput = { host: 'localhost', origin: 'http://localhost', remoteAddress: '127.0.0.1', method: 'POST', pathname: '/tasks' }

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
  })

  it('default on: a local read request remains reachable without a token', () => {
    const decision = evaluateHttpRequestSecurity(localReadInput, baseSecurity())
    expect(decision).toMatchObject({ allowed: true, actor: 'local', requiredCapability: 'read' })
  })

  it('default on: a local mutation without a token is denied', () => {
    const decision = evaluateHttpRequestSecurity(localWriteInput, baseSecurity())
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/capability-scoped bearer token/)
  })

  it('default on: a loopback mutation with a valid capability token is allowed at its scope', () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = STRONG_TOKEN
    const decision = evaluateHttpRequestSecurity(
      { ...localWriteInput, authorization: `Bearer ${STRONG_TOKEN}` },
      baseSecurity(),
    )
    expect(decision).toMatchObject({ allowed: true, actor: 'http-token' })
  })

  it('can still opt back into legacy loopback trust explicitly', () => {
    const decision = evaluateHttpRequestSecurity(localWriteInput, baseSecurity({ capabilityScopedLoopback: false }))
    expect(decision).toMatchObject({ allowed: true, actor: 'local' })
  })
})
