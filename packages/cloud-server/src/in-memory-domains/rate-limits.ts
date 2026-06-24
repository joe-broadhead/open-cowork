import { key, normalizePositiveInteger } from './store-helpers.ts'
import type { ClaimRateLimitInput, RateLimitClaimRecord } from '../control-plane-store.ts'

// Rate-limit domain extracted from in-memory-control-plane-store.ts. Owns the
// per-(scope,source) sliding-window counters and the claim/allow decision. No host
// — no cross-domain dependencies. Behaviour-preserving; covered by the
// cloud-http-server rate-limit suite.

export class InMemoryRateLimitsDomain {
  private readonly rateLimits = new Map<string, { windowStartedAtMs: number, count: number }>()

  claimRateLimit(input: ClaimRateLimitInput): RateLimitClaimRecord {
    const limit = normalizePositiveInteger(input.limit, 'Rate limit')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Rate-limit window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    const rateKey = key(input.scope, input.source)
    const existing = this.rateLimits.get(rateKey)
    const count = existing && existing.windowStartedAtMs === startedAtMs ? existing.count + 1 : 1
    this.rateLimits.set(rateKey, { windowStartedAtMs: startedAtMs, count })
    const retryAfterMs = quotaRetryAfterMs(nowMs, startedAtMs, windowMs)
    return {
      allowed: count <= limit,
      scope: input.scope,
      source: input.source,
      limit,
      count,
      resetAt: new Date(nowMs + retryAfterMs).toISOString(),
      retryAfterMs,
      policyCode: input.policyCode,
    }
  }
}

function windowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}

function quotaRetryAfterMs(nowMs: number, startedAtMs: number, windowMs: number) {
  return Math.max(1, startedAtMs + windowMs - nowMs)
}
