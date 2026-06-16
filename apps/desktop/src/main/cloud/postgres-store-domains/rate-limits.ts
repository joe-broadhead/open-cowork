import { normalizePositiveInteger, retryAfterMs, windowStart } from '../postgres-store-normalizers.ts'
import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import type { ClaimRateLimitInput } from '../control-plane-store.ts'

// Rate-limit SQL domain extracted from postgres-control-plane-store.ts. Owns the
// fixed-window per-(scope,source) counter — an atomic upsert that resets the window
// or increments the count, returning the allow/deny verdict + retry hint. Pure pool
// access, no other coupling. Behaviour-preserving; covered by the pglite +
// real-Postgres control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresRateLimitsRepositoryOptions = {
  pool: PgExecutor
}

export class PostgresRateLimitsRepository {
  private readonly options: PostgresRateLimitsRepositoryOptions

  constructor(options: PostgresRateLimitsRepositoryOptions) {
    this.options = options
  }

  async claimRateLimit(input: ClaimRateLimitInput) {
    const limit = normalizePositiveInteger(input.limit, 'Rate limit')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Rate-limit window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    const result = await this.options.pool.query(
      `INSERT INTO cloud_rate_limits (scope, source, window_started_at_ms, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (scope, source) DO UPDATE
       SET window_started_at_ms = CASE
             WHEN cloud_rate_limits.window_started_at_ms = $3 THEN cloud_rate_limits.window_started_at_ms
             ELSE $3
           END,
           count = CASE
             WHEN cloud_rate_limits.window_started_at_ms = $3 THEN cloud_rate_limits.count + 1
             ELSE 1
           END
       RETURNING count, window_started_at_ms`,
      [input.scope, input.source, startedAtMs],
    )
    const count = numberValue(result.rows[0]?.count)
    const resetMs = retryAfterMs(nowMs, numberValue(result.rows[0]?.window_started_at_ms), windowMs)
    return {
      allowed: count <= limit,
      scope: input.scope,
      source: input.source,
      limit,
      count,
      resetAt: new Date(nowMs + resetMs).toISOString(),
      retryAfterMs: resetMs,
      policyCode: input.policyCode,
    }
  }
}
