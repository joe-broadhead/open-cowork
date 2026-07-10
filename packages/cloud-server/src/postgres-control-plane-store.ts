import type { WorkflowWebhookReplayClaim, WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  nowIso,
  stableJson,
} from './postgres-store-id-helpers.ts'
import { reconcilePostgresConcurrencyCounters } from './postgres-store-domains/quotas.ts'
import {
  normalizeNonNegativeInteger,
  normalizeNullableText,
  normalizePositiveInteger,
  normalizeText,
  retryAfterMs,
  windowStart,
} from './postgres-store-normalizers.ts'
import {
  generateChannelInteractionToken,
  hashChannelInteractionToken,
  verifyChannelInteractionTokenHash,
} from './control-plane-store.ts'
import { redactAuditMetadata } from './audit-redaction.ts'
import { normalizeAuditQueryLimit, paginateAuditEvents } from './audit-query.ts'
import type {
  CoordinationWatch,
} from '@open-cowork/shared'
import type {
  AttachWorkflowRunSessionInput,
  AppendWorkspaceEventInput,
  AuditEventRecord,
  AckChannelDeliveryInput,
  AppendProjectedSessionEventInput,
  BindChannelSessionInput,
  ChannelProviderId,
  ClaimDueWorkflowRunInput,
  ClaimChannelDeliveryInput,
  ClaimChannelProviderEventInput,
  ClaimRateLimitInput,
  ClaimedWorkflowRunRecord,
  CommandQueueQuota,
  CompleteChannelProviderEventInput,
  ConsumeUsageQuotaInput,
  CompleteWorkflowRunInput,
  ControlPlaneRole,
  ControlPlaneSessionStatus,
  ControlPlaneStore,
  ArtifactUploadReservationRecord,
  CreateCustomRoleInput,
  CreateArtifactUploadReservationInput,
  CustomRoleRecord,
  MemberPermissionResolution,
  RevokeApiTokensForAccountInput,
  UpdateCustomRoleInput,
  CreateChannelBindingInput,
  CreateChannelDeliveryInput,
  CreateChannelInteractionInput,
  CreateCloudCoordinationWatchInput,
  CreateAccountInput,
  CreateByokSecretInput,
  CreateHeadlessAgentInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  CreateThreadSmartFilterInput,
  CreateThreadTagInput,
  DisableByokSecretInput,
  EnqueueCommandInput,
  FailWorkflowRunInput,
  FindChannelInteractionInput,
  GrantApiTokenChannelBindingInput,
  IssuedApiTokenRecord,
  IssuedChannelInteractionRecord,
  IssuedManagedWorkerCredentialRecord,
  IssueApiTokenInput,
  ListApiTokenChannelBindingGrantsInput,
  ListCloudCoordinationWatchesInput,
  ListMatchingCloudCoordinationWatchesInput,
  ListWorkflowRunsForWorkflowsInput,
  ListWorkflowsPageInput,
  ListSessionsPageInput,
  ManagedWorkerCredentialRecord,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  ListChannelDeliveriesInput,
  PrincipalMembershipRecord,
  QueryAuditEventsInput,
  QueryAuditEventsResult,
  QuotaConsumptionRecord,
  RecordManagedWorkerHeartbeatInput,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
  RecordCloudAuthFailureInput,
  RecordUsageEventInput,
  RecoverSessionLeaseInput,
  ReapExpiredSessionLeasesInput,
  ReapedSessionLeaseRecord,
  ReapExpiredWorkflowClaimsInput,
  ReapedWorkflowClaimRecord,
  ReleaseArtifactUploadReservationInput,
  RevokeApiTokenInput,
  RevokeManagedWorkerCredentialInput,
  ResolvedManagedWorkerCredentialRecord,
  ResolveChannelInteractionInput,
  ResolveChannelInteractionWithCommandInput,
  SessionCommandRecord,
  SettleArtifactUploadReservationInput,
  ThreadMetadataRecord,
  ThreadTagLinkInput,
  UsageEventRecord,
  UsageQuotaCounterRecord,
  UpdateChannelBindingInput,
  UpdateChannelCursorInput,
  UpdateCloudCoordinationWatchInput,
  UpdateHeadlessAgentInput,
  UpdateManagedWorkerPoolInput,
  UpdateManagedWorkerStatusInput,
  UpdateWorkflowStatusInput,
  UpdateThreadSmartFilterInput,
  UpdateThreadTagInput,
  UpsertBillingSubscriptionInput,
  UpsertChannelIdentityInput,
  UpsertMembershipInput,
  WorkerLeaseRecord,
  WorkerRole,
  WorkspaceEventCursorRecord,
  CreateManagedWorkerPoolInput,
  RegisterManagedWorkerInput,
  IssueManagedWorkerCredentialInput,
  ApiTokenChannelBindingGrantRecord,
  ListChannelIdentitiesInput,
} from './control-plane-store.ts'
import { runPostgresControlPlaneMigrations } from './postgres-migrations.ts'
import { CLOUD_SSE_NOTIFY_CHANNEL, encodeSsePgNotifyPayload } from './sse-pg-notify.ts'
import { cloudPostgresPoolPlan, type CloudPostgresPoolConfig } from './postgres-pool-options.ts'
import { normalizeChannelProviderId as normalizeProvider } from './channel-provider-utils.ts'
import { usageEventFromRow } from './postgres-domains/billing.ts'
import { channelInteractionFromRow, channelSessionBindingFromRow } from './postgres-domains/channels.ts'
import {
  auditEventFromRow,
  tenantFromRow,
  userFromRow,
} from './postgres-domains/identity.ts'
import { migrationFromRow } from './postgres-domains/schema.ts'
import {
  commandFromRow,
} from './postgres-domains/sessions.ts'
import { numberValue, type QueryResult, type QueryRow } from './postgres-domains/shared.ts'
import { PostgresBillingRepository } from './postgres-store-domains/billing.ts'
import { PostgresByokSecretsRepository } from './postgres-store-domains/byok.ts'
import { PostgresApiTokensRepository } from './postgres-store-domains/api-tokens.ts'
import { PostgresAuthBackoffRepository } from './postgres-store-domains/auth-backoff.ts'
import { PostgresRateLimitsRepository } from './postgres-store-domains/rate-limits.ts'
import { PostgresSessionsRepository } from './postgres-store-domains/sessions.ts'
import { PostgresSessionIndexesRepository } from './postgres-store-domains/session-indexes.ts'
import { PostgresThreadIndexRepository } from './postgres-store-domains/thread-index.ts'
import { PostgresWebhooksRepository } from './postgres-store-domains/webhooks.ts'
import { PostgresWorkflowsRepository } from './postgres-store-domains/workflows.ts'
import { PostgresWorkerHeartbeatsRepository } from './postgres-store-domains/worker-heartbeats.ts'
import { PostgresSettingsRepository } from './postgres-store-domains/settings.ts'
import { PostgresChannelBindingsRepository } from './postgres-store-domains/channel-bindings.ts'
import { PostgresHeadlessAgentsRepository } from './postgres-store-domains/headless-agents.ts'
import { PostgresChannelIdentitiesRepository } from './postgres-store-domains/channel-identities.ts'
import { PostgresIdentityRepository } from './postgres-store-domains/identity.ts'
import { PostgresRolesRepository } from './postgres-store-domains/roles.ts'
import { PostgresManagedPolicyRepository } from './postgres-store-domains/policy.ts'
import { PostgresSsoRepository } from './postgres-store-domains/sso.ts'
import type { ManagedPolicyRecord, SetManagedPolicyInput } from './control-plane-policy.ts'
import type { OrgSsoConfigRecord, UpsertOrgSsoConfigInput } from './control-plane-sso.ts'
import type {
  ClaimScimSyncEventsInput,
  CompleteScimSyncEventInput,
  EnqueueScimSyncEventInput,
  FailScimSyncEventInput,
  ListScimSyncEventsInput,
  ScimSyncEventRecord,
} from './control-plane-scim.ts'
import { membershipFromRow } from './postgres-domains/identity.ts'
import { resolveEffectivePermissions } from './control-plane-permissions.ts'
import { PostgresManagedWorkersRepository } from './postgres-store-domains/workers.ts'
import { PostgresChannelProviderEventsRepository } from './postgres-store-domains/channel-provider-events.ts'
import { PostgresChannelDeliveriesRepository } from './postgres-store-domains/channel-deliveries.ts'
import { PostgresCoordinationWatchesRepository } from './postgres-store-domains/coordination-watches.ts'
import { PostgresArtifactUploadReservationsRepository } from './postgres-store-domains/artifact-upload-reservations.ts'
import { PostgresWorkspaceEventsRepository } from './postgres-store-domains/workspace-events.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }
type PgPool = PgExecutor & { connect(): Promise<PgClient>; end(): Promise<void> }

