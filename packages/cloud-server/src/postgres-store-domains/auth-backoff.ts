import { normalizePositiveInteger, windowStart } from '../postgres-store-normalizers.ts'
import { cloudAuthBackoffFromRow } from '../postgres-domains/identity.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type { RecordCloudAuthFailureInput } from '../control-plane-store.ts'

// Auth-backoff SQL domain extracted from postgres-control-plane-store.ts. Owns the
// fail-closed authentication backoff per scope — check the current block state, and
// record a failure that opens/extends a block once the windowed failure count crosses
// the limit. The blocked_until timestamp is cast to bigint so the first-failure VALUES
// branch resolves to bigint (epoch-ms exceeds int4; PostgreSQL CASE type-resolution
// would otherwise unify with the `0` literal). Pure pool access. Behaviour-preserving;
// covered by the pglite + real-Postgres control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresAuthBackoffRepositoryOptions = {
  pool: PgExecutor
}

export class PostgresAuthBackoffRepository {
  private readonly options: PostgresAuthBackoffRepositoryOptions

  constructor(options: PostgresAuthBackoffRepositoryOptions) {
    this.options = options
  }

  async checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }) {
    const nowMs = (input.now || new Date()).getTime()
    const row = await this.maybeOne(
      `SELECT * FROM cloud_auth_failures WHERE scope = $1`,
      [input.scope],
    )
    if (!row) {
      return {
        allowed: true,
        scope: input.scope,
        source: input.source || input.scope,
        failureCount: 0,
        blockedUntilMs: 0,
        retryAfterMs: 0,
      }
    }
    return cloudAuthBackoffFromRow(row, nowMs)
  }

  async recordCloudAuthFailure(input: RecordCloudAuthFailureInput) {
    const nowMs = (input.now || new Date()).getTime()
    const windowMs = normalizePositiveInteger(input.windowMs, 'Auth backoff window')
    const limit = normalizePositiveInteger(input.limit, 'Auth failure limit')
    const backoffMs = normalizePositiveInteger(input.backoffMs, 'Auth backoff duration')
    const startedAtMs = windowStart(nowMs, windowMs)
    const blockedUntilMs = nowMs + backoffMs
    const result = await this.options.pool.query(
      `INSERT INTO cloud_auth_failures (
        scope, source, auth_window_started_at_ms, auth_failure_count, blocked_until_ms
       )
       VALUES ($1, $2, $3, 1, CASE WHEN $4 <= 1 THEN $5::bigint ELSE 0 END)
       ON CONFLICT (scope) DO UPDATE
       SET source = EXCLUDED.source,
           auth_window_started_at_ms = CASE
             WHEN cloud_auth_failures.auth_window_started_at_ms = $3 THEN cloud_auth_failures.auth_window_started_at_ms
             ELSE $3
           END,
           auth_failure_count = CASE
             WHEN cloud_auth_failures.auth_window_started_at_ms = $3 THEN cloud_auth_failures.auth_failure_count + 1
             ELSE 1
           END,
           blocked_until_ms = CASE
             WHEN (
               CASE
                 WHEN cloud_auth_failures.auth_window_started_at_ms = $3 THEN cloud_auth_failures.auth_failure_count + 1
                 ELSE 1
               END
             ) >= $4 THEN GREATEST(cloud_auth_failures.blocked_until_ms, $5)
             ELSE cloud_auth_failures.blocked_until_ms
           END
       RETURNING *`,
      [input.scope, input.source, startedAtMs, limit, blockedUntilMs],
    )
    return cloudAuthBackoffFromRow(result.rows[0]!, nowMs)
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
