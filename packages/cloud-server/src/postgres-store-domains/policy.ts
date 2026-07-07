import { nowIso } from '../postgres-store-id-helpers.ts'
import {
  iso,
  jsonRecord,
  jsonStringArray,
  stringOrNull,
  type QueryResult,
  type QueryRow,
} from '../postgres-domains/shared.ts'
import {
  DEFAULT_MANAGED_POLICY,
  applyManagedPolicyInput,
  effectiveManagedPolicy,
  type ManagedPolicyRecord,
  type SetManagedPolicyInput,
} from '../control-plane-policy.ts'
import type {
  ManagedDesktopPolicy,
  ManagedPolicyExtensionClasses,
  ManagedPolicyKeyManagement,
  ManagedPolicyPermissionCeilings,
} from '@open-cowork/shared'
import type { RecordAuditEventInput } from '../control-plane-store.ts'

// Managed-policy SQL domain: the single org-scoped workspace & desktop policy record
// (cloud_managed_policies), the Postgres peer of the in-memory policy domain. Owns
// get + set (upsert). A set reads the current record inside the transaction, MERGES
// the partial input via the shared pure helper, upserts, and records the audit event
// in the same transaction. Covered by the pglite + real-Postgres contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresManagedPolicyRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

function nullableList(value: unknown): string[] | null {
  return value === null || value === undefined ? null : jsonStringArray(value)
}

export function managedPolicyFromRow(row: QueryRow): ManagedPolicyRecord {
  const fields: ManagedDesktopPolicy = {
    allowedProviders: nullableList(row.allowed_providers),
    deniedProviders: jsonStringArray(row.denied_providers),
    allowedModels: nullableList(row.allowed_models),
    deniedModels: jsonStringArray(row.denied_models),
    keyManagement: String(row.key_management) as ManagedPolicyKeyManagement,
    extensions: jsonRecord(row.extensions) as unknown as ManagedPolicyExtensionClasses,
    features: jsonRecord(row.features) as Record<string, boolean>,
    permissionCeilings: jsonRecord(row.permission_ceilings) as unknown as ManagedPolicyPermissionCeilings,
    updateChannel: stringOrNull(row.update_channel),
  }
  return {
    orgId: String(row.org_id),
    ...fields,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export class PostgresManagedPolicyRepository {
  private readonly options: PostgresManagedPolicyRepositoryOptions

  constructor(options: PostgresManagedPolicyRepositoryOptions) {
    this.options = options
  }

  async getManagedPolicy(orgId: string): Promise<ManagedPolicyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_managed_policies WHERE org_id = $1`,
      [orgId],
    )
    return result.rows[0] ? managedPolicyFromRow(result.rows[0]) : null
  }

  async setManagedPolicy(input: SetManagedPolicyInput): Promise<ManagedPolicyRecord> {
    return this.options.withTransaction(async (client) => {
      const existingResult = await client.query(
        `SELECT * FROM cloud_managed_policies WHERE org_id = $1 FOR UPDATE`,
        [input.orgId],
      )
      const existing = existingResult.rows[0] ? managedPolicyFromRow(existingResult.rows[0]) : null
      const base = existing ? effectiveManagedPolicy(existing) : DEFAULT_MANAGED_POLICY
      const fields = applyManagedPolicyInput(base, input)
      const now = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_managed_policies (
           org_id, allowed_providers, denied_providers, allowed_models, denied_models,
           key_management, extensions, features, permission_ceilings, update_channel,
           created_at, updated_at
         ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $11)
         ON CONFLICT (org_id) DO UPDATE SET
           allowed_providers = EXCLUDED.allowed_providers,
           denied_providers = EXCLUDED.denied_providers,
           allowed_models = EXCLUDED.allowed_models,
           denied_models = EXCLUDED.denied_models,
           key_management = EXCLUDED.key_management,
           extensions = EXCLUDED.extensions,
           features = EXCLUDED.features,
           permission_ceilings = EXCLUDED.permission_ceilings,
           update_channel = EXCLUDED.update_channel,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.orgId,
          fields.allowedProviders === null ? null : JSON.stringify(fields.allowedProviders),
          JSON.stringify(fields.deniedProviders),
          fields.allowedModels === null ? null : JSON.stringify(fields.allowedModels),
          JSON.stringify(fields.deniedModels),
          fields.keyManagement,
          JSON.stringify(fields.extensions),
          JSON.stringify(fields.features),
          JSON.stringify(fields.permissionCeilings),
          fields.updateChannel,
          now,
        ],
      )
      const record = managedPolicyFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'managed_policy.updated',
        targetType: 'managed_policy',
        targetId: input.orgId,
        metadata: {
          keyManagement: record.keyManagement,
          permissionCeilings: record.permissionCeilings,
          extensions: record.extensions,
          allowedProviders: record.allowedProviders,
          deniedProviders: record.deniedProviders,
          allowedModels: record.allowedModels,
          deniedModels: record.deniedModels,
          features: record.features,
          updateChannel: record.updateChannel,
        },
        createdAt: input.updatedAt,
      })
      return record
    })
  }
}