export type PostgresControlPlaneStoreOptions = {
  connectionString: string
  runMigrations?: boolean
  pool?: PgPool
  // Opt-in (default off): emit a best-effort Postgres NOTIFY after each session/workspace
  // event commit so web pods running the LISTEN/NOTIFY accelerator wake the matching SSE
  // topic immediately instead of waiting for the next poll. Off ⇒ no NOTIFY is issued.
  ssePgNotify?: boolean
}

const require = createRequire(import.meta.url)

const CHANNEL_TEXT_MAX_LENGTH = 256
export function loadPgPool(connectionString: string): PgPool {
  type PgPoolClient = { query(text: string): Promise<unknown> }
  type RealPgPool = PgPool & { on?(event: 'connect', handler: (client: PgPoolClient) => void): void }
  const pg = require('pg') as { Pool: new (options: CloudPostgresPoolConfig) => RealPgPool }
  const { config, lockTimeoutMs } = cloudPostgresPoolPlan(connectionString)
  const pool = new pg.Pool(config)
  if (lockTimeoutMs > 0 && typeof pool.on === 'function') {
    // lock_timeout is not a native pool option; set it per connection so a blocked
    // FOR UPDATE waits at most lockTimeoutMs instead of pinning a pooled connection.
    pool.on('connect', (client) => {
      void Promise.resolve(client.query(`SET lock_timeout = ${lockTimeoutMs}`)).catch(() => {})
    })
  }
  return pool
}

export class PostgresControlPlaneStore implements ControlPlaneStore, WorkflowWebhookSecurityStore {
  private readonly pool: PgPool
  private readonly ownsPool: boolean
  // Set by connect() from PostgresControlPlaneStoreOptions.ssePgNotify (default off).
  private ssePgNotifyEnabled = false
  private readonly identity: PostgresIdentityRepository
  private readonly roles: PostgresRolesRepository
  private readonly managedPolicy: PostgresManagedPolicyRepository
  private readonly sso: PostgresSsoRepository
  private readonly apiTokens: PostgresApiTokensRepository
  private readonly rateLimits: PostgresRateLimitsRepository
  private readonly authBackoff: PostgresAuthBackoffRepository
  private readonly workerHeartbeats: PostgresWorkerHeartbeatsRepository
  private readonly sessions: PostgresSessionsRepository
  private readonly sessionIndexes: PostgresSessionIndexesRepository
  private readonly threadIndex: PostgresThreadIndexRepository
  private readonly webhooks: PostgresWebhooksRepository
  private readonly workflows: PostgresWorkflowsRepository
  private readonly settings: PostgresSettingsRepository
  private readonly channelBindings: PostgresChannelBindingsRepository
  private readonly headlessAgents: PostgresHeadlessAgentsRepository
  private readonly channelIdentities: PostgresChannelIdentitiesRepository
  private readonly billing: PostgresBillingRepository
  private readonly byokSecrets: PostgresByokSecretsRepository
  private readonly managedWorkers: PostgresManagedWorkersRepository
  private readonly channelProviderEvents: PostgresChannelProviderEventsRepository
  private readonly channelDeliveries: PostgresChannelDeliveriesRepository
  private readonly coordinationWatches: PostgresCoordinationWatchesRepository
  private readonly artifactUploadReservations: PostgresArtifactUploadReservationsRepository
  private readonly workspaceEvents: PostgresWorkspaceEventsRepository
  private readonly quotaDeps = {
    lockQuota: (executor: PgExecutor, orgId: string, quotaKey: string, now?: Date) => this.lockQuota(executor, orgId, quotaKey, now),
    consumeUsageQuota: (executor: PgExecutor, input: ConsumeUsageQuotaInput) => this.consumeUsageQuotaWithExecutor(executor, input),
  }

