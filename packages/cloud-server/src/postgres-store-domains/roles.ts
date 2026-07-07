import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeText, normalizeNullableText } from '../postgres-store-normalizers.ts'
import { iso, jsonStringArray, stringOrNull, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import {
  normalizeControlPlanePermissions,
  normalizeCustomRoleKey,
  type ControlPlanePermission,
  type CreateCustomRoleInput,
  type CustomRoleRecord,
  type UpdateCustomRoleInput,
} from '../control-plane-permissions.ts'
import type { ControlPlaneRole, RecordAuditEventInput } from '../control-plane-store.ts'

// Custom-roles SQL domain: the org-defined named permission maps (cloud_custom_roles),
// the Postgres peer of the in-memory roles domain. Owns create/list/get/update/delete.
// Audit recording + the transaction runner arrive via the injected host. Covered by the
// pglite + real-Postgres control-plane contract suites.

const ROLE_NAME_MAX_LENGTH = 96
const ROLE_DESCRIPTION_MAX_LENGTH = 512

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresRolesRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

function normalizeBaseRole(role: ControlPlaneRole | null | undefined): ControlPlaneRole {
  return role === 'owner' || role === 'admin' ? role : 'member'
}

export function customRoleFromRow(row: QueryRow): CustomRoleRecord {
  return {
    orgId: String(row.org_id),
    roleKey: String(row.role_key),
    name: String(row.name),
    description: stringOrNull(row.description),
    baseRole: String(row.base_role) as ControlPlaneRole,
    permissions: normalizeControlPlanePermissions(jsonStringArray(row.permissions) as ControlPlanePermission[]),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export class PostgresRolesRepository {
  private readonly options: PostgresRolesRepositoryOptions

  constructor(options: PostgresRolesRepositoryOptions) {
    this.options = options
  }

  async createCustomRole(input: CreateCustomRoleInput): Promise<CustomRoleRecord> {
    return this.options.withTransaction(async (client) => {
      const roleKey = normalizeCustomRoleKey(input.roleKey)
      const name = normalizeText(input.name, ROLE_NAME_MAX_LENGTH, 'Custom role name')
      const description = normalizeNullableText(input.description, ROLE_DESCRIPTION_MAX_LENGTH, 'Custom role description')
      const baseRole = normalizeBaseRole(input.baseRole)
      const permissions = normalizeControlPlanePermissions(input.permissions)
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_custom_roles (org_id, role_key, name, description, base_role, permissions, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
         ON CONFLICT (org_id, role_key) DO NOTHING
         RETURNING *`,
        [input.orgId, roleKey, name, description, baseRole, JSON.stringify(permissions), now],
      )
      if (!result.rows[0]) throw new Error(`Custom role ${roleKey} already exists.`)
      const record = customRoleFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'custom_role.created',
        targetType: 'custom_role',
        targetId: roleKey,
        metadata: { name: record.name, baseRole: record.baseRole, permissions: record.permissions },
        createdAt: input.createdAt,
      })
      return record
    })
  }

  async listCustomRoles(orgId: string): Promise<CustomRoleRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_custom_roles WHERE org_id = $1 ORDER BY role_key`,
      [orgId],
    )
    return result.rows.map(customRoleFromRow)
  }

  async getCustomRole(orgId: string, roleKey: string): Promise<CustomRoleRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_custom_roles WHERE org_id = $1 AND role_key = $2`,
      [orgId, roleKey],
    )
    return result.rows[0] ? customRoleFromRow(result.rows[0]) : null
  }

  async updateCustomRole(input: UpdateCustomRoleInput): Promise<CustomRoleRecord | null> {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.updatedAt)
      const name = input.name === undefined || input.name === null
        ? null
        : normalizeText(input.name, ROLE_NAME_MAX_LENGTH, 'Custom role name')
      const description = input.description === undefined
        ? undefined
        : normalizeNullableText(input.description, ROLE_DESCRIPTION_MAX_LENGTH, 'Custom role description')
      const baseRole = input.baseRole === undefined || input.baseRole === null ? null : normalizeBaseRole(input.baseRole)
      const permissions = input.permissions === undefined || input.permissions === null
        ? null
        : normalizeControlPlanePermissions(input.permissions)
      const result = await client.query(
        `UPDATE cloud_custom_roles
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             base_role = COALESCE($6, base_role),
             permissions = COALESCE($7::jsonb, permissions),
             updated_at = $8
         WHERE org_id = $1 AND role_key = $2
         RETURNING *`,
        [
          input.orgId,
          input.roleKey,
          name,
          description !== undefined,
          description ?? null,
          baseRole,
          permissions ? JSON.stringify(permissions) : null,
          now,
        ],
      )
      if (!result.rows[0]) return null
      const record = customRoleFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'custom_role.updated',
        targetType: 'custom_role',
        targetId: record.roleKey,
        metadata: { name: record.name, baseRole: record.baseRole, permissions: record.permissions },
        createdAt: input.updatedAt,
      })
      return record
    })
  }

  async deleteCustomRole(orgId: string, roleKey: string): Promise<boolean> {
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM cloud_custom_roles WHERE org_id = $1 AND role_key = $2 RETURNING role_key`,
        [orgId, roleKey],
      )
      if (!result.rows[0]) return false
      await this.options.recordAuditEvent(client, {
        orgId,
        actorType: 'system',
        actorId: 'custom_role.delete',
        eventType: 'custom_role.deleted',
        targetType: 'custom_role',
        targetId: roleKey,
        metadata: {},
      })
      return true
    })
  }
}
