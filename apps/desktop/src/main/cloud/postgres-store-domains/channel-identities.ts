import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeNullableText, normalizeRecord, normalizeText } from '../postgres-store-normalizers.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import { channelIdentityFromRow } from '../postgres-domains/channels.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  ChannelProviderId,
  ListChannelIdentitiesInput,
  UpsertChannelIdentityInput,
} from '../control-plane-store.ts'

// Channel-identity SQL domain extracted from postgres-control-plane-store.ts. Owns
// the per-org provider-identity records (upsert keyed on org+provider+workspace+user,
// get / list / find). Pure CRUD over cloud_channel_identities — no session, command,
// audit, or transaction coupling — reached only through the injected pool.
// Behaviour-preserving; covered by the pglite + real-Postgres control-plane contracts.

const CHANNEL_TEXT_MAX_LENGTH = 256

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresChannelIdentitiesRepositoryOptions = {
  pool: PgExecutor
}

export class PostgresChannelIdentitiesRepository {
  private readonly options: PostgresChannelIdentitiesRepositoryOptions

  constructor(options: PostgresChannelIdentitiesRepositoryOptions) {
    this.options = options
  }

  async upsertChannelIdentity(input: UpsertChannelIdentityInput) {
    const now = nowIso(input.updatedAt)
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const result = await this.options.pool.query(
      `INSERT INTO cloud_channel_identities (
        identity_id, org_id, provider, external_workspace_id, external_user_id,
        account_id, role, status, metadata, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
       ON CONFLICT (org_id, provider, (COALESCE(external_workspace_id, '')), external_user_id) DO UPDATE
       SET account_id = CASE
             WHEN EXCLUDED.account_id IS NOT NULL THEN EXCLUDED.account_id
             ELSE cloud_channel_identities.account_id
           END,
           role = EXCLUDED.role,
           status = EXCLUDED.status,
           metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.identityId || `chid_${provider}_${externalUserId}`,
        input.orgId,
        provider,
        externalWorkspaceId,
        externalUserId,
        input.accountId || null,
        input.role || 'viewer',
        input.status || 'pending',
        JSON.stringify(normalizeRecord(input.metadata, 'Channel identity metadata')),
        now,
      ],
    )
    return channelIdentityFromRow(result.rows[0])
  }

  async getChannelIdentity(orgId: string, identityId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_identities WHERE org_id = $1 AND identity_id = $2`, [orgId, identityId])
    return row ? channelIdentityFromRow(row) : null
  }

  async listChannelIdentities(orgId: string, input: ListChannelIdentitiesInput = {}) {
    const provider = input.provider ? normalizeProvider(input.provider) : null
    const externalWorkspaceIdSpecified = input.externalWorkspaceId !== undefined
    const externalWorkspaceId = externalWorkspaceIdSpecified
      ? normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
      : null
    const role = input.role && ['owner', 'admin', 'member', 'approver', 'viewer'].includes(input.role)
      ? input.role
      : null
    const status = input.status && ['active', 'disabled', 'pending'].includes(input.status)
      ? input.status
      : null
    const limit = Number.isInteger(input.limit) && Number(input.limit) > 0
      ? Math.min(Number(input.limit), 500)
      : 100
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_channel_identities
       WHERE org_id = $1
         AND ($2::text IS NULL OR provider = $2)
         AND ($3::boolean = false OR COALESCE(external_workspace_id, '') = COALESCE($4, ''))
         AND ($5::text IS NULL OR role = $5)
         AND ($6::text IS NULL OR status = $6)
       ORDER BY updated_at DESC, identity_id
       LIMIT $7`,
      [orgId, provider, externalWorkspaceIdSpecified, externalWorkspaceId, role, status, limit],
    )
    return result.rows.map(channelIdentityFromRow)
  }

  async findChannelIdentity(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalUserId: string }) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_identities
       WHERE org_id = $1
         AND provider = $2
         AND COALESCE(external_workspace_id, '') = COALESCE($3, '')
         AND external_user_id = $4`,
      [
        input.orgId,
        normalizeProvider(input.provider),
        normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
        normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id'),
      ],
    )
    return row ? channelIdentityFromRow(row) : null
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