  private constructor(pool: PgPool, ownsPool: boolean) {
    this.pool = pool
    this.ownsPool = ownsPool
    this.identity = new PostgresIdentityRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
      requireTenant: (tenantId, executor) => this.requireTenant(tenantId, executor),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
    })
    this.roles = new PostgresRolesRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.managedPolicy = new PostgresManagedPolicyRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.sso = new PostgresSsoRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.apiTokens = new PostgresApiTokensRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.settings = new PostgresSettingsRepository({
      pool: this.pool,
      requireTenant: (tenantId) => this.requireTenant(tenantId),
      requireTenantUser: (tenantId, userId) => this.requireTenantUser(tenantId, userId),
    })
    this.rateLimits = new PostgresRateLimitsRepository({ pool: this.pool })
    this.authBackoff = new PostgresAuthBackoffRepository({ pool: this.pool })
    this.workerHeartbeats = new PostgresWorkerHeartbeatsRepository({ pool: this.pool })
    this.sessions = new PostgresSessionsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenant: (tenantId, executor) => this.requireTenant(tenantId, executor),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
      emitSseNotify: (payload) => this.emitSseNotify(payload),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
      quotaDeps: this.quotaDeps,
    })
    this.sessionIndexes = new PostgresSessionIndexesRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
    })
    this.threadIndex = new PostgresThreadIndexRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenant: (tenantId, executor) => this.requireTenant(tenantId, executor),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
      requireSessions: (tenantId, sessionIds, executor) => this.sessions.requireSessions(tenantId, sessionIds, executor),
    })
    this.webhooks = new PostgresWebhooksRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
    })
    this.workflows = new PostgresWorkflowsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenant: (tenantId, executor) => this.requireTenant(tenantId, executor),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
      assertLeaseTokenIfPresent: (tenantId, sessionId, leaseToken, executor) => this.sessions.assertLeaseTokenIfPresent(tenantId, sessionId, leaseToken, executor),
      quotaDeps: this.quotaDeps,
    })
    this.channelBindings = new PostgresChannelBindingsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
      lockQuota: (executor, orgId, quotaKey, now) => this.lockQuota(executor, orgId, quotaKey, now),
    })
    this.headlessAgents = new PostgresHeadlessAgentsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.channelIdentities = new PostgresChannelIdentitiesRepository({ pool: this.pool })
    this.billing = new PostgresBillingRepository({
      pool: this.pool,
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.byokSecrets = new PostgresByokSecretsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.managedWorkers = new PostgresManagedWorkersRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      recordAuditEvent: (executor, input) => this.recordAuditEventWithExecutor(executor, input),
    })
    this.channelProviderEvents = new PostgresChannelProviderEventsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
    })
    this.channelDeliveries = new PostgresChannelDeliveriesRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      consumeUsageQuota: (executor, input) => this.consumeUsageQuotaWithExecutor(executor, input),
    })
    this.coordinationWatches = new PostgresCoordinationWatchesRepository(this.pool)
    this.artifactUploadReservations = new PostgresArtifactUploadReservationsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      consumeUsageQuota: (executor, input) => this.consumeUsageQuotaWithExecutor(executor, input),
      adjustUsageQuota: (executor, input) => this.adjustUsageQuotaWithExecutor(executor, input),
    })
    this.workspaceEvents = new PostgresWorkspaceEventsRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
      requireSession: (tenantId, sessionId, executor) => this.sessions.requireSession(tenantId, sessionId, executor, true),
      emitSseNotify: (payload) => this.emitSseNotify(payload),
    })
  }

  static async connect(options: PostgresControlPlaneStoreOptions) {
    const pool = options.pool || loadPgPool(options.connectionString)
    const store = new PostgresControlPlaneStore(pool, !options.pool)
    store.ssePgNotifyEnabled = options.ssePgNotify === true
    if (options.runMigrations !== false) await store.runMigrations()
    return store
  }

  // Best-effort SSE accelerator NOTIFY: ids only (Postgres NOTIFY payloads cap ~8000
  // bytes), parametrised via pg_notify so the payload is never string-interpolated, and
  // fire-and-forget — a NOTIFY failure must never fail the already-committed write. No-op
  // unless the opt-in flag is set.
  private emitSseNotify(payload: Parameters<typeof encodeSsePgNotifyPayload>[0]) {
    if (!this.ssePgNotifyEnabled) return
    void Promise.resolve(
      this.pool.query('SELECT pg_notify($1, $2)', [CLOUD_SSE_NOTIFY_CHANNEL, encodeSsePgNotifyPayload(payload)]),
    ).catch(() => {})
  }

  async close() {
    if (this.ownsPool) await this.pool.end()
  }

  async runMigrations() {
    await runPostgresControlPlaneMigrations(this.pool, (fn) => this.withTransaction(fn))
  }

  async createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }) {
    return this.identity.createTenant(input)
  }

  async ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }) {
    return this.identity.ensureUser(input)
  }

  async ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }) {
    return this.identity.ensureOrgForTenant(input)
  }

  async createAccount(input: CreateAccountInput) {
    return this.identity.createAccount(input)
  }

  async findAccountBySubject(idpSubject: string) {
    return this.identity.findAccountBySubject(idpSubject)
  }

  async findAccountByEmail(email: string) {
    return this.identity.findAccountByEmail(email)
  }

  async upsertMembership(input: UpsertMembershipInput) {
    return this.identity.upsertMembership(input)
  }

  async listOrgMembers(orgId: string, input: { query?: string | null, limit?: number | null } = {}) {
    return this.identity.listOrgMembers(orgId, input)
  }

  async listOrgMembersPage(orgId: string, input: { afterAccountId?: string | null, limit?: number | null } = {}) {
    return this.identity.listOrgMembersPage(orgId, input)
  }

  async listMembershipsForAccount(accountId: string) {
    return this.identity.listMembershipsForAccount(accountId)
  }

  async resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): Promise<PrincipalMembershipRecord | null> {
    return this.identity.resolvePrincipalMembership(input)
  }

  async createCustomRole(input: CreateCustomRoleInput): Promise<CustomRoleRecord> {
    const org = await this.maybeOne(`SELECT 1 FROM cloud_orgs WHERE org_id = $1`, [input.orgId])
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    return this.roles.createCustomRole(input)
  }

  async listCustomRoles(orgId: string): Promise<CustomRoleRecord[]> {
    return this.roles.listCustomRoles(orgId)
  }

  async getCustomRole(orgId: string, roleKey: string): Promise<CustomRoleRecord | null> {
    return this.roles.getCustomRole(orgId, roleKey)
  }

  async updateCustomRole(input: UpdateCustomRoleInput): Promise<CustomRoleRecord | null> {
    return this.roles.updateCustomRole(input)
  }

  async deleteCustomRole(orgId: string, roleKey: string): Promise<boolean> {
    return this.roles.deleteCustomRole(orgId, roleKey)
  }

  async getManagedPolicy(orgId: string): Promise<ManagedPolicyRecord | null> {
    return this.managedPolicy.getManagedPolicy(orgId)
  }

  async setManagedPolicy(input: SetManagedPolicyInput): Promise<ManagedPolicyRecord> {
    const org = await this.maybeOne(`SELECT 1 FROM cloud_orgs WHERE org_id = $1`, [input.orgId])
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    return this.managedPolicy.setManagedPolicy(input)
  }

  async getOrgSsoConfig(orgId: string): Promise<OrgSsoConfigRecord | null> {
    return this.sso.getOrgSsoConfig(orgId)
  }

  async upsertOrgSsoConfig(input: UpsertOrgSsoConfigInput): Promise<OrgSsoConfigRecord> {
    const org = await this.maybeOne(`SELECT 1 FROM cloud_orgs WHERE org_id = $1`, [input.orgId])
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    return this.sso.upsertOrgSsoConfig(input)
  }

  async deleteOrgSsoConfig(orgId: string): Promise<boolean> {
    return this.sso.deleteOrgSsoConfig(orgId)
  }

  async findOrgSsoConfigByScimToken(plaintext: string): Promise<OrgSsoConfigRecord | null> {
    return this.sso.findOrgSsoConfigByScimToken(plaintext)
  }

  async findOrgSsoConfigByDomain(domain: string): Promise<OrgSsoConfigRecord | null> {
    return this.sso.findOrgSsoConfigByDomain(domain)
  }

  async enqueueScimSyncEvent(input: EnqueueScimSyncEventInput): Promise<ScimSyncEventRecord> {
    const org = await this.maybeOne(`SELECT 1 FROM cloud_orgs WHERE org_id = $1`, [input.orgId])
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    return this.sso.enqueueScimSyncEvent(input)
  }

  async claimNextScimSyncEvents(input: ClaimScimSyncEventsInput = {}): Promise<ScimSyncEventRecord[]> {
    return this.sso.claimNextScimSyncEvents(input)
  }

  async completeScimSyncEvent(input: CompleteScimSyncEventInput): Promise<ScimSyncEventRecord | null> {
    return this.sso.completeScimSyncEvent(input)
  }

  async failScimSyncEvent(input: FailScimSyncEventInput): Promise<ScimSyncEventRecord | null> {
    return this.sso.failScimSyncEvent(input)
  }

  async listScimSyncEvents(input: ListScimSyncEventsInput): Promise<ScimSyncEventRecord[]> {
    return this.sso.listScimSyncEvents(input)
  }

  // Effective permissions for a member: its custom role's permission map when one
  // is assigned (and still exists), otherwise the built-in role's map.
  async resolveMemberPermissions(orgId: string, accountId: string): Promise<MemberPermissionResolution | null> {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_memberships WHERE org_id = $1 AND account_id = $2`,
      [orgId, accountId],
    )
    if (!row) return null
    const membership = membershipFromRow(row)
    const customRole = membership.customRoleKey ? await this.roles.getCustomRole(orgId, membership.customRoleKey) : null
    return {
      orgId,
      accountId,
      role: membership.role,
      customRoleKey: customRole ? membership.customRoleKey : null,
      permissions: resolveEffectivePermissions({ role: membership.role, customRole }),
    }
  }

  async issueApiToken(input: IssueApiTokenInput): Promise<IssuedApiTokenRecord> {
    return this.apiTokens.issueApiToken(input)
  }

  async findApiTokenByPlaintext(plaintext: string, now = new Date()) {
    return this.apiTokens.findApiTokenByPlaintext(plaintext, now)
  }

  async listApiTokens(orgId: string) {
    return this.apiTokens.listApiTokens(orgId)
  }

  async revokeApiToken(input: RevokeApiTokenInput) {
    return this.apiTokens.revokeApiToken(input)
  }

  async revokeApiTokensForAccount(input: RevokeApiTokensForAccountInput) {
    return this.apiTokens.revokeApiTokensForAccount(input)
  }

  async grantApiTokenChannelBinding(input: GrantApiTokenChannelBindingInput): Promise<ApiTokenChannelBindingGrantRecord> {
    return this.apiTokens.grantApiTokenChannelBinding(input)
  }

  async listApiTokenChannelBindingGrants(input: ListApiTokenChannelBindingGrantsInput): Promise<ApiTokenChannelBindingGrantRecord[]> {
    return this.apiTokens.listApiTokenChannelBindingGrants(input)
  }

  async createManagedWorkerPool(input: CreateManagedWorkerPoolInput): Promise<ManagedWorkerPoolRecord> {
    return this.managedWorkers.createPool(input)
  }

  async updateManagedWorkerPool(input: UpdateManagedWorkerPoolInput): Promise<ManagedWorkerPoolRecord | null> {
    return this.managedWorkers.updatePool(input)
  }

  async getManagedWorkerPool(orgId: string, poolId: string) {
    return this.managedWorkers.getPool(orgId, poolId)
  }

  async listManagedWorkerPools(orgId: string, input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {}) {
    return this.managedWorkers.listPools(orgId, input)
  }

  async registerManagedWorker(input: RegisterManagedWorkerInput): Promise<ManagedWorkerRecord> {
    return this.managedWorkers.registerWorker(input)
  }

  async updateManagedWorkerStatus(input: UpdateManagedWorkerStatusInput): Promise<ManagedWorkerRecord | null> {
    return this.managedWorkers.updateWorkerStatus(input)
  }

  async getManagedWorker(orgId: string, workerId: string) {
    return this.managedWorkers.getWorker(orgId, workerId)
  }

  async listManagedWorkers(orgId: string, input: { poolId?: string | null, status?: ManagedWorkerStatus | null, limit?: number | null } = {}) {
    return this.managedWorkers.listWorkers(orgId, input)
  }

  async issueManagedWorkerCredential(input: IssueManagedWorkerCredentialInput): Promise<IssuedManagedWorkerCredentialRecord> {
    return this.managedWorkers.issueCredential(input)
  }

  async listManagedWorkerCredentials(orgId: string, workerId: string) {
    return this.managedWorkers.listCredentials(orgId, workerId)
  }

  async findManagedWorkerCredentialByPlaintext(plaintext: string, now = new Date()): Promise<ResolvedManagedWorkerCredentialRecord | null> {
    return this.managedWorkers.findCredentialByPlaintext(plaintext, now)
  }

  async revokeManagedWorkerCredential(input: RevokeManagedWorkerCredentialInput): Promise<ManagedWorkerCredentialRecord | null> {
    return this.managedWorkers.revokeCredential(input)
  }

  async recordManagedWorkerHeartbeat(input: RecordManagedWorkerHeartbeatInput): Promise<ManagedWorkerHeartbeatRecord> {
    return this.managedWorkers.recordHeartbeat(input)
  }

  async listManagedWorkerHeartbeats(orgId: string, input: { workerId?: string | null, limit?: number | null } = {}) {
    return this.managedWorkers.listHeartbeats(orgId, input)
  }

  async recordAuditEvent(input: RecordAuditEventInput) {
    return this.recordAuditEventWithExecutor(this.pool, input)
  }

  async listAuditEvents(orgId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_audit_events
       WHERE org_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT $2`,
      [orgId, Math.max(1, Math.min(limit, 500))],
    )
    return result.rows.map(auditEventFromRow)
  }

  async queryAuditEvents(input: QueryAuditEventsInput): Promise<QueryAuditEventsResult> {
    const limit = normalizeAuditQueryLimit(input.limit)
    const conditions: string[] = ['org_id = $1']
    const values: unknown[] = [input.orgId]
    const bind = (value: unknown) => {
      values.push(value)
      return `$${values.length}`
    }
    if (input.actorId) conditions.push(`actor_id = ${bind(input.actorId)}`)
    if (input.actorType) conditions.push(`actor_type = ${bind(input.actorType)}`)
    // Anchored LIKE on the escaped prefix keeps "session." matching session.* only.
    if (input.eventTypePrefix) conditions.push(`event_type LIKE ${bind(`${likePrefixEscape(input.eventTypePrefix)}%`)} ESCAPE '\\'`)
    if (input.targetType) conditions.push(`target_type = ${bind(input.targetType)}`)
    if (input.targetId) conditions.push(`target_id = ${bind(input.targetId)}`)
    if (input.result) conditions.push(`metadata->>'result' = ${bind(input.result)}`)
    if (input.from) conditions.push(`created_at >= ${bind(input.from.toISOString())}`)
    if (input.to) conditions.push(`created_at <= ${bind(input.to.toISOString())}`)
    if (input.cursor) {
      // Keyset: rows strictly AFTER the cursor in (created_at DESC, event_id DESC) order.
      conditions.push(`(created_at, event_id) < (${bind(input.cursor.createdAt)}, ${bind(input.cursor.eventId)})`)
    }
    const result = await this.pool.query(
      `SELECT * FROM cloud_audit_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, event_id DESC
       LIMIT ${bind(limit + 1)}`,
      values,
    )
    return paginateAuditEvents(result.rows.map(auditEventFromRow), limit)
  }

  async consumeUsageQuota(input: ConsumeUsageQuotaInput) {
    return this.withTransaction((client) => this.consumeUsageQuotaWithExecutor(client, input))
  }

  async listUsageQuotaCounters(orgId: string): Promise<UsageQuotaCounterRecord[]> {
    const result = await this.pool.query(
      `SELECT org_id, quota_key, window_started_at_ms, quantity
       FROM cloud_usage_counters
       WHERE org_id = $1
       ORDER BY quota_key ASC`,
      [orgId],
    )
    return result.rows.map((row) => ({
      orgId: String(row.org_id),
      quotaKey: String(row.quota_key),
      windowStartedAtMs: numberValue(row.window_started_at_ms),
      quantity: numberValue(row.quantity),
    }))
  }

  async createArtifactUploadReservation(input: CreateArtifactUploadReservationInput): Promise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  }> {
    return this.artifactUploadReservations.create(input)
  }

  async getArtifactUploadReservation(input: {
    orgId: string
    tenantId: string
    sessionId: string
    artifactId: string
  }): Promise<ArtifactUploadReservationRecord | null> {
    return this.artifactUploadReservations.get(input)
  }

  async settleArtifactUploadReservation(input: SettleArtifactUploadReservationInput): Promise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
    settled: boolean
  }> {
    return this.artifactUploadReservations.settle(input)
  }

  async releaseArtifactUploadReservation(input: ReleaseArtifactUploadReservationInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.artifactUploadReservations.release(input)
  }

  async recordUsageEvent(input: RecordUsageEventInput) {
    return this.recordUsageEventWithExecutor(this.pool, input)
  }

  async listUsageEvents(orgId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_usage_events
       WHERE org_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT $2`,
      [orgId, Math.max(1, Math.min(limit, 500))],
    )
    return result.rows.map(usageEventFromRow)
  }

  async upsertBillingSubscription(input: UpsertBillingSubscriptionInput) {
    return this.billing.upsertBillingSubscription(input)
  }

  async getBillingSubscription(orgId: string) {
    return this.billing.getBillingSubscription(orgId)
  }

  async findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }) {
    return this.billing.findBillingSubscriptionByProvider(input)
  }

  async claimRateLimit(input: ClaimRateLimitInput) {
    return this.rateLimits.claimRateLimit(input)
  }

  async checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }) {
    return this.authBackoff.checkCloudAuthBackoff(input)
  }

  async recordCloudAuthFailure(input: RecordCloudAuthFailureInput) {
    return this.authBackoff.recordCloudAuthFailure(input)
  }

  async createByokSecret(input: CreateByokSecretInput) {
    return this.byokSecrets.createByokSecret(input)
  }

  async getByokSecret(orgId: string, providerId: string) {
    return this.byokSecrets.getByokSecret(orgId, providerId)
  }

  async getActiveByokSecret(orgId: string, providerId: string) {
    return this.byokSecrets.getActiveByokSecret(orgId, providerId)
  }

  async listByokSecrets(orgId: string) {
    return this.byokSecrets.listByokSecrets(orgId)
  }

  async disableByokSecret(input: DisableByokSecretInput) {
    return this.byokSecrets.disableByokSecret(input)
  }

  async recordByokSecretValidation(input: RecordByokSecretValidationInput) {
    return this.byokSecrets.recordByokSecretValidation(input)
  }

  async createHeadlessAgent(input: CreateHeadlessAgentInput) {
    return this.headlessAgents.createHeadlessAgent(input)
  }

  async updateHeadlessAgent(input: UpdateHeadlessAgentInput) {
    return this.headlessAgents.updateHeadlessAgent(input)
  }

  async getHeadlessAgent(orgId: string, agentId: string) {
    return this.headlessAgents.getHeadlessAgent(orgId, agentId)
  }

  async listHeadlessAgents(orgId: string) {
    return this.headlessAgents.listHeadlessAgents(orgId)
  }

  async createChannelBinding(input: CreateChannelBindingInput) {
    return this.channelBindings.createChannelBinding(input)
  }

  async updateChannelBinding(input: UpdateChannelBindingInput) {
    return this.channelBindings.updateChannelBinding(input)
  }

  async getChannelBinding(orgId: string, bindingId: string) {
    return this.channelBindings.getChannelBinding(orgId, bindingId)
  }

  async listChannelBindings(orgId: string, agentId?: string | null) {
    return this.channelBindings.listChannelBindings(orgId, agentId)
  }

  async upsertChannelIdentity(input: UpsertChannelIdentityInput) {
    return this.channelIdentities.upsertChannelIdentity(input)
  }

  async getChannelIdentity(orgId: string, identityId: string) {
    return this.channelIdentities.getChannelIdentity(orgId, identityId)
  }

  async listChannelIdentities(orgId: string, input: ListChannelIdentitiesInput = {}) {
    return this.channelIdentities.listChannelIdentities(orgId, input)
  }

  async findChannelIdentity(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalUserId: string }) {
    return this.channelIdentities.findChannelIdentity(input)
  }

  async bindChannelSession(input: BindChannelSessionInput) {
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const relationship = await this.maybeOne(
      `SELECT b.binding_id
       FROM cloud_channel_bindings b
       JOIN headless_agents a
         ON a.agent_id = $3
        AND a.org_id = $1
       JOIN cloud_orgs o
         ON o.org_id = $1
       JOIN cloud_sessions s
         ON s.tenant_id = o.tenant_id
        AND s.session_id = $4
       WHERE b.org_id = $1
         AND b.binding_id = $2
         AND b.agent_id = a.agent_id
         AND b.provider = $5`,
      [input.orgId, input.channelBindingId, input.agentId, input.sessionId, provider],
    )
    if (!relationship) throw new Error('Channel session binding references must belong to the same org, agent, provider, and session.')
    const now = nowIso(input.createdAt)
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_session_bindings (
        binding_id, org_id, agent_id, channel_binding_id, provider,
        external_workspace_id, external_thread_id, external_chat_id, session_id,
        last_event_sequence, last_workspace_sequence, last_chat_message_id,
        status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel session binding id'),
        input.orgId,
        input.agentId,
        input.channelBindingId,
        provider,
        externalWorkspaceId,
        normalizeText(input.externalThreadId, CHANNEL_TEXT_MAX_LENGTH, 'External thread id'),
        normalizeText(input.externalChatId, CHANNEL_TEXT_MAX_LENGTH, 'External chat id'),
        input.sessionId,
        normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence'),
        normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence'),
        normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id'),
        input.status || 'active',
        now,
      ],
    )
    const row = result.rows[0] || await this.one(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND provider = $2 AND COALESCE(external_workspace_id, '') = COALESCE($3::text, '')
         AND external_chat_id = $4 AND external_thread_id = $5`,
      [input.orgId, provider, externalWorkspaceId, input.externalChatId, input.externalThreadId],
    )
    const binding = channelSessionBindingFromRow(row)
    if (result.rows[0]) {
      await this.recordAuditEvent({
        orgId: binding.orgId,
        actorType: 'system',
        actorId: 'channel_session.bind',
        eventType: 'channel_session_bound',
        targetType: 'channel_session_binding',
        targetId: binding.bindingId,
        metadata: { provider: binding.provider, sessionId: binding.sessionId },
        createdAt: input.createdAt,
      })
    }
    return binding
  }

  async getChannelSessionBinding(orgId: string, bindingId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_session_bindings WHERE org_id = $1 AND binding_id = $2`, [orgId, bindingId])
    return row ? channelSessionBindingFromRow(row) : null
  }

  async findChannelSessionBindingByThread(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalChatId: string, externalThreadId: string }) {
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND provider = $2 AND COALESCE(external_workspace_id, '') = COALESCE($3::text, '')
         AND external_chat_id = $4 AND external_thread_id = $5`,
      [input.orgId, normalizeProvider(input.provider), externalWorkspaceId, input.externalChatId, input.externalThreadId],
    )
    return row ? channelSessionBindingFromRow(row) : null
  }

  async listChannelSessionBindingsForSession(orgId: string, sessionId: string) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND session_id = $2 AND status = 'active'
       ORDER BY updated_at DESC, binding_id`,
      [orgId, sessionId],
    )
    return result.rows.map(channelSessionBindingFromRow)
  }

  async updateChannelCursor(input: UpdateChannelCursorInput) {
    const lastEventSequence = normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence'), lastWorkspaceSequence = normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence')
    const result = await this.pool.query(
      `UPDATE cloud_channel_session_bindings
       SET last_event_sequence = $3,
           last_workspace_sequence = $4,
           last_chat_message_id = CASE WHEN $5::boolean THEN $6 ELSE last_chat_message_id END,
           updated_at = $7
       WHERE org_id = $1
         AND binding_id = $2
         AND last_event_sequence <= $3
         AND last_workspace_sequence <= $4
       RETURNING *`,
      [
        input.orgId,
        input.bindingId,
        lastEventSequence,
        lastWorkspaceSequence,
        input.lastChatMessageId !== undefined,
        normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id'),
        nowIso(input.updatedAt),
      ],
    )
    if (result.rows[0]) return { ok: true as const, binding: channelSessionBindingFromRow(result.rows[0]) }
    const existing = await this.maybeOne(`SELECT * FROM cloud_channel_session_bindings WHERE org_id = $1 AND binding_id = $2`, [input.orgId, input.bindingId])
    if (!existing) return { ok: false as const, reason: 'not_found' as const }
    return { ok: false as const, reason: 'stale' as const, binding: channelSessionBindingFromRow(existing) }
  }

  async createChannelInteraction(input: CreateChannelInteractionInput): Promise<IssuedChannelInteractionRecord> {
    const plaintextToken = generateChannelInteractionToken({ interactionId: input.interactionId, secret: input.tokenSecret })
    const relationship = await this.maybeOne(
      `SELECT a.agent_id
       FROM headless_agents a
       JOIN cloud_orgs o
         ON o.org_id = $1
       JOIN cloud_sessions s
         ON s.tenant_id = o.tenant_id
        AND s.session_id = $3
       LEFT JOIN cloud_channel_identities i
         ON i.identity_id = $4
       WHERE a.org_id = $1
         AND a.agent_id = $2
         AND ($4::text IS NULL OR i.org_id = $1)`,
      [input.orgId, input.agentId, input.sessionId, input.createdByIdentityId || null],
    )
    if (!relationship) throw new Error('Channel interaction references must belong to the same org, agent, session, and identity.')
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_interactions (
        interaction_id, org_id, agent_id, session_id, provider, external_interaction_id,
        token_hash, kind, target_id, status, created_by_identity_id,
        expires_at, used_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, NULL, $12, $12)
       ON CONFLICT (interaction_id) DO NOTHING
       RETURNING *`,
      [
        input.interactionId,
        input.orgId,
        input.agentId,
        input.sessionId,
        normalizeProvider(input.provider),
        normalizeNullableText(input.externalInteractionId, CHANNEL_TEXT_MAX_LENGTH, 'External interaction id'),
        await hashChannelInteractionToken(plaintextToken),
        input.kind,
        normalizeText(input.targetId, CHANNEL_TEXT_MAX_LENGTH, 'Interaction target id'),
        input.createdByIdentityId || null,
        input.expiresAt.toISOString(),
        nowIso(input.createdAt),
      ],
    )
    if (!result.rows[0]) throw new Error(`Channel interaction ${input.interactionId} already exists.`)
    return { interaction: channelInteractionFromRow(result.rows[0]), plaintextToken }
  }

  // Resolve a pending interaction by the token's embedded interaction id, then verify the
  // per-interaction salted hash in app code (the SQL prefix match only narrows the id, it
  // does not check the secret). A forged id cannot pass the hash verification.
  private async findPendingChannelInteractionRowByToken(orgId: string, token: string, now: string, client?: PgExecutor) {
    const executor = client ?? this.pool
    const candidates = await executor.query(
      `SELECT * FROM cloud_channel_interactions
       WHERE org_id = $1
         AND status = 'pending'
         AND expires_at > $3
         AND left($2, length('occi_' || interaction_id || '_')) = ('occi_' || interaction_id || '_')${client ? '\n       FOR UPDATE' : ''}`,
      [orgId, token, now],
    )
    for (const row of candidates.rows) {
      if (await verifyChannelInteractionTokenHash(token, String(row.token_hash))) return row
    }
    return null
  }

  async findChannelInteraction(input: FindChannelInteractionInput) {
    const now = nowIso(input.now)
    if (input.token) {
      const row = await this.findPendingChannelInteractionRowByToken(input.orgId, input.token, now)
      return row ? channelInteractionFromRow(row) : null
    }
    if (input.provider && input.externalInteractionId) {
      const row = await this.maybeOne(
        `SELECT * FROM cloud_channel_interactions
         WHERE org_id = $1 AND status = 'pending' AND expires_at > $4
           AND provider = $2 AND external_interaction_id = $3`,
        [input.orgId, input.provider, input.externalInteractionId, now],
      )
      return row ? channelInteractionFromRow(row) : null
    }
    return null
  }

  async resolveChannelInteraction(input: ResolveChannelInteractionInput) {
    const now = nowIso(input.usedAt)
    let updatedRow: QueryRow | null = null
    if (input.token) {
      const candidate = await this.findPendingChannelInteractionRowByToken(input.orgId, input.token, now)
      if (candidate) {
        const result = await this.pool.query(
          `UPDATE cloud_channel_interactions
           SET status = 'used', used_at = $3, updated_at = $3
           WHERE org_id = $1 AND interaction_id = $2 AND status = 'pending' AND expires_at > $3
           RETURNING *`,
          [input.orgId, String(candidate.interaction_id), now],
        )
        updatedRow = result.rows[0] ?? null
      }
    } else if (input.provider && input.externalInteractionId) {
      const result = await this.pool.query(
        `UPDATE cloud_channel_interactions
         SET status = 'used', used_at = $4, updated_at = $4
         WHERE org_id = $1 AND status = 'pending' AND expires_at > $4
           AND provider = $2 AND external_interaction_id = $3
         RETURNING *`,
        [input.orgId, input.provider, input.externalInteractionId, now],
      )
      updatedRow = result.rows[0] ?? null
    }
    const interaction = updatedRow ? channelInteractionFromRow(updatedRow) : null
    if (interaction) {
      await this.recordAuditEvent({
        orgId: interaction.orgId,
        actorType: 'system',
        actorId: input.identityId,
        eventType: 'channel_interaction.used',
        targetType: 'channel_interaction',
        targetId: interaction.interactionId,
        metadata: { kind: interaction.kind, targetId: interaction.targetId },
        createdAt: input.usedAt,
      })
    }
    return interaction
  }

  async resolveChannelInteractionWithCommand(input: ResolveChannelInteractionWithCommandInput) {
    return this.withTransaction(async (client) => {
      const usedAt = nowIso(input.usedAt)
      const selected = input.token
        ? await this.findPendingChannelInteractionRowByToken(input.orgId, input.token, usedAt, client)
        : input.provider && input.externalInteractionId
          ? await this.maybeOne(
            `SELECT * FROM cloud_channel_interactions
             WHERE org_id = $1 AND status = 'pending' AND expires_at > $4
               AND provider = $2 AND external_interaction_id = $3
             FOR UPDATE`,
            [input.orgId, input.provider, input.externalInteractionId, usedAt],
            client,
          )
          : null
      if (!selected) return null
      const interaction = channelInteractionFromRow(selected)
      if (input.command.sessionId !== interaction.sessionId) {
        throw new Error('Channel interaction command session does not match interaction session.')
      }
      await this.requireTenantUser(input.command.tenantId, input.command.userId, client)
      await this.sessions.requireSession(input.command.tenantId, input.command.sessionId, client, true)
      const payload = input.command.payload || {}
      const existingCommand = await this.maybeOne(
        `SELECT * FROM cloud_session_commands WHERE command_id = $1`,
        [input.command.commandId],
        client,
      )
      let command: SessionCommandRecord
      if (existingCommand) {
        command = commandFromRow(existingCommand)
        if (
          command.tenantId !== input.command.tenantId
          || command.userId !== input.command.userId
          || command.sessionId !== input.command.sessionId
          || command.kind !== input.command.kind
          || command.targetLeaseToken !== (input.command.targetLeaseToken ?? null)
          || stableJson(command.payload) !== stableJson(payload)
        ) {
          throw new Error(`Command id ${input.command.commandId} was reused with different content.`)
        }
      } else {
        const createdAt = nowIso(input.command.createdAt)
        const sequence = await this.sessions.incrementSessionCounter(
          client,
          input.command.tenantId,
          input.command.sessionId,
          'next_command_sequence',
        )
        const commandResult = await client.query(
          `INSERT INTO cloud_session_commands (
            command_id, tenant_id, user_id, session_id, kind, payload,
            target_lease_token, created_sequence, created_at, status
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
           RETURNING *`,
          [
            input.command.commandId,
            input.command.tenantId,
            input.command.userId,
            input.command.sessionId,
            input.command.kind,
            JSON.stringify(payload),
            input.command.targetLeaseToken ?? null,
            sequence,
            createdAt,
          ],
        )
        command = commandFromRow(commandResult.rows[0]!)
      }
      const updated = await client.query(
        `UPDATE cloud_channel_interactions
         SET status = 'used', used_at = $2, updated_at = $2
         WHERE interaction_id = $1
         RETURNING *`,
        [interaction.interactionId, usedAt],
      )
      const resolvedInteraction = channelInteractionFromRow(updated.rows[0]!)
      await this.recordAuditEventWithExecutor(client, {
        orgId: resolvedInteraction.orgId,
        actorType: 'system',
        actorId: input.identityId,
        eventType: 'channel_interaction.used',
        targetType: 'channel_interaction',
        targetId: resolvedInteraction.interactionId,
        metadata: { kind: resolvedInteraction.kind, targetId: resolvedInteraction.targetId },
        createdAt: input.usedAt,
      })
      return { interaction: resolvedInteraction, command }
    })
  }

  async createChannelDelivery(input: CreateChannelDeliveryInput) {
    return this.channelDeliveries.create(input)
  }

  async listChannelDeliveries(input: ListChannelDeliveriesInput) {
    return this.channelDeliveries.list(input)
  }

  async claimNextChannelDelivery(input: ClaimChannelDeliveryInput) {
    return this.channelDeliveries.claimNext(input)
  }

  async ackChannelDelivery(input: AckChannelDeliveryInput) {
    return this.channelDeliveries.ack(input)
  }

  async pruneTerminalChannelDeliveries(input: { olderThan: Date; limit: number }) {
    return this.channelDeliveries.pruneTerminal(input)
  }

  async pruneStaleThrottleState(input: { olderThan: Date; limit: number }) {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const cutoff = input.olderThan.getTime()
    const rateLimits = await this.pool.query(
      `DELETE FROM cloud_rate_limits
       WHERE ctid IN (SELECT ctid FROM cloud_rate_limits WHERE window_started_at_ms < $1 ORDER BY window_started_at_ms LIMIT $2)
       RETURNING scope`,
      [cutoff, limit],
    )
    const authFailures = await this.pool.query(
      `DELETE FROM cloud_auth_failures
       WHERE ctid IN (SELECT ctid FROM cloud_auth_failures WHERE blocked_until_ms < $1 ORDER BY blocked_until_ms LIMIT $2)
       RETURNING scope`,
      [cutoff, limit],
    )
    return rateLimits.rows.length + authFailures.rows.length
  }

  async pruneExpiredChannelInteractions(input: { olderThan: Date; limit: number }) {
    // Interaction tokens are one-shot and time-bounded; once expired they can never
    // authenticate again, so deleting expired rows past the cutoff is safe. Bounded
    // by a ctid-keyed subselect so a single batch never locks the whole table.
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const result = await this.pool.query(
      `DELETE FROM cloud_channel_interactions
       WHERE ctid IN (
         SELECT ctid FROM cloud_channel_interactions
         WHERE expires_at < $1
         ORDER BY expires_at
         LIMIT $2
       )
       RETURNING interaction_id`,
      [input.olderThan.toISOString(), limit],
    )
    return result.rows.length
  }

  // Opt-in event-log retention (P1-C3). Each deletes the oldest rows created before the cutoff,
  // bounded by a ctid-keyed subselect (ORDER BY created_at, supported by the 022 indexes) so a
  // single batch never locks the whole table; the scheduler drains in batches.
  async pruneExpiredSessionEvents(input: { olderThan: Date; limit: number }) {
    return this.pruneByCreatedAt('cloud_session_events', 'event_id', input)
  }

  async pruneExpiredAuditEvents(input: { olderThan: Date; limit: number }) {
    return this.pruneByCreatedAt('cloud_audit_events', 'event_id', input)
  }

  async pruneExpiredUsageEvents(input: { olderThan: Date; limit: number }) {
    return this.pruneByCreatedAt('cloud_usage_events', 'event_id', input)
  }

  async pruneExpiredWorkspaceEvents(input: { olderThan: Date; limit: number }) {
    return this.pruneByCreatedAt('cloud_workspace_events', 'event_id', input)
  }

  private async pruneByCreatedAt(table: string, returning: string, input: { olderThan: Date; limit: number }) {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const result = await this.pool.query(
      `DELETE FROM ${table}
       WHERE ctid IN (
         SELECT ctid FROM ${table}
         WHERE created_at < $1
         ORDER BY created_at
         LIMIT $2
       )
       RETURNING ${returning}`,
      [input.olderThan.toISOString(), limit],
    )
    return result.rows.length
  }

  // P2-7: recompute every concurrency gauge from its source table, self-healing any drift left by the
  // old write-clamp. Co-located with the gauge reads in the quotas domain; returns rows touched.
  async reconcileConcurrencyCounters() {
    return reconcilePostgresConcurrencyCounters(this.pool)
  }

  async createCloudCoordinationWatch(input: CreateCloudCoordinationWatchInput): Promise<CoordinationWatch> {
    return this.coordinationWatches.create(input)
  }

  async updateCloudCoordinationWatch(input: UpdateCloudCoordinationWatchInput): Promise<CoordinationWatch | null> {
    return this.coordinationWatches.update(input)
  }

  async getCloudCoordinationWatch(workspaceId: string, watchId: string): Promise<CoordinationWatch | null> {
    return this.coordinationWatches.get(workspaceId, watchId)
  }

  async listCloudCoordinationWatches(input: ListCloudCoordinationWatchesInput): Promise<CoordinationWatch[]> {
    return this.coordinationWatches.list(input)
  }

  async listMatchingCloudCoordinationWatches(input: ListMatchingCloudCoordinationWatchesInput): Promise<CoordinationWatch[]> {
    return this.coordinationWatches.listMatching(input)
  }

  async deleteCloudCoordinationWatch(workspaceId: string, watchId: string): Promise<boolean> {
    return this.coordinationWatches.delete(workspaceId, watchId)
  }

  async claimChannelProviderEvent(input: ClaimChannelProviderEventInput) {
    return this.channelProviderEvents.claim(input)
  }

  async completeChannelProviderEvent(input: CompleteChannelProviderEventInput) {
    return this.channelProviderEvents.complete(input)
  }

  async createSession(input: {
    tenantId: string
    userId: string
    sessionId: string
    opencodeSessionId: string
    profileName: string
    title?: string | null
    createdAt?: Date
    quota?: {
      orgId?: string | null
      maxConcurrentSessionsPerOrg?: number | null
      policyCode?: string
    } | null
  }) {
    return this.sessions.createSession(input)
  }

  async getSession(tenantId: string, userId: string, sessionId: string) {
    return this.sessions.getSession(tenantId, userId, sessionId)
  }

  async getOwnedSessionIds(tenantId: string, userId: string, sessionIds: string[]) {
    return this.sessions.getOwnedSessionIds(tenantId, userId, sessionIds)
  }

  async getSessionForTenant(tenantId: string, sessionId: string) {
    return this.sessions.getSessionForTenant(tenantId, sessionId)
  }

  async findSession(sessionId: string) {
    return this.sessions.findSession(sessionId)
  }

  async listSessions(tenantId: string, userId: string) {
    return this.sessions.listSessions(tenantId, userId)
  }

  async listSessionsPage(input: ListSessionsPageInput) {
    return this.sessions.listSessionsPage(input)
  }

  async listAllSessions() {
    return this.sessions.listAllSessions()
  }

  async listRunnableSessions(input: {
    limit?: number | null
    now?: Date
  } = {}) {
    return this.sessions.listRunnableSessions(input)
  }

  async bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.sessions.bindSessionRuntime(input)
  }

  async updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.sessions.updateSessionStatus(input)
  }

  async appendSessionEvent(input: {
    tenantId: string
    sessionId: string
    eventId?: string
    type: string
    payload?: Record<string, unknown>
    leaseToken?: string | null
    createdAt?: Date
  }) {
    return this.sessions.appendSessionEvent(input)
  }

  async appendProjectedSessionEvent(input: AppendProjectedSessionEventInput) {
    return this.sessions.appendProjectedSessionEvent(input)
  }

  async listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    return this.sessions.listSessionEvents(tenantId, sessionId, afterSequence, limit)
  }
  async listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    return this.sessions.listSessionEventsForStream(tenantId, sessionId, afterSequence, limit)
  }

  async getSessionEventStats(tenantId: string, sessionId: string) {
    return this.sessions.getSessionEventStats(tenantId, sessionId)
  }

  async upsertCloudArtifactIndex(input: Parameters<PostgresSessionIndexesRepository['upsertCloudArtifactIndex']>[0]) {
    return this.sessionIndexes.upsertCloudArtifactIndex(input)
  }

  async getCloudArtifactIndexRecord(input: Parameters<PostgresSessionIndexesRepository['getCloudArtifactIndexRecord']>[0]) {
    return this.sessionIndexes.getCloudArtifactIndexRecord(input)
  }

  async listCloudArtifactIndex(input: Parameters<PostgresSessionIndexesRepository['listCloudArtifactIndex']>[0]) {
    return this.sessionIndexes.listCloudArtifactIndex(input)
  }

  async upsertCloudLaunchpadSessionSummary(input: Parameters<PostgresSessionIndexesRepository['upsertCloudLaunchpadSessionSummary']>[0]) {
    return this.sessionIndexes.upsertCloudLaunchpadSessionSummary(input)
  }

  async listCloudLaunchpadSessionSummaries(input: Parameters<PostgresSessionIndexesRepository['listCloudLaunchpadSessionSummaries']>[0]) {
    return this.sessionIndexes.listCloudLaunchpadSessionSummaries(input)
  }

  async appendWorkspaceEvent(input: AppendWorkspaceEventInput) {
    return this.workspaceEvents.appendWorkspaceEvent(input)
  }

  async listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    return this.workspaceEvents.listWorkspaceEvents(tenantId, userId, afterSequence, limit)
  }

  async listWorkspaceEventsForStream(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    return this.workspaceEvents.listWorkspaceEventsForStream(tenantId, userId, afterSequence, limit)
  }

  async getWorkspaceEventCursor(tenantId: string, userId: string): Promise<WorkspaceEventCursorRecord> {
    return this.workspaceEvents.getWorkspaceEventCursor(tenantId, userId)
  }

  async writeSessionProjection(input: {
    tenantId: string
    sessionId: string
    sequence: number
    view: Record<string, unknown>
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.sessions.writeSessionProjection(input)
  }

  async getSessionProjection(tenantId: string, sessionId: string) {
    return this.sessions.getSessionProjection(tenantId, sessionId)
  }

  async getMaxProjectionLag(): Promise<number> {
    return this.sessions.getMaxProjectionLag()
  }

  async claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
    quota: {
      orgId?: string | null
      maxActiveWorkersPerOrg?: number | null
      policyCode?: string
    } | null = null,
  ) {
    return this.sessions.claimSessionLease(tenantId, sessionId, workerId, now, ttlMs, quota)
  }

  async releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()) {
    return this.sessions.releaseSessionLease(lease, now)
  }

  async recoverSessionLease(lease: WorkerLeaseRecord, input: RecoverSessionLeaseInput = {}) {
    return this.sessions.recoverSessionLease(lease, input)
  }

  async renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000) {
    return this.sessions.renewSessionLease(lease, now, ttlMs)
  }

  async checkpointSession(lease: WorkerLeaseRecord) {
    return this.sessions.checkpointSession(lease)
  }

  async reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): Promise<ReapedSessionLeaseRecord[]> {
    return this.sessions.reapExpiredSessionLeases(input)
  }

  async assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }) {
    return this.sessions.assertSessionCommandQueueQuota(input)
  }

  async enqueueSessionCommand(input: EnqueueCommandInput) {
    return this.sessions.enqueueSessionCommand(input)
  }

  async claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()) {
    return this.sessions.claimNextSessionCommand(lease, now)
  }

  async ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.sessions.ackSessionCommand(lease, commandId, now)
  }

  async checkpointAndAckSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.sessions.checkpointAndAckSessionCommand(lease, commandId, now)
  }

  async failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string) {
    return this.sessions.failSessionCommand(lease, commandId, error)
  }

  async recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }) {
    return this.workerHeartbeats.recordWorkerHeartbeat(input)
  }

  async listWorkerHeartbeats() {
    return this.workerHeartbeats.listWorkerHeartbeats()
  }

  async setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }) {
    return this.settings.setSettingMetadata(input)
  }

  async getSettingMetadata(tenantId: string, keyName: string, userId?: string | null) {
    return this.settings.getSettingMetadata(tenantId, keyName, userId)
  }

  async listSettingMetadata(tenantId: string, userId?: string | null) {
    return this.settings.listSettingMetadata(tenantId, userId)
  }

  async createWorkflow(input: CreateWorkflowInput) {
    return this.workflows.createWorkflow(input)
  }

  async findWorkflow(workflowId: string) {
    return this.workflows.findWorkflow(workflowId)
  }

  async listWorkflows(tenantId: string, userId: string) {
    return this.workflows.listWorkflows(tenantId, userId)
  }

  async listWorkflowsPage(input: ListWorkflowsPageInput) {
    return this.workflows.listWorkflowsPage(input)
  }

  async getWorkflow(tenantId: string, userId: string, workflowId: string) {
    return this.workflows.getWorkflow(tenantId, userId, workflowId)
  }

  async getWorkflowForTenant(tenantId: string, workflowId: string) {
    return this.workflows.getWorkflowForTenant(tenantId, workflowId)
  }

  async updateWorkflowStatus(input: UpdateWorkflowStatusInput) {
    return this.workflows.updateWorkflowStatus(input)
  }

  async listWorkflowRuns(tenantId: string, workflowId: string, limit = 25) {
    return this.workflows.listWorkflowRuns(tenantId, workflowId, limit)
  }

  async listWorkflowRunsForWorkflows(input: ListWorkflowRunsForWorkflowsInput) {
    return this.workflows.listWorkflowRunsForWorkflows(input)
  }

  async createWorkflowRun(input: CreateWorkflowRunInput) {
    return this.workflows.createWorkflowRun(input)
  }

  async claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): Promise<ClaimedWorkflowRunRecord | null> {
    return this.workflows.claimDueWorkflowRun(input)
  }

  async reapExpiredWorkflowClaims(input: ReapExpiredWorkflowClaimsInput = {}): Promise<ReapedWorkflowClaimRecord[]> {
    return this.workflows.reapExpiredWorkflowClaims(input)
  }

  async attachWorkflowRunSession(input: AttachWorkflowRunSessionInput) {
    return this.workflows.attachWorkflowRunSession(input)
  }

  async completeWorkflowRun(input: CompleteWorkflowRunInput) {
    return this.workflows.completeWorkflowRun(input)
  }

  async failWorkflowRun(input: FailWorkflowRunInput) {
    return this.workflows.failWorkflowRun(input)
  }

  async getWorkflowRun(tenantId: string, runId: string) {
    return this.workflows.getWorkflowRun(tenantId, runId)
  }

  async getWorkflowRunBySession(tenantId: string, sessionId: string) {
    return this.workflows.getWorkflowRunBySession(tenantId, sessionId)
  }

  async listThreadTags(tenantId: string) {
    return this.threadIndex.listThreadTags(tenantId)
  }

  async createThreadTag(input: CreateThreadTagInput) {
    return this.threadIndex.createThreadTag(input)
  }

  async updateThreadTag(input: UpdateThreadTagInput) {
    return this.threadIndex.updateThreadTag(input)
  }

  async deleteThreadTag(tenantId: string, tagId: string) {
    return this.threadIndex.deleteThreadTag(tenantId, tagId)
  }

  async applyThreadTags(input: ThreadTagLinkInput) {
    return this.threadIndex.applyThreadTags(input)
  }

  async removeThreadTags(input: ThreadTagLinkInput) {
    return this.threadIndex.removeThreadTags(input)
  }

  async listThreadSmartFilters(tenantId: string) {
    return this.threadIndex.listThreadSmartFilters(tenantId)
  }

  async createThreadSmartFilter(input: CreateThreadSmartFilterInput) {
    return this.threadIndex.createThreadSmartFilter(input)
  }

  async updateThreadSmartFilter(input: UpdateThreadSmartFilterInput) {
    return this.threadIndex.updateThreadSmartFilter(input)
  }

  async deleteThreadSmartFilter(tenantId: string, filterId: string) {
    return this.threadIndex.deleteThreadSmartFilter(tenantId, filterId)
  }

  async listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): Promise<ThreadMetadataRecord[]> {
    return this.threadIndex.listThreadMetadata(input)
  }

  async recordSchemaMigration(id: string, appliedAt = new Date()) {
    await this.pool.query(
      `INSERT INTO cloud_schema_migrations (id, applied_at)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, appliedAt.toISOString()],
    )
    const row = await this.one(
      `SELECT * FROM cloud_schema_migrations WHERE id = $1`,
      [id],
    )
    return migrationFromRow(row)
  }

  async listSchemaMigrations() {
    const result = await this.pool.query(
      `SELECT * FROM cloud_schema_migrations ORDER BY applied_at, id`,
    )
    return result.rows.map(migrationFromRow)
  }

  async claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }) {
    return this.webhooks.claimRequest(input)
  }

  async checkAuthBackoff(input: { scope: string, nowMs: number }) {
    return this.webhooks.checkAuthBackoff(input)
  }

  async recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }) {
    return this.webhooks.recordAuthFailure(input)
  }

  async claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }): Promise<WorkflowWebhookReplayClaim | null> {
    return this.webhooks.claimSignature(input)
  }

  async clear() {
    await this.pool.query('DELETE FROM cloud_managed_worker_heartbeats')
    await this.pool.query('DELETE FROM cloud_worker_credentials')
    await this.pool.query('DELETE FROM cloud_managed_workers')
    await this.pool.query('DELETE FROM cloud_worker_pools')
    await this.pool.query('DELETE FROM cloud_subscriptions')
    await this.pool.query('DELETE FROM cloud_auth_failures')
    await this.pool.query('DELETE FROM cloud_rate_limits')
    await this.pool.query('DELETE FROM cloud_quota_locks')
    await this.pool.query('DELETE FROM cloud_usage_counters')
    await this.pool.query('DELETE FROM cloud_usage_events')
    await this.pool.query('DELETE FROM cloud_webhook_replay_claims')
    await this.pool.query('DELETE FROM cloud_webhook_auth_failures')
    await this.pool.query('DELETE FROM cloud_webhook_rate_limits')
  }

  private async recordAuditEventWithExecutor(
    executor: PgExecutor,
    input: RecordAuditEventInput,
  ): Promise<AuditEventRecord> {
    const eventId = input.eventId || randomRecordId('audit')
    const result = await executor.query(
      `INSERT INTO cloud_audit_events (
        event_id, org_id, account_id, actor_type, actor_id,
        event_type, target_type, target_id, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        eventId,
        input.orgId,
        input.accountId || null,
        input.actorType,
        input.actorId || null,
        input.eventType,
        input.targetType || null,
        input.targetId || null,
        JSON.stringify(redactAuditMetadata(input.metadata)),
        nowIso(input.createdAt),
      ],
    )
    if (result.rows[0]) return auditEventFromRow(result.rows[0])
    const existing = await this.maybeOne(`SELECT * FROM cloud_audit_events WHERE event_id = $1`, [eventId], executor)
    if (!existing) throw new Error(`Audit event ${eventId} was not recorded.`)
    return auditEventFromRow(existing)
  }

  private async recordUsageEventWithExecutor(
    executor: PgExecutor,
    input: RecordUsageEventInput,
  ): Promise<UsageEventRecord> {
    const eventId = input.eventId || randomRecordId('usage')
    const result = await executor.query(
      `INSERT INTO cloud_usage_events (
        event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        eventId,
        input.orgId,
        input.accountId || null,
        input.eventType,
        normalizePositiveInteger(input.quantity || 1, 'Usage quantity'),
        input.unit || 'count',
        JSON.stringify(redactAuditMetadata(input.metadata)),
        nowIso(input.createdAt),
      ],
    )
    if (result.rows[0]) return usageEventFromRow(result.rows[0])
    const existing = await this.maybeOne(`SELECT * FROM cloud_usage_events WHERE event_id = $1`, [eventId], executor)
    if (!existing) throw new Error(`Usage event ${eventId} was not recorded.`)
    return usageEventFromRow(existing)
  }

  private async consumeUsageQuotaWithExecutor(
    executor: PgExecutor,
    input: ConsumeUsageQuotaInput,
  ) {
    const limit = normalizePositiveInteger(input.limit, 'Quota limit')
    const quantity = normalizePositiveInteger(input.quantity || 1, 'Quota quantity')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Quota window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    await executor.query(
      `INSERT INTO cloud_usage_counters (org_id, quota_key, window_started_at_ms, quantity)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (org_id, quota_key) DO NOTHING`,
      [input.orgId, input.quotaKey, startedAtMs],
    )
    const row = await this.one(
      `SELECT * FROM cloud_usage_counters
       WHERE org_id = $1 AND quota_key = $2
       FOR UPDATE`,
      [input.orgId, input.quotaKey],
      executor,
    )
    const currentStartedAtMs = numberValue(row.window_started_at_ms)
    const currentQuantity = currentStartedAtMs === startedAtMs ? numberValue(row.quantity) : 0
    const nextQuantity = currentQuantity + quantity
    const resetMs = retryAfterMs(nowMs, startedAtMs, windowMs)
    const resetAt = new Date(nowMs + resetMs).toISOString()
    if (nextQuantity > limit) {
      return {
        allowed: false,
        orgId: input.orgId,
        quotaKey: input.quotaKey,
        limit,
        used: currentQuantity,
        remaining: Math.max(0, limit - currentQuantity),
        resetAt,
        retryAfterMs: resetMs,
        policyCode: input.policyCode,
      }
    }
    await executor.query(
      `UPDATE cloud_usage_counters
       SET window_started_at_ms = $3, quantity = $4
       WHERE org_id = $1 AND quota_key = $2`,
      [input.orgId, input.quotaKey, startedAtMs, nextQuantity],
    )
    return {
      allowed: true,
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      used: nextQuantity,
      remaining: Math.max(0, limit - nextQuantity),
      resetAt,
      retryAfterMs: resetMs,
      policyCode: input.policyCode,
    }
  }

  private async adjustUsageQuotaWithExecutor(
    executor: PgExecutor,
    input: {
      orgId: string
      quotaKey: string
      windowStartedAtMs: number
      quantityDelta: number
    },
  ) {
    if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) return
    await executor.query(
      `UPDATE cloud_usage_counters
       SET quantity = GREATEST(0, quantity + $4)
       WHERE org_id = $1 AND quota_key = $2 AND window_started_at_ms = $3`,
      [input.orgId, input.quotaKey, input.windowStartedAtMs, input.quantityDelta],
    )
  }

  private async lockQuota(
    executor: PgExecutor,
    orgId: string,
    quotaKey: string,
    now = new Date(),
  ) {
    await executor.query(
      `INSERT INTO cloud_quota_locks (org_id, quota_key, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, quota_key) DO UPDATE
       SET updated_at = EXCLUDED.updated_at`,
      [orgId, quotaKey, now.toISOString()],
    )
    await this.one(
      `SELECT * FROM cloud_quota_locks WHERE org_id = $1 AND quota_key = $2 FOR UPDATE`,
      [orgId, quotaKey],
      executor,
    )
  }

  private async requireTenant(tenantId: string, executor: PgExecutor = this.pool) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_tenants WHERE tenant_id = $1`,
      [tenantId],
      executor,
    )
    if (!row) throw new Error(`Unknown tenant ${tenantId}.`)
    return tenantFromRow(row)
  }

  private async requireTenantUser(
    tenantId: string,
    userId: string,
    executor: PgExecutor = this.pool,
  ) {
    await this.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_users WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
      executor,
    )
    if (!row) throw new Error(`User ${userId} does not belong to tenant ${tenantId}.`)
    return userFromRow(row)
  }

  private async one<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }

  private async withTransaction<T>(fn: (client: PgClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

function randomRecordId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('base64url')}`
}

// Escape LIKE metacharacters in a caller-supplied prefix so an action filter like
// "session_" matches the literal underscore, not any character. Paired with
// ESCAPE '\\' in the query.
function likePrefixEscape(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function createPostgresControlPlaneStore(options: PostgresControlPlaneStoreOptions) {
  return PostgresControlPlaneStore.connect(options)
}
