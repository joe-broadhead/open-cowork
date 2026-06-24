import type { WorkflowWebhookReplayClaim, WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  nowIso,
  stableJson,
  workspaceOperationFromType,
} from './postgres-store-id-helpers.ts'
import {
  normalizeNonNegativeInteger,
  normalizeNullableText,
  normalizePositiveInteger,
  normalizeText,
  optionalTrimmedText,
  redactOperationalText,
  retryAfterMs,
  windowStart,
} from './postgres-store-normalizers.ts'
import {
  generateChannelInteractionToken,
  hashChannelInteractionToken,
  decodeSessionPageCursor,
  encodeSessionPageCursor,
} from './control-plane-store.ts'
import { redactAuditMetadata } from './audit-redaction.ts'
import type {
  CoordinationWatch,
} from '@open-cowork/shared'
import type {
  AttachWorkflowRunSessionInput,
  AppendWorkspaceEventInput,
  AuditEventRecord,
  AckChannelDeliveryInput,
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
  ListSessionsPageInput,
  ManagedWorkerCredentialRecord,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  ListChannelDeliveriesInput,
  PrincipalMembershipRecord,
  RecordManagedWorkerHeartbeatInput,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
  RecordCloudAuthFailureInput,
  RecordUsageEventInput,
  ReapExpiredSessionLeasesInput,
  ReapedSessionLeaseRecord,
  ReapExpiredWorkflowClaimsInput,
  ReapedWorkflowClaimRecord,
  RevokeApiTokenInput,
  RevokeManagedWorkerCredentialInput,
  ResolvedManagedWorkerCredentialRecord,
  ResolveChannelInteractionInput,
  ResolveChannelInteractionWithCommandInput,
  SessionCommandRecord,
  SessionEventRecord,
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
  WorkspaceEventRecord,
  CreateManagedWorkerPoolInput,
  RegisterManagedWorkerInput,
  IssueManagedWorkerCredentialInput,
  ApiTokenChannelBindingGrantRecord,
  ListChannelIdentitiesInput,
} from './control-plane-store.ts'
import { runPostgresControlPlaneMigrations } from './postgres-migrations.ts'
import { cloudPostgresPoolPlan, type CloudPostgresPoolConfig } from './postgres-pool-options.ts'
import { workspaceEventCursorFromRow } from './workspace-event-cursor.ts'
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
  eventFromRow,
  leaseFromRow,
  projectionFromRow,
  sessionFromRow,
  sessionFromRowWithProjectSource,
  workspaceEventFromRow,
} from './postgres-domains/sessions.ts'
import { numberValue, type QueryResult, type QueryRow } from './postgres-domains/shared.ts'
import { assertPostgresCommandEnqueueQuotas, assertPostgresCommandQueueQuota, assertPostgresConcurrentSessionQuota, checkPostgresActiveWorkerQuota, listPostgresRunnableSessions } from './postgres-store-domains/quotas.ts'
import { PostgresBillingRepository } from './postgres-store-domains/billing.ts'
import { PostgresByokSecretsRepository } from './postgres-store-domains/byok.ts'
import { PostgresApiTokensRepository } from './postgres-store-domains/api-tokens.ts'
import { PostgresAuthBackoffRepository } from './postgres-store-domains/auth-backoff.ts'
import { PostgresRateLimitsRepository } from './postgres-store-domains/rate-limits.ts'
import { PostgresThreadIndexRepository } from './postgres-store-domains/thread-index.ts'
import { PostgresWebhooksRepository } from './postgres-store-domains/webhooks.ts'
import { PostgresWorkflowsRepository } from './postgres-store-domains/workflows.ts'
import { PostgresWorkerHeartbeatsRepository } from './postgres-store-domains/worker-heartbeats.ts'
import { PostgresSettingsRepository } from './postgres-store-domains/settings.ts'
import { PostgresChannelBindingsRepository } from './postgres-store-domains/channel-bindings.ts'
import { PostgresHeadlessAgentsRepository } from './postgres-store-domains/headless-agents.ts'
import { PostgresChannelIdentitiesRepository } from './postgres-store-domains/channel-identities.ts'
import { PostgresIdentityRepository } from './postgres-store-domains/identity.ts'
import { PostgresManagedWorkersRepository } from './postgres-store-domains/workers.ts'
import { PostgresChannelProviderEventsRepository } from './postgres-store-domains/channel-provider-events.ts'
import { PostgresChannelDeliveriesRepository } from './postgres-store-domains/channel-deliveries.ts'
import { PostgresCoordinationWatchesRepository } from './postgres-store-domains/coordination-watches.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }
type PgPool = PgExecutor & { connect(): Promise<PgClient>; end(): Promise<void> }

