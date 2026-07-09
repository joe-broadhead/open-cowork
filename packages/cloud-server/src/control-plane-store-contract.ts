import type { CoordinationWatch } from '@open-cowork/shared'
import type { QuotaPolicyCode } from './control-plane-errors.ts'
import type {
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderId,
  ClaimChannelProviderEventInput,
  CompleteChannelProviderEventInput,
} from './channel-provider-types.ts'
import type {
  CreateCloudCoordinationWatchInput,
  ListCloudCoordinationWatchesInput,
  ListMatchingCloudCoordinationWatchesInput,
  UpdateCloudCoordinationWatchInput,
} from './coordination-watch-records.ts'
import type { WorkspaceEventCursorRecord } from './workspace-event-cursor.ts'
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
import type { ControlPlaneRole, ControlPlaneSessionStatus, WorkerRole } from './control-plane-enums.ts'
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
  CreateCustomRoleInput,
  CustomRoleRecord,
  MemberPermissionResolution,
  RevokeApiTokensForAccountInput,
  UpdateCustomRoleInput,
} from './control-plane-permissions.ts'
import type {
  ManagedPolicyRecord,
  SetManagedPolicyInput,
} from './control-plane-policy.ts'
import type {
  OrgSsoConfigRecord,
  UpsertOrgSsoConfigInput,
} from './control-plane-sso.ts'
import type {
  ClaimScimSyncEventsInput,
  CompleteScimSyncEventInput,
  EnqueueScimSyncEventInput,
  FailScimSyncEventInput,
  ListScimSyncEventsInput,
  ScimSyncEventRecord,
} from './control-plane-scim.ts'
import type {
  BillingSubscriptionRecord,
  ArtifactUploadReservationRecord,
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
  ListCloudArtifactIndexInput,
  ListCloudArtifactIndexResult,
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  ListCloudLaunchpadSessionSummariesInput,
  ListCloudLaunchpadSessionSummariesResult,
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
  SchemaMigrationRecord,
  SettingMetadataRecord,
  ThreadMetadataRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
} from './control-plane-workspace-records.ts'
import type {
  ListRunnableSessionsInput,
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

// The control-plane store CONTRACT — the `ControlPlaneStore` interface that both
// the in-memory and Postgres implementations satisfy and that the session
// service, scheduler, readiness, and routes program against. Lifted out of the
// in-memory implementation file so the contract is decoupled from any one
// implementation; it references only the extracted type modules.

export type MaybePromise<T> = T | Promise<T>

export type ControlPlaneStore = {
  createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }): MaybePromise<TenantRecord>
  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): MaybePromise<UserRecord>
  ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }): MaybePromise<OrgRecord>
  createAccount(input: CreateAccountInput): MaybePromise<AccountRecord>
  findAccountBySubject(idpSubject: string): MaybePromise<AccountRecord | null>
  findAccountByEmail(email: string): MaybePromise<AccountRecord | null>
  upsertMembership(input: UpsertMembershipInput): MaybePromise<MembershipRecord>
  listOrgMembers(orgId: string, input?: { query?: string | null, limit?: number | null }): MaybePromise<OrgMemberRecord[]>
  // Keyset iteration over ALL members of an org, ordered by the immutable account_id so the
  // cursor is stable even while the caller mutates memberships mid-iteration (SCIM reconcile).
  // Callers page until a short page is returned; unlike listOrgMembers this is not capped at a
  // single UI page.
  listOrgMembersPage(orgId: string, input?: { afterAccountId?: string | null, limit?: number | null }): MaybePromise<OrgMemberRecord[]>
  listMembershipsForAccount(accountId: string): MaybePromise<MembershipRecord[]>
  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): MaybePromise<PrincipalMembershipRecord | null>
  // Custom roles (org-defined named permission maps). CRUD plus effective-permission
  // resolution for a member; built-in roles keep working when no custom role applies.
  createCustomRole(input: CreateCustomRoleInput): MaybePromise<CustomRoleRecord>
  listCustomRoles(orgId: string): MaybePromise<CustomRoleRecord[]>
  getCustomRole(orgId: string, roleKey: string): MaybePromise<CustomRoleRecord | null>
  updateCustomRole(input: UpdateCustomRoleInput): MaybePromise<CustomRoleRecord | null>
  deleteCustomRole(orgId: string, roleKey: string): MaybePromise<boolean>
  // Org-managed workspace & desktop policy (#898). A single record per org; a set
  // merges a partial input onto the current record (or the unrestricted defaults).
  getManagedPolicy(orgId: string): MaybePromise<ManagedPolicyRecord | null>
  setManagedPolicy(input: SetManagedPolicyInput): MaybePromise<ManagedPolicyRecord>
  // Per-org enterprise SSO config (#895): a single record per org (SAML 2.0 + OIDC,
  // domain verification, SSO-only enforcement, SCIM enablement). Secrets are stored
  // as `enc:vN:` ciphertext / salted-hash — the store never sees plaintext. Lookups
  // by SCIM bearer token (route auth) and by verified email domain (login enforcement).
  getOrgSsoConfig(orgId: string): MaybePromise<OrgSsoConfigRecord | null>
  upsertOrgSsoConfig(input: UpsertOrgSsoConfigInput): MaybePromise<OrgSsoConfigRecord>
  deleteOrgSsoConfig(orgId: string): MaybePromise<boolean>
  findOrgSsoConfigByScimToken(plaintext: string): MaybePromise<OrgSsoConfigRecord | null>
  findOrgSsoConfigByDomain(domain: string): MaybePromise<OrgSsoConfigRecord | null>
  // The durable SCIM sync-event queue (#895): enqueue on every provisioning write,
  // claim-with-backoff for the reconciler, complete/fail with exponential retry.
  enqueueScimSyncEvent(input: EnqueueScimSyncEventInput): MaybePromise<ScimSyncEventRecord>
  claimNextScimSyncEvents(input?: ClaimScimSyncEventsInput): MaybePromise<ScimSyncEventRecord[]>
  completeScimSyncEvent(input: CompleteScimSyncEventInput): MaybePromise<ScimSyncEventRecord | null>
  failScimSyncEvent(input: FailScimSyncEventInput): MaybePromise<ScimSyncEventRecord | null>
  listScimSyncEvents(input: ListScimSyncEventsInput): MaybePromise<ScimSyncEventRecord[]>
  resolveMemberPermissions(orgId: string, accountId: string): MaybePromise<MemberPermissionResolution | null>
  issueApiToken(input: IssueApiTokenInput): MaybePromise<IssuedApiTokenRecord>
  listApiTokens(orgId: string): MaybePromise<ApiTokenRecord[]>
  findApiTokenByPlaintext(plaintext: string, now?: Date): MaybePromise<ApiTokenRecord | null>
  revokeApiToken(input: RevokeApiTokenInput): MaybePromise<ApiTokenRecord | null>
  // Revoke every live API token issued to one member (credential revocation on a
  // permission downgrade / deprovision). Returns the count revoked.
  revokeApiTokensForAccount(input: RevokeApiTokensForAccountInput): MaybePromise<number>
  grantApiTokenChannelBinding(input: GrantApiTokenChannelBindingInput): MaybePromise<ApiTokenChannelBindingGrantRecord>
  listApiTokenChannelBindingGrants(input: ListApiTokenChannelBindingGrantsInput): MaybePromise<ApiTokenChannelBindingGrantRecord[]>
  createManagedWorkerPool(input: CreateManagedWorkerPoolInput): MaybePromise<ManagedWorkerPoolRecord>
  updateManagedWorkerPool(input: UpdateManagedWorkerPoolInput): MaybePromise<ManagedWorkerPoolRecord | null>
  getManagedWorkerPool(orgId: string, poolId: string): MaybePromise<ManagedWorkerPoolRecord | null>
  listManagedWorkerPools(orgId: string, input?: { status?: ManagedWorkerPoolStatus | null, limit?: number | null }): MaybePromise<ManagedWorkerPoolRecord[]>
  registerManagedWorker(input: RegisterManagedWorkerInput): MaybePromise<ManagedWorkerRecord>
  updateManagedWorkerStatus(input: UpdateManagedWorkerStatusInput): MaybePromise<ManagedWorkerRecord | null>
  getManagedWorker(orgId: string, workerId: string): MaybePromise<ManagedWorkerRecord | null>
  listManagedWorkers(orgId: string, input?: {
    poolId?: string | null
    status?: ManagedWorkerStatus | null
    limit?: number | null
  }): MaybePromise<ManagedWorkerRecord[]>
  issueManagedWorkerCredential(input: IssueManagedWorkerCredentialInput): MaybePromise<IssuedManagedWorkerCredentialRecord>
  listManagedWorkerCredentials(orgId: string, workerId: string): MaybePromise<ManagedWorkerCredentialRecord[]>
  findManagedWorkerCredentialByPlaintext(plaintext: string, now?: Date): MaybePromise<ResolvedManagedWorkerCredentialRecord | null>
  revokeManagedWorkerCredential(input: RevokeManagedWorkerCredentialInput): MaybePromise<ManagedWorkerCredentialRecord | null>
  recordManagedWorkerHeartbeat(input: RecordManagedWorkerHeartbeatInput): MaybePromise<ManagedWorkerHeartbeatRecord>
  listManagedWorkerHeartbeats(orgId: string, input?: { workerId?: string | null, limit?: number | null }): MaybePromise<ManagedWorkerHeartbeatRecord[]>
  recordAuditEvent(input: RecordAuditEventInput): MaybePromise<AuditEventRecord>
  listAuditEvents(orgId: string, limit?: number): MaybePromise<AuditEventRecord[]>
  queryAuditEvents(input: QueryAuditEventsInput): MaybePromise<QueryAuditEventsResult>
  consumeUsageQuota(input: ConsumeUsageQuotaInput): MaybePromise<QuotaConsumptionRecord>
  listUsageQuotaCounters(orgId: string): MaybePromise<UsageQuotaCounterRecord[]>
  createArtifactUploadReservation(input: CreateArtifactUploadReservationInput): MaybePromise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  }>
  getArtifactUploadReservation(input: {
    orgId: string
    tenantId: string
    sessionId: string
    artifactId: string
  }): MaybePromise<ArtifactUploadReservationRecord | null>
  settleArtifactUploadReservation(input: SettleArtifactUploadReservationInput): MaybePromise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
    settled: boolean
  }>
  releaseArtifactUploadReservation(input: ReleaseArtifactUploadReservationInput): MaybePromise<ArtifactUploadReservationRecord | null>
  recordUsageEvent(input: RecordUsageEventInput): MaybePromise<UsageEventRecord>
  listUsageEvents(orgId: string, limit?: number): MaybePromise<UsageEventRecord[]>
  upsertBillingSubscription(input: UpsertBillingSubscriptionInput): MaybePromise<BillingSubscriptionRecord>
  getBillingSubscription(orgId: string): MaybePromise<BillingSubscriptionRecord | null>
  findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }): MaybePromise<BillingSubscriptionRecord | null>
  claimRateLimit(input: ClaimRateLimitInput): MaybePromise<RateLimitClaimRecord>
  checkCloudAuthBackoff(input: CheckCloudAuthBackoffInput): MaybePromise<CloudAuthBackoffRecord>
  recordCloudAuthFailure(input: RecordCloudAuthFailureInput): MaybePromise<CloudAuthBackoffRecord>
  createByokSecret(input: CreateByokSecretInput): MaybePromise<ByokSecretRecord>
  getByokSecret(orgId: string, providerId: string): MaybePromise<ByokSecretRecord | null>
  getActiveByokSecret(orgId: string, providerId: string): MaybePromise<ByokSecretRecord | null>
  listByokSecrets(orgId: string): MaybePromise<ByokSecretRecord[]>
  disableByokSecret(input: DisableByokSecretInput): MaybePromise<ByokSecretRecord | null>
  recordByokSecretValidation(input: RecordByokSecretValidationInput): MaybePromise<ByokSecretRecord | null>
  createHeadlessAgent(input: CreateHeadlessAgentInput): MaybePromise<HeadlessAgentRecord>
  updateHeadlessAgent(input: UpdateHeadlessAgentInput): MaybePromise<HeadlessAgentRecord | null>
  getHeadlessAgent(orgId: string, agentId: string): MaybePromise<HeadlessAgentRecord | null>
  listHeadlessAgents(orgId: string): MaybePromise<HeadlessAgentRecord[]>
  createChannelBinding(input: CreateChannelBindingInput): MaybePromise<ChannelBindingRecord>
  updateChannelBinding(input: UpdateChannelBindingInput): MaybePromise<ChannelBindingRecord | null>
  getChannelBinding(orgId: string, bindingId: string): MaybePromise<ChannelBindingRecord | null>
  listChannelBindings(orgId: string, agentId?: string | null): MaybePromise<ChannelBindingRecord[]>
  upsertChannelIdentity(input: UpsertChannelIdentityInput): MaybePromise<ChannelIdentityRecord>
  getChannelIdentity(orgId: string, identityId: string): MaybePromise<ChannelIdentityRecord | null>
  listChannelIdentities(orgId: string, input?: ListChannelIdentitiesInput): MaybePromise<ChannelIdentityRecord[]>
  findChannelIdentity(input: {
    orgId: string
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalUserId: string
  }): MaybePromise<ChannelIdentityRecord | null>
  bindChannelSession(input: BindChannelSessionInput): MaybePromise<ChannelSessionBindingRecord>
  getChannelSessionBinding(orgId: string, bindingId: string): MaybePromise<ChannelSessionBindingRecord | null>
  findChannelSessionBindingByThread(input: {
    orgId: string
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  }): MaybePromise<ChannelSessionBindingRecord | null>
  listChannelSessionBindingsForSession(orgId: string, sessionId: string): MaybePromise<ChannelSessionBindingRecord[]>
  updateChannelCursor(input: UpdateChannelCursorInput): MaybePromise<ChannelCursorUpdateResult>
  createChannelInteraction(input: CreateChannelInteractionInput): MaybePromise<IssuedChannelInteractionRecord>
  findChannelInteraction(input: FindChannelInteractionInput): MaybePromise<ChannelInteractionRecord | null>
  resolveChannelInteraction(input: ResolveChannelInteractionInput): MaybePromise<ChannelInteractionRecord | null>
  resolveChannelInteractionWithCommand(input: ResolveChannelInteractionWithCommandInput): MaybePromise<{
    interaction: ChannelInteractionRecord
    command: SessionCommandRecord
  } | null>
  createChannelDelivery(input: CreateChannelDeliveryInput): MaybePromise<ChannelDeliveryRecord>
  listChannelDeliveries(input: ListChannelDeliveriesInput): MaybePromise<ChannelDeliveryRecord[]>
  claimNextChannelDelivery(input: ClaimChannelDeliveryInput): MaybePromise<ChannelDeliveryRecord | null>
  ackChannelDelivery(input: AckChannelDeliveryInput): MaybePromise<ChannelDeliveryRecord | null>
  // Retention sweeps for the transient channel tables. Each deletes up to `limit`
  // rows past the cutoff and returns the count deleted, so the scheduler can batch
  // until drained. Disabled (never called) unless a retention window is configured.
  pruneTerminalChannelDeliveries(input: { olderThan: Date; limit: number }): MaybePromise<number>
  pruneExpiredChannelInteractions(input: { olderThan: Date; limit: number }): MaybePromise<number>
  // Delete stale per-source throttle rows (rate-limit windows + expired auth-backoff blocks)
  // older than the cutoff; returns the count removed so the scheduler can batch until drained.
  pruneStaleThrottleState(input: { olderThan: Date; limit: number }): MaybePromise<number>
  // Opt-in retention for the compliance/projection-sensitive event logs (P1-C3). Each deletes up to
  // `limit` rows created before the cutoff (oldest first) and returns the count, so the scheduler can
  // batch until drained. Disabled (never called) unless the operator configures the window. Pruning
  // session events trims old SSE replay history; the durable projection still covers the gap.
  pruneExpiredSessionEvents(input: { olderThan: Date; limit: number }): MaybePromise<number>
  pruneExpiredAuditEvents(input: { olderThan: Date; limit: number }): MaybePromise<number>
  pruneExpiredUsageEvents(input: { olderThan: Date; limit: number }): MaybePromise<number>
  pruneExpiredWorkspaceEvents(input: { olderThan: Date; limit: number }): MaybePromise<number>
  // Recompute the maintained concurrency gauges from their source tables (P2-7), correcting any
  // drift accumulated under the old write-clamp; returns the number of counter rows touched. The
  // in-memory store counts live, so it has no gauge to reconcile and returns 0.
  reconcileConcurrencyCounters(): MaybePromise<number>
  createCloudCoordinationWatch(input: CreateCloudCoordinationWatchInput): MaybePromise<CoordinationWatch>
  updateCloudCoordinationWatch(input: UpdateCloudCoordinationWatchInput): MaybePromise<CoordinationWatch | null>
  getCloudCoordinationWatch(workspaceId: string, watchId: string): MaybePromise<CoordinationWatch | null>
  listCloudCoordinationWatches(input: ListCloudCoordinationWatchesInput): MaybePromise<CoordinationWatch[]>
  listMatchingCloudCoordinationWatches(input: ListMatchingCloudCoordinationWatchesInput): MaybePromise<CoordinationWatch[]>
  deleteCloudCoordinationWatch(workspaceId: string, watchId: string): MaybePromise<boolean>
  claimChannelProviderEvent(input: ClaimChannelProviderEventInput): MaybePromise<ChannelProviderEventClaimResult>
  completeChannelProviderEvent(input: CompleteChannelProviderEventInput): MaybePromise<ChannelProviderEventRecord | null>
  createSession(input: CreateSessionInput): MaybePromise<SessionRecord>
  getSession(tenantId: string, userId: string, sessionId: string): MaybePromise<SessionRecord | null>
  getOwnedSessionIds(tenantId: string, userId: string, sessionIds: string[]): MaybePromise<Set<string>>
  getSessionForTenant(tenantId: string, sessionId: string): MaybePromise<SessionRecord | null>
  findSession(sessionId: string): MaybePromise<SessionRecord | null>
  listSessions(tenantId: string, userId: string): MaybePromise<SessionRecord[]>
  listSessionsPage(input: ListSessionsPageInput): MaybePromise<ListSessionsPageRecord>
  listAllSessions(): MaybePromise<SessionRecord[]>
  listRunnableSessions(input: ListRunnableSessionsInput): MaybePromise<RunnableSessionListRecord>
  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): MaybePromise<SessionRecord>
  updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): MaybePromise<SessionRecord>
  appendSessionEvent(input: AppendEventInput): MaybePromise<SessionEventRecord>
  appendProjectedSessionEvent(input: AppendProjectedSessionEventInput): MaybePromise<AppendProjectedSessionEventResult>
  listSessionEvents(tenantId: string, sessionId: string, afterSequence?: number, limit?: number): MaybePromise<SessionEventRecord[]>
  // SSE replay hot-path read. Identical scoped query/ordering to listSessionEvents but skips
  // the requireSession existence pre-check: the WHERE clause is already scoped by
  // tenant_id/session_id, so an unknown/unauthorized pair simply yields an empty result.
  // The SSE connection authorized the principal+session once at connect; re-running that
  // pre-check on every 1s poll was redundant per-connection DB load. Non-stream callers keep
  // listSessionEvents (which still validates existence).
  listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence?: number, limit?: number): MaybePromise<SessionEventRecord[]>
  // Aggregate count + max sequence for projection-status, so it never loads the whole
  // event log just to compute lag (index-served on the postgres backend).
  getSessionEventStats(tenantId: string, sessionId: string): MaybePromise<{ count: number; latestSequence: number }>
  upsertCloudArtifactIndex(input: UpsertCloudArtifactIndexInput): MaybePromise<CloudArtifactIndexRecord>
  getCloudArtifactIndexRecord(input: {
    tenantId: string
    userId: string
    sessionId: string
    artifactId: string
  }): MaybePromise<CloudArtifactIndexRecord | null>
  listCloudArtifactIndex(input: ListCloudArtifactIndexInput): MaybePromise<ListCloudArtifactIndexResult>
  upsertCloudLaunchpadSessionSummary(input: UpsertCloudLaunchpadSessionSummaryInput): MaybePromise<CloudLaunchpadSessionSummaryRecord>
  listCloudLaunchpadSessionSummaries(input: ListCloudLaunchpadSessionSummariesInput): MaybePromise<ListCloudLaunchpadSessionSummariesResult>
  appendWorkspaceEvent(input: AppendWorkspaceEventInput): MaybePromise<WorkspaceEventRecord>
  getWorkspaceEventCursor(tenantId: string, userId: string): MaybePromise<WorkspaceEventCursorRecord>
  listWorkspaceEvents(tenantId: string, userId: string, afterSequence?: number, limit?: number): MaybePromise<WorkspaceEventRecord[]>
  // SSE replay hot-path read (see listSessionEventsForStream). Skips the requireTenantUser
  // pre-check; the WHERE clause is scoped by tenant_id/user_id so a bad pair yields empty.
  listWorkspaceEventsForStream(tenantId: string, userId: string, afterSequence?: number, limit?: number): MaybePromise<WorkspaceEventRecord[]>
  writeSessionProjection(input: WriteProjectionInput): MaybePromise<SessionProjectionRecord>
  getSessionProjection(tenantId: string, sessionId: string): MaybePromise<SessionProjectionRecord | null>
  // Max durable-event-to-projection gap across sessions (P1-F), emitted as the
  // open_cowork_cloud_projection_lag_events gauge so the (previously phantom) projection-lag
  // alert can fire. A single aggregate; the scheduler throttles how often it runs.
  getMaxProjectionLag(): MaybePromise<number>
  claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now?: Date,
    ttlMs?: number,
    quota?: {
      orgId?: string | null
      maxActiveWorkersPerOrg?: number | null
      policyCode?: QuotaPolicyCode | string
    } | null,
  ): MaybePromise<WorkerLeaseRecord | null>
  releaseSessionLease(lease: WorkerLeaseRecord, now?: Date): MaybePromise<boolean>
  renewSessionLease(lease: WorkerLeaseRecord, now?: Date, ttlMs?: number): MaybePromise<WorkerLeaseRecord>
  checkpointSession(lease: WorkerLeaseRecord): MaybePromise<WorkerLeaseRecord>
  reapExpiredSessionLeases(input?: ReapExpiredSessionLeasesInput): MaybePromise<ReapedSessionLeaseRecord[]>
  assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }): MaybePromise<void>
  enqueueSessionCommand(input: EnqueueCommandInput): MaybePromise<SessionCommandRecord>
  claimNextSessionCommand(lease: WorkerLeaseRecord, now?: Date): MaybePromise<SessionCommandRecord | null>
  ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now?: Date): MaybePromise<SessionCommandRecord>
  checkpointAndAckSessionCommand(lease: WorkerLeaseRecord, commandId: string, now?: Date): MaybePromise<CheckpointAndAckSessionCommandResult>
  failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string): MaybePromise<SessionCommandRecord>
  recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }): MaybePromise<WorkerHeartbeatRecord>
  listWorkerHeartbeats(): MaybePromise<WorkerHeartbeatRecord[]>
  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): MaybePromise<SettingMetadataRecord>
  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): MaybePromise<SettingMetadataRecord | null>
  listSettingMetadata(tenantId: string, userId?: string | null): MaybePromise<SettingMetadataRecord[]>
  createWorkflow(input: CreateWorkflowInput): MaybePromise<CloudWorkflowRecord>
  findWorkflow(workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  listWorkflows(tenantId: string, userId: string): MaybePromise<CloudWorkflowRecord[]>
  getWorkflow(tenantId: string, userId: string, workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  getWorkflowForTenant(tenantId: string, workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  updateWorkflowStatus(input: UpdateWorkflowStatusInput): MaybePromise<CloudWorkflowRecord | null>
  listWorkflowRuns(tenantId: string, workflowId: string, limit?: number): MaybePromise<CloudWorkflowRunRecord[]>
  createWorkflowRun(input: CreateWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord>
  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): MaybePromise<ClaimedWorkflowRunRecord | null>
  reapExpiredWorkflowClaims(input?: ReapExpiredWorkflowClaimsInput): MaybePromise<ReapedWorkflowClaimRecord[]>
  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): MaybePromise<CloudWorkflowRunRecord | null>
  completeWorkflowRun(input: CompleteWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord | null>
  failWorkflowRun(input: FailWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord | null>
  getWorkflowRun(tenantId: string, runId: string): MaybePromise<CloudWorkflowRunRecord | null>
  getWorkflowRunBySession(tenantId: string, sessionId: string): MaybePromise<CloudWorkflowRunRecord | null>
  listThreadTags(tenantId: string): MaybePromise<ThreadTagRecord[]>
  createThreadTag(input: CreateThreadTagInput): MaybePromise<ThreadTagRecord>
  updateThreadTag(input: UpdateThreadTagInput): MaybePromise<ThreadTagRecord | null>
  deleteThreadTag(tenantId: string, tagId: string): MaybePromise<boolean>
  applyThreadTags(input: ThreadTagLinkInput): MaybePromise<void>
  removeThreadTags(input: ThreadTagLinkInput): MaybePromise<void>
  listThreadSmartFilters(tenantId: string): MaybePromise<ThreadSmartFilterRecord[]>
  createThreadSmartFilter(input: CreateThreadSmartFilterInput): MaybePromise<ThreadSmartFilterRecord>
  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): MaybePromise<ThreadSmartFilterRecord | null>
  deleteThreadSmartFilter(tenantId: string, filterId: string): MaybePromise<boolean>
  listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): MaybePromise<ThreadMetadataRecord[]>
  recordSchemaMigration(id: string, appliedAt?: Date): MaybePromise<SchemaMigrationRecord>
  listSchemaMigrations(): MaybePromise<SchemaMigrationRecord[]>
  close?(): MaybePromise<void>
}
