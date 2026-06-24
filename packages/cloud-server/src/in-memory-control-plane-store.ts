import { redactOperationalText } from './operational-text-redaction.ts'
import { normalizeCloudProjectSource, summarizeCloudProjectSource, type CoordinationWatch } from '@open-cowork/shared'
import { publicQuotaMessage, quotaExceeded, type QuotaPolicyCode } from './control-plane-errors.ts'
import type {
  CreateManagedWorkerPoolInput,
  IssueManagedWorkerCredentialInput,
  IssuedManagedWorkerCredentialRecord,
  ManagedWorkerCredentialRecord,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  RecordManagedWorkerHeartbeatInput,
  RegisterManagedWorkerInput,
  ResolvedManagedWorkerCredentialRecord,
  RevokeManagedWorkerCredentialInput,
  UpdateManagedWorkerPoolInput,
  UpdateManagedWorkerStatusInput,
} from './managed-worker-types.ts'
import { InMemoryManagedWorkersDomain } from './in-memory-domains/workers.ts'
import { InMemoryQuotaDomain } from './in-memory-domains/quotas.ts'
import { InMemoryChannelProviderEventsDomain } from './in-memory-domains/channel-provider-events.ts'
import { InMemoryChannelDeliveriesDomain } from './in-memory-domains/channel-deliveries.ts'
import { InMemoryCoordinationWatchesDomain } from './in-memory-domains/coordination-watches.ts'
import { InMemoryChannelIdentitiesDomain } from './in-memory-domains/channel-identities.ts'
import { InMemoryByokSecretsDomain } from './in-memory-domains/byok-secrets.ts'
import { InMemoryBillingDomain } from './in-memory-domains/billing.ts'
import { InMemoryUsageDomain } from './in-memory-domains/usage-events.ts'
import { InMemoryHeadlessAgentsDomain } from './in-memory-domains/headless-agents.ts'
import { InMemorySmartFiltersDomain } from './in-memory-domains/thread-smart-filters.ts'
import { InMemoryThreadTagsDomain } from './in-memory-domains/thread-tags.ts'
import { InMemorySchemaMigrationsDomain } from './in-memory-domains/schema-migrations.ts'
import { InMemoryWorkerHeartbeatsDomain } from './in-memory-domains/worker-heartbeats.ts'
import { InMemoryAuthBackoffDomain } from './in-memory-domains/auth-backoff.ts'
import { InMemoryRateLimitsDomain } from './in-memory-domains/rate-limits.ts'
import { InMemoryUsageQuotaDomain } from './in-memory-domains/usage-quota.ts'
import { InMemoryWorkspaceEventsDomain } from './in-memory-domains/workspace-events.ts'
import { InMemoryAuditDomain } from './in-memory-domains/audit.ts'
import { InMemoryChannelBindingsDomain } from './in-memory-domains/channel-bindings.ts'
import { InMemoryIdentityDomain } from './in-memory-domains/identity.ts'
import { InMemoryApiTokensDomain } from './in-memory-domains/api-tokens.ts'
import { InMemorySettingsDomain } from './in-memory-domains/settings.ts'
import { InMemoryWorkflowsDomain } from './in-memory-domains/workflows.ts'
import {
  clone,
  key,
  normalizeListLimit,
  normalizeNonNegativeInteger,
  normalizeNullableText,
  normalizeText,
  nowIso,
  stableJson,
} from './in-memory-domains/store-helpers.ts'
import {
  generateChannelInteractionToken,
  hashChannelInteractionToken,
} from './control-plane-tokens.ts'
import { decodeSessionPageCursor, encodeSessionPageCursor } from './session-page-cursor.ts'
import type { WorkspaceEventCursorRecord } from './workspace-event-cursor.ts'
import { channelThreadKey, normalizeChannelProviderId as normalizeProvider } from './channel-provider-utils.ts'
import type { ChannelProviderEventClaimResult, ChannelProviderEventRecord, ChannelProviderId, ClaimChannelProviderEventInput, CompleteChannelProviderEventInput } from './channel-provider-types.ts'
import type { CreateCloudCoordinationWatchInput, ListCloudCoordinationWatchesInput, ListMatchingCloudCoordinationWatchesInput, UpdateCloudCoordinationWatchInput } from './coordination-watch-records.ts'
import type {
  ControlPlaneRole,
  ControlPlaneSessionStatus,
  WorkReaperAction,
  WorkerRole,
} from './control-plane-enums.ts'
import type {
  AccountRecord,
  MembershipRecord,
  OrgMemberRecord,
  OrgRecord,
  PrincipalMembershipRecord,
  TenantRecord,
  UserRecord,
} from './control-plane-records.ts'
import type {
  BillingSubscriptionRecord,
  CloudAuthBackoffRecord,
  QuotaConsumptionRecord,
  RateLimitClaimRecord,
  UsageEventRecord,
  UsageQuotaCounterRecord,
} from './control-plane-usage-records.ts'
import type {
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelSessionBindingRecord,
  IssuedChannelInteractionRecord,
} from './control-plane-channel-records.ts'
import type {
  ApiTokenChannelBindingGrantRecord,
  ApiTokenRecord,
  AuditEventRecord,
  ByokSecretRecord,
  HeadlessAgentRecord,
  IssuedApiTokenRecord,
} from './control-plane-auth-records.ts'
import type {
  ListSessionsPageInput,
  ListSessionsPageRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  WorkerLeaseRecord,
  WorkspaceEventRecord,
} from './control-plane-session-records.ts'
import type {
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  SchemaMigrationRecord,
  SettingMetadataRecord,
  ThreadMetadataRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
} from './control-plane-workspace-records.ts'
import type {
  ClaimRunnableSessionsInput,
  ListRunnableSessionsInput,
  ReapExpiredSessionLeasesInput,
  ReapExpiredWorkflowClaimsInput,
  ReapedSessionLeaseRecord,
  ReapedWorkflowClaimRecord,
  RunnableSessionClaimRecord,
  RunnableSessionListRecord,
  SessionCommandRecord,
  WorkerHeartbeatRecord,
} from './control-plane-worker-records.ts'
import type {
  CreateAccountInput,
  CreateByokSecretInput,
  DisableByokSecretInput,
  GrantApiTokenChannelBindingInput,
  IssueApiTokenInput,
  ListApiTokenChannelBindingGrantsInput,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
  RevokeApiTokenInput,
  UpsertMembershipInput,
} from './control-plane-account-inputs.ts'
import type {
  CheckCloudAuthBackoffInput,
  ClaimRateLimitInput,
  ConsumeUsageQuotaInput,
  CreateSessionInput,
  RecordCloudAuthFailureInput,
  RecordUsageEventInput,
  UpsertBillingSubscriptionInput,
} from './control-plane-usage-inputs.ts'
import type {
  AppendEventInput,
  AppendWorkspaceEventInput,
  CommandQueueQuota,
  EnqueueCommandInput,
  WriteProjectionInput,
} from './control-plane-event-inputs.ts'
import type {
  AckChannelDeliveryInput,
  BindChannelSessionInput,
  ChannelCursorUpdateResult,
  ClaimChannelDeliveryInput,
  CreateChannelBindingInput,
  CreateChannelDeliveryInput,
  CreateChannelInteractionInput,
  FindChannelInteractionInput,
  ListChannelDeliveriesInput,
  ListChannelIdentitiesInput,
  ResolveChannelInteractionInput,
  ResolveChannelInteractionWithCommandInput,
  UpdateChannelBindingInput,
  UpdateChannelCursorInput,
  UpsertChannelIdentityInput,
} from './control-plane-channel-inputs.ts'
import type {
  AttachWorkflowRunSessionInput,
  ClaimDueWorkflowRunInput,
  CompleteWorkflowRunInput,
  CreateHeadlessAgentInput,
  CreateThreadSmartFilterInput,
  CreateThreadTagInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  FailWorkflowRunInput,
  ThreadTagLinkInput,
  UpdateHeadlessAgentInput,
  UpdateThreadSmartFilterInput,
  UpdateThreadTagInput,
  UpdateWorkflowStatusInput,
} from './control-plane-workflow-inputs.ts'
import type { ControlPlaneStore } from './control-plane-store-contract.ts'
export type { ControlPlaneStore, MaybePromise } from './control-plane-store-contract.ts'
export { ControlPlaneQuotaExceededError, publicQuotaMessage } from './control-plane-errors.ts'
export type { QuotaPolicyCode } from './control-plane-errors.ts'
export type {
  CreateManagedWorkerPoolInput,
  IssueManagedWorkerCredentialInput,
  IssuedManagedWorkerCredentialRecord,
  ManagedWorkerCredentialRecord,
  ManagedWorkerCredentialScope,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolMode,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  RecordManagedWorkerHeartbeatInput,
  RegisterManagedWorkerInput,
  ResolvedManagedWorkerCredentialRecord,
  RevokeManagedWorkerCredentialInput,
  UpdateManagedWorkerPoolInput,
  UpdateManagedWorkerStatusInput,
} from './managed-worker-types.ts'
export { generateManagedWorkerCredential, hashManagedWorkerCredential } from './in-memory-domains/workers.ts'
export type { CreateCloudCoordinationWatchInput, ListCloudCoordinationWatchesInput, ListMatchingCloudCoordinationWatchesInput, UpdateCloudCoordinationWatchInput } from './coordination-watch-records.ts'
export {
  generateChannelInteractionToken,
  generateCloudApiToken,
  hashChannelInteractionToken,
  hashCloudApiToken,
  plaintextMatchesCloudApiTokenId,
  verifyCloudApiTokenHash,
} from './control-plane-tokens.ts'

