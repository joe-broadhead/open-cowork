import test from 'node:test'
import assert from 'node:assert/strict'
import { WebhookRateLimiter as SharedLimiter } from '@open-cowork/shared/node'
// Root package.json does not depend on gateway-channel; import built dist.
import { WebhookRateLimiter as ChannelLimiter } from '../packages/gateway-channel/dist/webhook-rate-limiter.js'

/**
 * SEC-4 / post-#959: monorepo gateway-channel keeps an algorithm twin of the
 * shared WebhookRateLimiter. Fail closed if claim/backoff semantics diverge.
 */
test('shared and gateway-channel WebhookRateLimiter claim/backoff stay lockstep', async () => {
  // Ensure dist is present (CI builds packages before node tests).
  const nowMs = 1_700_000_000_000
  const claim = { key: 'parity', nowMs, windowMs: 60_000, maxRequests: 3 }

  const sClaim = new SharedLimiter()
  const cClaim = new ChannelLimiter()
  for (let i = 0; i < 3; i++) {
    assert.equal(sClaim.claim(claim).ok, true)
    assert.equal(cClaim.claim(claim).ok, true)
  }
  const sLimited = sClaim.claim(claim)
  const cLimited = cClaim.claim(claim)
  assert.equal(sLimited.ok, false)
  assert.equal(cLimited.ok, false)
  if (!sLimited.ok && !cLimited.ok) {
    assert.equal(sLimited.retryAfterMs, cLimited.retryAfterMs)
  }

  const sBack = new SharedLimiter()
  const cBack = new ChannelLimiter()
  const backoff = { key: 'auth', nowMs, windowMs: 60_000, maxFailures: 2, backoffMs: 30_000 }
  assert.equal(sBack.backoff(backoff).ok, true)
  assert.equal(cBack.backoff(backoff).ok, true)
  assert.equal(sBack.backoff(backoff).ok, true)
  assert.equal(cBack.backoff(backoff).ok, true)
  const sBlocked = sBack.claim({ key: 'auth', nowMs, windowMs: 60_000, maxRequests: 100 })
  const cBlocked = cBack.claim({ key: 'auth', nowMs, windowMs: 60_000, maxRequests: 100 })
  assert.equal(sBlocked.ok, false)
  assert.equal(cBlocked.ok, false)
})
