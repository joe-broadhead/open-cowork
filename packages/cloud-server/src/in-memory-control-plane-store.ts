import type { CoordinationWatch } from '@open-cowork/shared'
import type { QuotaPolicyCode } from './control-plane-errors.ts'
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
import { InMemoryRolesDomain } from './in-memory-domains/roles.ts'
import { InMemoryManagedPolicyDomain } from './in-memory-domains/policy.ts'
import { InMemorySsoDomain } from './in-memory-domains/sso.ts'
import {
  restoreChannelState,
  snapshotChannelState,
  type InMemoryChannelStateSnapshot,
} from './in-memory-channel-state-snapshot.ts'
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
import { resolveEffectivePermissions } from './control-plane-permissions.ts'
import type {
  CreateCustomRoleInput,
  CustomRoleRecord,
  MemberPermissionResolution,
  RevokeApiTokensForAccountInput,
  UpdateCustomRoleInput,
} from './control-plane-permissions.ts'
import { InMemorySettingsDomain } from './in-memory-domains/settings.ts'
import { InMemoryWorkflowsDomain } from './in-memory-domains/workflows.ts'
import { InMemorySessionsDomain, type SessionState } from './in-memory-domains/sessions.ts'
import {
  clone,
  key,
  normalizeNonNegativeInteger,
  normalizeNullableText,
  normalizeText,
  nowIso,
} from './in-memory-domains/store-helpers.ts'
import {
  generateChannelInteractionToken,
  hashChannelInteractionToken,
  plaintextMatchesChannelInteractionId,
  verifyChannelInteractionTokenHash,
} from './control-plane-tokens.ts'
import type { WorkspaceEventCursorRecord } from './workspace-event-cursor.ts'
import { channelThreadKey, normalizeChannelProviderId as normalizeProvider } from './channel-provider-utils.ts'
import type { ChannelProviderEventClaimResult, ChannelProviderEventRecord, ChannelProviderId, ClaimChannelProviderEventInput, CompleteChannelProviderEventInput } from './channel-provider-types.ts'
import type { CreateCloudCoordinationWatchInput, ListCloudCoordinationWatchesInput, ListMatchingCloudCoordinationWatchesInput, UpdateCloudCoordinationWatchInput } from './coordination-watch-records.ts'
import type {
  ControlPlaneRole,
  ControlPlaneSessionStatus,
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
  ArtifactUploadReservationRecord,
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
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  ListCloudArtifactIndexInput,
  ListCloudArtifactIndexResult,
  ListCloudLaunchpadSessionSummariesInput,
  ListCloudLaunchpadSessionSummariesResult,
  ListSessionsPageInput,
  ListSessionsPageRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  UpsertCloudArtifactIndexInput,
  UpsertCloudLaunchpadSessionSummaryInput,
  WorkerLeaseRecord,
  WorkspaceEventRecord,
} from './control-plane-session-records.ts'
import type {
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  ListWorkflowRunsForWorkflowsInput,
  ListWorkflowsPageInput,
  ListWorkflowsPageRecord,
  SchemaMigrationRecord,
  SettingMetadataRecord,
  ThreadMetadataRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
} from './control-plane-workspace-records.ts'
import type {
  ListRunnableSessionsInput,
  RecoverSessionLeaseInput,
  ReapExpiredSessionLeasesInput,
  ReapExpiredWorkflowClaimsInput,
  ReapedSessionLeaseRecord,
  ReapedWorkflowClaimRecord,
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
  QueryAuditEventsInput,
  QueryAuditEventsResult,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
  RevokeApiTokenInput,
  UpsertMembershipInput,
} from './control-plane-account-inputs.ts'
import type {
  CheckCloudAuthBackoffInput,
  ClaimRateLimitInput,
  ConsumeUsageQuotaInput,
  CreateArtifactUploadReservationInput,
  CreateSessionInput,
  RecordCloudAuthFailureInput,
  RecordUsageEventInput,
  ReleaseArtifactUploadReservationInput,
  SettleArtifactUploadReservationInput,
  UpsertBillingSubscriptionInput,
} from './control-plane-usage-inputs.ts'
import type {
  AppendEventInput,
  AppendProjectedSessionEventInput,
  AppendProjectedSessionEventResult,
  AppendWorkspaceEventInput,
  CheckpointAndAckSessionCommandResult,
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
export type { InMemoryChannelStateSnapshot } from './in-memory-channel-state-snapshot.ts'

const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const CHANNEL_TEXT_MAX_LENGTH = 256


function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function artifactUploadReservationKey(orgId: string, tenantId: string, sessionId: string, artifactId: string) {
  return key(orgId, tenantId, sessionId, artifactId)
}

function quotaWindowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly channelSessionBindings = new Map<string, ChannelSessionBindingRecord>()
  private readonly channelSessionBindingsByThread = new Map<string, string>()
  private readonly channelInteractions = new Map<string, ChannelInteractionRecord>()
  private readonly channelInteractionsByExternal = new Map<string, string>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly artifactIndex = new Map<string, CloudArtifactIndexRecord>()
  private readonly artifactUploadReservations = new Map<string, ArtifactUploadReservationRecord>()
  private readonly launchpadSessionSummaries = new Map<string, CloudLaunchpadSessionSummaryRecord>()
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
  private readonly rolesDomain = new InMemoryRolesDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly managedPolicyDomain = new InMemoryManagedPolicyDomain({
    orgExists: (orgId) => this.orgExists(orgId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly ssoDomain = new InMemorySsoDomain({
    orgExists: (orgId) => this.orgExists(orgId),
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
  private readonly sessionsDomain = new InMemorySessionsDomain({
    sessions: this.sessions,
    artifactIndex: this.artifactIndex,
    launchpadSessionSummaries: this.launchpadSessionSummaries,
  }, {
    requireTenant: (tenantId) => { this.requireTenant(tenantId) },
    requireTenantUser: (tenantId, userId) => { this.requireTenantUser(tenantId, userId) },
    resolveOrgId: (tenantId) => this.orgIdForTenant(tenantId),
    resolveOrgIdOrNull: (tenantId) => this.resolveOrgIdOrNull(tenantId),
    appendWorkspaceEvent: (input) => this.appendWorkspaceEvent(input),
    findWorkspaceEvent: (tenantId, userId, eventId) => this.workspaceEventsDomain.findWorkspaceEvent(tenantId, userId, eventId),
    snapshotWorkspaceEvents: () => this.workspaceEventsDomain.snapshot(),
    restoreWorkspaceEvents: (snapshot) => {
      this.workspaceEventsDomain.restore(snapshot as Parameters<InMemoryWorkspaceEventsDomain['restore']>[0])
    },
    assertCommandQueueQuota: (input) => { this.quotaDomain.assertCommandQueueQuota(input) },
    consumeUsageQuota: (input) => this.consumeUsageQuota(input),
    snapshotUsageQuotaCounters: () => this.usageQuotaDomain.snapshotCounters(),
    restoreUsageQuotaCounters: (snapshot) => {
      this.usageQuotaDomain.restoreCounters(snapshot as Parameters<InMemoryUsageQuotaDomain['restoreCounters']>[0])
    },
    recordAuditEvent: (input) => { this.recordAuditEvent(input) },
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

  snapshotChannelState(orgId: string): InMemoryChannelStateSnapshot {
    return snapshotChannelState(this, orgId)
  }

  restoreChannelState(snapshot: InMemoryChannelStateSnapshot): void {
    restoreChannelState(this, snapshot)
  }

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

  listOrgMembersPage(orgId: string, input: { afterAccountId?: string | null, limit?: number | null } = {}): OrgMemberRecord[] {
    return this.identityDomain.listOrgMembersPage(orgId, input)
  }

  listMembershipsForAccount(accountId: string): MembershipRecord[] {
    return this.identityDomain.listMembershipsForAccount(accountId)
  }

  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): PrincipalMembershipRecord | null {
    return this.identityDomain.resolvePrincipalMembership(input)
  }

  createCustomRole(input: CreateCustomRoleInput): CustomRoleRecord {
    return this.rolesDomain.createCustomRole(input)
  }

  listCustomRoles(orgId: string): CustomRoleRecord[] {
    return this.rolesDomain.listCustomRoles(orgId)
  }

  getCustomRole(orgId: string, roleKey: string): CustomRoleRecord | null {
    return this.rolesDomain.getCustomRole(orgId, roleKey)
  }

  updateCustomRole(input: UpdateCustomRoleInput): CustomRoleRecord | null {
    return this.rolesDomain.updateCustomRole(input)
  }

  deleteCustomRole(orgId: string, roleKey: string): boolean {
    return this.rolesDomain.deleteCustomRole(orgId, roleKey)
  }

  getManagedPolicy(orgId: string): ManagedPolicyRecord | null {
    return this.managedPolicyDomain.getManagedPolicy(orgId)
  }

  setManagedPolicy(input: SetManagedPolicyInput): ManagedPolicyRecord {
    return this.managedPolicyDomain.setManagedPolicy(input)
  }

  getOrgSsoConfig(orgId: string): OrgSsoConfigRecord | null {
    return this.ssoDomain.getOrgSsoConfig(orgId)
  }

  upsertOrgSsoConfig(input: UpsertOrgSsoConfigInput): OrgSsoConfigRecord {
    return this.ssoDomain.upsertOrgSsoConfig(input)
  }

  deleteOrgSsoConfig(orgId: string): boolean {
    return this.ssoDomain.deleteOrgSsoConfig(orgId)
  }

  findOrgSsoConfigByScimToken(plaintext: string): Promise<OrgSsoConfigRecord | null> {
    return this.ssoDomain.findOrgSsoConfigByScimToken(plaintext)
  }

  findOrgSsoConfigByDomain(domain: string): OrgSsoConfigRecord | null {
    return this.ssoDomain.findOrgSsoConfigByDomain(domain)
  }

  enqueueScimSyncEvent(input: EnqueueScimSyncEventInput): ScimSyncEventRecord {
    return this.ssoDomain.enqueueScimSyncEvent(input)
  }

  claimNextScimSyncEvents(input: ClaimScimSyncEventsInput = {}): ScimSyncEventRecord[] {
    return this.ssoDomain.claimNextScimSyncEvents(input)
  }

  completeScimSyncEvent(input: CompleteScimSyncEventInput): ScimSyncEventRecord | null {
    return this.ssoDomain.completeScimSyncEvent(input)
  }

  failScimSyncEvent(input: FailScimSyncEventInput): ScimSyncEventRecord | null {
    return this.ssoDomain.failScimSyncEvent(input)
  }

  listScimSyncEvents(input: ListScimSyncEventsInput): ScimSyncEventRecord[] {
    return this.ssoDomain.listScimSyncEvents(input)
  }

  // Effective permissions for a member: its custom role's permission map when one
  // is assigned (and still exists), otherwise the built-in role's map.
  resolveMemberPermissions(orgId: string, accountId: string): MemberPermissionResolution | null {
    const membership = this.identityDomain.listMembershipsForAccount(accountId).find((entry) => entry.orgId === orgId)
    if (!membership) return null
    const customRole = membership.customRoleKey ? this.rolesDomain.getCustomRole(orgId, membership.customRoleKey) : null
    return {
      orgId,
      accountId,
      role: membership.role,
      customRoleKey: customRole ? membership.customRoleKey : null,
      permissions: resolveEffectivePermissions({ role: membership.role, customRole }),
    }
  }

  revokeApiTokensForAccount(input: RevokeApiTokensForAccountInput): number {
    return this.apiTokensDomain.revokeApiTokensForAccount(input)
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

  issueApiToken(input: IssueApiTokenInput): Promise<IssuedApiTokenRecord> {
    return this.apiTokensDomain.issueApiToken(input)
  }

  listApiTokens(orgId: string): ApiTokenRecord[] {
    return this.apiTokensDomain.listApiTokens(orgId)
  }

  findApiTokenByPlaintext(plaintext: string, now = new Date()): Promise<ApiTokenRecord | null> {
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

  issueManagedWorkerCredential(input: IssueManagedWorkerCredentialInput): Promise<IssuedManagedWorkerCredentialRecord> {
    return this.managedWorkersDomain.issueCredential(input)
  }

  listManagedWorkerCredentials(orgId: string, workerId: string): ManagedWorkerCredentialRecord[] {
    return this.managedWorkersDomain.listCredentials(orgId, workerId)
  }

  findManagedWorkerCredentialByPlaintext(plaintext: string, now = new Date()): Promise<ResolvedManagedWorkerCredentialRecord | null> {
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

  queryAuditEvents(input: QueryAuditEventsInput): QueryAuditEventsResult {
    return this.auditDomain.queryAuditEvents(input)
  }

  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord {
    return this.usageQuotaDomain.consumeUsageQuota(input)
  }

  listUsageQuotaCounters(orgId: string): UsageQuotaCounterRecord[] {
    return this.usageQuotaDomain.listUsageQuotaCounters(orgId)
  }

  createArtifactUploadReservation(input: CreateArtifactUploadReservationInput): {
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  } {
    if (!this.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    this.requireSession(input.tenantId, input.sessionId)
    const reservationKey = artifactUploadReservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const existing = this.artifactUploadReservations.get(reservationKey)
    if (existing) return { reservation: clone(existing), quota: null }
    const quota = input.quota ? this.consumeUsageQuota(input.quota) : null
    if (quota && !quota.allowed) return { reservation: null, quota }
    const now = input.createdAt || input.quota?.now || new Date()
    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
    const quotaWindowMs = input.quota?.windowMs ?? null
    const quotaWindowStartedAtMs = input.quota ? quotaWindowStart((input.quota.now || now).getTime(), input.quota.windowMs) : null
    const reservation: ArtifactUploadReservationRecord = {
      orgId: input.orgId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      objectKey: input.objectKey,
      filename: input.filename,
      contentType: input.contentType || null,
      quotaKey: input.quota?.quotaKey ?? null,
      quotaWindowMs,
      quotaWindowStartedAtMs,
      reservedBytes: normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes'),
      settledBytes: null,
      status: 'reserved',
      expiresAt: nowIso(expiresAt),
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    }
    this.artifactUploadReservations.set(reservationKey, reservation)
    return { reservation: clone(reservation), quota }
  }

  getArtifactUploadReservation(input: {
    orgId: string
    tenantId: string
    sessionId: string
    artifactId: string
  }): ArtifactUploadReservationRecord | null {
    const reservation = this.artifactUploadReservations.get(artifactUploadReservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId))
    return reservation ? clone(reservation) : null
  }

  settleArtifactUploadReservation(input: SettleArtifactUploadReservationInput): {
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
    settled: boolean
  } {
    const reservationKey = artifactUploadReservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.artifactUploadReservations.get(reservationKey)
    if (!reservation) return { reservation: null, quota: null, settled: false }
    if (reservation.status !== 'reserved') return { reservation: clone(reservation), quota: null, settled: reservation.status === 'settled' }
    const actualBytes = normalizeNonNegativeInteger(input.actualBytes, 'Artifact upload size')
    const delta = actualBytes - reservation.reservedBytes
    const quota = delta > 0 && input.quota ? this.consumeUsageQuota({ ...input.quota, quantity: delta }) : null
    if (quota && !quota.allowed) return { reservation: clone(reservation), quota, settled: false }
    if (delta < 0 && reservation.quotaKey && reservation.quotaWindowStartedAtMs !== null) {
      this.usageQuotaDomain.adjustUsageQuota({
        orgId: reservation.orgId,
        quotaKey: reservation.quotaKey,
        windowStartedAtMs: reservation.quotaWindowStartedAtMs,
        quantityDelta: delta,
      })
    }
    const now = input.now || new Date()
    const settled: ArtifactUploadReservationRecord = {
      ...reservation,
      settledBytes: actualBytes,
      status: 'settled',
      updatedAt: nowIso(now),
    }
    this.artifactUploadReservations.set(reservationKey, settled)
    return { reservation: clone(settled), quota, settled: true }
  }

  releaseArtifactUploadReservation(input: ReleaseArtifactUploadReservationInput): ArtifactUploadReservationRecord | null {
    const reservationKey = artifactUploadReservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.artifactUploadReservations.get(reservationKey)
    if (!reservation) return null
    if (reservation.status === 'reserved' && reservation.quotaKey && reservation.quotaWindowStartedAtMs !== null) {
      this.usageQuotaDomain.adjustUsageQuota({
        orgId: reservation.orgId,
        quotaKey: reservation.quotaKey,
        windowStartedAtMs: reservation.quotaWindowStartedAtMs,
        quantityDelta: -reservation.reservedBytes,
      })
    }
    const released: ArtifactUploadReservationRecord = {
      ...reservation,
      status: reservation.status === 'reserved' ? input.status : reservation.status,
      updatedAt: nowIso(input.now),
    }
    this.artifactUploadReservations.set(reservationKey, released)
    return clone(released)
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

  async createChannelInteraction(input: CreateChannelInteractionInput): Promise<IssuedChannelInteractionRecord> {
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
    const tokenHash = await hashChannelInteractionToken(plaintextToken)
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
    if (record.externalInteractionId) {
      this.channelInteractionsByExternal.set(key(record.orgId, record.provider, record.externalInteractionId), record.interactionId)
    }
    return { interaction: clone(record), plaintextToken }
  }

  private async findChannelInteractionByToken(token: string, orgId: string): Promise<ChannelInteractionRecord | null> {
    // Pre-filter by the interaction id embedded in the presented token
    // (`occi_<interactionId>_<secret>`), then verify the per-interaction salted hash.
    for (const interaction of this.channelInteractions.values()) {
      if (interaction.orgId !== orgId) continue
      if (!plaintextMatchesChannelInteractionId(token, interaction.interactionId)) continue
      if (await verifyChannelInteractionTokenHash(token, interaction.tokenHash)) return interaction
    }
    return null
  }

  private async findChannelInteractionMutable(input: FindChannelInteractionInput): Promise<ChannelInteractionRecord | null> {
    let interaction: ChannelInteractionRecord | null = null
    if (input.token) {
      interaction = await this.findChannelInteractionByToken(input.token, input.orgId)
    } else if (input.externalInteractionId && input.provider) {
      const interactionId = this.channelInteractionsByExternal.get(key(input.orgId, input.provider, input.externalInteractionId))
      interaction = interactionId ? this.channelInteractions.get(interactionId) ?? null : null
    }
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

  async findChannelInteraction(input: FindChannelInteractionInput): Promise<ChannelInteractionRecord | null> {
    const interaction = await this.findChannelInteractionMutable(input)
    return interaction ? clone(interaction) : null
  }

  async resolveChannelInteraction(input: ResolveChannelInteractionInput): Promise<ChannelInteractionRecord | null> {
    const now = input.usedAt || new Date()
    const interaction = await this.findChannelInteractionMutable({ ...input, now })
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

  async resolveChannelInteractionWithCommand(input: ResolveChannelInteractionWithCommandInput): Promise<{
    interaction: ChannelInteractionRecord
    command: SessionCommandRecord
  } | null> {
    const now = input.usedAt || new Date()
    const interaction = await this.findChannelInteractionMutable({ ...input, now })
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

  pruneTerminalChannelDeliveries(input: { olderThan: Date; limit: number }): number {
    return this.channelDeliveriesDomain.pruneTerminal(input)
  }

  pruneStaleThrottleState(input: { olderThan: Date; limit: number }): number {
    const cutoff = input.olderThan.getTime()
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    return this.rateLimitsDomain.pruneStale(cutoff, limit) + this.authBackoffDomain.pruneStale(cutoff, limit)
  }

  pruneExpiredChannelInteractions(input: { olderThan: Date; limit: number }): number {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const cutoff = input.olderThan.toISOString()
    const stale = Array.from(this.channelInteractions.values())
      .filter((interaction) => interaction.expiresAt < cutoff)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, limit)
    for (const interaction of stale) this.channelInteractions.delete(interaction.interactionId)
    return stale.length
  }

  // Opt-in event-log retention (P1-C3). Matches the postgres ctid `ORDER BY created_at LIMIT` delete:
  // remove the oldest rows created before the cutoff, bounded by limit, oldest-first across sessions.
  pruneExpiredSessionEvents(input: { olderThan: Date; limit: number }): number {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const cutoff = input.olderThan.toISOString()
    const stale = Array.from(this.sessions.values())
      .flatMap((session) => session.events.map((event) => ({ session, event })))
      .filter(({ event }) => event.createdAt < cutoff)
      .sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt))
      .slice(0, limit)
    const removeBySession = new Map<typeof stale[number]['session'], Set<string>>()
    for (const { session, event } of stale) {
      const ids = removeBySession.get(session) || new Set<string>()
      ids.add(event.eventId)
      removeBySession.set(session, ids)
    }
    for (const [session, ids] of removeBySession) {
      session.events = session.events.filter((event) => !ids.has(event.eventId))
    }
    return stale.length
  }

  pruneExpiredAuditEvents(input: { olderThan: Date; limit: number }): number {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    return this.auditDomain.pruneStale(input.olderThan.toISOString(), limit)
  }

  pruneExpiredUsageEvents(input: { olderThan: Date; limit: number }): number {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    return this.usageDomain.pruneStale(input.olderThan.toISOString(), limit)
  }

  // The in-memory quota path counts active rows live (no maintained gauge), so there is nothing to
  // reconcile — kept for contract parity with the postgres gauge. (P2-7)
  reconcileConcurrencyCounters(): number {
    return 0
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
    return this.sessionsDomain.createSession(input)
  }

  getSession(tenantId: string, userId: string, sessionId: string): SessionRecord | null {
    return this.sessionsDomain.getSession(tenantId, userId, sessionId)
  }

  getOwnedSessionIds(tenantId: string, userId: string, sessionIds: string[]): Set<string> {
    return this.sessionsDomain.getOwnedSessionIds(tenantId, userId, sessionIds)
  }

  getSessionForTenant(tenantId: string, sessionId: string): SessionRecord | null {
    return this.sessionsDomain.getSessionForTenant(tenantId, sessionId)
  }

  findSession(sessionId: string): SessionRecord | null {
    return this.sessionsDomain.findSession(sessionId)
  }

  listSessions(tenantId: string, userId: string): SessionRecord[] {
    return this.sessionsDomain.listSessions(tenantId, userId)
  }

  listSessionsPage(input: ListSessionsPageInput): ListSessionsPageRecord {
    return this.sessionsDomain.listSessionsPage(input)
  }

  listRunnableSessions(input: ListRunnableSessionsInput = {}): RunnableSessionListRecord {
    return this.sessionsDomain.listRunnableSessions(input)
  }

  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    return this.sessionsDomain.bindSessionRuntime(input)
  }

  updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    return this.sessionsDomain.updateSessionStatus(input)
  }

  appendSessionEvent(input: AppendEventInput): SessionEventRecord {
    return this.sessionsDomain.appendSessionEvent(input)
  }

  appendProjectedSessionEvent(input: AppendProjectedSessionEventInput): AppendProjectedSessionEventResult {
    return this.sessionsDomain.appendProjectedSessionEvent(input)
  }

  listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number): SessionEventRecord[] {
    return this.sessionsDomain.listSessionEvents(tenantId, sessionId, afterSequence, limit)
  }

  listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence = 0, limit?: number): SessionEventRecord[] {
    return this.sessionsDomain.listSessionEventsForStream(tenantId, sessionId, afterSequence, limit)
  }

  getSessionEventStats(tenantId: string, sessionId: string): { count: number; latestSequence: number } {
    return this.sessionsDomain.getSessionEventStats(tenantId, sessionId)
  }

  upsertCloudArtifactIndex(input: UpsertCloudArtifactIndexInput): CloudArtifactIndexRecord {
    return this.sessionsDomain.upsertCloudArtifactIndex(input)
  }

  getCloudArtifactIndexRecord(input: {
    tenantId: string
    userId: string
    sessionId: string
    artifactId: string
  }): CloudArtifactIndexRecord | null {
    return this.sessionsDomain.getCloudArtifactIndexRecord(input)
  }

  listCloudArtifactIndex(input: ListCloudArtifactIndexInput): ListCloudArtifactIndexResult {
    return this.sessionsDomain.listCloudArtifactIndex(input)
  }

  upsertCloudLaunchpadSessionSummary(input: UpsertCloudLaunchpadSessionSummaryInput): CloudLaunchpadSessionSummaryRecord {
    return this.sessionsDomain.upsertCloudLaunchpadSessionSummary(input)
  }

  listCloudLaunchpadSessionSummaries(input: ListCloudLaunchpadSessionSummariesInput): ListCloudLaunchpadSessionSummariesResult {
    return this.sessionsDomain.listCloudLaunchpadSessionSummaries(input)
  }

  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord {
    return this.workspaceEventsDomain.appendWorkspaceEvent(input)
  }

  listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number): WorkspaceEventRecord[] {
    return this.workspaceEventsDomain.listWorkspaceEvents(tenantId, userId, afterSequence, limit)
  }

  listWorkspaceEventsForStream(tenantId: string, userId: string, afterSequence = 0, limit?: number): WorkspaceEventRecord[] {
    return this.workspaceEventsDomain.listWorkspaceEventsForStream(tenantId, userId, afterSequence, limit)
  }

  getWorkspaceEventCursor(tenantId: string, userId: string): WorkspaceEventCursorRecord {
    return this.workspaceEventsDomain.getWorkspaceEventCursor(tenantId, userId)
  }

  pruneExpiredWorkspaceEvents(input: { olderThan: Date, limit: number }): number {
    return this.workspaceEventsDomain.pruneExpiredWorkspaceEvents(input)
  }

  writeSessionProjection(input: WriteProjectionInput): SessionProjectionRecord {
    return this.sessionsDomain.writeSessionProjection(input)
  }

  getSessionProjection(tenantId: string, sessionId: string): SessionProjectionRecord | null {
    return this.sessionsDomain.getSessionProjection(tenantId, sessionId)
  }

  getMaxProjectionLag(): number {
    return this.sessionsDomain.getMaxProjectionLag()
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
    return this.sessionsDomain.claimSessionLease(tenantId, sessionId, workerId, now, ttlMs, quota)
  }

  releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()): boolean {
    return this.sessionsDomain.releaseSessionLease(lease, now)
  }

  renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000): WorkerLeaseRecord {
    return this.sessionsDomain.renewSessionLease(lease, now, ttlMs)
  }

  checkpointSession(lease: WorkerLeaseRecord): WorkerLeaseRecord {
    return this.sessionsDomain.checkpointSession(lease)
  }

  reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): ReapedSessionLeaseRecord[] {
    return this.sessionsDomain.reapExpiredSessionLeases(input)
  }

  recoverSessionLease(lease: WorkerLeaseRecord, input: RecoverSessionLeaseInput = {}): ReapedSessionLeaseRecord | null {
    return this.sessionsDomain.recoverSessionLease(lease, input)
  }

  assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }): void {
    return this.sessionsDomain.assertSessionCommandQueueQuota(input)
  }

  enqueueSessionCommand(input: EnqueueCommandInput): SessionCommandRecord {
    return this.sessionsDomain.enqueueSessionCommand(input)
  }

  claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()): SessionCommandRecord | null {
    return this.sessionsDomain.claimNextSessionCommand(lease, now)
  }

  ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()): SessionCommandRecord {
    return this.sessionsDomain.ackSessionCommand(lease, commandId, now)
  }

  checkpointAndAckSessionCommand(
    lease: WorkerLeaseRecord,
    commandId: string,
    now = new Date(),
  ): CheckpointAndAckSessionCommandResult {
    return this.sessionsDomain.checkpointAndAckSessionCommand(lease, commandId, now)
  }

  failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string): SessionCommandRecord {
    return this.sessionsDomain.failSessionCommand(lease, commandId, error)
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

  listWorkflowsPage(input: ListWorkflowsPageInput): ListWorkflowsPageRecord {
    return this.workflowsDomain.listWorkflowsPage(input)
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

  listWorkflowRunsForWorkflows(input: ListWorkflowRunsForWorkflowsInput): CloudWorkflowRunRecord[] {
    return this.workflowsDomain.listWorkflowRunsForWorkflows(input)
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

  assertSchemaIntegrity(): void {
    // The in-memory store has no physical schema to drift independently from
    // its typed domains. Migration-ledger completeness is checked by readiness.
  }

  private requireSession(tenantId: string, sessionId: string) {
    return this.sessionsDomain.requireSession(tenantId, sessionId)
  }

  private assertSessionLease(tenantId: string, sessionId: string, leaseToken: string | null | undefined) {
    this.sessionsDomain.assertSessionLease(tenantId, sessionId, leaseToken)
  }

  private assertSessionBelongsToUser(tenantId: string, sessionId: string, userId: string) {
    this.sessionsDomain.assertSessionBelongsToUser(tenantId, sessionId, userId)
  }

  private sessionHasCommands(tenantId: string, sessionId: string) {
    return this.sessionsDomain.sessionHasCommands(tenantId, sessionId)
  }
}
