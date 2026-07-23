/**
 * Process-local inbound webhook rate limit for Durable Gateway (JOE-923 progressive).
 *
 * Algorithm kernel: `@open-cowork/shared/node` {@link WebhookRateLimiter}
 * (shared with monorepo channel gateways via `@open-cowork/gateway-channel`).
 *
 * Client identity uses the same trusted-proxy walk as exposed HTTP guards
 * (`resolveHttpClientAddress`) so spoofed `X-Forwarded-For` cannot multiply
 * rate-limit buckets when the socket peer is not a trusted proxy.
 */

import { WebhookRateLimiter, type WebhookRateLimitResult } from '@open-cowork/shared/node'
import { getConfig } from '../config.js'
import { resolveHttpClientAddress } from '../security.js'

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

export interface InboundWebhookRateKeyOptions {
  /** Override trusted proxy CIDRs (tests). Defaults to exposedHttp config when non-local HTTP is allowed. */
  trustedProxyCidrs?: string[]
}

/**
 * Rate-limit key: provider + resolved client address.
 * Forwarding headers are ignored unless the socket peer is a configured trusted proxy.
 */
export function inboundWebhookRateKey(
  provider: string,
  req: {
    socket?: { remoteAddress?: string | null }
    headers?: Record<string, string | string[] | undefined>
  },
  options: InboundWebhookRateKeyOptions = {},
): string {
  let trustedProxyCidrs = options.trustedProxyCidrs
  if (trustedProxyCidrs === undefined) {
    const security = getConfig().security
    trustedProxyCidrs = security.allowNonLocalHttp === true
      ? (security.exposedHttp?.trustedProxyCidrs || [])
      : []
  }
  const client = resolveHttpClientAddress({
    remoteAddress: req.socket?.remoteAddress || undefined,
    forwarded: req.headers?.['forwarded'],
    xForwardedFor: req.headers?.['x-forwarded-for'],
    trustedProxyCidrs,
  })
  const remote = client.replace(/[^a-zA-Z0-9:._-]/g, '_') || 'unknown'
  return `${provider}:${remote}`
}
