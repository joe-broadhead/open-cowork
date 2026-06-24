import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeNullableText, normalizeRecord, normalizeText } from '../postgres-store-normalizers.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import { channelBindingFromRow } from '../postgres-domains/channels.ts'
import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import {
  ControlPlaneQuotaExceededError,
  type CreateChannelBindingInput,
  type RecordAuditEventInput,
  type UpdateChannelBindingInput,
} from '../control-plane-store.ts'

// Channel-binding SQL domain extracted from postgres-control-plane-store.ts. Owns the
// agent↔provider-channel binding records (create with the per-org gateway-binding
// quota gate, update, get, list). Quota locking + audit recording + the transaction
// runner arrive via the injected host (the store keeps lockQuota, shared with the
// usage-quota path). Behaviour-preserving; covered by the pglite + real-Postgres
// control-plane contract suites (including the quota-exceeded rejection).

const CHANNEL_TEXT_MAX_LENGTH = 256

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresChannelBindingsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
  lockQuota(executor: PgExecutor, orgId: string, quotaKey: string, now?: Date): Promise<unknown>
}

export class PostgresChannelBindingsRepository {
  private readonly options: PostgresChannelBindingsRepositoryOptions

  constructor(options: PostgresChannelBindingsRepositoryOptions) {
    this.options = options
  }

  async createChannelBinding(input: CreateChannelBindingInput) {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.createdAt)
      const bindingLimit = input.quota?.maxGatewayChannelBindingsPerOrg
      if (bindingLimit && bindingLimit > 0) {
        await this.options.lockQuota(client, input.orgId, 'gateway_channel_bindings')
        const countRow = await this.one(
          `SELECT count(*)::int AS count
           FROM cloud_channel_bindings
           WHERE org_id = $1 AND status <> 'disabled'`,
          [input.orgId],
          client,
        )
        const activeBindings = numberValue(countRow.count)
        if (activeBindings >= bindingLimit) {
          throw new ControlPlaneQuotaExceededError({
            message: 'Gateway channel binding quota exceeded.',
            policyCode: input.quota?.policyCode || 'quota.gateway_channel_bindings_exceeded',
            retryAfterMs: 60_000,
            limit: bindingLimit,
            used: activeBindings,
            resetAt: new Date(Date.now() + 60_000).toISOString(),
          })
        }
      }
      const result = await client.query(
        `INSERT INTO cloud_channel_bindings (
          binding_id, org_id, agent_id, provider, external_workspace_id,
          display_name, status, credential_ref, settings, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
         ON CONFLICT (binding_id) DO NOTHING
         RETURNING *`,
        [
          normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
          input.orgId,
          input.agentId,
          normalizeProvider(input.provider),
          normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
          normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
          input.status || 'active',
          normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
          JSON.stringify(normalizeRecord(input.settings, 'Channel binding settings')),
          now,
        ],
      )
      const row = result.rows[0] || await this.one(
        `SELECT * FROM cloud_channel_bindings WHERE org_id = $1 AND binding_id = $2`,
        [input.orgId, input.bindingId],
        client,
      )
      const binding = channelBindingFromRow(row)
      if (result.rows[0]) {
        await this.options.recordAuditEvent(client, {
          orgId: binding.orgId,
          actorType: 'system',
          actorId: 'channel_binding.create',
          eventType: 'channel_binding.created',
          targetType: 'channel_binding',
          targetId: binding.bindingId,
          metadata: { provider: binding.provider, displayName: binding.displayName, credentialRefConfigured: Boolean(binding.credentialRef) },
          createdAt: input.createdAt,
        })
      }
      return binding
    })
  }

  async updateChannelBinding(input: UpdateChannelBindingInput) {
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE cloud_channel_bindings
         SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
             status = COALESCE($5, status),
             credential_ref = CASE WHEN $6::boolean THEN $7 ELSE credential_ref END,
             settings = CASE WHEN $8::boolean THEN $9::jsonb ELSE settings END,
             updated_at = $10
         WHERE org_id = $1 AND binding_id = $2
         RETURNING *`,
        [
          input.orgId,
          input.bindingId,
          input.displayName !== undefined,
          input.displayName === undefined ? null : normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
          input.status || null,
          input.credentialRef !== undefined,
          input.credentialRef === undefined ? null : normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
          input.settings !== undefined,
          input.settings === undefined ? null : JSON.stringify(normalizeRecord(input.settings, 'Channel binding settings')),
          nowIso(input.updatedAt),
        ],
      )
      if (!result.rows[0]) return null
      const binding = channelBindingFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'channel_binding.updated',
        targetType: 'channel_binding',
        targetId: binding.bindingId,
        metadata: {
          provider: binding.provider,
          displayName: binding.displayName,
          status: binding.status,
          credentialRefConfigured: Boolean(binding.credentialRef),
          settingsChanged: input.settings !== undefined,
        },
        createdAt: input.updatedAt,
      })
      return binding
    })
  }

  async getChannelBinding(orgId: string, bindingId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_bindings WHERE org_id = $1 AND binding_id = $2`, [orgId, bindingId])
    return row ? channelBindingFromRow(row) : null
  }

  async listChannelBindings(orgId: string, agentId?: string | null) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_channel_bindings
       WHERE org_id = $1 AND ($2::text IS NULL OR agent_id = $2)
       ORDER BY updated_at DESC, binding_id
       LIMIT 1000`,
      [orgId, agentId || null],
    )
    return result.rows.map(channelBindingFromRow)
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

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