export type PostgresControlPlaneStoreOptions = {
  connectionString: string
  runMigrations?: boolean
  pool?: PgPool
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
  private readonly identity: PostgresIdentityRepository
  private readonly apiTokens: PostgresApiTokensRepository
  private readonly rateLimits: PostgresRateLimitsRepository
  private readonly authBackoff: PostgresAuthBackoffRepository
  private readonly workerHeartbeats: PostgresWorkerHeartbeatsRepository
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
    this.threadIndex = new PostgresThreadIndexRepository({
      pool: this.pool,
      withTransaction: (fn) => this.withTransaction(fn),
      requireTenant: (tenantId, executor) => this.requireTenant(tenantId, executor),
      requireTenantUser: (tenantId, userId, executor) => this.requireTenantUser(tenantId, userId, executor),
      requireSession: (tenantId, sessionId, executor) => this.requireSession(tenantId, sessionId, executor),
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
      assertLeaseTokenIfPresent: (tenantId, sessionId, leaseToken, executor) => this.assertLeaseTokenIfPresent(tenantId, sessionId, leaseToken, executor),
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
  }

  static async connect(options: PostgresControlPlaneStoreOptions) {
    const pool = options.pool || loadPgPool(options.connectionString)
    const store = new PostgresControlPlaneStore(pool, !options.pool)
    if (options.runMigrations !== false) await store.runMigrations()
    return store
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

  async listMembershipsForAccount(accountId: string) {
    return this.identity.listMembershipsForAccount(accountId)
  }

  async resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): Promise<PrincipalMembershipRecord | null> {
    return this.identity.resolvePrincipalMembership(input)
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
        hashChannelInteractionToken(plaintextToken),
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

  async findChannelInteraction(input: FindChannelInteractionInput) {
    const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
    const now = nowIso(input.now)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_interactions
       WHERE org_id = $1
         AND status = 'pending'
         AND expires_at > $5
         AND (
           ($2::text IS NOT NULL AND token_hash = $2)
           OR (
             $3::text IS NOT NULL
             AND $4::text IS NOT NULL
             AND provider = $3
             AND external_interaction_id = $4
           )
         )`,
      [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, now],
    )
    return row ? channelInteractionFromRow(row) : null
  }

  async resolveChannelInteraction(input: ResolveChannelInteractionInput) {
    const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
    const now = nowIso(input.usedAt)
    const result = await this.pool.query(
      `UPDATE cloud_channel_interactions
       SET status = 'used', used_at = $5, updated_at = $5
       WHERE org_id = $1
         AND status = 'pending'
         AND expires_at > $5
         AND (
           ($2::text IS NOT NULL AND token_hash = $2)
           OR (
             $3::text IS NOT NULL
             AND $4::text IS NOT NULL
             AND provider = $3
             AND external_interaction_id = $4
           )
         )
       RETURNING *`,
      [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, now],
    )
    const interaction = result.rows[0] ? channelInteractionFromRow(result.rows[0]) : null
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
      const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
      const usedAt = nowIso(input.usedAt)
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_channel_interactions
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > $5
           AND (
             ($2::text IS NOT NULL AND token_hash = $2)
             OR (
               $3::text IS NOT NULL
               AND $4::text IS NOT NULL
               AND provider = $3
               AND external_interaction_id = $4
             )
           )
         FOR UPDATE`,
        [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, usedAt],
        client,
      )
      if (!selected) return null
      const interaction = channelInteractionFromRow(selected)
      if (input.command.sessionId !== interaction.sessionId) {
        throw new Error('Channel interaction command session does not match interaction session.')
      }
      await this.requireTenantUser(input.command.tenantId, input.command.userId, client)
      await this.requireSession(input.command.tenantId, input.command.sessionId, client, true)
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
        const sequence = await this.incrementSessionCounter(
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
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_sessions WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      if (existing) return sessionFromRow(existing)
      await assertPostgresConcurrentSessionQuota(client, { tenantId: input.tenantId, quota: input.quota, now: input.createdAt }, this.quotaDeps)
      const createdAt = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_sessions (
          tenant_id, session_id, user_id, opencode_session_id, profile_name,
          status, title, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'idle', $6, $7, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.userId,
          input.opencodeSessionId,
          input.profileName,
          input.title || null,
          createdAt,
        ],
      )
      return sessionFromRow(result.rows[0]!)
    })
  }

  async getSession(tenantId: string, userId: string, sessionId: string) {
    await this.requireTenantUser(tenantId, userId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
      [tenantId, userId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async getSessionForTenant(tenantId: string, sessionId: string) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async findSession(sessionId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE session_id = $1 OR opencode_session_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async listSessions(tenantId: string, userId: string) {
    await this.requireTenantUser(tenantId, userId)
    // Defensively bound this per-user read so it can never become an unbounded
    // scan that grows with a user's lifetime session count; the result is ordered
    // most-recent-first, and UI callers that need to page beyond this use
    // listSessionsPage (keyset cursor). Mirrors the listAllSessions cap.
    const result = await this.pool.query(
      `SELECT s.*, p.view -> 'projectSource' AS projection_project_source
       FROM cloud_sessions s
       LEFT JOIN cloud_session_projections p
         ON p.tenant_id = s.tenant_id
        AND p.session_id = s.session_id
       WHERE s.tenant_id = $1 AND s.user_id = $2
       ORDER BY s.updated_at DESC, s.session_id
       LIMIT 1000`,
      [tenantId, userId],
    )
    return result.rows.map(sessionFromRowWithProjectSource)
  }

  async listSessionsPage(input: ListSessionsPageInput) {
    await this.requireTenantUser(input.tenantId, input.userId)
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)))
    const cursor = decodeSessionPageCursor(input.cursor, input)
    const params: unknown[] = [input.tenantId, input.userId]
    const where = ['s.tenant_id = $1', 's.user_id = $2']
    if (input.status) {
      params.push(input.status)
      where.push(`s.status = $${params.length}`)
    }
    if (input.profileName) {
      params.push(input.profileName)
      where.push(`s.profile_name = $${params.length}`)
    }
    const query = input.query?.trim().toLowerCase()
    if (query) {
      params.push(`%${query}%`)
      where.push(`(
        lower(COALESCE(s.title, '')) LIKE $${params.length}
        OR lower(s.session_id) LIKE $${params.length}
        OR lower(s.opencode_session_id) LIKE $${params.length}
        OR lower(s.profile_name) LIKE $${params.length}
      )`)
    }
    if (cursor) {
      params.push(cursor.updatedAt, cursor.sessionId)
      const updatedAtParam = params.length - 1
      const sessionIdParam = params.length
      where.push(`(s.updated_at < $${updatedAtParam} OR (s.updated_at = $${updatedAtParam} AND s.session_id > $${sessionIdParam}))`)
    }
    params.push(limit + 1)
    const result = await this.pool.query(
      `SELECT s.*, p.view -> 'projectSource' AS projection_project_source
       FROM cloud_sessions s
       LEFT JOIN cloud_session_projections p
         ON p.tenant_id = s.tenant_id
        AND p.session_id = s.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.updated_at DESC, s.session_id
       LIMIT $${params.length}`,
      params,
    )
    const rows = result.rows.map(sessionFromRowWithProjectSource)
    const items = rows.slice(0, limit)
    return {
      items,
      nextCursor: rows.length > limit && items.length > 0 ? encodeSessionPageCursor(items[items.length - 1]!, input) : null,
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
    }
  }

  async listAllSessions() {
    // Defensively bound this cross-tenant read so it can never become an unbounded
    // full-table scan; it has no production caller (diagnostics/compat only).
    const result = await this.pool.query(
      `SELECT * FROM cloud_sessions ORDER BY updated_at DESC, tenant_id, session_id LIMIT 1000`,
    )
    return result.rows.map(sessionFromRow)
  }

  async listRunnableSessions(input: {
    limit?: number | null
    now?: Date
  } = {}) {
    return listPostgresRunnableSessions(this.pool, input)
  }

  async claimRunnableSessions(input: {
    workerId: string
    limit?: number | null
    now?: Date
    ttlMs?: number
  }) {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const ttlMs = input.ttlMs ?? 30_000
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    return this.withTransaction(async (client) => {
      const selected = await client.query(
        `SELECT sessions.*, runnable.first_sequence
         FROM cloud_sessions sessions
         JOIN (
           SELECT commands.tenant_id, commands.session_id, min(commands.created_sequence) AS first_sequence
           FROM cloud_session_commands commands
           LEFT JOIN cloud_worker_leases leases
             ON leases.tenant_id = commands.tenant_id
            AND leases.session_id = commands.session_id
           WHERE commands.target_lease_token IS NULL
             AND commands.status IN ('pending', 'running')
             AND (commands.status <> 'pending' OR commands.available_at IS NULL OR commands.available_at <= $2)
             AND (leases.lease_expires_at_ms IS NULL OR leases.lease_expires_at_ms <= $1)
           GROUP BY commands.tenant_id, commands.session_id
           ORDER BY first_sequence, commands.tenant_id, commands.session_id
           LIMIT $3
         ) runnable
           ON runnable.tenant_id = sessions.tenant_id
          AND runnable.session_id = sessions.session_id
         ORDER BY runnable.first_sequence, sessions.tenant_id, sessions.session_id
         FOR UPDATE OF sessions SKIP LOCKED`,
        [nowMs, now.toISOString(), limit],
      )
      // Batch-fetch the current leases for all selected sessions in one query instead
      // of a per-row locking SELECT (the N+1). The CTE already holds `FOR UPDATE OF
      // sessions SKIP LOCKED` on each session, which serializes claims per session, so
      // the per-row lease FOR UPDATE was redundant — an unclaimed session has no
      // concurrent lease mutation (renew/release require a live lease token it lacks).
      const leaseByKey = new Map<string, ReturnType<typeof leaseFromRow>>()
      if (selected.rows.length > 0) {
        const leaseRows = await client.query(
          `SELECT * FROM cloud_worker_leases
           WHERE (tenant_id, session_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
          [selected.rows.map((row) => String(row.tenant_id)), selected.rows.map((row) => String(row.session_id))],
        )
        for (const leaseRow of leaseRows.rows) {
          leaseByKey.set(`${String(leaseRow.tenant_id)} ${String(leaseRow.session_id)}`, leaseFromRow(leaseRow))
        }
      }
      const leases = []
      for (const row of selected.rows) {
        const tenantId = String(row.tenant_id)
        const sessionId = String(row.session_id)
        const currentLease = leaseByKey.get(`${tenantId} ${sessionId}`) || null
        if (currentLease && currentLease.leaseExpiresAt > nowMs) continue
        const attempt = numberValue(row.next_lease_attempt) + 1
        const leaseRecord = {
          tenantId,
          sessionId,
          leasedBy: input.workerId,
          leaseToken: `${tenantId}:${sessionId}:${attempt}:${input.workerId}`,
          leaseExpiresAt: nowMs + ttlMs,
          checkpointVersion: currentLease?.checkpointVersion || 0,
        }
        await client.query(
          `UPDATE cloud_sessions
           SET next_lease_attempt = $3, status = 'running', updated_at = $4
           WHERE tenant_id = $1 AND session_id = $2`,
          [tenantId, sessionId, attempt, now.toISOString()],
        )
        const result = await client.query(
          `INSERT INTO cloud_worker_leases (
            tenant_id, session_id, leased_by, lease_token, lease_expires_at_ms, checkpoint_version
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, session_id) DO UPDATE
           SET leased_by = EXCLUDED.leased_by,
               lease_token = EXCLUDED.lease_token,
               lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
               checkpoint_version = EXCLUDED.checkpoint_version
           RETURNING *`,
          [
            tenantId,
            sessionId,
            leaseRecord.leasedBy,
            leaseRecord.leaseToken,
            leaseRecord.leaseExpiresAt,
            leaseRecord.checkpointVersion,
          ],
        )
        leases.push(leaseFromRow(result.rows[0]!))
      }
      return {
        leases,
        pendingSessionCountEstimate: selected.rows.length,
      }
    })
  }

  async bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `UPDATE cloud_sessions
         SET opencode_session_id = $3,
             title = CASE WHEN $4::boolean THEN $5 ELSE title END,
             updated_at = $6
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.opencodeSessionId,
          input.title !== undefined,
          input.title ?? null,
          updatedAt,
        ],
      )
      if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
      return sessionFromRow(result.rows[0])
    })
  }

  async updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `UPDATE cloud_sessions
         SET status = $3,
             title = CASE WHEN $4::boolean THEN $5 ELSE title END,
             updated_at = $6
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.status,
          input.title !== undefined,
          input.title ?? null,
          updatedAt,
        ],
      )
      if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
      return sessionFromRow(result.rows[0])
    })
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
    return this.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const payload = input.payload || {}
      if (input.eventId) {
        const existing = await this.findEvent(input.tenantId, input.sessionId, input.eventId, client)
        if (existing) return this.replayOrRejectEvent(existing, input.type, payload)
      }
      const createdAt = nowIso(input.createdAt)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_event_sequence',
        createdAt,
      )
      const eventId = input.eventId || `${input.sessionId}:${sequence}`
      const inserted = await client.query(
        `INSERT INTO cloud_session_events (
          tenant_id, session_id, event_id, sequence, type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [input.tenantId, input.sessionId, eventId, sequence, input.type, JSON.stringify(payload), createdAt],
      )
      return eventFromRow(inserted.rows[0]!)
    })
  }

  async listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    await this.requireSession(tenantId, sessionId)
    // `limit` bounds the read for the SSE replay hot path (it paginates by advancing its
    // cursor across polls). Callers that need the full stream (projection rebuild) omit
    // it and get every event.
    const bounded = Number.isInteger(limit) && (limit as number) > 0
    const result = await this.pool.query(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND sequence > $3
       ORDER BY sequence${bounded ? ' LIMIT $4' : ''}`,
      bounded ? [tenantId, sessionId, afterSequence, limit] : [tenantId, sessionId, afterSequence],
    )
    return result.rows.map(eventFromRow)
  }

  async getSessionEventStats(tenantId: string, sessionId: string) {
    await this.requireSession(tenantId, sessionId)
    const row = await this.one<{ count: string | number; latest: string | number }>(
      `SELECT count(*)::int AS count, COALESCE(max(sequence), 0)::int AS latest
       FROM cloud_session_events WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return { count: Number(row.count), latestSequence: Number(row.latest) }
  }

  async appendWorkspaceEvent(input: AppendWorkspaceEventInput) {
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      if (input.sessionId) {
        const session = await this.requireSession(input.tenantId, input.sessionId, client, true)
        if (String(session.user_id) !== input.userId) {
          throw new Error(`Session ${input.sessionId} does not belong to user ${input.userId}.`)
        }
      }

      const payload = input.payload || {}
      const sessionId = input.sessionId || null
      const entityType = optionalTrimmedText(input.entityType) || (sessionId ? 'session' : 'workspace')
      const entityId = optionalTrimmedText(input.entityId) || sessionId || input.userId
      const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
      await client.query(
        `INSERT INTO cloud_workspace_event_counters (tenant_id, user_id, next_sequence)
         VALUES ($1, $2, 0)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [input.tenantId, input.userId],
      )
      const counter = await this.one(
        `SELECT next_sequence
         FROM cloud_workspace_event_counters
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.tenantId, input.userId],
        client,
      )
      if (input.eventId) {
        const existing = await this.findWorkspaceEvent(input.tenantId, input.userId, input.eventId, client)
        if (existing) {
          const projectionVersion = Number.isFinite(input.projectionVersion)
            ? Math.max(0, Math.floor(input.projectionVersion || 0))
            : existing.projectionVersion
          return this.replayOrRejectWorkspaceEvent(existing, input.type, payload, {
            sessionId,
            entityType,
            entityId,
            operation,
            projectionVersion,
          })
        }
      }

      const sequence = numberValue(counter.next_sequence) + 1
      const eventId = input.eventId || `${input.userId}:${sequence}`
      const projectionVersion = Number.isFinite(input.projectionVersion)
        ? Math.max(0, Math.floor(input.projectionVersion || 0))
        : sequence
      await client.query(
        `UPDATE cloud_workspace_event_counters
         SET next_sequence = $3
         WHERE tenant_id = $1 AND user_id = $2`,
        [input.tenantId, input.userId, sequence],
      )
      const createdAt = nowIso(input.createdAt)
      const inserted = await client.query(
        `INSERT INTO cloud_workspace_events (
          tenant_id, user_id, event_id, sequence, session_id,
          entity_type, entity_id, operation, projection_version,
          type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [
          input.tenantId,
          input.userId,
          eventId,
          sequence,
          sessionId,
          entityType,
          entityId,
          operation,
          projectionVersion,
          input.type,
          JSON.stringify(payload),
          createdAt,
        ],
      )
      return workspaceEventFromRow(inserted.rows[0]!)
    })
  }

  async listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    await this.requireTenantUser(tenantId, userId)
    const bounded = Number.isInteger(limit) && (limit as number) > 0
    const result = await this.pool.query(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND sequence > $3
       ORDER BY sequence${bounded ? ' LIMIT $4' : ''}`,
      bounded ? [tenantId, userId, afterSequence, limit] : [tenantId, userId, afterSequence],
    )
    return result.rows.map(workspaceEventFromRow)
  }

  async getWorkspaceEventCursor(tenantId: string, userId: string): Promise<WorkspaceEventCursorRecord> {
    await this.requireTenantUser(tenantId, userId)
    const result = await this.pool.query(
      `SELECT min(sequence) AS earliest_sequence, max(sequence) AS latest_sequence
       FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    )
    return workspaceEventCursorFromRow(result.rows[0])
  }

  async writeSessionProjection(input: {
    tenantId: string
    sessionId: string
    sequence: number
    view: Record<string, unknown>
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const lease = await this.getLease(input.tenantId, input.sessionId, client, true)
      if (lease && lease.leaseToken !== (input.leaseToken ?? null)) {
        throw new Error('Projection write used a stale worker lease.')
      }
      const currentRow = await this.maybeOne(
        `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      const current = currentRow ? projectionFromRow(currentRow) : null
      if (input.sequence < (current?.sequence || 0)) {
        throw new Error('Projection sequence must be monotonic.')
      }
      if (input.sequence === current?.sequence) {
        if (stableJson(current.view) !== stableJson(input.view)) {
          throw new Error('Projection sequence was reused with different content.')
        }
        return current
      }
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_session_projections (tenant_id, session_id, sequence, view, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET sequence = EXCLUDED.sequence, view = EXCLUDED.view, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.tenantId, input.sessionId, input.sequence, JSON.stringify(input.view), updatedAt],
      )
      await client.query(
        `UPDATE cloud_sessions SET updated_at = $3 WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId, updatedAt],
      )
      return projectionFromRow(result.rows[0]!)
    })
  }

  async getSessionProjection(tenantId: string, sessionId: string) {
    await this.requireSession(tenantId, sessionId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? projectionFromRow(row) : null
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
    return this.withTransaction(async (client) => {
      const session = await this.requireSession(tenantId, sessionId, client, true)
      const lease = await this.getLease(tenantId, sessionId, client, true)
      const nowMs = now.getTime()
      if (lease && lease.leaseExpiresAt > nowMs) return null
      if (!(await checkPostgresActiveWorkerQuota(client, { tenantId, quota, nowMs }, this.quotaDeps))) return null
      const attempt = numberValue(session.next_lease_attempt) + 1
      const leaseRecord: WorkerLeaseRecord = {
        tenantId,
        sessionId,
        leasedBy: workerId,
        leaseToken: `${tenantId}:${sessionId}:${attempt}:${workerId}`,
        leaseExpiresAt: nowMs + ttlMs,
        checkpointVersion: lease?.checkpointVersion || 0,
      }
      await client.query(
        `UPDATE cloud_sessions
         SET next_lease_attempt = $3, status = 'running', updated_at = $4
         WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId, attempt, now.toISOString()],
      )
      const result = await client.query(
        `INSERT INTO cloud_worker_leases (
          tenant_id, session_id, leased_by, lease_token, lease_expires_at_ms, checkpoint_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET leased_by = EXCLUDED.leased_by,
             lease_token = EXCLUDED.lease_token,
             lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
             checkpoint_version = EXCLUDED.checkpoint_version
         RETURNING *`,
        [
          tenantId,
          sessionId,
          leaseRecord.leasedBy,
          leaseRecord.leaseToken,
          leaseRecord.leaseExpiresAt,
          leaseRecord.checkpointVersion,
        ],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()) {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM cloud_worker_leases
         WHERE tenant_id = $1
           AND session_id = $2
           AND lease_token = $3
         RETURNING lease_token`,
        [lease.tenantId, lease.sessionId, lease.leaseToken],
      )
      if (!result.rows[0]) return false
      await client.query(
        `UPDATE cloud_sessions
         SET status = 'idle', updated_at = $3
         WHERE tenant_id = $1
           AND session_id = $2`,
        [lease.tenantId, lease.sessionId, nowIso(now)],
      )
      return true
    })
  }

  async renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET lease_expires_at_ms = $3
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId, now.getTime() + ttlMs],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async checkpointSession(lease: WorkerLeaseRecord) {
    return this.withTransaction(async (client) => {
      const current = await this.assertCurrentLease(lease, client)
      if (lease.checkpointVersion !== current.checkpointVersion) {
        throw new Error('Checkpoint version is stale.')
      }
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET checkpoint_version = checkpoint_version + 1
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): Promise<ReapedSessionLeaseRecord[]> {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxCommandAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    return this.withTransaction(async (client) => {
      const expired = await client.query(
        `SELECT *
         FROM cloud_worker_leases
         WHERE lease_expires_at_ms <= $1
         ORDER BY lease_expires_at_ms ASC, tenant_id, session_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowMs, limit],
      )
      const reaped: ReapedSessionLeaseRecord[] = []
      for (const row of expired.rows) {
        const lease = leaseFromRow(row)
        const commands = await client.query(
          `SELECT *
           FROM cloud_session_commands
           WHERE tenant_id = $1
             AND session_id = $2
             AND status = 'running'
             AND claimed_lease_token = $3
           ORDER BY created_sequence
           FOR UPDATE`,
          [lease.tenantId, lease.sessionId, lease.leaseToken],
        )
        const retriedCommandIds: string[] = []
        const failedCommandIds: string[] = []
        for (const commandRow of commands.rows) {
          const command = commandFromRow(commandRow)
          if (command.attemptCount >= maxAttempts) {
            const summary = 'Worker lease expired after the maximum retry attempts.'
            await client.query(
              `UPDATE cloud_session_commands
               SET status = 'failed',
                   error = $2,
                   last_error_code = 'lease_expired_max_attempts',
                   last_error_summary = $2
               WHERE command_id = $1`,
              [command.commandId, summary],
            )
            failedCommandIds.push(command.commandId)
          } else {
            await client.query(
              `UPDATE cloud_session_commands
               SET status = 'pending',
                   claimed_by = NULL,
                   claimed_lease_token = NULL,
                   available_at = $2,
                   error = NULL,
                   last_error_code = 'lease_expired',
                   last_error_summary = 'Worker lease expired before command completion.'
               WHERE command_id = $1`,
              [command.commandId, nowIsoValue],
            )
            retriedCommandIds.push(command.commandId)
          }
        }
        await client.query(
          `DELETE FROM cloud_worker_leases
           WHERE tenant_id = $1 AND session_id = $2 AND lease_token = $3`,
          [lease.tenantId, lease.sessionId, lease.leaseToken],
        )
        const action: ReapedSessionLeaseRecord['action'] = failedCommandIds.length > 0 && retriedCommandIds.length === 0
          ? 'failed'
          : retriedCommandIds.length > 0
            ? 'retried'
            : 'released'
        await client.query(
          `UPDATE cloud_sessions
           SET status = $3, updated_at = $4
           WHERE tenant_id = $1 AND session_id = $2`,
          [
            lease.tenantId,
            lease.sessionId,
            action === 'failed' ? 'errored' : 'idle',
            nowIsoValue,
          ],
        )
        const org = await this.maybeOne(
          `SELECT org_id FROM cloud_orgs WHERE tenant_id = $1 OR org_id = $1 LIMIT 1`,
          [lease.tenantId],
          client,
        )
        if (org) {
          await this.recordAuditEventWithExecutor(client, {
            orgId: String(org.org_id),
            actorType: 'system',
            actorId: 'managed-work-reaper',
            eventType: 'managed_work.session_lease_reaped',
            targetType: 'session',
            targetId: lease.sessionId,
            metadata: {
              action,
              leasedBy: lease.leasedBy,
              retriedCommandIds,
              failedCommandIds,
            },
            createdAt: now,
          })
        }
        reaped.push({
          tenantId: lease.tenantId,
          sessionId: lease.sessionId,
          leaseToken: lease.leaseToken,
          leasedBy: lease.leasedBy,
          action,
          retriedCommandIds,
          failedCommandIds,
          reapedAt: nowIsoValue,
        })
      }
      return reaped
    })
  }

  async assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }) {
    await this.withTransaction(async (client) => {
      await assertPostgresCommandQueueQuota(client, input, this.quotaDeps)
    })
  }

  async enqueueSessionCommand(input: EnqueueCommandInput) {
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      const payload = input.payload || {}
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_session_commands WHERE command_id = $1`,
        [input.commandId],
        client,
      )
      if (existing) {
        const command = commandFromRow(existing)
        if (
          command.tenantId !== input.tenantId
          || command.userId !== input.userId
          || command.sessionId !== input.sessionId
          || command.kind !== input.kind
          || command.targetLeaseToken !== (input.targetLeaseToken ?? null)
          || stableJson(command.payload) !== stableJson(payload)
        ) {
          throw new Error(`Command id ${input.commandId} was reused with different content.`)
        }
        return command
      }
      const createdAt = nowIso(input.createdAt)
      await assertPostgresCommandEnqueueQuotas(client, {
        tenantId: input.tenantId,
        queueQuota: input.quota,
        usageQuotas: input.usageQuotas,
        now: new Date(createdAt),
      }, this.quotaDeps)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_command_sequence',
      )
      const result = await client.query(
        `INSERT INTO cloud_session_commands (
          command_id, tenant_id, user_id, session_id, kind, payload,
          target_lease_token, created_sequence, created_at, status
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
         RETURNING *`,
        [
          input.commandId,
          input.tenantId,
          input.userId,
          input.sessionId,
          input.kind,
          JSON.stringify(payload),
          input.targetLeaseToken ?? null,
          sequence,
          createdAt,
        ],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client, now.getTime())
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_session_commands
         WHERE tenant_id = $1
           AND session_id = $2
           AND (
             (status = 'pending'
                AND (available_at IS NULL OR available_at <= $4)
                AND (target_lease_token IS NULL OR target_lease_token = $3))
             OR (status = 'running' AND claimed_lease_token <> $3 AND target_lease_token IS NULL)
           )
         ORDER BY created_sequence
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [lease.tenantId, lease.sessionId, lease.leaseToken, now.toISOString()],
        client,
      )
      if (!selected) return null
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'running',
             claimed_by = $2,
             claimed_lease_token = $3,
             attempt_count = attempt_count + 1,
             available_at = NULL,
             last_error_code = NULL,
             last_error_summary = NULL
         WHERE command_id = $1
         RETURNING *`,
        [String(selected.command_id), lease.leasedBy, lease.leaseToken],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status === 'acked') return command
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'acked',
             acked_at = $2,
             error = NULL,
             last_error_code = NULL,
             last_error_summary = NULL
         WHERE command_id = $1
         RETURNING *`,
        [commandId, now.toISOString()],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'failed',
             error = $2,
             last_error_code = 'execution_failed',
             last_error_summary = $3
         WHERE command_id = $1
         RETURNING *`,
        [commandId, error, redactOperationalText(error, 512, 'Command error')],
      )
      return commandFromRow(result.rows[0]!)
    })
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

  private async requireSession(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor = this.pool,
    forUpdate = false,
  ) {
    await this.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    if (!row) throw new Error(`Unknown session ${sessionId}.`)
    return row
  }

  private async requireCommand(commandId: string, executor: PgExecutor, forUpdate = false) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_commands
       WHERE command_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [commandId],
      executor,
    )
    if (!row) throw new Error(`Unknown command ${commandId}.`)
    return commandFromRow(row)
  }

  private async assertCurrentLease(lease: WorkerLeaseRecord, executor: PgExecutor, nowMs = Date.now()) {
    const current = await this.getLease(lease.tenantId, lease.sessionId, executor, true)
    if (!current || current.leaseToken !== lease.leaseToken || current.leaseExpiresAt <= nowMs) {
      throw new Error('Worker lease is stale.')
    }
    return current
  }

  private async assertLeaseTokenIfPresent(
    tenantId: string,
    sessionId: string,
    leaseToken: string | null | undefined,
    executor: PgExecutor,
  ) {
    if (leaseToken === undefined) return
    const current = await this.getLease(tenantId, sessionId, executor, true)
    if (!current || current.leaseToken !== leaseToken || current.leaseExpiresAt <= Date.now()) {
      throw new Error('Worker lease is stale.')
    }
  }

  private async getLease(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor,
    forUpdate = false,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_worker_leases
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    return row ? leaseFromRow(row) : null
  }

  private async findEvent(
    tenantId: string,
    sessionId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND event_id = $3`,
      [tenantId, sessionId, eventId],
      executor,
    )
    return row ? eventFromRow(row) : null
  }

  private async findWorkspaceEvent(
    tenantId: string,
    userId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND event_id = $3`,
      [tenantId, userId, eventId],
      executor,
    )
    return row ? workspaceEventFromRow(row) : null
  }

  private replayOrRejectEvent(
    existing: SessionEventRecord,
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (existing.type !== type || stableJson(existing.payload) !== stableJson(payload)) {
      throw new Error(`Event id ${existing.eventId} was reused with different content.`)
    }
    return existing
  }

  private replayOrRejectWorkspaceEvent(
    existing: WorkspaceEventRecord,
    type: string,
    payload: Record<string, unknown>,
    expected: {
      sessionId: string | null
      entityType: string
      entityId: string
      operation: string
      projectionVersion: number
    },
  ) {
    if (
      existing.type !== type
      || stableJson(existing.payload) !== stableJson(payload)
      || existing.sessionId !== expected.sessionId
      || existing.entityType !== expected.entityType
      || existing.entityId !== expected.entityId
      || existing.operation !== expected.operation
      || existing.projectionVersion !== expected.projectionVersion
    ) {
      throw new Error(`Workspace event id ${existing.eventId} was reused with different content.`)
    }
    return existing
  }

  private async incrementSessionCounter(
    executor: PgExecutor,
    tenantId: string,
    sessionId: string,
    field: 'next_event_sequence' | 'next_command_sequence',
    updatedAt?: string,
  ) {
    const setUpdatedAt = updatedAt ? ', updated_at = $3' : ''
    const values = updatedAt ? [tenantId, sessionId, updatedAt] : [tenantId, sessionId]
    const result = await executor.query(
      `UPDATE cloud_sessions
       SET ${field} = ${field} + 1${setUpdatedAt}
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING ${field}`,
      values,
    )
    return numberValue(result.rows[0]?.[field])
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

export async function createPostgresControlPlaneStore(options: PostgresControlPlaneStoreOptions) {
  return PostgresControlPlaneStore.connect(options)
}
