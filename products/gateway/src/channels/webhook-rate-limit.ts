/**
 * Process-local inbound webhook rate limit for Durable Gateway (JOE-923 progressive).
 *
 * Algorithm matches `@open-cowork/gateway-channel` `WebhookRateLimiter` (fixed window +
 * auth-failure backoff + cap eviction). Kept local so Durable stays on
 * `@open-cowork/shared` only; dual-stack security changes must still update both
 * stacks (see `docs/evidence/channel-stack-security-matrix-2026-07-21.md`).
 */

export type DurableWebhookRateLimitRecord = {
  count: number
  resetAt: number
  blockedUntil: number
}

export type DurableWebhookRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number }

const DEFAULT_MAX_RECORDS = 10_000

/** Defaults tuned for public webhook endpoints (per remote address). */
export const DURABLE_WEBHOOK_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 120,
  authFailureWindowMs: 60_000,
  maxAuthFailures: 20,
  authFailureBackoffMs: 60_000,
} as const

export class DurableWebhookRateLimiter {
  private readonly records = new Map<string, DurableWebhookRateLimitRecord>()

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {}

  clear(): void {
    this.records.clear()
  }

  claim(input: { key: string; nowMs: number; windowMs: number; maxRequests: number }): DurableWebhookRateLimitResult {
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

  backoff(input: { key: string; nowMs: number; windowMs: number; maxFailures: number; backoffMs: number }): DurableWebhookRateLimitResult {
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

  private record(key: string, nowMs: number, windowMs: number): DurableWebhookRateLimitRecord {
    const existing = this.records.get(key)
    if (existing && existing.resetAt > nowMs) return existing
    const next: DurableWebhookRateLimitRecord = { count: 0, resetAt: nowMs + windowMs, blockedUntil: 0 }
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

  private prune(nowMs: number): void {
    for (const [key, record] of this.records) {
      if (record.resetAt <= nowMs && record.blockedUntil <= nowMs) this.records.delete(key)
    }
  }
}

const inboundWebhookRateLimiter = new DurableWebhookRateLimiter()

export function claimInboundWebhookRateLimit(key: string, nowMs = Date.now()): DurableWebhookRateLimitResult {
  return inboundWebhookRateLimiter.claim({
    key,
    nowMs,
    windowMs: DURABLE_WEBHOOK_RATE_LIMIT.windowMs,
    maxRequests: DURABLE_WEBHOOK_RATE_LIMIT.maxRequests,
  })
}

export function noteInboundWebhookAuthFailure(key: string, nowMs = Date.now()): DurableWebhookRateLimitResult {
  return inboundWebhookRateLimiter.backoff({
    key,
    nowMs,
    windowMs: DURABLE_WEBHOOK_RATE_LIMIT.authFailureWindowMs,
    maxFailures: DURABLE_WEBHOOK_RATE_LIMIT.maxAuthFailures,
    backoffMs: DURABLE_WEBHOOK_RATE_LIMIT.authFailureBackoffMs,
  })
}

/** Test-only: clear limiter state between cases. */
export function clearInboundWebhookRateLimitForTest(): void {
  inboundWebhookRateLimiter.clear()
}

/** Rate-limit key: provider + remote address (falls closed to `unknown`). */
export function inboundWebhookRateKey(provider: string, req: { socket?: { remoteAddress?: string | null }; headers?: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers?.['x-forwarded-for']
  const forwardedFirst = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const remote = (forwardedFirst?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown').replace(/[^a-zA-Z0-9:._-]/g, '_')
  return `${provider}:${remote}`
}
