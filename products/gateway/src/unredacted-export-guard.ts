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
 * When the request is asking for unredacted/raw data, apply the export guard
 * and return a 429 response body if limited. Returns null when allowed.
 */
export function guardUnredactedExport(
  req: any,
  options: {
    operation: string
    target: string
    unredacted: boolean
    config?: UnredactedExportGuardConfig
    now?: number
  },
): ReturnType<typeof json> | null {
  if (!options.unredacted) return null
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
