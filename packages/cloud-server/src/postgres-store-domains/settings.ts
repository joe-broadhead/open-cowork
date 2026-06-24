import { nowIso } from '../postgres-store-id-helpers.ts'
import { settingFromRow } from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'

// Setting-metadata SQL domain extracted from postgres-control-plane-store.ts. Owns the
// tenant-scoped and user-scoped key/value settings (upsert keyed on
// tenant+user_scope+key, get, list). Tenant + tenant-user existence checks arrive via
// the injected host (requireTenant / requireTenantUser, store-wide). Behaviour-
// preserving; covered by the pglite + real-Postgres control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresSettingsRepositoryOptions = {
  pool: PgExecutor
  requireTenant(tenantId: string): Promise<unknown>
  requireTenantUser(tenantId: string, userId: string): Promise<unknown>
}

export class PostgresSettingsRepository {
  private readonly options: PostgresSettingsRepositoryOptions

  constructor(options: PostgresSettingsRepositoryOptions) {
    this.options = options
  }

  async setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }) {
    await this.options.requireTenant(input.tenantId)
    if (input.userId) await this.options.requireTenantUser(input.tenantId, input.userId)
    const result = await this.options.pool.query(
      `INSERT INTO cloud_setting_metadata (
        tenant_id, user_scope, user_id, key, value, updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (tenant_id, user_scope, key) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.tenantId,
        input.userId || '',
        input.userId || null,
        input.key,
        JSON.stringify(input.value),
        nowIso(input.updatedAt),
      ],
    )
    return settingFromRow(result.rows[0]!)
  }

  async getSettingMetadata(tenantId: string, keyName: string, userId?: string | null) {
    await this.options.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_setting_metadata
       WHERE tenant_id = $1 AND user_scope = $2 AND key = $3`,
      [tenantId, userId || '', keyName],
    )
    return row ? settingFromRow(row) : null
  }

  async listSettingMetadata(tenantId: string, userId?: string | null) {
    await this.options.requireTenant(tenantId)
    if (userId) await this.options.requireTenantUser(tenantId, userId)
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_setting_metadata
       WHERE tenant_id = $1 AND user_scope = $2
       ORDER BY key`,
      [tenantId, userId || ''],
    )
    return result.rows.map(settingFromRow)
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
