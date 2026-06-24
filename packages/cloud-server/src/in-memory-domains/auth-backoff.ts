import { clone, normalizePositiveInteger } from './store-helpers.ts'
import type {
  CheckCloudAuthBackoffInput,
  CloudAuthBackoffRecord,
  RecordCloudAuthFailureInput,
} from '../control-plane-store.ts'

// Cloud auth-backoff domain extracted from in-memory-control-plane-store.ts. Owns
// the per-scope failure counters + windows, and the check (is this scope blocked?)
// / record-failure (increment, window-roll, block) logic. No host — no cross-domain
// dependencies. Behaviour-preserving; covered by the cloud-http-server auth suite.

export class InMemoryAuthBackoffDomain {
  private readonly authFailures = new Map<string, CloudAuthBackoffRecord>()
  private readonly authFailureWindows = new Map<string, number>()

  checkCloudAuthBackoff(input: CheckCloudAuthBackoffInput): CloudAuthBackoffRecord {
    const nowMs = (input.now || new Date()).getTime()
    const existing = this.authFailures.get(input.scope)
    return {
      allowed: !existing || existing.blockedUntilMs <= nowMs,
      scope: input.scope,
      source: input.source || existing?.source || input.scope,
      failureCount: existing?.failureCount || 0,
      blockedUntilMs: existing?.blockedUntilMs || 0,
      retryAfterMs: existing ? Math.max(0, existing.blockedUntilMs - nowMs) : 0,
    }
  }

  recordCloudAuthFailure(input: RecordCloudAuthFailureInput): CloudAuthBackoffRecord {
    const windowMs = normalizePositiveInteger(input.windowMs, 'Auth backoff window')
    const limit = normalizePositiveInteger(input.limit, 'Auth failure limit')
    const backoffMs = normalizePositiveInteger(input.backoffMs, 'Auth backoff duration')
    const nowMs = (input.now || new Date()).getTime()
    const existing = this.authFailures.get(input.scope)
    const currentWindowStartedAtMs = windowStart(nowMs, windowMs)
    const existingWindowStartedAtMs = this.authFailureWindows.get(input.scope)
    const failureCount = existing && existingWindowStartedAtMs === currentWindowStartedAtMs
      ? existing.failureCount + 1
      : 1
    const blockedUntilMs = failureCount >= limit
      ? Math.max(existing?.blockedUntilMs || 0, nowMs + backoffMs)
      : existing?.blockedUntilMs || 0
    const record: CloudAuthBackoffRecord = {
      allowed: blockedUntilMs <= nowMs,
      scope: input.scope,
      source: input.source,
      failureCount,
      blockedUntilMs,
      retryAfterMs: Math.max(0, blockedUntilMs - nowMs),
    }
    this.authFailures.set(input.scope, record)
    this.authFailureWindows.set(input.scope, currentWindowStartedAtMs)
    return clone(record)
  }
}

function windowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}