type SessionState = {
  record: SessionRecord
  nextEventSequence: number
  nextCommandSequence: number
  nextLeaseAttempt: number
  lease: WorkerLeaseRecord | null
  events: SessionEventRecord[]
  projection: SessionProjectionRecord | null
  commands: SessionCommandRecord[]
}

const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const CHANNEL_TEXT_MAX_LENGTH = 256


function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly channelSessionBindings = new Map<string, ChannelSessionBindingRecord>()
  private readonly channelSessionBindingsByThread = new Map<string, string>()
  private readonly channelInteractions = new Map<string, ChannelInteractionRecord>()
  private readonly channelInteractionsByTokenHash = new Map<string, string>()
  private readonly channelInteractionsByExternal = new Map<string, string>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly managedWorkersDomain = new InMemoryManagedWorkersDomain({
    orgTenantId: (orgId) => this.orgTenantId(orgId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly quotaDomain = new InMemoryQuotaDomain({
    resolveOrgId: (tenantId) => this.orgIdForTenant(tenantId),
    sessions: () => this.sessions.values(),
    workflowRuns: () => this.workflowsDomain.allRuns(),
    consumeUsageQuota: (input) => this.consumeUsageQuota(input),
  })
  private readonly channelProviderEventsDomain = new InMemoryChannelProviderEventsDomain({
    orgExists: (orgId) => this.orgExists(orgId),
  })
  private readonly channelIdentitiesDomain = new InMemoryChannelIdentitiesDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    accountExists: (accountId) => this.accountExists(accountId),
  })
  private readonly channelDeliveriesDomain = new InMemoryChannelDeliveriesDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    getHeadlessAgent: (orgId, agentId) => this.getHeadlessAgent(orgId, agentId),
    getChannelBinding: (orgId, bindingId) => this.getChannelBinding(orgId, bindingId),
    getChannelSessionBinding: (orgId, bindingId) => {
      const binding = this.channelSessionBindings.get(bindingId)
      return binding?.orgId === orgId ? binding : null
    },
    consumeUsageQuota: (input) => this.consumeUsageQuota(input),
  })
  private readonly coordinationWatchesDomain = new InMemoryCoordinationWatchesDomain()
  private readonly workflowsDomain = new InMemoryWorkflowsDomain({
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
    requireTenantUser: (tenantId, userId) => { this.requireTenantUser(tenantId, userId) },
    assertWorkflowRunQuota: (input) => { this.quotaDomain.assertWorkflowRunQuota(input) },
    sessionHasCommands: (tenantId, sessionId) => this.sessionHasCommands(tenantId, sessionId),
    assertSessionLease: (tenantId, sessionId, leaseToken) => { this.assertSessionLease(tenantId, sessionId, leaseToken) },
  })
  private readonly settingsDomain = new InMemorySettingsDomain({
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
    requireTenantUser: (tenantId, userId) => { this.requireTenantUser(tenantId, userId) },
  })
  private readonly apiTokensDomain = new InMemoryApiTokensDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    accountExists: (accountId) => this.accountExists(accountId),
    getChannelBinding: (orgId, bindingId) => this.getChannelBinding(orgId, bindingId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly schemaMigrationsDomain = new InMemorySchemaMigrationsDomain()
  private readonly workerHeartbeatsDomain = new InMemoryWorkerHeartbeatsDomain()
  private readonly authBackoffDomain = new InMemoryAuthBackoffDomain()
  private readonly rateLimitsDomain = new InMemoryRateLimitsDomain()
  private readonly identityDomain = new InMemoryIdentityDomain({
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly channelBindingsDomain = new InMemoryChannelBindingsDomain({
    getHeadlessAgent: (orgId, agentId) => this.getHeadlessAgent(orgId, agentId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly auditDomain = new InMemoryAuditDomain({
    orgExists: (orgId) => this.orgExists(orgId),
  })
  private readonly workspaceEventsDomain = new InMemoryWorkspaceEventsDomain({
    requireTenantUser: (tenantId, userId) => { this.requireTenantUser(tenantId, userId) },
    assertSessionBelongsToUser: (tenantId, sessionId, userId) => { this.assertSessionBelongsToUser(tenantId, sessionId, userId) },
  })
  private readonly usageQuotaDomain = new InMemoryUsageQuotaDomain({
    orgExists: (orgId) => this.orgExists(orgId),
  })
  private readonly threadTagsDomain = new InMemoryThreadTagsDomain({
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
    requireSession: (tenantId, sessionId) => { this.requireSession(tenantId, sessionId) },
  })
  private readonly smartFiltersDomain = new InMemorySmartFiltersDomain({
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
  })
  private readonly headlessAgentsDomain = new InMemoryHeadlessAgentsDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    accountExists: (accountId) => this.accountExists(accountId),
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly usageDomain = new InMemoryUsageDomain({
    orgExists: (orgId) => this.orgExists(orgId),
  })
  private readonly billingDomain = new InMemoryBillingDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly byokSecretsDomain = new InMemoryByokSecretsDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    accountExists: (accountId) => this.accountExists(accountId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })

  createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }): TenantRecord {
    return this.identityDomain.createTenant(input)
  }

  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): UserRecord {
    return this.identityDomain.ensureUser(input)
  }

  ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }): OrgRecord {
    return this.identityDomain.ensureOrgForTenant(input)
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    return this.identityDomain.createAccount(input)
  }

  findAccountBySubject(idpSubject: string): AccountRecord | null {
    return this.identityDomain.findAccountBySubject(idpSubject)
  }

  findAccountByEmail(email: string): AccountRecord | null {
    return this.identityDomain.findAccountByEmail(email)
  }

  upsertMembership(input: UpsertMembershipInput): MembershipRecord {
    return this.identityDomain.upsertMembership(input)
  }

  listOrgMembers(orgId: string, input: { query?: string | null, limit?: number | null } = {}): OrgMemberRecord[] {
    return this.identityDomain.listOrgMembers(orgId, input)
  }

  listMembershipsForAccount(accountId: string): MembershipRecord[] {
    return this.identityDomain.listMembershipsForAccount(accountId)
  }

  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): PrincipalMembershipRecord | null {
    return this.identityDomain.resolvePrincipalMembership(input)
  }

  orgExists(orgId: string): boolean {
    return this.identityDomain.orgExists(orgId)
  }

  accountExists(accountId: string): boolean {
    return this.identityDomain.accountExists(accountId)
  }

  private requireTenant(tenantId: string) {
    return this.identityDomain.requireTenant(tenantId)
  }

  private requireTenantUser(tenantId: string, userId: string) {
    return this.identityDomain.requireTenantUser(tenantId, userId)
  }

  private orgIdForTenant(tenantId: string) {
    return this.identityDomain.orgIdForTenant(tenantId)
  }

  private orgTenantId(orgId: string): string | null {
    return this.identityDomain.orgTenantId(orgId)
  }

  private resolveOrgIdOrNull(tenantId: string): string | null {
    return this.identityDomain.resolveOrgIdOrNull(tenantId)
  }

  issueApiToken(input: IssueApiTokenInput): IssuedApiTokenRecord {
    return this.apiTokensDomain.issueApiToken(input)
  }

  listApiTokens(orgId: string): ApiTokenRecord[] {
    return this.apiTokensDomain.listApiTokens(orgId)
  }

  findApiTokenByPlaintext(plaintext: string, now = new Date()): ApiTokenRecord | null {
    return this.apiTokensDomain.findApiTokenByPlaintext(plaintext, now)
  }

  revokeApiToken(input: RevokeApiTokenInput): ApiTokenRecord | null {
    return this.apiTokensDomain.revokeApiToken(input)
  }

  grantApiTokenChannelBinding(input: GrantApiTokenChannelBindingInput): ApiTokenChannelBindingGrantRecord {
    return this.apiTokensDomain.grantApiTokenChannelBinding(input)
  }

  listApiTokenChannelBindingGrants(input: ListApiTokenChannelBindingGrantsInput): ApiTokenChannelBindingGrantRecord[] {
    return this.apiTokensDomain.listApiTokenChannelBindingGrants(input)
  }

  createManagedWorkerPool(input: CreateManagedWorkerPoolInput): ManagedWorkerPoolRecord {
    return this.managedWorkersDomain.createPool(input)
  }

  updateManagedWorkerPool(input: UpdateManagedWorkerPoolInput): ManagedWorkerPoolRecord | null {
    return this.managedWorkersDomain.updatePool(input)
  }

  getManagedWorkerPool(orgId: string, poolId: string): ManagedWorkerPoolRecord | null {
    return this.managedWorkersDomain.getPool(orgId, poolId)
  }

  listManagedWorkerPools(orgId: string, input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {}): ManagedWorkerPoolRecord[] {
    return this.managedWorkersDomain.listPools(orgId, input)
  }

  registerManagedWorker(input: RegisterManagedWorkerInput): ManagedWorkerRecord {
    return this.managedWorkersDomain.registerWorker(input)
  }

  updateManagedWorkerStatus(input: UpdateManagedWorkerStatusInput): ManagedWorkerRecord | null {
    return this.managedWorkersDomain.updateWorkerStatus(input)
  }

  getManagedWorker(orgId: string, workerId: string): ManagedWorkerRecord | null {
    return this.managedWorkersDomain.getWorker(orgId, workerId)
  }

  listManagedWorkers(orgId: string, input: { poolId?: string | null, status?: ManagedWorkerStatus | null, limit?: number | null } = {}): ManagedWorkerRecord[] {
    return this.managedWorkersDomain.listWorkers(orgId, input)
  }

  issueManagedWorkerCredential(input: IssueManagedWorkerCredentialInput): IssuedManagedWorkerCredentialRecord {
    return this.managedWorkersDomain.issueCredential(input)
  }

  listManagedWorkerCredentials(orgId: string, workerId: string): ManagedWorkerCredentialRecord[] {
    return this.managedWorkersDomain.listCredentials(orgId, workerId)
  }

  findManagedWorkerCredentialByPlaintext(plaintext: string, now = new Date()): ResolvedManagedWorkerCredentialRecord | null {
    return this.managedWorkersDomain.findCredentialByPlaintext(plaintext, now)
  }

  revokeManagedWorkerCredential(input: RevokeManagedWorkerCredentialInput): ManagedWorkerCredentialRecord | null {
    return this.managedWorkersDomain.revokeCredential(input)
  }

  recordManagedWorkerHeartbeat(input: RecordManagedWorkerHeartbeatInput): ManagedWorkerHeartbeatRecord {
    return this.managedWorkersDomain.recordHeartbeat(input)
  }

  listManagedWorkerHeartbeats(orgId: string, input: { workerId?: string | null, limit?: number | null } = {}): ManagedWorkerHeartbeatRecord[] {
    return this.managedWorkersDomain.listHeartbeats(orgId, input)
  }

  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord {
    return this.auditDomain.recordAuditEvent(input)
  }

  listAuditEvents(orgId: string, limit = 100): AuditEventRecord[] {
    return this.auditDomain.listAuditEvents(orgId, limit)
  }

  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord {
    return this.usageQuotaDomain.consumeUsageQuota(input)
  }

  listUsageQuotaCounters(orgId: string): UsageQuotaCounterRecord[] {
    return this.usageQuotaDomain.listUsageQuotaCounters(orgId)
  }

  recordUsageEvent(input: RecordUsageEventInput): UsageEventRecord {
    return this.usageDomain.recordUsageEvent(input)
  }

  listUsageEvents(orgId: string, limit = 100): UsageEventRecord[] {
    return this.usageDomain.listUsageEvents(orgId, limit)
  }

  upsertBillingSubscription(input: UpsertBillingSubscriptionInput): BillingSubscriptionRecord {
    return this.billingDomain.upsertBillingSubscription(input)
  }

  getBillingSubscription(orgId: string): BillingSubscriptionRecord | null {
    return this.billingDomain.getBillingSubscription(orgId)
  }

  findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }): BillingSubscriptionRecord | null {
    return this.billingDomain.findBillingSubscriptionByProvider(input)
  }

  claimRateLimit(input: ClaimRateLimitInput): RateLimitClaimRecord {
    return this.rateLimitsDomain.claimRateLimit(input)
  }

  checkCloudAuthBackoff(input: CheckCloudAuthBackoffInput): CloudAuthBackoffRecord {
    return this.authBackoffDomain.checkCloudAuthBackoff(input)
  }

  recordCloudAuthFailure(input: RecordCloudAuthFailureInput): CloudAuthBackoffRecord {
    return this.authBackoffDomain.recordCloudAuthFailure(input)
  }

  createByokSecret(input: CreateByokSecretInput): ByokSecretRecord {
    return this.byokSecretsDomain.createByokSecret(input)
  }

  getByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    return this.byokSecretsDomain.getByokSecret(orgId, providerId)
  }

  getActiveByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    return this.byokSecretsDomain.getActiveByokSecret(orgId, providerId)
  }

  listByokSecrets(orgId: string): ByokSecretRecord[] {
    return this.byokSecretsDomain.listByokSecrets(orgId)
  }

  disableByokSecret(input: DisableByokSecretInput): ByokSecretRecord | null {
    return this.byokSecretsDomain.disableByokSecret(input)
  }

  recordByokSecretValidation(input: RecordByokSecretValidationInput): ByokSecretRecord | null {
    return this.byokSecretsDomain.recordByokSecretValidation(input)
  }

  createHeadlessAgent(input: CreateHeadlessAgentInput): HeadlessAgentRecord {
    return this.headlessAgentsDomain.createHeadlessAgent(input)
  }

  updateHeadlessAgent(input: UpdateHeadlessAgentInput): HeadlessAgentRecord | null {
    return this.headlessAgentsDomain.updateHeadlessAgent(input)
  }

  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null {
    return this.headlessAgentsDomain.getHeadlessAgent(orgId, agentId)
  }

  listHeadlessAgents(orgId: string): HeadlessAgentRecord[] {
    return this.headlessAgentsDomain.listHeadlessAgents(orgId)
  }

  createChannelBinding(input: CreateChannelBindingInput): ChannelBindingRecord {
    return this.channelBindingsDomain.createChannelBinding(input)
  }

  updateChannelBinding(input: UpdateChannelBindingInput): ChannelBindingRecord | null {
    return this.channelBindingsDomain.updateChannelBinding(input)
  }

  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null {
    return this.channelBindingsDomain.getChannelBinding(orgId, bindingId)
  }

  listChannelBindings(orgId: string, agentId?: string | null): ChannelBindingRecord[] {
    return this.channelBindingsDomain.listChannelBindings(orgId, agentId)
  }

  upsertChannelIdentity(input: UpsertChannelIdentityInput): ChannelIdentityRecord {
    return this.channelIdentitiesDomain.upsert(input)
  }

  getChannelIdentity(orgId: string, identityId: string): ChannelIdentityRecord | null {
    return this.channelIdentitiesDomain.get(orgId, identityId)
  }

  listChannelIdentities(orgId: string, input: ListChannelIdentitiesInput = {}): ChannelIdentityRecord[] {
    return this.channelIdentitiesDomain.list(orgId, input)
  }

  findChannelIdentity(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalUserId: string }): ChannelIdentityRecord | null {
    return this.channelIdentitiesDomain.find(input)
  }

  bindChannelSession(input: BindChannelSessionInput): ChannelSessionBindingRecord {
    const channelBinding = this.getChannelBinding(input.orgId, input.channelBindingId)
    if (!channelBinding) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
    const agent = this.getHeadlessAgent(input.orgId, input.agentId)
    if (!agent) throw new Error(`Unknown headless agent ${input.agentId}.`)
    if (channelBinding.agentId !== agent.agentId) throw new Error('Channel session binding agent does not match channel binding.')
    const provider = normalizeProvider(input.provider)
    if (channelBinding.provider !== provider) throw new Error('Channel session binding provider does not match channel binding.')
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalChatId = normalizeText(input.externalChatId, CHANNEL_TEXT_MAX_LENGTH, 'External chat id')
    const externalThreadId = normalizeText(input.externalThreadId, CHANNEL_TEXT_MAX_LENGTH, 'External thread id')
    const threadKey = key(input.orgId, channelThreadKey(provider, externalWorkspaceId, externalChatId, externalThreadId))
    const existingId = this.channelSessionBindingsByThread.get(threadKey)
    if (existingId) return clone(this.channelSessionBindings.get(existingId) as ChannelSessionBindingRecord)
    const session = this.getSessionForTenant(this.orgTenantId(input.orgId) || input.orgId, input.sessionId)
    if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
    const now = nowIso(input.createdAt)
    const record: ChannelSessionBindingRecord = {
      bindingId: normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel session binding id'),
      orgId: input.orgId,
      agentId: input.agentId,
      channelBindingId: input.channelBindingId,
      provider,
      externalWorkspaceId,
      externalThreadId,
      externalChatId,
      sessionId: input.sessionId,
      lastEventSequence: normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence'),
      lastWorkspaceSequence: normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence'),
      lastChatMessageId: normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id'),
      status: input.status || 'active',
      createdAt: now,
      updatedAt: now,
    }
    this.channelSessionBindings.set(record.bindingId, record)
    this.channelSessionBindingsByThread.set(threadKey, record.bindingId)
    this.recordAuditEvent({
      orgId: record.orgId,
      actorType: 'system',
      actorId: 'channel_session.bind',
      eventType: 'channel_session_bound',
      targetType: 'channel_session_binding',
      targetId: record.bindingId,
      metadata: { provider: record.provider, sessionId: record.sessionId },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  getChannelSessionBinding(orgId: string, bindingId: string): ChannelSessionBindingRecord | null {
    const binding = this.channelSessionBindings.get(bindingId)
    return binding && binding.orgId === orgId ? clone(binding) : null
  }

  findChannelSessionBindingByThread(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalChatId: string, externalThreadId: string }): ChannelSessionBindingRecord | null {
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalChatId = normalizeText(input.externalChatId, CHANNEL_TEXT_MAX_LENGTH, 'External chat id')
    const externalThreadId = normalizeText(input.externalThreadId, CHANNEL_TEXT_MAX_LENGTH, 'External thread id')
    const bindingId = this.channelSessionBindingsByThread.get(key(input.orgId, channelThreadKey(provider, externalWorkspaceId, externalChatId, externalThreadId)))
    return bindingId ? clone(this.channelSessionBindings.get(bindingId) || null) : null
  }

  listChannelSessionBindingsForSession(orgId: string, sessionId: string): ChannelSessionBindingRecord[] {
    return Array.from(this.channelSessionBindings.values())
      .filter((binding) => binding.orgId === orgId && binding.sessionId === sessionId && binding.status === 'active')
      .map((binding) => clone(binding))
  }

  updateChannelCursor(input: UpdateChannelCursorInput): ChannelCursorUpdateResult {
    const existing = this.channelSessionBindings.get(input.bindingId)
    if (!existing || existing.orgId !== input.orgId) return { ok: false, reason: 'not_found' }
    const lastEventSequence = normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence')
    const lastWorkspaceSequence = normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence')
    if (lastEventSequence < existing.lastEventSequence || lastWorkspaceSequence < existing.lastWorkspaceSequence) {
      return { ok: false, reason: 'stale', binding: clone(existing) }
    }
    existing.lastEventSequence = lastEventSequence
    existing.lastWorkspaceSequence = lastWorkspaceSequence
    if (input.lastChatMessageId !== undefined) existing.lastChatMessageId = normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id')
    existing.updatedAt = nowIso(input.updatedAt)
    return { ok: true, binding: clone(existing) }
  }

  createChannelInteraction(input: CreateChannelInteractionInput): IssuedChannelInteractionRecord {
    if (!this.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const agent = this.getHeadlessAgent(input.orgId, input.agentId)
    if (!agent) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const session = this.getSessionForTenant(this.orgTenantId(input.orgId) || input.orgId, input.sessionId)
    if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
    if (input.createdByIdentityId) {
      const identity = this.channelIdentitiesDomain.get(input.orgId, input.createdByIdentityId)
      if (!identity || identity.orgId !== input.orgId) throw new Error(`Unknown channel identity ${input.createdByIdentityId}.`)
    }
    const plaintextToken = generateChannelInteractionToken({ interactionId: input.interactionId, secret: input.tokenSecret })
    const tokenHash = hashChannelInteractionToken(plaintextToken)
    const existing = this.channelInteractions.get(input.interactionId)
    if (existing) throw new Error(`Channel interaction ${input.interactionId} already exists.`)
    const now = nowIso(input.createdAt)
    const record: ChannelInteractionRecord = {
      interactionId: normalizeText(input.interactionId, CHANNEL_TEXT_MAX_LENGTH, 'Channel interaction id'),
      orgId: input.orgId,
      agentId: normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
      sessionId: normalizeText(input.sessionId, CHANNEL_TEXT_MAX_LENGTH, 'Session id'),
      provider: normalizeProvider(input.provider),
      externalInteractionId: normalizeNullableText(input.externalInteractionId, CHANNEL_TEXT_MAX_LENGTH, 'External interaction id'),
      tokenHash,
      kind: input.kind,
      targetId: normalizeText(input.targetId, CHANNEL_TEXT_MAX_LENGTH, 'Interaction target id'),
      status: 'pending',
      createdByIdentityId: input.createdByIdentityId || null,
      expiresAt: input.expiresAt.toISOString(),
      usedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.channelInteractions.set(record.interactionId, record)
    this.channelInteractionsByTokenHash.set(record.tokenHash, record.interactionId)
    if (record.externalInteractionId) {
      this.channelInteractionsByExternal.set(key(record.orgId, record.provider, record.externalInteractionId), record.interactionId)
    }
    return { interaction: clone(record), plaintextToken }
  }

  private findChannelInteractionMutable(input: FindChannelInteractionInput): ChannelInteractionRecord | null {
    const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
    const interactionId = tokenHash
      ? this.channelInteractionsByTokenHash.get(tokenHash)
      : input.externalInteractionId && input.provider
        ? this.channelInteractionsByExternal.get(key(input.orgId, input.provider, input.externalInteractionId))
        : undefined
    const interaction = interactionId ? this.channelInteractions.get(interactionId) : null
    if (!interaction || interaction.orgId !== input.orgId) return null
    const now = input.now || new Date()
    if (interaction.status !== 'pending') return null
    if (new Date(interaction.expiresAt).getTime() <= now.getTime()) {
      interaction.status = 'expired'
      interaction.updatedAt = now.toISOString()
      return null
    }
    return interaction
  }

  findChannelInteraction(input: FindChannelInteractionInput): ChannelInteractionRecord | null {
    const interaction = this.findChannelInteractionMutable(input)
    return interaction ? clone(interaction) : null
  }

  resolveChannelInteraction(input: ResolveChannelInteractionInput): ChannelInteractionRecord | null {
    const now = input.usedAt || new Date()
    const interaction = this.findChannelInteractionMutable({ ...input, now })
    if (!interaction) return null
    interaction.status = 'used'
    interaction.usedAt = now.toISOString()
    interaction.updatedAt = interaction.usedAt
    this.recordAuditEvent({
      orgId: interaction.orgId,
      actorType: 'system',
      actorId: input.identityId,
      eventType: 'channel_interaction.used',
      targetType: 'channel_interaction',
      targetId: interaction.interactionId,
      metadata: { kind: interaction.kind, targetId: interaction.targetId, tokenHash: interaction.tokenHash },
      createdAt: now,
    })
    return clone(interaction)
  }

  resolveChannelInteractionWithCommand(input: ResolveChannelInteractionWithCommandInput): {
    interaction: ChannelInteractionRecord
    command: SessionCommandRecord
  } | null {
    const now = input.usedAt || new Date()
    const interaction = this.findChannelInteractionMutable({ ...input, now })
    if (!interaction) return null
    if (input.command.sessionId !== interaction.sessionId) throw new Error('Channel interaction command session does not match interaction session.')
    const command = this.enqueueSessionCommand(input.command)
    interaction.status = 'used'
    interaction.usedAt = now.toISOString()
    interaction.updatedAt = interaction.usedAt
    this.recordAuditEvent({
      orgId: interaction.orgId,
      actorType: 'system',
      actorId: input.identityId,
      eventType: 'channel_interaction.used',
      targetType: 'channel_interaction',
      targetId: interaction.interactionId,
      metadata: { kind: interaction.kind, targetId: interaction.targetId },
      createdAt: now,
    })
    return { interaction: clone(interaction), command }
  }

  createChannelDelivery(input: CreateChannelDeliveryInput): ChannelDeliveryRecord {
    return this.channelDeliveriesDomain.create(input)
  }

  listChannelDeliveries(input: ListChannelDeliveriesInput): ChannelDeliveryRecord[] {
    return this.channelDeliveriesDomain.list(input)
  }

  claimNextChannelDelivery(input: ClaimChannelDeliveryInput): ChannelDeliveryRecord | null {
    return this.channelDeliveriesDomain.claimNext(input)
  }

  ackChannelDelivery(input: AckChannelDeliveryInput): ChannelDeliveryRecord | null {
    return this.channelDeliveriesDomain.ack(input)
  }

  createCloudCoordinationWatch(input: CreateCloudCoordinationWatchInput): CoordinationWatch { return this.coordinationWatchesDomain.create(input) }
  updateCloudCoordinationWatch(input: UpdateCloudCoordinationWatchInput): CoordinationWatch | null { return this.coordinationWatchesDomain.update(input) }
  getCloudCoordinationWatch(workspaceId: string, watchId: string): CoordinationWatch | null { return this.coordinationWatchesDomain.get(workspaceId, watchId) }
  listCloudCoordinationWatches(input: ListCloudCoordinationWatchesInput): CoordinationWatch[] { return this.coordinationWatchesDomain.list(input) }
  listMatchingCloudCoordinationWatches(input: ListMatchingCloudCoordinationWatchesInput): CoordinationWatch[] { return this.coordinationWatchesDomain.listMatching(input) }
  deleteCloudCoordinationWatch(workspaceId: string, watchId: string): boolean { return this.coordinationWatchesDomain.delete(workspaceId, watchId) }

  claimChannelProviderEvent(input: ClaimChannelProviderEventInput): ChannelProviderEventClaimResult {
    return this.channelProviderEventsDomain.claim(input)
  }

  completeChannelProviderEvent(input: CompleteChannelProviderEventInput): ChannelProviderEventRecord | null {
    return this.channelProviderEventsDomain.complete(input)
  }

  createSession(input: CreateSessionInput): SessionRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const sessionKey = key(input.tenantId, input.sessionId)
    const existing = this.sessions.get(sessionKey)
    if (existing) return clone(existing.record)
    const maxConcurrentSessions = input.quota?.maxConcurrentSessionsPerOrg
    if (maxConcurrentSessions && maxConcurrentSessions > 0) {
      const orgId = input.quota?.orgId || this.orgIdForTenant(input.tenantId)
      const activeSessions = Array.from(this.sessions.values())
        .filter((session) => this.orgIdForTenant(session.record.tenantId) === orgId && session.record.status !== 'closed')
        .length
      if (activeSessions >= maxConcurrentSessions) {
        quotaExceeded({
          message: 'Concurrent cloud session quota exceeded.',
          policyCode: input.quota?.policyCode || 'quota.concurrent_sessions_exceeded',
          retryAfterMs: 60_000,
          limit: maxConcurrentSessions,
          used: activeSessions,
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
    }
    const createdAt = nowIso(input.createdAt)
    const record: SessionRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      opencodeSessionId: input.opencodeSessionId,
      profileName: input.profileName,
      status: 'idle',
      title: input.title || null,
      createdAt,
      updatedAt: createdAt,
    }
    this.sessions.set(sessionKey, {
      record,
      nextEventSequence: 0,
      nextCommandSequence: 0,
      nextLeaseAttempt: 0,
      lease: null,
      events: [],
      projection: null,
      commands: [],
    })
    return clone(record)
  }

  getSession(tenantId: string, userId: string, sessionId: string): SessionRecord | null {
    this.requireTenantUser(tenantId, userId)
    const record = this.sessions.get(key(tenantId, sessionId))?.record || null
    if (!record || record.userId !== userId) return null
    return clone(record)
  }

  getSessionForTenant(tenantId: string, sessionId: string): SessionRecord | null {
    this.requireTenant(tenantId)
    return clone(this.sessions.get(key(tenantId, sessionId))?.record || null)
  }

  findSession(sessionId: string): SessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.record.sessionId === sessionId || session.record.opencodeSessionId === sessionId) {
        return clone(session.record)
      }
    }
    return null
  }

  listSessions(tenantId: string, userId: string): SessionRecord[] {
    this.requireTenantUser(tenantId, userId)
    return Array.from(this.sessions.values())
      .filter((session) => session.record.tenantId === tenantId && session.record.userId === userId)
      .sort((left, right) => (
        right.record.updatedAt.localeCompare(left.record.updatedAt)
        || left.record.sessionId.localeCompare(right.record.sessionId)
      ))
      .map((session) => this.sessionRecordWithProjectSource(session.record))
  }

  private sessionRecordWithProjectSource(record: SessionRecord): SessionRecord {
    const stored = this.sessions.get(key(record.tenantId, record.sessionId))
    const source = normalizeCloudProjectSource(stored?.projection?.view?.projectSource)
    return {
      ...clone(record),
      projectSource: summarizeCloudProjectSource(source),
    }
  }

  listSessionsPage(input: ListSessionsPageInput): ListSessionsPageRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const limit = normalizeListLimit(input.limit)
    const cursor = decodeSessionPageCursor(input.cursor, input)
    const query = input.query?.trim().toLowerCase() || null
    const filtered = Array.from(this.sessions.values())
      .map((session) => session.record)
      .filter((session) => session.tenantId === input.tenantId && session.userId === input.userId)
      .filter((session) => !input.status || session.status === input.status)
      .filter((session) => !input.profileName || session.profileName === input.profileName)
      .filter((session) => !query || [
        session.title || '',
        session.sessionId,
        session.opencodeSessionId,
        session.profileName,
      ].some((field) => field.toLowerCase().includes(query)))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || left.sessionId.localeCompare(right.sessionId)
      ))
      .filter((session) => !cursor
        || session.updatedAt < cursor.updatedAt
        || (session.updatedAt === cursor.updatedAt && session.sessionId > cursor.sessionId))
    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    return {
      items: page.map((session) => this.sessionRecordWithProjectSource(session)),
      nextCursor: hasMore && page.length > 0 ? encodeSessionPageCursor(page[page.length - 1]!, input) : null,
      totalEstimate: filtered.length,
    }
  }

  listAllSessions(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((session) => clone(session.record))
  }

  listRunnableSessions(input: ListRunnableSessionsInput = {}): RunnableSessionListRecord {
    const nowMs = (input.now || new Date()).getTime()
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const candidates = this.runnableSessionCandidates(nowMs)
    return {
      sessions: candidates.slice(0, limit).map((candidate) => ({
        tenantId: candidate.session.record.tenantId,
        sessionId: candidate.session.record.sessionId,
      })),
      pendingSessionCountEstimate: candidates.length,
    }
  }

  claimRunnableSessions(input: ClaimRunnableSessionsInput): RunnableSessionClaimRecord {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const ttlMs = input.ttlMs ?? 30_000
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const candidates = this.runnableSessionCandidates(nowMs)

    const leases: WorkerLeaseRecord[] = []
    for (const candidate of candidates.slice(0, limit)) {
      const session = candidate.session
      const attempt = session.nextLeaseAttempt += 1
      const lease: WorkerLeaseRecord = {
        tenantId: session.record.tenantId,
        sessionId: session.record.sessionId,
        leasedBy: input.workerId,
        leaseToken: `${session.record.tenantId}:${session.record.sessionId}:${attempt}:${input.workerId}`,
        leaseExpiresAt: nowMs + ttlMs,
        checkpointVersion: session.lease?.checkpointVersion || 0,
      }
      session.lease = lease
      session.record.status = 'running'
      session.record.updatedAt = now.toISOString()
      leases.push(clone(lease))
    }
    return {
      leases,
      pendingSessionCountEstimate: candidates.length,
    }
  }

  private runnableSessionCandidates(nowMs: number) {
    return Array.from(this.sessions.values())
      .map((session) => {
        if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
        const runnable = session.commands
          .filter((command) => command.targetLeaseToken === null)
          .filter((command) => command.status === 'pending' || command.status === 'running')
          .filter((command) => !command.availableAt || Date.parse(command.availableAt) <= nowMs)
          .sort((a, b) => a.createdSequence - b.createdSequence)[0]
        return runnable ? { session, firstSequence: runnable.createdSequence } : null
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => (
        a.firstSequence - b.firstSequence
        || a.session.record.tenantId.localeCompare(b.session.record.tenantId)
        || a.session.record.sessionId.localeCompare(b.session.record.sessionId)
      ))
  }

  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
    session.record.opencodeSessionId = input.opencodeSessionId
    if (input.title !== undefined) session.record.title = input.title
    session.record.updatedAt = nowIso(input.updatedAt)
    return clone(session.record)
  }

  updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
    session.record.status = input.status
    if (input.title !== undefined) session.record.title = input.title
    session.record.updatedAt = nowIso(input.updatedAt)
    return clone(session.record)
  }

  appendSessionEvent(input: AppendEventInput): SessionEventRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
    const payload = input.payload || {}
    const eventId = input.eventId || `${input.sessionId}:${session.nextEventSequence + 1}`
    const existing = session.events.find((event) => event.eventId === eventId)
    if (existing) {
      if (
        existing.type !== input.type
        || stableJson(existing.payload) !== stableJson(payload)
      ) {
        throw new Error(`Event id ${eventId} was reused with different content.`)
      }
      return clone(existing)
    }
    const event: SessionEventRecord = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      eventId,
      sequence: session.nextEventSequence += 1,
      type: input.type,
      payload,
      createdAt: nowIso(input.createdAt),
    }
    session.events.push(event)
    session.record.updatedAt = event.createdAt
    return clone(event)
  }

  listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number): SessionEventRecord[] {
    const session = this.requireSession(tenantId, sessionId)
    const matching = session.events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
    return Number.isInteger(limit) && (limit as number) > 0 ? matching.slice(0, limit) : matching
  }

  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord {
    return this.workspaceEventsDomain.appendWorkspaceEvent(input)
  }

  listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number): WorkspaceEventRecord[] {
    return this.workspaceEventsDomain.listWorkspaceEvents(tenantId, userId, afterSequence, limit)
  }

  getWorkspaceEventCursor(tenantId: string, userId: string): WorkspaceEventCursorRecord {
    return this.workspaceEventsDomain.getWorkspaceEventCursor(tenantId, userId)
  }

  writeSessionProjection(input: WriteProjectionInput): SessionProjectionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    if (session.lease && session.lease.leaseToken !== input.leaseToken) {
      throw new Error('Projection write used a stale worker lease.')
    }
    if (input.sequence < (session.projection?.sequence || 0)) {
      throw new Error('Projection sequence must be monotonic.')
    }
    if (input.sequence === session.projection?.sequence) {
      if (stableJson(session.projection.view) !== stableJson(input.view)) {
        throw new Error('Projection sequence was reused with different content.')
      }
      return clone(session.projection)
    }
    const projection: SessionProjectionRecord = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: input.sequence,
      view: input.view,
      updatedAt: nowIso(input.updatedAt),
    }
    session.projection = projection
    session.record.updatedAt = projection.updatedAt
    return clone(projection)
  }

  getSessionProjection(tenantId: string, sessionId: string): SessionProjectionRecord | null {
    const session = this.requireSession(tenantId, sessionId)
    return clone(session.projection)
  }

  claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
    quota: {
      orgId?: string | null
      maxActiveWorkersPerOrg?: number | null
      policyCode?: QuotaPolicyCode | string
    } | null = null,
  ): WorkerLeaseRecord | null {
    const session = this.requireSession(tenantId, sessionId)
    const nowMs = now.getTime()
    if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
    const maxActiveWorkers = quota?.maxActiveWorkersPerOrg
    if (maxActiveWorkers && maxActiveWorkers > 0) {
      const orgId = quota?.orgId || this.orgIdForTenant(tenantId)
      const activeLeases = Array.from(this.sessions.values())
        .filter((state) => this.orgIdForTenant(state.record.tenantId) === orgId)
        .filter((state) => state.lease && state.lease.leaseExpiresAt > nowMs)
        .length
      if (activeLeases >= maxActiveWorkers) {
        return null
      }
    }
    const attempt = session.nextLeaseAttempt += 1
    const lease: WorkerLeaseRecord = {
      tenantId,
      sessionId,
      leasedBy: workerId,
      leaseToken: `${tenantId}:${sessionId}:${attempt}:${workerId}`,
      leaseExpiresAt: nowMs + ttlMs,
      checkpointVersion: session.lease?.checkpointVersion || 0,
    }
    session.lease = lease
    session.record.status = 'running'
    session.record.updatedAt = now.toISOString()
    return clone(lease)
  }

  releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()): boolean {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken) return false
    session.lease = null
    session.record.status = 'idle'
    session.record.updatedAt = now.toISOString()
    return true
  }

  renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000): WorkerLeaseRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    session.lease = {
      ...session.lease!,
      leaseExpiresAt: now.getTime() + ttlMs,
    }
    return clone(session.lease)
  }

  checkpointSession(lease: WorkerLeaseRecord): WorkerLeaseRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    if (lease.checkpointVersion !== session.lease?.checkpointVersion) {
      throw new Error('Checkpoint version is stale.')
    }
    session.lease = {
      ...session.lease!,
      checkpointVersion: session.lease!.checkpointVersion + 1,
    }
    return clone(session.lease)
  }

  reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): ReapedSessionLeaseRecord[] {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxCommandAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const reaped: ReapedSessionLeaseRecord[] = []
    const candidates = Array.from(this.sessions.values())
      .filter((session) => Boolean(session.lease) && session.lease!.leaseExpiresAt <= nowMs)
      .sort((left, right) => left.lease!.leaseExpiresAt - right.lease!.leaseExpiresAt || left.record.tenantId.localeCompare(right.record.tenantId) || left.record.sessionId.localeCompare(right.record.sessionId))
      .slice(0, limit)
    for (const session of candidates) {
      const lease = session.lease!
      const runningCommands = session.commands.filter((command) => (
        command.status === 'running'
        && command.claimedLeaseToken === lease.leaseToken
      ))
      const retriedCommandIds: string[] = []
      const failedCommandIds: string[] = []
      for (const command of runningCommands) {
        if (command.attemptCount >= maxAttempts) {
          command.status = 'failed'
          command.error = 'Worker lease expired after the maximum retry attempts.'
          command.lastErrorCode = 'lease_expired_max_attempts'
          command.lastErrorSummary = command.error
          failedCommandIds.push(command.commandId)
        } else {
          command.status = 'pending'
          command.claimedBy = null
          command.claimedLeaseToken = null
          command.availableAt = nowIsoValue
          command.error = null
          command.lastErrorCode = 'lease_expired'
          command.lastErrorSummary = 'Worker lease expired before command completion.'
          retriedCommandIds.push(command.commandId)
        }
      }
      session.lease = null
      session.record.status = failedCommandIds.length > 0 && retriedCommandIds.length === 0 ? 'errored' : 'idle'
      session.record.updatedAt = nowIsoValue
      const action: WorkReaperAction = failedCommandIds.length > 0 && retriedCommandIds.length === 0
        ? 'failed'
        : retriedCommandIds.length > 0
          ? 'retried'
          : 'released'
      const record: ReapedSessionLeaseRecord = {
        tenantId: lease.tenantId,
        sessionId: lease.sessionId,
        leaseToken: lease.leaseToken,
        leasedBy: lease.leasedBy,
        action,
        retriedCommandIds,
        failedCommandIds,
        reapedAt: nowIsoValue,
      }
      const orgId = this.resolveOrgIdOrNull(lease.tenantId)
      if (orgId) {
        this.recordAuditEvent({
          orgId,
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
      reaped.push(record)
    }
    return reaped
  }

  assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }): void {
    this.quotaDomain.assertCommandQueueQuota(input)
  }

  enqueueSessionCommand(input: EnqueueCommandInput): SessionCommandRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const payload = input.payload || {}
    const existing = session.commands.find((command) => command.commandId === input.commandId)
    if (existing) {
      if (
        existing.userId !== input.userId
        || existing.kind !== input.kind
        || existing.targetLeaseToken !== (input.targetLeaseToken ?? null)
        || stableJson(existing.payload) !== stableJson(payload)
      ) {
        throw new Error(`Command id ${input.commandId} was reused with different content.`)
      }
      return clone(existing)
    }
    this.assertSessionCommandQueueQuota({ tenantId: input.tenantId, quota: input.quota, now: input.createdAt })
    if (input.usageQuotas?.length) {
      const countersSnapshot = this.usageQuotaDomain.snapshotCounters()
      try {
        for (const quota of input.usageQuotas) {
          const result = this.consumeUsageQuota(quota)
          if (!result.allowed) {
            quotaExceeded({
              message: publicQuotaMessage(result.policyCode),
              policyCode: result.policyCode || 'quota.prompts_per_hour_exceeded',
              retryAfterMs: result.retryAfterMs,
              limit: result.limit,
              used: result.used,
              resetAt: result.resetAt,
            })
          }
        }
      } catch (error) {
        this.usageQuotaDomain.restoreCounters(countersSnapshot); throw error
      }
    }
    const command: SessionCommandRecord = {
      commandId: input.commandId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      kind: input.kind,
      payload,
      targetLeaseToken: input.targetLeaseToken ?? null,
      createdSequence: session.nextCommandSequence += 1,
      createdAt: nowIso(input.createdAt),
      status: 'pending',
      claimedBy: null,
      claimedLeaseToken: null,
      attemptCount: 0,
      availableAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      ackedAt: null,
      error: null,
    }
    session.commands.push(command)
    return clone(command)
  }

  claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()): SessionCommandRecord | null {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    const nowMs = now.getTime()
    this.assertCurrentLease(session, lease, nowMs)
    const command = session.commands.find((entry) => (
      (entry.status === 'pending'
        && (!entry.availableAt || Date.parse(entry.availableAt) <= nowMs)
        && (entry.targetLeaseToken === null || entry.targetLeaseToken === lease.leaseToken))
      || (entry.status === 'running'
        && entry.claimedLeaseToken !== lease.leaseToken
        && entry.targetLeaseToken === null)
    ))
    if (!command) return null
    command.status = 'running'
    command.claimedBy = lease.leasedBy
    command.claimedLeaseToken = lease.leaseToken
    command.attemptCount += 1
    command.lastErrorCode = null
    command.lastErrorSummary = null
    return clone(command)
  }

  ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()): SessionCommandRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status === 'acked') return clone(command)
    if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'acked'
    command.ackedAt = now.toISOString()
    command.error = null
    return clone(command)
  }

  failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string): SessionCommandRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'failed'
    command.error = error
    command.lastErrorCode = 'execution_failed'
    command.lastErrorSummary = redactOperationalText(error, 512, 'Command error')
    return clone(command)
  }

  recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }): WorkerHeartbeatRecord {
    return this.workerHeartbeatsDomain.recordWorkerHeartbeat(input)
  }

  listWorkerHeartbeats(): WorkerHeartbeatRecord[] {
    return this.workerHeartbeatsDomain.listWorkerHeartbeats()
  }

  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): SettingMetadataRecord {
    return this.settingsDomain.setSettingMetadata(input)
  }

  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): SettingMetadataRecord | null {
    return this.settingsDomain.getSettingMetadata(tenantId, keyName, userId)
  }

  listSettingMetadata(tenantId: string, userId?: string | null): SettingMetadataRecord[] {
    return this.settingsDomain.listSettingMetadata(tenantId, userId)
  }

  createWorkflow(input: CreateWorkflowInput): CloudWorkflowRecord {
    return this.workflowsDomain.createWorkflow(input)
  }

  findWorkflow(workflowId: string): CloudWorkflowRecord | null {
    return this.workflowsDomain.findWorkflow(workflowId)
  }

  listWorkflows(tenantId: string, userId: string): CloudWorkflowRecord[] {
    return this.workflowsDomain.listWorkflows(tenantId, userId)
  }

  getWorkflow(tenantId: string, userId: string, workflowId: string): CloudWorkflowRecord | null {
    return this.workflowsDomain.getWorkflow(tenantId, userId, workflowId)
  }

  getWorkflowForTenant(tenantId: string, workflowId: string): CloudWorkflowRecord | null {
    return this.workflowsDomain.getWorkflowForTenant(tenantId, workflowId)
  }

  updateWorkflowStatus(input: UpdateWorkflowStatusInput): CloudWorkflowRecord | null {
    return this.workflowsDomain.updateWorkflowStatus(input)
  }

  listWorkflowRuns(tenantId: string, workflowId: string, limit = 25): CloudWorkflowRunRecord[] {
    return this.workflowsDomain.listWorkflowRuns(tenantId, workflowId, limit)
  }

  createWorkflowRun(input: CreateWorkflowRunInput): CloudWorkflowRunRecord {
    return this.workflowsDomain.createWorkflowRun(input)
  }

  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): ClaimedWorkflowRunRecord | null {
    return this.workflowsDomain.claimDueWorkflowRun(input)
  }

  reapExpiredWorkflowClaims(input: ReapExpiredWorkflowClaimsInput = {}): ReapedWorkflowClaimRecord[] {
    return this.workflowsDomain.reapExpiredWorkflowClaims(input)
  }

  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): CloudWorkflowRunRecord | null {
    return this.workflowsDomain.attachWorkflowRunSession(input)
  }

  completeWorkflowRun(input: CompleteWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.workflowsDomain.completeWorkflowRun(input)
  }

  failWorkflowRun(input: FailWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.workflowsDomain.failWorkflowRun(input)
  }

  getWorkflowRun(tenantId: string, runId: string): CloudWorkflowRunRecord | null {
    return this.workflowsDomain.getWorkflowRun(tenantId, runId)
  }

  getWorkflowRunBySession(tenantId: string, sessionId: string): CloudWorkflowRunRecord | null {
    return this.workflowsDomain.getWorkflowRunBySession(tenantId, sessionId)
  }

  listThreadTags(tenantId: string): ThreadTagRecord[] {
    return this.threadTagsDomain.listThreadTags(tenantId)
  }

  createThreadTag(input: CreateThreadTagInput): ThreadTagRecord {
    return this.threadTagsDomain.createThreadTag(input)
  }

  updateThreadTag(input: UpdateThreadTagInput): ThreadTagRecord | null {
    return this.threadTagsDomain.updateThreadTag(input)
  }

  deleteThreadTag(tenantId: string, tagId: string): boolean {
    return this.threadTagsDomain.deleteThreadTag(tenantId, tagId)
  }

  applyThreadTags(input: ThreadTagLinkInput): void {
    this.threadTagsDomain.applyThreadTags(input)
  }

  removeThreadTags(input: ThreadTagLinkInput): void {
    this.threadTagsDomain.removeThreadTags(input)
  }

  private sessionTagLinkIds(tenantId: string, sessionId: string): ReadonlySet<string> | undefined {
    return this.threadTagsDomain.sessionTagLinkIds(tenantId, sessionId)
  }

  private tagsForSession(tenantId: string, sessionId: string): ThreadTagRecord[] {
    return this.threadTagsDomain.tagsForSession(tenantId, sessionId)
  }

  listThreadSmartFilters(tenantId: string): ThreadSmartFilterRecord[] {
    return this.smartFiltersDomain.listThreadSmartFilters(tenantId)
  }

  createThreadSmartFilter(input: CreateThreadSmartFilterInput): ThreadSmartFilterRecord {
    return this.smartFiltersDomain.createThreadSmartFilter(input)
  }

  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): ThreadSmartFilterRecord | null {
    return this.smartFiltersDomain.updateThreadSmartFilter(input)
  }

  deleteThreadSmartFilter(tenantId: string, filterId: string): boolean {
    return this.smartFiltersDomain.deleteThreadSmartFilter(tenantId, filterId)
  }

  listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): ThreadMetadataRecord[] {
    this.requireTenantUser(input.tenantId, input.userId)
    const tagIds = input.tagIds
      ? normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      : []
    const limit = Number.isInteger(input.limit) && input.limit && input.limit > 0
      ? Math.min(input.limit, THREAD_BULK_MAX_SESSION_IDS)
      : THREAD_BULK_MAX_SESSION_IDS
    return Array.from(this.sessions.values())
      .filter((session) => session.record.tenantId === input.tenantId && session.record.userId === input.userId)
      .filter((session) => {
        if (tagIds.length === 0) return true
        const sessionTagIds = this.sessionTagLinkIds(input.tenantId, session.record.sessionId)
        return Boolean(sessionTagIds && tagIds.some((tagId) => sessionTagIds.has(tagId)))
      })
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, limit)
      .map((session) => ({
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        sessionId: session.record.sessionId,
        title: session.record.title,
        profileName: session.record.profileName,
        status: session.record.status,
        createdAt: session.record.createdAt,
        updatedAt: session.record.updatedAt,
        tags: this.tagsForSession(session.record.tenantId, session.record.sessionId),
      }))
  }

  recordSchemaMigration(id: string, appliedAt = new Date()): SchemaMigrationRecord {
    return this.schemaMigrationsDomain.recordSchemaMigration(id, appliedAt)
  }

  listSchemaMigrations(): SchemaMigrationRecord[] {
    return this.schemaMigrationsDomain.listSchemaMigrations()
  }

  // Centralized identity-existence checks — the single abstraction every domain's
  // host wiring and the store's own methods call, so the org/account maps can later
  // move into an identity domain behind these (delegate) methods.
  private requireCommand(session: SessionState, commandId: string) {
    const command = session.commands.find((entry) => entry.commandId === commandId)
    if (!command) throw new Error(`Unknown command ${commandId}.`)
    return command
  }

  private requireSession(tenantId: string, sessionId: string) {
    this.requireTenant(tenantId)
    const session = this.sessions.get(key(tenantId, sessionId))
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  // Resolve a session and (if a lease token is supplied) fence it.
  private assertSessionLease(tenantId: string, sessionId: string, leaseToken: string | null | undefined) {
    const session = this.requireSession(tenantId, sessionId)
    this.assertLeaseTokenIfPresent(session, leaseToken)
  }

  // Assert a session exists and belongs to the user (no SessionState leak to callers).
  private assertSessionBelongsToUser(tenantId: string, sessionId: string, userId: string) {
    const session = this.requireSession(tenantId, sessionId)
    if (session.record.userId !== userId) {
      throw new Error(`Session ${sessionId} does not belong to user ${userId}.`)
    }
  }

  private sessionHasCommands(tenantId: string, sessionId: string) {
    const session = this.sessions.get(key(tenantId, sessionId))
    return Boolean(session?.commands.length)
  }

  // The raw tag-id link set for a session, for session-listing's tag filter —
  // lets the session methods query thread-tag links without reaching into the
  // thread-tags map directly (so that map can move to its own domain).

  private assertCurrentLease(session: SessionState, lease: WorkerLeaseRecord, nowMs = Date.now()) {
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken || session.lease.leaseExpiresAt <= nowMs) {
      throw new Error('Worker lease is stale.')
    }
  }

  private assertLeaseTokenIfPresent(session: SessionState, leaseToken: string | null | undefined) {
    if (leaseToken === undefined) return
    if (!session.lease || session.lease.leaseToken !== leaseToken || session.lease.leaseExpiresAt <= Date.now()) {
      throw new Error('Worker lease is stale.')
    }
  }
}
