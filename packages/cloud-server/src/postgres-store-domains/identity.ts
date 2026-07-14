import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeCustomRoleKey } from '../control-plane-permissions.ts'
import { accountFromRow, membershipFromRow, orgFromRow, userFromRow } from '../postgres-domains/identity.ts'
import { iso, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import type {
  ControlPlaneRole,
  CreateAccountInput,
  OrgMemberRecord,
  PrincipalMembershipRecord,
  RecordAuditEventInput,
  TenantRecord,
  UpsertMembershipInput,
  UserRecord,
} from '../control-plane-store.ts'

// Identity-root SQL domain extracted from postgres-control-plane-store.ts. Owns the
// tenant / user / org / account / membership lifecycle (create / ensure / find /
// upsert / list / resolve), including the principal-membership resolution join.
// The store-wide tenant/user existence checks (requireTenant / requireTenantUser,
// called from ~40 other store methods) plus transaction + audit recording arrive
// via the injected host. Behaviour-preserving; covered by the pglite + real-Postgres
// control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresIdentityRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
  requireTenant(tenantId: string, executor?: PgExecutor): Promise<TenantRecord>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<UserRecord>
}

export class PostgresIdentityRepository {
  private readonly options: PostgresIdentityRepositoryOptions

  constructor(options: PostgresIdentityRepositoryOptions) {
    this.options = options
  }

