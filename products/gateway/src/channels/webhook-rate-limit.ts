/**
 * Process-local inbound webhook rate limit for Durable Gateway (JOE-923 progressive).
 *
 * Algorithm kernel: `@open-cowork/shared/node` {@link WebhookRateLimiter}
 * (shared with monorepo channel gateways via `@open-cowork/gateway-channel`).
 */

import { WebhookRateLimiter, type WebhookRateLimitResult } from '@open-cowork/shared/node'

export type DurableWebhookRateLimitResult = WebhookRateLimitResult

/** Defaults tuned for public webhook endpoints (per remote address). */
export const DURABLE_WEBHOOK_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 120,
  authFailureWindowMs: 60_000,
  maxAuthFailures: 20,
  authFailureBackoffMs: 60_000,
} as const

const inboundWebhookRateLimiter = new WebhookRateLimiter()

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
