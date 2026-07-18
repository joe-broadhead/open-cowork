import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evaluateExposedHttpGuard,
  exposedHttpGuardKeys,
  recordExposedHttpAuthResult,
  resetExposedHttpGuardsForTest,
  resolveHttpClientAddress,
  type ExposedHttpGuardConfig,
} from '../security.js'

const guardConfig: ExposedHttpGuardConfig = {
  rateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100, maxTrackedClients: 100 },
  authLockout: { enabled: true, maxConsecutiveFailures: 3, lockoutMs: 30_000 },
}

describe('exposed HTTP authentication identities', () => {
  beforeEach(() => {
    resetExposedHttpGuardsForTest()
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'admin-configured-token-value'
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-configured-token-value'
  })

  afterEach(() => {
    resetExposedHttpGuardsForTest()
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
  })

  it('collapses rotating invalid bearer guesses into one address-scoped failure bucket', () => {
    const address = '203.0.113.44'
    const guesses = ['guess-one', 'guess-two', 'guess-three'].map(token => exposedHttpGuardKeys(address, `Bearer ${token}`))
    expect([...new Set(guesses.map(keys => keys.authLockoutKey))]).toHaveLength(1)

    guesses.forEach(keys => recordExposedHttpAuthResult(keys, false, guardConfig, 10_000))

    const rotatedGuess = exposedHttpGuardKeys(address, 'Bearer never-tried-before')
    recordExposedHttpAuthResult(rotatedGuess, true, guardConfig, 10_000)
    expect(evaluateExposedHttpGuard(rotatedGuess, guardConfig, 10_000)).toMatchObject({ allowed: false, reason: 'locked_out' })
  })

  it('keeps known valid credential identities separate from invalid guesses and one another', () => {
    const address = '203.0.113.45'
    const invalid = exposedHttpGuardKeys(address, 'Bearer invalid')
    const admin = exposedHttpGuardKeys(address, 'Bearer admin-configured-token-value')
    const operator = exposedHttpGuardKeys(address, 'Bearer operator-configured-token-value')
    expect([...new Set([invalid.authLockoutKey, admin.authLockoutKey, operator.authLockoutKey])]).toHaveLength(3)

    for (let index = 0; index < 3; index += 1) recordExposedHttpAuthResult(invalid, false, guardConfig, 20_000)
    expect(evaluateExposedHttpGuard(invalid, guardConfig, 20_000)).toMatchObject({ allowed: false, reason: 'locked_out' })
    expect(evaluateExposedHttpGuard(admin, guardConfig, 20_000)).toEqual({ allowed: true })
    expect(evaluateExposedHttpGuard(operator, guardConfig, 20_000)).toEqual({ allowed: true })
  })
})

describe('trusted proxy forwarding-family policy', () => {
  const proxy = { remoteAddress: '10.0.0.8', trustedProxyCidrs: ['10.0.0.0/8'] }

  it('accepts one valid family or matching normalized families', () => {
    expect(resolveHttpClientAddress({ ...proxy, forwarded: 'for=203.0.113.8;proto=https' })).toBe('203.0.113.8')
    expect(resolveHttpClientAddress({
      ...proxy,
      forwarded: 'for=203.0.113.9;proto=https, for=10.0.0.4',
      xForwardedFor: '203.0.113.9, 10.0.0.4',
    })).toBe('203.0.113.9')
  })

  it('fails closed to the socket peer when Forwarded and X-Forwarded-For conflict', () => {
    expect(resolveHttpClientAddress({
      ...proxy,
      forwarded: 'for=203.0.113.10',
      xForwardedFor: '198.51.100.10',
    })).toBe(proxy.remoteAddress)
  })

  it('does not fall back to the other family when either supplied chain is malformed', () => {
    expect(resolveHttpClientAddress({
      ...proxy,
      forwarded: 'for=unknown',
      xForwardedFor: '203.0.113.11',
    })).toBe(proxy.remoteAddress)
    expect(resolveHttpClientAddress({
      ...proxy,
      forwarded: 'for=203.0.113.12',
      xForwardedFor: '203.0.113.12, unknown',
    })).toBe(proxy.remoteAddress)
  })
})