  async createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }) {
    await this.options.pool.query(
      `INSERT INTO cloud_tenants (tenant_id, name, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [input.tenantId, input.name, nowIso(input.createdAt)],
    )
    await this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.name, orgId: input.orgId, createdAt: input.createdAt })
    return this.options.requireTenant(input.tenantId)
  }

  async ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }) {
    await this.options.requireTenant(input.tenantId)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_users WHERE tenant_id = $1 AND user_id = $2`,
      [input.tenantId, input.userId],
    )
    if (existing) return userFromRow(existing)
    await this.options.pool.query(
      `INSERT INTO cloud_users (tenant_id, user_id, email, role, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [input.tenantId, input.userId, input.email, input.role || 'member', nowIso(input.createdAt)],
    )
    const org = await this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId, createdAt: input.createdAt })
    const account = await this.createAccount({
      accountId: input.userId,
      idpSubject: input.userId,
      email: input.email,
      createdAt: input.createdAt,
    })
    await this.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: input.role || 'member',
      status: 'active',
      updatedAt: input.createdAt,
      actor: { actorType: 'system', actorId: 'identity.ensureUser' },
    })
    return this.options.requireTenantUser(input.tenantId, input.userId)
  }

  async ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }) {
    const now = nowIso(input.createdAt)
    const result = await this.options.pool.query(
      `INSERT INTO cloud_orgs (org_id, tenant_id, name, plan_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (tenant_id) DO UPDATE
       SET name = COALESCE(NULLIF(EXCLUDED.name, ''), cloud_orgs.name),
           plan_key = COALESCE(EXCLUDED.plan_key, cloud_orgs.plan_key),
           status = cloud_orgs.status,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [input.orgId || input.tenantId, input.tenantId, input.name, input.planKey ?? null, input.status || 'active', now],
    )
    return orgFromRow(result.rows[0]!)
  }

  async createAccount(input: CreateAccountInput) {
    const now = nowIso(input.createdAt)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_accounts
       WHERE ($1::text IS NOT NULL AND idp_subject = $1)
          OR lower(email) = lower($2)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.idpSubject || null, input.email],
    )
    if (existing) {
      const result = await this.options.pool.query(
        `UPDATE cloud_accounts
         SET idp_subject = COALESCE(cloud_accounts.idp_subject, $2),
             email = lower($3),
             display_name = COALESCE($4, cloud_accounts.display_name),
             updated_at = $5
         WHERE account_id = $1
         RETURNING *`,
        [
          existing.account_id,
          input.idpSubject || null,
          input.email,
          input.displayName || null,
          now,
        ],
      )
      return accountFromRow(result.rows[0]!)
    }
    const result = await this.options.pool.query(
      `INSERT INTO cloud_accounts (account_id, idp_subject, email, display_name, created_at, updated_at)
       VALUES ($1, $2, lower($3), $4, $5, $5)
       ON CONFLICT (account_id) DO UPDATE
       SET idp_subject = COALESCE(cloud_accounts.idp_subject, EXCLUDED.idp_subject),
           email = EXCLUDED.email,
           display_name = COALESCE(EXCLUDED.display_name, cloud_accounts.display_name),
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [input.accountId, input.idpSubject || null, input.email, input.displayName || null, now],
    )
    return accountFromRow(result.rows[0]!)
  }

  async findAccountBySubject(idpSubject: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_accounts WHERE idp_subject = $1`, [idpSubject])
    return row ? accountFromRow(row) : null
  }

  async findAccountByEmail(email: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_accounts WHERE lower(email) = lower($1)`, [email])
    return row ? accountFromRow(row) : null
  }

  async upsertMembership(input: UpsertMembershipInput) {
    return this.options.withTransaction(async (client) => {
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_memberships WHERE org_id = $1 AND account_id = $2`,
        [input.orgId, input.accountId],
        client,
      )
      const now = nowIso(input.updatedAt)
      // undefined ⇒ preserve any existing custom-role assignment; null ⇒ clear; string ⇒ assign.
      const customRoleKey = input.customRoleKey === undefined
        ? (existing ? (existing.custom_role_key == null ? null : String(existing.custom_role_key)) : null)
        : (input.customRoleKey === null ? null : normalizeCustomRoleKey(input.customRoleKey))
      const result = await client.query(
        `INSERT INTO cloud_memberships (org_id, account_id, role, custom_role_key, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (org_id, account_id) DO UPDATE
         SET role = EXCLUDED.role,
             custom_role_key = EXCLUDED.custom_role_key,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.orgId, input.accountId, input.role, customRoleKey, input.status || 'active', now],
      )
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.accountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: existing ? 'membership.updated' : 'membership.created',
        targetType: 'membership',
        targetId: `${input.orgId}:${input.accountId}`,
        metadata: { role: input.role, status: input.status || 'active' },
        createdAt: input.updatedAt,
      })
      return membershipFromRow(result.rows[0]!)
    })
  }

  async listOrgMembers(orgId: string, input: { query?: string | null, limit?: number | null } = {}) {
    const queryText = input.query?.trim() || null
    const result = await this.options.pool.query(
      `SELECT
         m.org_id,
         m.account_id,
         a.email,
         a.display_name,
         m.role,
         m.custom_role_key,
         m.status,
         m.created_at,
         m.updated_at
       FROM cloud_memberships m
       JOIN cloud_accounts a ON a.account_id = m.account_id
       WHERE m.org_id = $1
         AND (
           $2::text IS NULL
           OR m.account_id ILIKE '%' || $2 || '%'
           OR a.email ILIKE '%' || $2 || '%'
           OR COALESCE(a.display_name, '') ILIKE '%' || $2 || '%'
           OR m.role ILIKE '%' || $2 || '%'
           OR m.status ILIKE '%' || $2 || '%'
         )
       ORDER BY m.updated_at DESC, a.email ASC
       LIMIT $3`,
      [orgId, queryText, Math.max(1, Math.min(input.limit || 100, 500))],
    )
    return result.rows.map((row): OrgMemberRecord => ({
      orgId: String(row.org_id),
      accountId: String(row.account_id),
      email: String(row.email),
      displayName: row.display_name ? String(row.display_name) : null,
      role: row.role as OrgMemberRecord['role'],
      customRoleKey: row.custom_role_key == null ? null : String(row.custom_role_key),
      status: row.status as OrgMemberRecord['status'],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }))
  }

  async listOrgMembersPage(orgId: string, input: { afterAccountId?: string | null, limit?: number | null } = {}) {
    const afterAccountId = input.afterAccountId?.trim() || null
    const limit = Math.max(1, Math.min(input.limit || 500, 1000))
    const result = await this.options.pool.query(
      `SELECT
         m.org_id,
         m.account_id,
         a.email,
         a.display_name,
         m.role,
         m.custom_role_key,
         m.status,
         m.created_at,
         m.updated_at
       FROM cloud_memberships m
       JOIN cloud_accounts a ON a.account_id = m.account_id
       WHERE m.org_id = $1
         AND ($2::text IS NULL OR m.account_id > $2)
       ORDER BY m.account_id ASC
       LIMIT $3`,
      [orgId, afterAccountId, limit],
    )
    return result.rows.map((row): OrgMemberRecord => ({
      orgId: String(row.org_id),
      accountId: String(row.account_id),
      email: String(row.email),
      displayName: row.display_name ? String(row.display_name) : null,
      role: row.role as OrgMemberRecord['role'],
      customRoleKey: row.custom_role_key == null ? null : String(row.custom_role_key),
      status: row.status as OrgMemberRecord['status'],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }))
  }

  async listMembershipsForAccount(accountId: string) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_memberships WHERE account_id = $1 ORDER BY updated_at DESC, org_id`,
      [accountId],
    )
    return result.rows.map(membershipFromRow)
  }

  async resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): Promise<PrincipalMembershipRecord | null> {
    const row = await this.maybeOne(
      `SELECT
         o.org_id, o.tenant_id, o.name AS org_name, o.plan_key, o.status AS org_status,
         o.created_at AS org_created_at, o.updated_at AS org_updated_at,
         a.account_id, a.idp_subject, a.email, a.display_name,
         a.created_at AS account_created_at, a.updated_at AS account_updated_at,
         m.role, m.custom_role_key, m.status AS membership_status,
         m.created_at AS membership_created_at, m.updated_at AS membership_updated_at
       FROM cloud_orgs o
       JOIN cloud_memberships m ON m.org_id = o.org_id
       JOIN cloud_accounts a ON a.account_id = m.account_id
       WHERE (o.tenant_id = $1 OR o.org_id = $1)
         AND (
           ($2::text IS NOT NULL AND a.account_id = $2)
           OR ($3::text IS NOT NULL AND a.idp_subject = $3)
           OR ($4::text IS NOT NULL AND lower(a.email) = lower($4))
           OR ($5::text IS NOT NULL AND a.account_id = $5)
         )
       ORDER BY
         CASE
           WHEN $2::text IS NOT NULL AND a.account_id = $2 THEN 0
           WHEN $3::text IS NOT NULL AND a.idp_subject = $3 THEN 1
           WHEN $4::text IS NOT NULL AND lower(a.email) = lower($4) THEN 2
           WHEN $5::text IS NOT NULL AND a.account_id = $5 THEN 3
           ELSE 4
         END,
         m.updated_at DESC
       LIMIT 1`,
      [input.tenantId, input.accountId || null, input.idpSubject || null, input.email || null, input.userId || null],
    )
    if (!row) return null
    return {
      org: orgFromRow({
        org_id: row.org_id,
        tenant_id: row.tenant_id,
        name: row.org_name,
        plan_key: row.plan_key,
        status: row.org_status,
        created_at: row.org_created_at,
        updated_at: row.org_updated_at,
      }),
      account: accountFromRow({
        account_id: row.account_id,
        idp_subject: row.idp_subject,
        email: row.email,
        display_name: row.display_name,
        created_at: row.account_created_at,
        updated_at: row.account_updated_at,
      }),
      membership: membershipFromRow({
        org_id: row.org_id,
        account_id: row.account_id,
        role: row.role,
        custom_role_key: row.custom_role_key,
        status: row.membership_status,
        created_at: row.membership_created_at,
        updated_at: row.membership_updated_at,
      }),
    }
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
