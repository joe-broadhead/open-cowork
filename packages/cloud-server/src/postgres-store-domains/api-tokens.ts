import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeText } from '../postgres-store-normalizers.ts'
import { apiTokenChannelBindingGrantFromRow, apiTokenFromRow } from '../postgres-domains/identity.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import { generateCloudApiToken, hashCloudApiToken, verifyCloudApiTokenHash } from '../control-plane-tokens.ts'
import type {
  ApiTokenChannelBindingGrantRecord,
  GrantApiTokenChannelBindingInput,
  IssueApiTokenInput,
  IssuedApiTokenRecord,
  ListApiTokenChannelBindingGrantsInput,
  RecordAuditEventInput,
  RevokeApiTokenInput,
} from '../control-plane-store.ts'

// API-token SQL domain extracted from postgres-control-plane-store.ts. Owns the
// org API-token lifecycle — issue (hash-at-rest, plaintext returned once), resolve a
// presented plaintext to its token (constant-work hash verify over the prefix-matched
// candidates, fail-closed on revoked/expired), list, revoke, and the per-binding
// grant create/list. Audit recording + the transaction runner arrive via the injected
// host. Behaviour-preserving; covered by the pglite + real-Postgres control-plane
// contract suites (issue → resolve → grant → revoke → resolve-fails-closed).

const API_TOKEN_NAME_MAX_LENGTH = 96

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresApiTokensRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

export class PostgresApiTokensRepository {
  private readonly options: PostgresApiTokensRepositoryOptions

  constructor(options: PostgresApiTokensRepositoryOptions) {
    this.options = options
  }

  async issueApiToken(input: IssueApiTokenInput): Promise<IssuedApiTokenRecord> {
    return this.options.withTransaction(async (client) => {
      const generated = generateCloudApiToken(input)
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_api_tokens (
          token_id, org_id, account_id, name, token_hash, scopes, last4,
          expires_at, revoked_at, last_used_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NULL, NULL, $9, $9)
         RETURNING *`,
        [
          generated.tokenId,
          input.orgId,
          input.accountId || null,
          normalizeText(input.name, API_TOKEN_NAME_MAX_LENGTH, 'API token name'),
          hashCloudApiToken(generated.plaintext),
          JSON.stringify([...new Set(input.scopes)]),
          generated.plaintext.slice(-4),
          input.expiresAt ? input.expiresAt.toISOString() : null,
          now,
        ],
      )
      const token = apiTokenFromRow(result.rows[0]!)
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'api_token.created',
        targetType: 'api_token',
        targetId: token.tokenId,
        metadata: { name: token.name, scopes: token.scopes, last4: token.last4 },
        createdAt: input.createdAt,
      })
      return { token, plaintext: generated.plaintext }
    })
  }

  async findApiTokenByPlaintext(plaintext: string, now = new Date()) {
    const nowText = nowIso(now)
    // Fast path: standard tokens are `occ_<tokenId>_<secret>` with a fixed-shape
    // `tok_`+16-base64url id, so resolve by primary key (index seek) instead of
    // scanning every live token across all orgs on the auth hot path. The hash is
    // still verified below, so a forged/guessed id cannot authenticate. A token whose
    // id doesn't match the standard shape (legacy/custom) falls back to the prior scan.
    const standardTokenId = /^occ_(tok_[A-Za-z0-9_-]{16})_/.exec(plaintext)?.[1]
    const candidates = standardTokenId
      ? await this.options.pool.query(
        `SELECT *
         FROM cloud_api_tokens
         WHERE token_id = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > $2)`,
        [standardTokenId, nowText],
      )
      : await this.options.pool.query(
        `SELECT *
         FROM cloud_api_tokens
         WHERE left($1, length('occ_' || token_id || '_')) = ('occ_' || token_id || '_')
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > $2)
         ORDER BY created_at DESC`,
        [plaintext, nowText],
      )
    const matched = candidates.rows.find((row) => verifyCloudApiTokenHash(plaintext, String(row.token_hash)))
    if (!matched) return null
    const result = await this.options.pool.query(
      `UPDATE cloud_api_tokens
       SET last_used_at = $2, updated_at = $2
       WHERE token_id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)
       RETURNING *`,
      [String(matched.token_id), nowText],
    )
    return result.rows[0] ? apiTokenFromRow(result.rows[0]) : null
  }

  async listApiTokens(orgId: string) {
    const result = await this.options.pool.query(
      `SELECT *
       FROM cloud_api_tokens
       WHERE org_id = $1
       ORDER BY created_at DESC`,
      [orgId],
    )
    return result.rows.map(apiTokenFromRow)
  }

  async revokeApiToken(input: RevokeApiTokenInput) {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.revokedAt)
      const result = await client.query(
        `UPDATE cloud_api_tokens
         SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
         WHERE token_id = $1
           AND ($3::text IS NULL OR org_id = $3)
         RETURNING *`,
        [input.tokenId, now, input.orgId || null],
      )
      if (!result.rows[0]) return null
      const token = apiTokenFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: token.orgId,
        accountId: token.accountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'api_token.revoked',
        targetType: 'api_token',
        targetId: token.tokenId,
        metadata: { name: token.name, scopes: token.scopes, last4: token.last4 },
        createdAt: input.revokedAt,
      })
      return token
    })
  }

  async grantApiTokenChannelBinding(input: GrantApiTokenChannelBindingInput): Promise<ApiTokenChannelBindingGrantRecord> {
    return this.options.withTransaction(async (client) => {
      const tokenRow = await this.maybeOne(
        `SELECT * FROM cloud_api_tokens WHERE org_id = $1 AND token_id = $2`,
        [input.orgId, input.tokenId],
        client,
      )
      if (!tokenRow) throw new Error(`Unknown API token ${input.tokenId}.`)
      const bindingRow = await this.maybeOne(
        `SELECT * FROM cloud_channel_bindings WHERE org_id = $1 AND binding_id = $2`,
        [input.orgId, input.channelBindingId],
        client,
      )
      if (!bindingRow) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
      const createdAt = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_api_token_channel_binding_grants (
          org_id, token_id, channel_binding_id, created_at
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, token_id, channel_binding_id) DO NOTHING
         RETURNING *`,
        [input.orgId, input.tokenId, input.channelBindingId, createdAt],
      )
      const row = result.rows[0] || await this.one(
        `SELECT * FROM cloud_api_token_channel_binding_grants
         WHERE org_id = $1 AND token_id = $2 AND channel_binding_id = $3`,
        [input.orgId, input.tokenId, input.channelBindingId],
        client,
      )
      if (result.rows[0]) {
        const token = apiTokenFromRow(tokenRow)
        await this.options.recordAuditEvent(client, {
          orgId: input.orgId,
          accountId: input.actor?.accountId || token.accountId,
          actorType: input.actor?.actorType || 'system',
          actorId: input.actor?.actorId || null,
          eventType: 'api_token.channel_binding_granted',
          targetType: 'api_token',
          targetId: input.tokenId,
          metadata: { channelBindingId: input.channelBindingId },
          createdAt: input.createdAt,
        })
      }
      return apiTokenChannelBindingGrantFromRow(row)
    })
  }

  async listApiTokenChannelBindingGrants(input: ListApiTokenChannelBindingGrantsInput): Promise<ApiTokenChannelBindingGrantRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_api_token_channel_binding_grants
       WHERE org_id = $1 AND token_id = $2
       ORDER BY channel_binding_id`,
      [input.orgId, input.tokenId],
    )
    return result.rows.map(apiTokenChannelBindingGrantFromRow)
  }

  private async one<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }
}
