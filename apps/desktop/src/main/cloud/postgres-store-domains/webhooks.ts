import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import { webhookAuthFailureFromRow } from '../postgres-domains/webhooks.ts'
import type { WorkflowWebhookReplayClaim } from '../../workflow/workflow-webhook-server.ts'

// Webhook-security SQL domain extracted from postgres-control-plane-store.ts. Implements
// the WorkflowWebhookSecurityStore surface for inbound webhooks: fixed-window request
// rate limiting, fail-closed auth backoff, and single-use signature/replay claims (with
// accept/release). The blocked-until timestamp is cast to bigint so the first-failure
// VALUES branch resolves to bigint (epoch-ms exceeds int4). Pure pool + transaction
// access. Behaviour-preserving; covered by the dedicated pglite webhook contract test.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresWebhooksRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
}

export class PostgresWebhooksRepository {
  private readonly options: PostgresWebhooksRepositoryOptions

  constructor(options: PostgresWebhooksRepositoryOptions) {
    this.options = options
  }

  async claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }) {
    const result = await this.options.pool.query(
      `INSERT INTO cloud_webhook_rate_limits (source, window_started_at_ms, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (source) DO UPDATE
       SET window_started_at_ms = CASE
             WHEN $2 - cloud_webhook_rate_limits.window_started_at_ms > $3 THEN $2
             ELSE cloud_webhook_rate_limits.window_started_at_ms
           END,
           count = CASE
             WHEN $2 - cloud_webhook_rate_limits.window_started_at_ms > $3 THEN 1
             ELSE cloud_webhook_rate_limits.count + 1
           END
       RETURNING count`,
      [input.source, input.nowMs, input.windowMs],
    )
    return numberValue(result.rows[0]?.count) <= input.limit
  }

  async checkAuthBackoff(input: { scope: string, nowMs: number }) {
    const row = await this.maybeOne(
      `SELECT blocked_until_ms FROM cloud_webhook_auth_failures WHERE scope = $1`,
      [input.scope],
    )
    return !row || numberValue(row.blocked_until_ms) <= input.nowMs
  }

  async recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }) {
    const blockedUntil = input.nowMs + input.backoffMs
    const result = await this.options.pool.query(
      `INSERT INTO cloud_webhook_auth_failures (
        scope, source, auth_window_started_at_ms, auth_failure_count, blocked_until_ms
       )
       VALUES ($1, $2, $3, 1, CASE WHEN $5 <= 1 THEN $6::bigint ELSE 0 END)
       ON CONFLICT (scope) DO UPDATE
       SET source = EXCLUDED.source,
           auth_window_started_at_ms = CASE
             WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN $3
             ELSE cloud_webhook_auth_failures.auth_window_started_at_ms
           END,
           auth_failure_count = CASE
             WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN 1
             ELSE cloud_webhook_auth_failures.auth_failure_count + 1
           END,
           blocked_until_ms = CASE
             WHEN (
               CASE
                 WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN 1
                 ELSE cloud_webhook_auth_failures.auth_failure_count + 1
               END
             ) >= $5 THEN GREATEST(cloud_webhook_auth_failures.blocked_until_ms, $6)
             ELSE cloud_webhook_auth_failures.blocked_until_ms
           END
       RETURNING *`,
      [input.scope, input.source, input.nowMs, input.windowMs, input.limit, blockedUntil],
    )
    return webhookAuthFailureFromRow(result.rows[0])
  }

  async claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }): Promise<WorkflowWebhookReplayClaim | null> {
    const claimed = await this.options.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM cloud_webhook_replay_claims WHERE $1 - seen_at_ms > $2`,
        [input.nowMs, input.windowMs],
      )
      const result = await client.query(
        `INSERT INTO cloud_webhook_replay_claims (replay_key, seen_at_ms, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (replay_key) DO NOTHING
         RETURNING replay_key`,
        [input.key, input.nowMs],
      )
      await client.query(
        `DELETE FROM cloud_webhook_replay_claims
         WHERE replay_key IN (
           SELECT replay_key
           FROM cloud_webhook_replay_claims
           ORDER BY seen_at_ms ASC
           OFFSET $1
         )`,
        [input.cacheLimit],
      )
      return Boolean(result.rows[0])
    })
    if (!claimed) return null
    let active = true
    return {
      accept: async () => {
        if (!active) return
        active = false
        await this.options.pool.query(
          `UPDATE cloud_webhook_replay_claims
           SET status = 'accepted'
           WHERE replay_key = $1`,
          [input.key],
        )
      },
      release: async () => {
        if (!active) return
        active = false
        await this.options.pool.query(
          `DELETE FROM cloud_webhook_replay_claims
           WHERE replay_key = $1 AND status = 'pending'`,
          [input.key],
        )
      },
    }
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
