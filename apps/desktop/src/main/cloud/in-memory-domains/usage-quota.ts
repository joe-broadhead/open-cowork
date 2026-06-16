import { clone, key, normalizePositiveInteger } from './store-helpers.ts'
import type {
  ConsumeUsageQuotaInput,
  QuotaConsumptionRecord,
  UsageQuotaCounterRecord,
} from '../control-plane-store.ts'

// Usage-quota (metering) domain extracted from in-memory-control-plane-store.ts.
// Owns the per-window usage counters and the consume (sliding-window increment +
// allow/deny) / list logic. Org existence arrives via the host. The snapshot /
// restore accessors let the command-queue enqueue path consume usage quota
// transactionally (roll the counters back if the enqueue fails). Behaviour-
// preserving; covered by the cloud-http-server usage-quota suite.

type UsageCounter = { windowStartedAtMs: number, quantity: number }

type InMemoryUsageQuotaHost = {
  orgExists(orgId: string): boolean
}

export class InMemoryUsageQuotaDomain {
  private readonly usageCounters = new Map<string, UsageCounter>()
  private readonly host: InMemoryUsageQuotaHost

  constructor(host: InMemoryUsageQuotaHost) {
    this.host = host
  }

  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const limit = normalizePositiveInteger(input.limit, 'Quota limit')
    const quantity = normalizePositiveInteger(input.quantity || 1, 'Quota quantity')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Quota window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    const counterKey = key(input.orgId, input.quotaKey)
    const existing = this.usageCounters.get(counterKey)
    const current = existing && existing.windowStartedAtMs === startedAtMs ? existing.quantity : 0
    const next = current + quantity
    const retryAfterMs = quotaRetryAfterMs(nowMs, startedAtMs, windowMs)
    const resetAt = new Date(nowMs + retryAfterMs).toISOString()
    if (next > limit) {
      return {
        allowed: false,
        orgId: input.orgId,
        quotaKey: input.quotaKey,
        limit,
        used: current,
        remaining: Math.max(0, limit - current),
        resetAt,
        retryAfterMs,
        policyCode: input.policyCode,
      }
    }
    this.usageCounters.set(counterKey, { windowStartedAtMs: startedAtMs, quantity: next })
    return {
      allowed: true,
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      used: next,
      remaining: Math.max(0, limit - next),
      resetAt,
      retryAfterMs,
      policyCode: input.policyCode,
    }
  }

  listUsageQuotaCounters(orgId: string): UsageQuotaCounterRecord[] {
    if (!this.host.orgExists(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.usageCounters.entries())
      .map(([counterKey, counter]) => {
        const [counterOrgId, quotaKey] = counterKey.split('\0', 2)
        return {
          orgId: counterOrgId,
          quotaKey,
          windowStartedAtMs: counter.windowStartedAtMs,
          quantity: counter.quantity,
        }
      })
      .filter((counter) => counter.orgId === orgId)
      .sort((left, right) => left.quotaKey.localeCompare(right.quotaKey))
      .map((counter) => clone(counter))
  }

  snapshotCounters(): Map<string, UsageCounter> {
    return new Map(this.usageCounters)
  }

  restoreCounters(snapshot: Map<string, UsageCounter>): void {
    this.usageCounters.clear()
    for (const [counterKey, counter] of snapshot) this.usageCounters.set(counterKey, counter)
  }
}

function windowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}

function quotaRetryAfterMs(nowMs: number, startedAtMs: number, windowMs: number) {
  return Math.max(1, startedAtMs + windowMs - nowMs)
}
