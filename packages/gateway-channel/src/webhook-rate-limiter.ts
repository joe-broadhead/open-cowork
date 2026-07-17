/**
 * Shared fixed-window webhook rate limiter used by both the Cloud Channel
 * Gateway (`apps/gateway`) and Standalone Gateway (`apps/standalone-gateway`).
 * JOE-875: one kernel, two product entrypoints.
 */

export type WebhookRateLimitRecord = {
  count: number
  resetAt: number
  blockedUntil: number
}

export type WebhookRateLimitClaimInput = {
  key: string
  nowMs: number
  windowMs: number
  maxRequests: number
}

export type WebhookRateLimitBackoffInput = {
  key: string
  nowMs: number
  windowMs: number
  maxFailures: number
  backoffMs: number
}

export type WebhookRateLimitCheckInput = {
  key: string
  nowMs: number
  windowMs: number
}

export type WebhookRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number }

const DEFAULT_MAX_RECORDS = 10_000

/**
 * Fixed-window counter with auth-failure backoff and relevance-based eviction
 * under cap pressure (prefer dropping non-blocking / soonest-expiring keys so
 * active attack blocks are preserved).
 */
export class WebhookRateLimiter {
  private readonly records = new Map<string, WebhookRateLimitRecord>()

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {}

  claim(input: WebhookRateLimitClaimInput): WebhookRateLimitResult {
    const record = this.record(input.key, input.nowMs, input.windowMs)
    if (record.blockedUntil > input.nowMs) {
      return { ok: false, retryAfterMs: record.blockedUntil - input.nowMs }
    }
    record.count += 1
    if (record.count > input.maxRequests) {
      record.blockedUntil = Math.max(record.blockedUntil, record.resetAt)
      return { ok: false, retryAfterMs: record.blockedUntil - input.nowMs }
    }
    return { ok: true }
  }

  backoff(input: WebhookRateLimitBackoffInput): WebhookRateLimitResult {
    const record = this.record(input.key, input.nowMs, input.windowMs)
    if (record.blockedUntil > input.nowMs) {
      return { ok: false, retryAfterMs: record.blockedUntil - input.nowMs }
    }
    record.count += 1
    if (record.count >= input.maxFailures) {
      record.blockedUntil = Math.max(record.blockedUntil, input.nowMs + input.backoffMs)
    }
    return { ok: true }
  }

  check(input: WebhookRateLimitCheckInput): WebhookRateLimitResult {
    const record = this.record(input.key, input.nowMs, input.windowMs)
    if (record.blockedUntil > input.nowMs) {
      return { ok: false, retryAfterMs: record.blockedUntil - input.nowMs }
    }
    return { ok: true }
  }

  private record(key: string, nowMs: number, windowMs: number): WebhookRateLimitRecord {
    const existing = this.records.get(key)
    if (existing && existing.resetAt > nowMs) return existing
    const next: WebhookRateLimitRecord = { count: 0, resetAt: nowMs + windowMs, blockedUntil: 0 }
    this.records.set(key, next)
    if (this.records.size > this.maxRecords) this.prune(nowMs)
    while (this.records.size > this.maxRecords) {
      let evictKey: string | null = null
      let evictBlocking = true
      let evictExpiry = Infinity
      for (const [candidateKey, candidate] of this.records) {
        const blocking = candidate.blockedUntil > nowMs
        const expiry = Math.max(candidate.resetAt, candidate.blockedUntil)
        if (
          evictKey === null
          || (!blocking && evictBlocking)
          || (blocking === evictBlocking && expiry < evictExpiry)
        ) {
          evictKey = candidateKey
          evictBlocking = blocking
          evictExpiry = expiry
        }
      }
      if (!evictKey) break
      this.records.delete(evictKey)
    }
    return next
  }

  private prune(nowMs: number) {
    for (const [key, record] of this.records) {
      if (record.resetAt <= nowMs && record.blockedUntil <= nowMs) this.records.delete(key)
    }
  }
}

/** @deprecated Prefer {@link WebhookRateLimiter}; alias kept for cloud-channel call sites. */
export class GatewayWebhookRateLimiter extends WebhookRateLimiter {}
