import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_UNREDACTED_EXPORT_GUARD,
  evaluateUnredactedExportGuard,
  guardUnredactedExport,
  resetUnredactedExportGuardForTests,
  unredactedExportActorKey,
} from '../unredacted-export-guard.js'

describe('unredacted-export-guard (JOE-952)', () => {
  beforeEach(() => {
    resetUnredactedExportGuardForTests()
  })

  it('allows up to maxRequests then rate-limits', () => {
    const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 3, windowMs: 60_000 }
    const now = 1_000_000
    expect(evaluateUnredactedExportGuard('actor-a', config, now).allowed).toBe(true)
    expect(evaluateUnredactedExportGuard('actor-a', config, now + 1).allowed).toBe(true)
    expect(evaluateUnredactedExportGuard('actor-a', config, now + 2).allowed).toBe(true)
    const limited = evaluateUnredactedExportGuard('actor-a', config, now + 3)
    expect(limited.allowed).toBe(false)
    if (!limited.allowed) expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('scopes buckets per actor', () => {
    const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 1, windowMs: 60_000 }
    const now = 2_000_000
    expect(evaluateUnredactedExportGuard('actor-a', config, now).allowed).toBe(true)
    expect(evaluateUnredactedExportGuard('actor-a', config, now + 1).allowed).toBe(false)
    expect(evaluateUnredactedExportGuard('actor-b', config, now + 1).allowed).toBe(true)
  })

  it('is a no-op when redacted', () => {
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    expect(
      guardUnredactedExport(req, { operation: 'evidence.export.unredacted', target: 'x', unredacted: false }),
    ).toBeNull()
  })

  it('returns 429 after the limit', () => {
    const req = {
      headers: { authorization: 'Bearer test-token-abcdef' },
      socket: { remoteAddress: '10.0.0.5' },
    }
    const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 2, windowMs: 60_000 }
    const now = 3_000_000
    expect(
      guardUnredactedExport(req, {
        operation: 'config.read.unredacted',
        target: 'config',
        unredacted: true,
        config,
        now,
      }),
    ).toBeNull()
    expect(
      guardUnredactedExport(req, {
        operation: 'config.read.unredacted',
        target: 'config',
        unredacted: true,
        config,
        now: now + 1,
      }),
    ).toBeNull()
    const denied = guardUnredactedExport(req, {
      operation: 'config.read.unredacted',
      target: 'config',
      unredacted: true,
      config,
      now: now + 2,
    })
    expect(denied).toBeTruthy()
    expect(denied?.status).toBe(429)
    expect((denied?.body as { error?: string })?.error).toBe('unredacted export rate limit exceeded')
  })

  it('uses bearer fingerprint when present', () => {
    const withToken = unredactedExportActorKey({
      headers: { authorization: 'Bearer abc' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const without = unredactedExportActorKey({
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    })
    expect(withToken).toMatch(/^http-token:/)
    expect(without).toMatch(/^http\|/)
    expect(withToken).not.toEqual(without)
  })
})
