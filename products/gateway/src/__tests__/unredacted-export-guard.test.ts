import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_UNREDACTED_EXPORT_GUARD,
  evaluateUnredactedExportGuard,
  guardUnredactedExport,
  resetUnredactedExportGuardForTests,
  unredactedExportActorKey,
} from '../unredacted-export-guard.ts'

test.beforeEach(() => {
  resetUnredactedExportGuardForTests()
})

test('evaluateUnredactedExportGuard allows up to maxRequests then rate-limits', () => {
  const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 3, windowMs: 60_000 }
  const now = 1_000_000
  assert.equal(evaluateUnredactedExportGuard('actor-a', config, now).allowed, true)
  assert.equal(evaluateUnredactedExportGuard('actor-a', config, now + 1).allowed, true)
  assert.equal(evaluateUnredactedExportGuard('actor-a', config, now + 2).allowed, true)
  const limited = evaluateUnredactedExportGuard('actor-a', config, now + 3)
  assert.equal(limited.allowed, false)
  if (!limited.allowed) assert.ok(limited.retryAfterSeconds >= 1)
})

test('evaluateUnredactedExportGuard scopes buckets per actor', () => {
  const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 1, windowMs: 60_000 }
  const now = 2_000_000
  assert.equal(evaluateUnredactedExportGuard('actor-a', config, now).allowed, true)
  assert.equal(evaluateUnredactedExportGuard('actor-a', config, now + 1).allowed, false)
  assert.equal(evaluateUnredactedExportGuard('actor-b', config, now + 1).allowed, true)
})

test('guardUnredactedExport is a no-op when redacted', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(
    guardUnredactedExport(req, { operation: 'evidence.export.unredacted', target: 'x', unredacted: false }),
    null,
  )
})

test('guardUnredactedExport returns 429 after the limit', () => {
  const req = {
    headers: { authorization: 'Bearer test-token-abcdef' },
    socket: { remoteAddress: '10.0.0.5' },
  }
  const config = { ...DEFAULT_UNREDACTED_EXPORT_GUARD, maxRequests: 2, windowMs: 60_000 }
  const now = 3_000_000
  assert.equal(
    guardUnredactedExport(req, {
      operation: 'config.read.unredacted',
      target: 'config',
      unredacted: true,
      config,
      now,
    }),
    null,
  )
  assert.equal(
    guardUnredactedExport(req, {
      operation: 'config.read.unredacted',
      target: 'config',
      unredacted: true,
      config,
      now: now + 1,
    }),
    null,
  )
  const denied = guardUnredactedExport(req, {
    operation: 'config.read.unredacted',
    target: 'config',
    unredacted: true,
    config,
    now: now + 2,
  })
  assert.ok(denied)
  assert.equal(denied?.status, 429)
  assert.equal((denied?.body as { error?: string })?.error, 'unredacted export rate limit exceeded')
})

test('unredactedExportActorKey uses bearer fingerprint when present', () => {
  const withToken = unredactedExportActorKey({
    headers: { authorization: 'Bearer abc' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  const without = unredactedExportActorKey({
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  })
  assert.match(withToken, /^http-token:/)
  assert.match(without, /^http\|/)
  assert.notEqual(withToken, without)
})
