import { createHash } from 'node:crypto'
import { json } from './daemon-router.js'
import { auditHttp, httpCallerIdentity } from './daemon-routes/http-guardrails.js'

// JOE-952: tighter sliding-window rate limit for unredacted / raw export paths.
// Auth already requires admin; this bounds bulk exfiltration if an admin token
// is compromised or a buggy client loops.

export interface UnredactedExportGuardConfig {
  enabled: boolean
  /** Sliding window length. */
  windowMs: number
  /** Max successful unredacted/raw export attempts per actor per window. */
  maxRequests: number
  maxTrackedActors: number
}

export const DEFAULT_UNREDACTED_EXPORT_GUARD: UnredactedExportGuardConfig = {
  enabled: true,
  windowMs: 60_000,
  maxRequests: 10,
  maxTrackedActors: 1024,
}

interface RateBucket {
  timestamps: number[]
}

const buckets = new Map<string, RateBucket>()

/** Test-only reset. */
export function resetUnredactedExportGuardForTests(): void {
  buckets.clear()
}

function touchLru(map: Map<string, RateBucket>, key: string, value: RateBucket, cap: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > Math.max(1, cap)) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export function unredactedExportActorKey(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const identity = httpCallerIdentity(req)
  const remote = String(req?.socket?.remoteAddress || 'unknown')
  return `${identity.actor}|${remote}`
}

export type UnredactedExportGuardDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

export function evaluateUnredactedExportGuard(
  actorKey: string,
  config: UnredactedExportGuardConfig = DEFAULT_UNREDACTED_EXPORT_GUARD,
  now: number = Date.now(),
): UnredactedExportGuardDecision {
  if (!config.enabled) return { allowed: true }
  const key = actorKey || 'unknown'
  const bucket = buckets.get(key) || { timestamps: [] }
  const windowStart = now - config.windowMs
  bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart)
  if (bucket.timestamps.length >= config.maxRequests) {
    const oldest = bucket.timestamps[0]!
    touchLru(buckets, key, bucket, config.maxTrackedActors)
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000)),
    }
  }
  bucket.timestamps.push(now)
  touchLru(buckets, key, bucket, config.maxTrackedActors)
  return { allowed: true }
}

/**
 * Dual-intent for raw/unredacted admin dumps (JOE-952 uniformity).
 * Callers must pass `localAdmin=true` (or set requireLocalAdmin=false only for
 * explicitly redacted-safe paths). Fail closed with 403 when missing.
 */
export function requireLocalAdminIntent(
  req: { url?: string },
  url: URL = new URL(req.url || '/', 'http://localhost'),
): ReturnType<typeof json> | null {
  if (url.searchParams.get('localAdmin') === 'true') return null
  return json(
    {
      error: 'localAdmin intent required',
      message: 'Raw/unredacted export requires explicit localAdmin=true dual intent in addition to admin capability.',
    },
    403,
  )
}

/**
 * When the request is asking for unredacted/raw data, apply the export guard
 * and return a 429 response body if limited. Returns null when allowed.
 * When `requireLocalAdmin` is true (default for sensitive dumps), also require
 * `localAdmin=true` query dual-intent.
 */
export function guardUnredactedExport(
  req: any,
  options: {
    operation: string
    target: string
    unredacted: boolean
    /** Default true for sensitive dumps; set false only when dual-intent is checked separately. */
    requireLocalAdmin?: boolean
    config?: UnredactedExportGuardConfig
    now?: number
    url?: URL
  },
): ReturnType<typeof json> | null {
  if (!options.unredacted) return null
  const url = options.url || new URL(req?.url || '/', 'http://localhost')
  if (options.requireLocalAdmin !== false) {
    const intent = requireLocalAdminIntent(req, url)
    if (intent) {
      auditHttp(req, options.operation, options.target, 'denied', {
        unredacted: true,
        reason: 'local_admin_required',
      })
      return intent
    }
  }
  const actorKey = unredactedExportActorKey(req)
  const decision = evaluateUnredactedExportGuard(actorKey, options.config, options.now)
  if (decision.allowed) {
    auditHttp(req, options.operation, options.target, 'ok', {
      unredacted: true,
      rateLimitActor: hashActorKey(actorKey),
    })
    return null
  }
  auditHttp(req, options.operation, options.target, 'denied', {
    unredacted: true,
    reason: 'rate_limited',
    retryAfterSeconds: decision.retryAfterSeconds,
    rateLimitActor: hashActorKey(actorKey),
  })
  return json(
    {
      error: 'unredacted export rate limit exceeded',
      message: 'Too many unredacted/raw export requests. Wait and retry, or use redacted exports.',
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    429,
  )
}

function hashActorKey(actorKey: string): string {
  return createHash('sha256').update(actorKey).digest('hex').slice(0, 12)
}
