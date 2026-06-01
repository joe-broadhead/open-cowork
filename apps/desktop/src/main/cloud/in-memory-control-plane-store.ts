import { createHash, randomBytes } from 'node:crypto'
import type {
  WorkflowDraft,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import type { CloudBillingEntitlements, CloudSubscriptionStatus } from '../config-types.ts'
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
import { redactAuditMetadata } from './audit-redaction.ts'
import {
  generateChannelInteractionToken,
  generateCloudApiToken,
  hashChannelInteractionToken,
  hashCloudApiToken,
  plaintextMatchesCloudApiTokenId,
  verifyCloudApiTokenHash,
} from './control-plane-tokens.ts'
import {
  decodeSessionPageCursor,
  encodeSessionPageCursor,
} from './session-page-cursor.ts'
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
export {
  generateChannelInteractionToken,
  generateCloudApiToken,
  hashChannelInteractionToken,
  hashCloudApiToken,
  plaintextMatchesCloudApiTokenId,
  verifyCloudApiTokenHash,
} from './control-plane-tokens.ts'

export type ControlPlaneRole = 'owner' | 'admin' | 'member'
export type ControlPlaneMembershipStatus = 'active' | 'invited' | 'disabled'
export type ApiTokenScope = 'desktop' | 'gateway' | 'admin' | 'operator' | 'worker-internal'
export type AuditActorType = 'user' | 'api_token' | 'system'
export type ControlPlaneSessionStatus = 'idle' | 'running' | 'closed' | 'errored'
export type ControlPlaneCommandKind = 'prompt' | 'abort' | 'permission.respond' | 'question.reply' | 'question.reject'
export type ControlPlaneCommandStatus = 'pending' | 'running' | 'acked' | 'failed'
export type WorkerRole = 'all-in-one' | 'web' | 'worker' | 'scheduler'
export type WorkReaperAction = 'retried' | 'failed' | 'released'
export type ChannelProviderKind = 'telegram' | 'slack' | 'email' | 'discord' | 'whatsapp' | 'signal' | 'webhook' | 'cli'
export type ChannelProviderId = ChannelProviderKind | `${ChannelProviderKind}-${string}` | `${string}-${string}`
export type HeadlessAgentStatus = 'active' | 'disabled'
export type ChannelBindingStatus = 'active' | 'disabled' | 'auth_required' | 'error'
export type ChannelIdentityRole = ControlPlaneRole | 'approver' | 'viewer'
export type ChannelIdentityStatus = 'active' | 'disabled' | 'pending'
export type ChannelSessionBindingStatus = 'active' | 'archived'
export type ChannelInteractionKind = 'permission' | 'question'
export type ChannelInteractionStatus = 'pending' | 'used' | 'expired' | 'revoked'
export type ChannelDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead'
export type ByokSecretStatus = 'pending_validation' | 'active' | 'disabled' | 'expired' | 'invalid' | 'unsupported'
export type UsageEventType =
  | 'session.created'
  | 'prompt.enqueued'
  | 'work.queued'
  | 'work.claimed'
  | 'worker.execution_started'
  | 'worker.execution_completed'
  | 'worker.execution_failed'
  | 'worker.minute'
  | 'artifact.uploaded'
  | 'artifact.downloaded'
  | 'gateway.delivery.claimed'
export type UsageUnit = 'count' | 'byte' | 'minute'
export type BillingSubscriptionStatus = CloudSubscriptionStatus

export type UsageEventRecord = {
  eventId: string
  orgId: string
  accountId: string | null
  eventType: UsageEventType | string
  quantity: number
  unit: UsageUnit | string
  metadata: Record<string, unknown>
  createdAt: string
}

export type BillingSubscriptionRecord = {
  orgId: string
  planKey: string
  providerId: string
  providerCustomerId: string | null
  providerSubscriptionId: string | null
  status: BillingSubscriptionStatus
  seats: number
  entitlements: CloudBillingEntitlements
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type QuotaConsumptionRecord = {
  allowed: boolean
  orgId: string
  quotaKey: string
  limit: number
  used: number
  remaining: number
  resetAt: string
  retryAfterMs: number
  policyCode?: QuotaPolicyCode | string
}

export type UsageQuotaCounterRecord = {
  orgId: string
  quotaKey: string
  windowStartedAtMs: number
  quantity: number
}

export type RateLimitClaimRecord = {
  allowed: boolean
  scope: string
  source: string
  limit: number
  count: number
  resetAt: string
  retryAfterMs: number
  policyCode?: QuotaPolicyCode | string
}

export type CloudAuthBackoffRecord = {
  allowed: boolean
  scope: string
  source: string
  failureCount: number
  blockedUntilMs: number
  retryAfterMs: number
}

export type TenantRecord = {
  tenantId: string
  name: string
  createdAt: string
}

export type UserRecord = {
  tenantId: string
  userId: string
  email: string
  role: ControlPlaneRole
  createdAt: string
}

export type OrgRecord = {
  orgId: string
  tenantId: string
  name: string
  planKey: string | null
  status: string
  createdAt: string
  updatedAt: string
}

export type AccountRecord = {
  accountId: string
  idpSubject: string | null
  email: string
  displayName: string | null
  createdAt: string
  updatedAt: string
}

export type MembershipRecord = {
  orgId: string
  accountId: string
  role: ControlPlaneRole
  status: ControlPlaneMembershipStatus
  createdAt: string
  updatedAt: string
}

export type OrgMemberRecord = {
  orgId: string
  accountId: string
  email: string
  displayName: string | null
  role: ControlPlaneRole
  status: ControlPlaneMembershipStatus
  createdAt: string
  updatedAt: string
}

export type PrincipalMembershipRecord = {
  org: OrgRecord
  account: AccountRecord
  membership: MembershipRecord
}

export type ApiTokenRecord = {
  tokenId: string
  orgId: string
  accountId: string | null
  name: string
  tokenHash: string
  scopes: ApiTokenScope[]
  last4: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export type IssuedApiTokenRecord = {
  token: ApiTokenRecord
  plaintext: string
}

export type AuditEventRecord = {
  eventId: string
  orgId: string
  accountId: string | null
  actorType: AuditActorType
  actorId: string | null
  eventType: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type ByokSecretRecord = {
  secretId: string
  orgId: string
  providerId: string
  status: ByokSecretStatus
  ciphertext: string | null
  kmsRef: string | null
  last4: string
  keyFingerprint: string
  createdByAccountId: string | null
  rotatedFromSecretId: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export type HeadlessAgentRecord = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status: HeadlessAgentStatus
  managed: boolean
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  displayName: string
  status: ChannelBindingStatus
  credentialRef: string | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelIdentityRecord = {
  identityId: string
  orgId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  externalUserId: string
  accountId: string | null
  role: ChannelIdentityRole
  status: ChannelIdentityStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelSessionBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  channelBindingId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  externalThreadId: string
  externalChatId: string
  sessionId: string
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId: string | null
  status: ChannelSessionBindingStatus
  createdAt: string
  updatedAt: string
}

export type ChannelInteractionRecord = {
  interactionId: string
  orgId: string
  agentId: string
  sessionId: string
  provider: ChannelProviderId
  externalInteractionId: string | null
  tokenHash: string
  kind: ChannelInteractionKind
  targetId: string
  status: ChannelInteractionStatus
  createdByIdentityId: string | null
  expiresAt: string
  usedAt: string | null
  createdAt: string
  updatedAt: string
}

export type IssuedChannelInteractionRecord = {
  interaction: ChannelInteractionRecord
  plaintextToken: string
}

export type ChannelDeliveryRecord = {
  deliveryId: string
  orgId: string
  agentId: string
  channelBindingId: string
  sessionBindingId: string | null
  provider: ChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status: ChannelDeliveryStatus
  attemptCount: number
  claimedBy: string | null
  claimExpiresAt: string | null
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type SessionRecord = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  status: ControlPlaneSessionStatus
  title: string | null
  createdAt: string
  updatedAt: string
}

export type ListSessionsPageInput = {
  tenantId: string
  userId: string
  limit?: number | null
  cursor?: string | null
  status?: ControlPlaneSessionStatus | null
  profileName?: string | null
  query?: string | null
}

export type ListSessionsPageRecord = {
  items: SessionRecord[]
  nextCursor: string | null
  totalEstimate: number
}

export type SessionEventRecord = {
  tenantId: string
  sessionId: string
  eventId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type WorkspaceEventRecord = {
  tenantId: string
  userId: string
  sessionId: string | null
  eventId: string
  sequence: number
  entityType: string
  entityId: string
  operation: string
  projectionVersion: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type SessionProjectionRecord = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  updatedAt: string
}

export type WorkerLeaseRecord = {
  tenantId: string
  sessionId: string
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: number
  checkpointVersion: number
}

export type ClaimRunnableSessionsInput = {
  workerId: string
  limit?: number | null
  now?: Date
  ttlMs?: number
}
export type ListRunnableSessionsInput = { limit?: number | null, now?: Date }
export type RunnableSessionRecord = { tenantId: string, sessionId: string }
export type RunnableSessionListRecord = { sessions: RunnableSessionRecord[], pendingSessionCountEstimate: number }
export type RunnableSessionClaimRecord = {
  leases: WorkerLeaseRecord[]
  pendingSessionCountEstimate: number
}

export type ReapExpiredSessionLeasesInput = {
  now?: Date
  maxCommandAttempts?: number | null
}

export type ReapedSessionLeaseRecord = {
  tenantId: string
  sessionId: string
  leaseToken: string
  leasedBy: string
  action: WorkReaperAction
  retriedCommandIds: string[]
  failedCommandIds: string[]
  reapedAt: string
}

export type ReapExpiredWorkflowClaimsInput = {
  now?: Date
  maxAttempts?: number | null
}

export type ReapedWorkflowClaimRecord = {
  tenantId: string
  workflowId: string
  runId: string
  claimToken: string
  claimedBy: string
  action: WorkReaperAction
  reapedAt: string
}

export type SessionCommandRecord = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload: Record<string, unknown>
  targetLeaseToken: string | null
  createdSequence: number
  createdAt: string
  status: ControlPlaneCommandStatus
  claimedBy: string | null
  claimedLeaseToken: string | null
  attemptCount: number
  availableAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  ackedAt: string | null
  error: string | null
}

export type WorkerHeartbeatRecord = {
  workerId: string
  role: WorkerRole
  activeSessionIds: string[]
  lastSeenAt: string
}

export type SettingMetadataRecord = {
  tenantId: string
  userId: string | null
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

export type ThreadTagRecord = {
  tenantId: string
  tagId: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export type ThreadSmartFilterRecord = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ThreadMetadataRecord = {
  tenantId: string
  userId: string
  sessionId: string
  title: string | null
  profileName: string
  status: ControlPlaneSessionStatus
  createdAt: string
  updatedAt: string
  tags: ThreadTagRecord[]
}

export type CloudWorkflowRecord = WorkflowSummary & {
  tenantId: string
  userId: string
}

export type CloudWorkflowRunRecord = WorkflowRun & {
  tenantId: string
  userId: string
  claimedBy: string | null
  claimToken: string | null
  claimExpiresAt: string | null
  attemptCount: number
  idempotencyKey: string | null
  checkpointVersion: number
  lastErrorCode: string | null
  lastErrorSummary: string | null
}

export type ClaimedWorkflowRunRecord = {
  workflow: CloudWorkflowRecord
  run: CloudWorkflowRunRecord
}

export type SchemaMigrationRecord = {
  id: string
  appliedAt: string
}

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

type WorkflowState = {
  record: CloudWorkflowRecord
  runs: CloudWorkflowRunRecord[]
}

export type CreateSessionInput = {
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
    policyCode?: QuotaPolicyCode | string
  } | null
}

export type ConsumeUsageQuotaInput = {
  orgId: string
  quotaKey: string
  limit: number
  quantity?: number
  windowMs: number
  now?: Date
  policyCode?: QuotaPolicyCode | string
}

export type RecordUsageEventInput = {
  eventId?: string
  orgId: string
  accountId?: string | null
  eventType: UsageEventType | string
  quantity?: number
  unit?: UsageUnit | string
  metadata?: Record<string, unknown>
  createdAt?: Date
}

export type UpsertBillingSubscriptionInput = {
  orgId: string
  planKey: string
  providerId: string
  providerCustomerId?: string | null
  providerSubscriptionId?: string | null
  status: BillingSubscriptionStatus
  seats?: number
  entitlements?: CloudBillingEntitlements
  currentPeriodEnd?: Date | string | null
  cancelAtPeriodEnd?: boolean
  metadata?: Record<string, unknown>
  updatedAt?: Date
}

export type ClaimRateLimitInput = {
  scope: string
  source: string
  limit: number
  windowMs: number
  now?: Date
  policyCode?: QuotaPolicyCode | string
}

export type CheckCloudAuthBackoffInput = {
  scope: string
  source?: string
  now?: Date
}

export type RecordCloudAuthFailureInput = {
  scope: string
  source: string
  windowMs: number
  limit: number
  backoffMs: number
  now?: Date
}

export type CreateAccountInput = {
  accountId: string
  idpSubject?: string | null
  email: string
  displayName?: string | null
  createdAt?: Date
}

export type UpsertMembershipInput = {
  orgId: string
  accountId: string
  role: ControlPlaneRole
  status?: ControlPlaneMembershipStatus
  updatedAt?: Date
  actor?: AuditActorInput
}

export type AuditActorInput = {
  actorType: AuditActorType
  actorId?: string | null
  accountId?: string | null
}

export type IssueApiTokenInput = {
  orgId: string
  accountId?: string | null
  name: string
  scopes: ApiTokenScope[]
  expiresAt?: Date | null
  createdAt?: Date
  tokenId?: string
  secret?: string
  actor?: AuditActorInput
}

export type RevokeApiTokenInput = {
  tokenId: string
  orgId?: string | null
  revokedAt?: Date
  actor?: AuditActorInput
}

export type RecordAuditEventInput = {
  eventId?: string
  orgId: string
  accountId?: string | null
  actorType: AuditActorType
  actorId?: string | null
  eventType: string
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown>
  createdAt?: Date
}

export type CreateByokSecretInput = {
  secretId: string
  orgId: string
  providerId: string
  status?: ByokSecretStatus
  ciphertext?: string | null
  kmsRef?: string | null
  last4: string
  keyFingerprint: string
  createdByAccountId?: string | null
  rotatedFromSecretId?: string | null
  createdAt?: Date
  actor?: AuditActorInput
}

export type DisableByokSecretInput = {
  orgId: string
  providerId: string
  secretId?: string | null
  disabledAt?: Date
  actor?: AuditActorInput
}

export type RecordByokSecretValidationInput = {
  orgId: string
  providerId: string
  secretId?: string | null
  status?: ByokSecretStatus
  validationError?: string | null
  validatedAt?: Date
  actor?: AuditActorInput
}

export type CreateHeadlessAgentInput = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status?: HeadlessAgentStatus
  managed?: boolean
  createdByAccountId?: string | null
  createdAt?: Date
}

export type UpdateHeadlessAgentInput = {
  orgId: string
  agentId: string
  profileName?: string
  name?: string
  status?: HeadlessAgentStatus
  managed?: boolean
  updatedAt?: Date
  actor?: AuditActorInput
}

export type CreateChannelBindingInput = {
  bindingId: string
  orgId: string
  agentId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  displayName: string
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
  createdAt?: Date
  quota?: {
    maxGatewayChannelBindingsPerOrg?: number | null
    policyCode?: string
  } | null
}

export type UpdateChannelBindingInput = {
  orgId: string
  bindingId: string
  displayName?: string
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
  updatedAt?: Date
  actor?: AuditActorInput
}

export type UpsertChannelIdentityInput = {
  identityId?: string
  orgId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  externalUserId: string
  accountId?: string | null
  role?: ChannelIdentityRole
  status?: ChannelIdentityStatus
  metadata?: Record<string, unknown>
  updatedAt?: Date
}

export type BindChannelSessionInput = {
  bindingId: string
  orgId: string
  agentId: string
  channelBindingId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  externalThreadId: string
  externalChatId: string
  sessionId: string
  lastEventSequence?: number
  lastWorkspaceSequence?: number
  lastChatMessageId?: string | null
  status?: ChannelSessionBindingStatus
  createdAt?: Date
}

export type UpdateChannelCursorInput = {
  orgId: string
  bindingId: string
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId?: string | null
  updatedAt?: Date
}

export type CreateChannelInteractionInput = {
  interactionId: string
  orgId: string
  agentId: string
  sessionId: string
  provider: ChannelProviderId
  externalInteractionId?: string | null
  kind: ChannelInteractionKind
  targetId: string
  createdByIdentityId?: string | null
  expiresAt: Date
  tokenSecret?: string
  createdAt?: Date
}

export type ResolveChannelInteractionInput = {
  orgId: string
  token?: string | null
  externalInteractionId?: string | null
  provider?: ChannelProviderId | null
  identityId: string
  usedAt?: Date
}

export type FindChannelInteractionInput = Omit<ResolveChannelInteractionInput, 'identityId' | 'usedAt'> & {
  now?: Date
}

export type ResolveChannelInteractionWithCommandInput = ResolveChannelInteractionInput & {
  command: EnqueueCommandInput
}

export type CreateChannelDeliveryInput = {
  deliveryId: string
  orgId: string
  agentId: string
  channelBindingId: string
  sessionBindingId?: string | null
  provider: ChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status?: ChannelDeliveryStatus
  nextAttemptAt?: Date
  createdAt?: Date
}

export type ClaimChannelDeliveryInput = {
  orgId: string
  claimedBy: string
  now?: Date
  ttlMs?: number
  quota?: Omit<ConsumeUsageQuotaInput, 'orgId'> | null
}

export type AckChannelDeliveryInput = {
  orgId: string
  deliveryId: string
  claimedBy?: string | null
  status: Extract<ChannelDeliveryStatus, 'sent' | 'failed' | 'dead'>
  lastError?: string | null
  nextAttemptAt?: Date | null
  updatedAt?: Date
}

export type ListChannelDeliveriesInput = {
  orgId: string
  status?: ChannelDeliveryStatus | null
  channelBindingId?: string | null
  limit?: number | null
}

export type AppendEventInput = {
  tenantId: string
  sessionId: string
  eventId?: string
  type: string
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

export type AppendWorkspaceEventInput = {
  tenantId: string
  userId: string
  sessionId?: string | null
  eventId?: string
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: string
  payload?: Record<string, unknown>
  createdAt?: Date
}

export type WriteProjectionInput = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  leaseToken?: string | null
  updatedAt?: Date
}

export type CommandQueueQuota = {
  orgId?: string | null
  maxQueuedCommandsPerOrg?: number | null
  maxQueueAgeMs?: number | null
  policyCode?: QuotaPolicyCode | string
  queueAgePolicyCode?: QuotaPolicyCode | string
}

export type WorkflowRunQuota = {
  orgId?: string | null
  maxConcurrentWorkflowRunsPerOrg?: number | null
  maxWorkflowRunsPerHour?: number | null
  policyCode?: QuotaPolicyCode | string
  workflowRunsPolicyCode?: QuotaPolicyCode | string
}

export type EnqueueCommandInput = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload?: Record<string, unknown>
  targetLeaseToken?: string | null
  createdAt?: Date
  quota?: CommandQueueQuota | null
  usageQuotas?: ConsumeUsageQuotaInput[]
}

export type CreateWorkflowInput = {
  tenantId: string
  userId: string
  workflowId: string
  draft: WorkflowDraft
  nextRunAt?: string | null
  createdAt?: Date
}

export type CreateWorkflowRunInput = {
  tenantId: string
  userId: string
  workflowId: string
  runId: string
  triggerType: WorkflowTriggerType
  triggerPayload?: Record<string, unknown> | null
  claimedBy?: string | null
  leaseTtlMs?: number | null
  createdAt?: Date
  quota?: WorkflowRunQuota | null
}

export type UpdateWorkflowStatusInput = {
  tenantId: string
  userId: string
  workflowId: string
  status: WorkflowStatus
  nextRunAt?: string | null
  updatedAt?: Date
}

export type ClaimDueWorkflowRunInput = {
  runId: string
  claimedBy?: string | null
  leaseTtlMs?: number | null
  now?: Date
  quota?: WorkflowRunQuota | null
}

export type AttachWorkflowRunSessionInput = {
  tenantId: string
  workflowId: string
  runId: string
  sessionId: string
  claimToken?: string | null
  startedAt?: Date
}

export type CompleteWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  summary: string | null
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  leaseToken?: string | null
  finishedAt?: Date
}

export type FailWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  error: string
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  leaseToken?: string | null
  finishedAt?: Date
}

export type CreateThreadTagInput = {
  tenantId: string
  tagId: string
  name: string
  color?: string | null
  createdAt?: Date
}

export type UpdateThreadTagInput = {
  tenantId: string
  tagId: string
  name?: string
  color?: string | null
  updatedAt?: Date
}

export type ThreadTagLinkInput = {
  tenantId: string
  sessionIds: string[]
  tagIds: string[]
  createdAt?: Date
}

export type CreateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt?: Date
}

export type UpdateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name?: string
  query?: Record<string, unknown>
  updatedAt?: Date
}

export type MaybePromise<T> = T | Promise<T>

export type ControlPlaneStore = {
  createTenant(input: { tenantId: string, name: string, createdAt?: Date }): MaybePromise<TenantRecord>
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
  listMembershipsForAccount(accountId: string): MaybePromise<MembershipRecord[]>
  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): MaybePromise<PrincipalMembershipRecord | null>
  issueApiToken(input: IssueApiTokenInput): MaybePromise<IssuedApiTokenRecord>
  listApiTokens(orgId: string): MaybePromise<ApiTokenRecord[]>
  findApiTokenByPlaintext(plaintext: string, now?: Date): MaybePromise<ApiTokenRecord | null>
  revokeApiToken(input: RevokeApiTokenInput): MaybePromise<ApiTokenRecord | null>
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
  consumeUsageQuota(input: ConsumeUsageQuotaInput): MaybePromise<QuotaConsumptionRecord>
  listUsageQuotaCounters(orgId: string): MaybePromise<UsageQuotaCounterRecord[]>
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
  updateChannelCursor(input: UpdateChannelCursorInput): MaybePromise<ChannelSessionBindingRecord | null>
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
  createSession(input: CreateSessionInput): MaybePromise<SessionRecord>
  getSession(tenantId: string, userId: string, sessionId: string): MaybePromise<SessionRecord | null>
  getSessionForTenant(tenantId: string, sessionId: string): MaybePromise<SessionRecord | null>
  findSession(sessionId: string): MaybePromise<SessionRecord | null>
  listSessions(tenantId: string, userId: string): MaybePromise<SessionRecord[]>
  listSessionsPage(input: ListSessionsPageInput): MaybePromise<ListSessionsPageRecord>
  listAllSessions(): MaybePromise<SessionRecord[]>
  listRunnableSessions(input: ListRunnableSessionsInput): MaybePromise<RunnableSessionListRecord>
  claimRunnableSessions(input: ClaimRunnableSessionsInput): MaybePromise<RunnableSessionClaimRecord>
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
  listSessionEvents(tenantId: string, sessionId: string, afterSequence?: number): MaybePromise<SessionEventRecord[]>
  appendWorkspaceEvent(input: AppendWorkspaceEventInput): MaybePromise<WorkspaceEventRecord>
  listWorkspaceEvents(tenantId: string, userId: string, afterSequence?: number): MaybePromise<WorkspaceEventRecord[]>
  writeSessionProjection(input: WriteProjectionInput): MaybePromise<SessionProjectionRecord>
  getSessionProjection(tenantId: string, sessionId: string): MaybePromise<SessionProjectionRecord | null>
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

const THREAD_TAG_NAME_MAX_LENGTH = 48
const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
const THREAD_DEFAULT_TAG_COLOR = '#64748b'
const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const SMART_FILTER_QUERY_MAX_BYTES = 16_384
const WORKFLOW_RUN_LIST_LIMIT = 100
const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_DELIVERY_ERROR_MAX_LENGTH = 1024
const BYOK_PROVIDER_ID_MAX_LENGTH = 64
const BYOK_SECRET_TEXT_MAX_LENGTH = 4096
const BILLING_TEXT_MAX_LENGTH = 256
const BILLING_METADATA_MAX_BYTES = 16_384
const BILLING_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
])

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function normalizeListLimit(value: number | null | undefined, fallback = 100, max = 500) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value || fallback)))
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function createWorkClaimToken(tenantId: string, workId: string, claimedBy: string) {
  return stableId('claim', tenantId, workId, claimedBy, randomBytes(16).toString('base64url'))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function key(...parts: string[]) {
  return parts.join('\0')
}

function workspaceOperationFromType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

function optionalTrimmedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function redactOperationalText(value: unknown, maxLength: number, label: string) {
  return normalizeText(value, maxLength, label)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(sk-[A-Za-z0-9._-]{6,})\b/g, '[redacted]')
    .replace(/\b(occ_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b(ocw_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
}

function normalizeOptionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined) return undefined
  return normalizeText(value, maxLength, label)
}

function normalizeTagColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : THREAD_DEFAULT_TAG_COLOR
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function normalizeThreadQuery(value: unknown) {
  const query = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return query
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

function normalizeNonNegativeInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`)
  return parsed
}

function normalizePositiveInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`)
  return parsed
}

function windowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}
function quotaRetryAfterMs(nowMs: number, startedAtMs: number, windowMs: number) {
  return Math.max(1, startedAtMs + windowMs - nowMs)
}

function normalizeProvider(value: unknown): ChannelProviderId {
  const provider = normalizeText(value, 64, 'Channel provider') as ChannelProviderId
  if (isChannelProviderId(provider)) return provider
  throw new Error(`Unsupported channel provider ${provider}.`)
}
function isChannelProviderId(value: string): value is ChannelProviderId {
  return ['telegram', 'slack', 'email', 'discord', 'whatsapp', 'signal', 'webhook', 'cli'].includes(value)
    || (/^[a-z][a-z0-9_-]{1,63}$/.test(value) && value.includes('-'))
}

function normalizeBillingStatus(value: unknown): BillingSubscriptionStatus {
  const status = normalizeText(value || 'incomplete', 32, 'Billing subscription status') as BillingSubscriptionStatus
  return BILLING_SUBSCRIPTION_STATUSES.has(status) ? status : 'incomplete'
}

function billingProviderKey(providerId: string, providerRecordId: string | null | undefined) {
  return key(normalizeText(providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id'), providerRecordId || '')
}

function isoNullable(value: Date | string | null | undefined) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function normalizeByokProviderId(value: unknown) {
  const providerId = normalizeText(value, BYOK_PROVIDER_ID_MAX_LENGTH, 'BYOK provider id').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) throw new Error(`Unsupported BYOK provider id ${providerId}.`)
  return providerId
}

function normalizeChannelIdentityRole(value: unknown): ChannelIdentityRole {
  const role = normalizeText(value || 'viewer', 32, 'Channel identity role') as ChannelIdentityRole
  if (!['owner', 'admin', 'member', 'approver', 'viewer'].includes(role)) {
    throw new Error(`Unsupported channel identity role ${role}.`)
  }
  return role
}

function channelScopeKey(provider: ChannelProviderId, externalWorkspaceId: string | null, externalId: string) {
  return key(provider, externalWorkspaceId || '', externalId)
}

function channelThreadKey(provider: ChannelProviderId, externalWorkspaceId: string | null, externalChatId: string, externalThreadId: string) {
  return key(provider, externalWorkspaceId || '', externalChatId, externalThreadId)
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly tenants = new Map<string, TenantRecord>()
  private readonly users = new Map<string, UserRecord>()
  private readonly orgs = new Map<string, OrgRecord>()
  private readonly orgsByTenant = new Map<string, string>()
  private readonly accounts = new Map<string, AccountRecord>()
  private readonly accountsBySubject = new Map<string, string>()
  private readonly accountsByEmail = new Map<string, string>()
  private readonly memberships = new Map<string, MembershipRecord>()
  private readonly apiTokens = new Map<string, ApiTokenRecord>()
  private readonly auditEvents = new Map<string, AuditEventRecord>()
  private readonly usageEvents = new Map<string, UsageEventRecord>()
  private readonly billingSubscriptions = new Map<string, BillingSubscriptionRecord>()
  private readonly billingSubscriptionsByProviderSubscription = new Map<string, string>()
  private readonly billingSubscriptionsByProviderCustomer = new Map<string, string>()
  private readonly usageCounters = new Map<string, { windowStartedAtMs: number, quantity: number }>()
  private readonly rateLimits = new Map<string, { windowStartedAtMs: number, count: number }>()
  private readonly authFailures = new Map<string, CloudAuthBackoffRecord>()
  private readonly authFailureWindows = new Map<string, number>()
  private readonly byokSecrets = new Map<string, ByokSecretRecord>()
  private readonly headlessAgents = new Map<string, HeadlessAgentRecord>()
  private readonly channelBindings = new Map<string, ChannelBindingRecord>()
  private readonly channelIdentities = new Map<string, ChannelIdentityRecord>()
  private readonly channelIdentitiesByExternal = new Map<string, string>()
  private readonly channelSessionBindings = new Map<string, ChannelSessionBindingRecord>()
  private readonly channelSessionBindingsByThread = new Map<string, string>()
  private readonly channelInteractions = new Map<string, ChannelInteractionRecord>()
  private readonly channelInteractionsByTokenHash = new Map<string, string>()
  private readonly channelInteractionsByExternal = new Map<string, string>()
  private readonly channelDeliveries = new Map<string, ChannelDeliveryRecord>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly heartbeats = new Map<string, WorkerHeartbeatRecord>()
  private readonly settings = new Map<string, SettingMetadataRecord>()
  private readonly workflows = new Map<string, WorkflowState>()
  private readonly workflowRuns = new Map<string, CloudWorkflowRunRecord>()
  private readonly threadTags = new Map<string, ThreadTagRecord>()
  private readonly threadTagLinks = new Map<string, Set<string>>()
  private readonly threadSmartFilters = new Map<string, ThreadSmartFilterRecord>()
  private readonly migrations = new Map<string, SchemaMigrationRecord>()
  private readonly workspaceEvents = new Map<string, { nextSequence: number, events: WorkspaceEventRecord[] }>()
  private readonly managedWorkersDomain = new InMemoryManagedWorkersDomain({
    orgTenantId: (orgId) => this.orgs.get(orgId)?.tenantId || null,
    hasTenant: (tenantId) => this.tenants.has(tenantId),
    recordAuditEvent: (input) => this.recordAuditEvent(input),
  })
  private readonly quotaDomain = new InMemoryQuotaDomain({
    resolveOrgId: (tenantId) => this.orgsByTenant.get(tenantId) || tenantId,
    sessions: () => this.sessions.values(),
    workflowRuns: () => this.workflowRuns.values(),
    consumeUsageQuota: (input) => this.consumeUsageQuota(input),
  })

  private orgIdForTenant(tenantId: string) {
    return this.orgsByTenant.get(tenantId) || tenantId
  }

  createTenant(input: { tenantId: string, name: string, createdAt?: Date }): TenantRecord {
    const existing = this.tenants.get(input.tenantId)
    if (existing) {
      this.ensureOrgForTenant({ tenantId: input.tenantId, name: existing.name, createdAt: input.createdAt })
      return clone(existing)
    }
    const record: TenantRecord = {
      tenantId: input.tenantId,
      name: input.name,
      createdAt: nowIso(input.createdAt),
    }
    this.tenants.set(input.tenantId, record)
    this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.name, createdAt: input.createdAt })
    return clone(record)
  }

  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): UserRecord {
    this.requireTenant(input.tenantId)
    const userKey = key(input.tenantId, input.userId)
    const existing = this.users.get(userKey)
    if (existing) return clone(existing)
    const record: UserRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      email: input.email,
      role: input.role || 'member',
      createdAt: nowIso(input.createdAt),
    }
    this.users.set(userKey, record)
    const org = this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId, createdAt: input.createdAt })
    const account = this.createAccount({
      accountId: input.userId,
      idpSubject: input.userId,
      email: input.email,
      createdAt: input.createdAt,
    })
    this.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: input.role || 'member',
      status: 'active',
      updatedAt: input.createdAt,
      actor: { actorType: 'system', actorId: 'compat.ensureUser' },
    })
    return clone(record)
  }

  ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }): OrgRecord {
    const existingOrgId = this.orgsByTenant.get(input.tenantId)
    if (existingOrgId) return clone(this.orgs.get(existingOrgId) as OrgRecord)
    const createdAt = nowIso(input.createdAt)
    const orgId = input.orgId || input.tenantId
    const record: OrgRecord = {
      orgId,
      tenantId: input.tenantId,
      name: input.name,
      planKey: input.planKey ?? null,
      status: input.status || 'active',
      createdAt,
      updatedAt: createdAt,
    }
    this.orgs.set(orgId, record)
    this.orgsByTenant.set(input.tenantId, orgId)
    return clone(record)
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    const bySubject = input.idpSubject ? this.accountsBySubject.get(input.idpSubject) : null
    const byEmail = this.accountsByEmail.get(input.email.toLowerCase())
    const existing = this.accounts.get(bySubject || byEmail || input.accountId)
    if (existing) {
      let changed = false
      if (input.idpSubject && !existing.idpSubject) {
        existing.idpSubject = input.idpSubject
        this.accountsBySubject.set(input.idpSubject, existing.accountId)
        changed = true
      }
      if (input.displayName && !existing.displayName) {
        existing.displayName = input.displayName
        changed = true
      }
      if (changed) existing.updatedAt = nowIso(input.createdAt)
      return clone(existing)
    }
    const createdAt = nowIso(input.createdAt)
    const record: AccountRecord = {
      accountId: input.accountId,
      idpSubject: input.idpSubject || null,
      email: input.email.toLowerCase(),
      displayName: input.displayName || null,
      createdAt,
      updatedAt: createdAt,
    }
    this.accounts.set(record.accountId, record)
    if (record.idpSubject) this.accountsBySubject.set(record.idpSubject, record.accountId)
    this.accountsByEmail.set(record.email, record.accountId)
    return clone(record)
  }

  findAccountBySubject(idpSubject: string): AccountRecord | null {
    const accountId = this.accountsBySubject.get(idpSubject)
    return accountId ? clone(this.accounts.get(accountId) || null) : null
  }

  findAccountByEmail(email: string): AccountRecord | null {
    const accountId = this.accountsByEmail.get(email.toLowerCase())
    return accountId ? clone(this.accounts.get(accountId) || null) : null
  }

  upsertMembership(input: UpsertMembershipInput): MembershipRecord {
    const org = this.orgs.get(input.orgId)
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    if (!this.accounts.has(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const membershipKey = key(input.orgId, input.accountId)
    const existing = this.memberships.get(membershipKey)
    const now = nowIso(input.updatedAt)
    const record: MembershipRecord = {
      orgId: input.orgId,
      accountId: input.accountId,
      role: input.role,
      status: input.status || 'active',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    this.memberships.set(membershipKey, record)
    this.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.accountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: existing ? 'membership.updated' : 'membership.created',
      targetType: 'membership',
      targetId: membershipKey,
      metadata: { role: record.role, status: record.status },
      createdAt: input.updatedAt,
    })
    return clone(record)
  }

  listOrgMembers(orgId: string, input: { query?: string | null, limit?: number | null } = {}): OrgMemberRecord[] {
    if (!this.orgs.has(orgId)) throw new Error(`Unknown org ${orgId}.`)
    const queryText = input.query?.trim().toLowerCase() || ''
    const limit = Math.max(1, Math.min(input.limit || 100, 500))
    return Array.from(this.memberships.values())
      .filter((membership) => membership.orgId === orgId)
      .map((membership) => {
        const account = this.accounts.get(membership.accountId)
        if (!account) return null
        return {
          orgId: membership.orgId,
          accountId: membership.accountId,
          email: account.email,
          displayName: account.displayName,
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        } satisfies OrgMemberRecord
      })
      .filter((member): member is OrgMemberRecord => Boolean(member))
      .filter((member) => {
        if (!queryText) return true
        return [
          member.accountId,
          member.email,
          member.displayName,
          member.role,
          member.status,
        ].filter(Boolean).join(' ').toLowerCase().includes(queryText)
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.email.localeCompare(right.email))
      .slice(0, limit)
      .map((member) => clone(member))
  }

  listMembershipsForAccount(accountId: string): MembershipRecord[] {
    return Array.from(this.memberships.values())
      .filter((membership) => membership.accountId === accountId)
      .map((membership) => clone(membership))
  }

  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): PrincipalMembershipRecord | null {
    const orgId = this.orgsByTenant.get(input.tenantId) || (this.orgs.has(input.tenantId) ? input.tenantId : undefined)
    if (!orgId) return null
    const org = this.orgs.get(orgId)
    const account = (input.accountId ? this.accounts.get(input.accountId) : null)
      || (input.idpSubject ? this.findAccountBySubject(input.idpSubject) : null)
      || (input.email ? this.findAccountByEmail(input.email) : null)
      || (input.userId ? this.accounts.get(input.userId) : null)
    if (!org || !account) return null
    const membership = this.memberships.get(key(org.orgId, account.accountId))
    return membership ? { org: clone(org), account: clone(account), membership: clone(membership) } : null
  }

  issueApiToken(input: IssueApiTokenInput): IssuedApiTokenRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.accountId && !this.accounts.has(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const generated = generateCloudApiToken(input)
    const now = nowIso(input.createdAt)
    const record: ApiTokenRecord = {
      tokenId: generated.tokenId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      name: normalizeText(input.name, 96, 'API token name'),
      tokenHash: hashCloudApiToken(generated.plaintext),
      scopes: [...new Set(input.scopes)],
      last4: generated.plaintext.slice(-4),
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.apiTokens.set(record.tokenId, record)
    this.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'api_token.created',
      targetType: 'api_token',
      targetId: record.tokenId,
      metadata: { name: record.name, scopes: record.scopes, last4: record.last4 },
      createdAt: input.createdAt,
    })
    return { token: clone(record), plaintext: generated.plaintext }
  }

  listApiTokens(orgId: string): ApiTokenRecord[] {
    return [...this.apiTokens.values()]
      .filter((token) => token.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((token) => clone(token))
  }

  findApiTokenByPlaintext(plaintext: string, now = new Date()): ApiTokenRecord | null {
    for (const token of this.apiTokens.values()) {
      if (!plaintextMatchesCloudApiTokenId(plaintext, token.tokenId)) continue
      if (!verifyCloudApiTokenHash(plaintext, token.tokenHash)) continue
      if (token.revokedAt) return null
      if (token.expiresAt && new Date(token.expiresAt).getTime() <= now.getTime()) return null
      token.lastUsedAt = now.toISOString()
      token.updatedAt = token.lastUsedAt
      return clone(token)
    }
    return null
  }

  revokeApiToken(input: RevokeApiTokenInput): ApiTokenRecord | null {
    const existing = this.apiTokens.get(input.tokenId)
    if (!existing) return null
    if (input.orgId && existing.orgId !== input.orgId) return null
    const revokedAt = nowIso(input.revokedAt)
    existing.revokedAt = existing.revokedAt || revokedAt
    existing.updatedAt = revokedAt
    this.recordAuditEvent({
      orgId: existing.orgId,
      accountId: existing.accountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'api_token.revoked',
      targetType: 'api_token',
      targetId: existing.tokenId,
      metadata: { name: existing.name, scopes: existing.scopes, last4: existing.last4 },
      createdAt: input.revokedAt,
    })
    return clone(existing)
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
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const eventId = input.eventId || stableId('audit', input.orgId, input.eventType, String(this.auditEvents.size + 1), nowIso(input.createdAt))
    const existing = this.auditEvents.get(eventId)
    if (existing) return clone(existing)
    const record: AuditEventRecord = {
      eventId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      actorType: input.actorType,
      actorId: input.actorId || null,
      eventType: input.eventType,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      metadata: redactAuditMetadata(input.metadata),
      createdAt: nowIso(input.createdAt),
    }
    this.auditEvents.set(eventId, record)
    return clone(record)
  }

  listAuditEvents(orgId: string, limit = 100): AuditEventRecord[] {
    if (!this.orgs.has(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.auditEvents.values())
      .filter((event) => event.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => clone(event))
  }

  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const limit = normalizePositiveInteger(input.limit, 'Quota limit')
    const quantity = normalizePositiveInteger(input.quantity || 1, 'Quota quantity')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Quota window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    const counterKey = key(input.orgId, input.quotaKey)
    const existing = this.usageCounters.get(counterKey)
    const current = existing && existing.windowStartedAtMs === startedAtMs ? existing.quantity : 0
    const next = current + quantity
    const retryAfterMs = quotaRetryAfterMs(nowMs, startedAtMs, windowMs)
    const resetAt = new Date(nowMs + retryAfterMs).toISOString()
    if (next > limit) {
      return {
        allowed: false,
        orgId: input.orgId,
        quotaKey: input.quotaKey,
        limit,
        used: current,
        remaining: Math.max(0, limit - current),
        resetAt,
        retryAfterMs,
        policyCode: input.policyCode,
      }
    }
    this.usageCounters.set(counterKey, { windowStartedAtMs: startedAtMs, quantity: next })
    return {
      allowed: true,
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      used: next,
      remaining: Math.max(0, limit - next),
      resetAt,
      retryAfterMs,
      policyCode: input.policyCode,
    }
  }

  listUsageQuotaCounters(orgId: string): UsageQuotaCounterRecord[] {
    if (!this.orgs.has(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.usageCounters.entries())
      .map(([counterKey, counter]) => {
        const [counterOrgId, quotaKey] = counterKey.split('\0', 2)
        return {
          orgId: counterOrgId,
          quotaKey,
          windowStartedAtMs: counter.windowStartedAtMs,
          quantity: counter.quantity,
        }
      })
      .filter((counter) => counter.orgId === orgId)
      .sort((left, right) => left.quotaKey.localeCompare(right.quotaKey))
      .map((counter) => clone(counter))
  }

  recordUsageEvent(input: RecordUsageEventInput): UsageEventRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const eventId = input.eventId || stableId('usage', input.orgId, input.eventType, String(this.usageEvents.size + 1), nowIso(input.createdAt))
    const existing = this.usageEvents.get(eventId)
    if (existing) return clone(existing)
    const record: UsageEventRecord = {
      eventId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      eventType: input.eventType,
      quantity: normalizePositiveInteger(input.quantity || 1, 'Usage quantity'),
      unit: input.unit || 'count',
      metadata: redactAuditMetadata(input.metadata),
      createdAt: nowIso(input.createdAt),
    }
    this.usageEvents.set(eventId, record)
    return clone(record)
  }

  listUsageEvents(orgId: string, limit = 100): UsageEventRecord[] {
    if (!this.orgs.has(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.usageEvents.values())
      .filter((event) => event.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => clone(event))
  }

  upsertBillingSubscription(input: UpsertBillingSubscriptionInput): BillingSubscriptionRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const existing = this.billingSubscriptions.get(input.orgId)
    const now = nowIso(input.updatedAt)
    const providerId = normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id')
    const providerCustomerId = normalizeNullableText(input.providerCustomerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider customer id')
    const providerSubscriptionId = normalizeNullableText(input.providerSubscriptionId, BILLING_TEXT_MAX_LENGTH, 'Billing provider subscription id')
    const record: BillingSubscriptionRecord = {
      orgId: input.orgId,
      planKey: normalizeText(input.planKey || existing?.planKey, BILLING_TEXT_MAX_LENGTH, 'Billing plan key'),
      providerId,
      providerCustomerId,
      providerSubscriptionId,
      status: normalizeBillingStatus(input.status),
      seats: normalizePositiveInteger(input.seats || existing?.seats || 1, 'Billing seats'),
      entitlements: normalizeRecord(input.entitlements, 'Billing entitlements', BILLING_METADATA_MAX_BYTES) as CloudBillingEntitlements,
      currentPeriodEnd: isoNullable(input.currentPeriodEnd),
      cancelAtPeriodEnd: input.cancelAtPeriodEnd === undefined ? existing?.cancelAtPeriodEnd || false : input.cancelAtPeriodEnd === true,
      metadata: redactAuditMetadata(normalizeRecord(input.metadata, 'Billing metadata', BILLING_METADATA_MAX_BYTES)),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (existing?.providerSubscriptionId) {
      this.billingSubscriptionsByProviderSubscription.delete(billingProviderKey(existing.providerId, existing.providerSubscriptionId))
    }
    if (existing?.providerCustomerId) {
      this.billingSubscriptionsByProviderCustomer.delete(billingProviderKey(existing.providerId, existing.providerCustomerId))
    }
    this.billingSubscriptions.set(record.orgId, record)
    if (record.providerSubscriptionId) {
      this.billingSubscriptionsByProviderSubscription.set(billingProviderKey(record.providerId, record.providerSubscriptionId), record.orgId)
    }
    if (record.providerCustomerId) {
      this.billingSubscriptionsByProviderCustomer.set(billingProviderKey(record.providerId, record.providerCustomerId), record.orgId)
    }
    this.recordAuditEvent({
      orgId: record.orgId,
      actorType: 'system',
      actorId: 'billing.subscription.upsert',
      eventType: existing ? 'billing.subscription.updated' : 'billing.subscription.created',
      targetType: 'billing_subscription',
      targetId: record.providerSubscriptionId || record.orgId,
      metadata: {
        providerId: record.providerId,
        previousPlanKey: existing?.planKey || null,
        previousStatus: existing?.status || null,
        previousEntitlementsHash: existing ? stableJson(existing.entitlements) : null,
        planKey: record.planKey,
        status: record.status,
        entitlementsHash: stableJson(record.entitlements),
        seats: record.seats,
        providerCustomerId: record.providerCustomerId,
        providerSubscriptionId: record.providerSubscriptionId,
        providerEventId: input.metadata?.stripeEventId || input.metadata?.eventId || null,
      },
      createdAt: input.updatedAt,
    })
    return clone(record)
  }

  getBillingSubscription(orgId: string): BillingSubscriptionRecord | null {
    const subscription = this.billingSubscriptions.get(orgId)
    return subscription ? clone(subscription) : null
  }

  findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }): BillingSubscriptionRecord | null {
    const providerId = normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id')
    const bySubscription = input.providerSubscriptionId
      ? this.billingSubscriptionsByProviderSubscription.get(billingProviderKey(providerId, input.providerSubscriptionId))
      : null
    const byCustomer = input.providerCustomerId
      ? this.billingSubscriptionsByProviderCustomer.get(billingProviderKey(providerId, input.providerCustomerId))
      : null
    const subscription = this.billingSubscriptions.get(bySubscription || byCustomer || '')
    return subscription ? clone(subscription) : null
  }

  claimRateLimit(input: ClaimRateLimitInput): RateLimitClaimRecord {
    const limit = normalizePositiveInteger(input.limit, 'Rate limit')
    const windowMs = normalizePositiveInteger(input.windowMs, 'Rate-limit window')
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const startedAtMs = windowStart(nowMs, windowMs)
    const rateKey = key(input.scope, input.source)
    const existing = this.rateLimits.get(rateKey)
    const count = existing && existing.windowStartedAtMs === startedAtMs ? existing.count + 1 : 1
    this.rateLimits.set(rateKey, { windowStartedAtMs: startedAtMs, count })
    const retryAfterMs = quotaRetryAfterMs(nowMs, startedAtMs, windowMs)
    return {
      allowed: count <= limit,
      scope: input.scope,
      source: input.source,
      limit,
      count,
      resetAt: new Date(nowMs + retryAfterMs).toISOString(),
      retryAfterMs,
      policyCode: input.policyCode,
    }
  }

  checkCloudAuthBackoff(input: CheckCloudAuthBackoffInput): CloudAuthBackoffRecord {
    const nowMs = (input.now || new Date()).getTime()
    const existing = this.authFailures.get(input.scope)
    return {
      allowed: !existing || existing.blockedUntilMs <= nowMs,
      scope: input.scope,
      source: input.source || existing?.source || input.scope,
      failureCount: existing?.failureCount || 0,
      blockedUntilMs: existing?.blockedUntilMs || 0,
      retryAfterMs: existing ? Math.max(0, existing.blockedUntilMs - nowMs) : 0,
    }
  }

  recordCloudAuthFailure(input: RecordCloudAuthFailureInput): CloudAuthBackoffRecord {
    const windowMs = normalizePositiveInteger(input.windowMs, 'Auth backoff window')
    const limit = normalizePositiveInteger(input.limit, 'Auth failure limit')
    const backoffMs = normalizePositiveInteger(input.backoffMs, 'Auth backoff duration')
    const nowMs = (input.now || new Date()).getTime()
    const existing = this.authFailures.get(input.scope)
    const currentWindowStartedAtMs = windowStart(nowMs, windowMs)
    const existingWindowStartedAtMs = this.authFailureWindows.get(input.scope)
    const failureCount = existing && existingWindowStartedAtMs === currentWindowStartedAtMs
      ? existing.failureCount + 1
      : 1
    const blockedUntilMs = failureCount >= limit
      ? Math.max(existing?.blockedUntilMs || 0, nowMs + backoffMs)
      : existing?.blockedUntilMs || 0
    const record: CloudAuthBackoffRecord = {
      allowed: blockedUntilMs <= nowMs,
      scope: input.scope,
      source: input.source,
      failureCount,
      blockedUntilMs,
      retryAfterMs: Math.max(0, blockedUntilMs - nowMs),
    }
    this.authFailures.set(input.scope, record)
    this.authFailureWindows.set(input.scope, currentWindowStartedAtMs)
    return clone(record)
  }

  createByokSecret(input: CreateByokSecretInput): ByokSecretRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.createdByAccountId && !this.accounts.has(input.createdByAccountId)) {
      throw new Error(`Unknown account ${input.createdByAccountId}.`)
    }
    const providerId = normalizeByokProviderId(input.providerId)
    const ciphertext = normalizeNullableText(input.ciphertext, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK ciphertext')
    const kmsRef = normalizeNullableText(input.kmsRef, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK KMS ref')
    if ((ciphertext && kmsRef) || (!ciphertext && !kmsRef)) {
      throw new Error('BYOK secret requires exactly one of ciphertext or kmsRef.')
    }
    const now = nowIso(input.createdAt)
    const status = input.status || 'pending_validation'
    const priorActive = this.getActiveByokSecret(input.orgId, providerId)
    if (priorActive && status === 'active') {
      const previous = this.byokSecrets.get(priorActive.secretId)
      if (previous) {
        previous.status = 'disabled'
        previous.updatedAt = now
      }
    }
    const record: ByokSecretRecord = {
      secretId: normalizeText(input.secretId, CHANNEL_TEXT_MAX_LENGTH, 'BYOK secret id'),
      orgId: input.orgId,
      providerId,
      status,
      ciphertext,
      kmsRef,
      last4: normalizeText(input.last4, 32, 'BYOK secret last4'),
      keyFingerprint: normalizeText(input.keyFingerprint, 128, 'BYOK key fingerprint'),
      createdByAccountId: input.createdByAccountId || null,
      rotatedFromSecretId: input.rotatedFromSecretId || priorActive?.secretId || null,
      lastValidatedAt: null,
      validationError: null,
      createdAt: now,
      updatedAt: now,
    }
    if (this.byokSecrets.has(record.secretId)) throw new Error(`BYOK secret ${record.secretId} already exists.`)
    this.byokSecrets.set(record.secretId, record)
    this.recordAuditEvent({
      orgId: record.orgId,
      accountId: record.createdByAccountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: priorActive
        ? status === 'active'
          ? 'byok_secret.rotated'
          : 'byok_secret.rotation_started'
        : 'byok_secret.created',
      targetType: 'byok_secret',
      targetId: record.secretId,
      metadata: {
        providerId: record.providerId,
        status: record.status,
        last4: record.last4,
        keyFingerprint: record.keyFingerprint,
        rotatedFromSecretId: record.rotatedFromSecretId,
      },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  getByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    const normalizedProviderId = normalizeByokProviderId(providerId)
    return Array.from(this.byokSecrets.values())
      .filter((secret) => secret.orgId === orgId && secret.providerId === normalizedProviderId)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || right.secretId.localeCompare(left.secretId)
      ))
      .map((secret) => clone(secret))[0] || null
  }

  getActiveByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    const normalizedProviderId = normalizeByokProviderId(providerId)
    const secret = Array.from(this.byokSecrets.values())
      .filter((candidate) => (
        candidate.orgId === orgId
        && candidate.providerId === normalizedProviderId
        && candidate.status === 'active'
      ))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || right.secretId.localeCompare(left.secretId)
      ))[0]
    return secret ? clone(secret) : null
  }

  listByokSecrets(orgId: string): ByokSecretRecord[] {
    if (!this.orgs.has(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.byokSecrets.values())
      .filter((secret) => secret.orgId === orgId)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || left.providerId.localeCompare(right.providerId)
        || right.secretId.localeCompare(left.secretId)
      ))
      .map((secret) => clone(secret))
  }

  disableByokSecret(input: DisableByokSecretInput): ByokSecretRecord | null {
    const providerId = normalizeByokProviderId(input.providerId)
    const selected = input.secretId
      ? [this.byokSecrets.get(input.secretId)].filter((secret): secret is ByokSecretRecord => Boolean(secret))
      : Array.from(this.byokSecrets.values())
        .filter((secret) => (
          secret.orgId === input.orgId
          && secret.providerId === providerId
          && secret.status !== 'disabled'
        ))
        .sort((left, right) => (
          right.updatedAt.localeCompare(left.updatedAt)
          || right.createdAt.localeCompare(left.createdAt)
          || right.secretId.localeCompare(left.secretId)
        ))
    const matching = selected.filter((secret) => secret.orgId === input.orgId && secret.providerId === providerId && secret.status !== 'disabled')
    if (matching.length === 0) return null
    const disabledAt = nowIso(input.disabledAt)
    for (const secret of matching) {
      secret.status = 'disabled'
      secret.updatedAt = disabledAt
      this.recordAuditEvent({
        orgId: secret.orgId,
        accountId: input.actor?.accountId || secret.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'byok_secret.disabled',
        targetType: 'byok_secret',
        targetId: secret.secretId,
        metadata: { providerId: secret.providerId, status: secret.status, last4: secret.last4, keyFingerprint: secret.keyFingerprint },
        createdAt: input.disabledAt,
      })
    }
    return clone(matching[0])
  }

  recordByokSecretValidation(input: RecordByokSecretValidationInput): ByokSecretRecord | null {
    const providerId = normalizeByokProviderId(input.providerId)
    const existing = input.secretId
      ? this.byokSecrets.get(input.secretId)
      : Array.from(this.byokSecrets.values()).find((secret) => (
        secret.orgId === input.orgId
        && secret.providerId === providerId
        && secret.status === 'active'
      ))
    if (!existing || existing.orgId !== input.orgId || existing.providerId !== providerId) return null
    existing.lastValidatedAt = nowIso(input.validatedAt)
    existing.validationError = input.validationError || null
    const priorActive = input.status === 'active'
      ? Array.from(this.byokSecrets.values()).find((candidate) => (
        candidate.secretId !== existing.secretId
        && candidate.orgId === existing.orgId
        && candidate.providerId === existing.providerId
        && candidate.status === 'active'
      )) || null
      : null
    if (input.status === 'active') {
      if (!existing.rotatedFromSecretId && priorActive) {
        existing.rotatedFromSecretId = priorActive.secretId
      }
      for (const candidate of this.byokSecrets.values()) {
        if (
          candidate.secretId !== existing.secretId
          && candidate.orgId === existing.orgId
          && candidate.providerId === existing.providerId
          && candidate.status === 'active'
        ) {
          candidate.status = 'disabled'
          candidate.updatedAt = existing.lastValidatedAt
        }
      }
    }
    if (input.status) existing.status = input.status
    existing.updatedAt = existing.lastValidatedAt
    this.recordAuditEvent({
      orgId: existing.orgId,
      accountId: input.actor?.accountId || existing.createdByAccountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'byok_secret.validated',
      targetType: 'byok_secret',
      targetId: existing.secretId,
      metadata: {
        providerId: existing.providerId,
        status: existing.status,
        last4: existing.last4,
        keyFingerprint: existing.keyFingerprint,
        validationError: existing.validationError,
      },
      createdAt: input.validatedAt,
    })
    if (input.status === 'active' && (priorActive || existing.rotatedFromSecretId)) {
      this.recordAuditEvent({
        orgId: existing.orgId,
        accountId: input.actor?.accountId || existing.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'byok_secret.rotated',
        targetType: 'byok_secret',
        targetId: existing.secretId,
        metadata: {
          providerId: existing.providerId,
          status: existing.status,
          last4: existing.last4,
          keyFingerprint: existing.keyFingerprint,
          rotatedFromSecretId: existing.rotatedFromSecretId || priorActive?.secretId || null,
        },
        createdAt: input.validatedAt,
      })
    }
    return clone(existing)
  }

  createHeadlessAgent(input: CreateHeadlessAgentInput): HeadlessAgentRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    this.requireTenant(input.tenantId)
    if (input.createdByAccountId && !this.accounts.has(input.createdByAccountId)) {
      throw new Error(`Unknown account ${input.createdByAccountId}.`)
    }
    const existing = this.headlessAgents.get(input.agentId)
    if (existing) return clone(existing)
    const now = nowIso(input.createdAt)
    const record: HeadlessAgentRecord = {
      agentId: normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
      orgId: input.orgId,
      tenantId: input.tenantId,
      profileName: normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile'),
      name: normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name'),
      status: input.status || 'active',
      managed: input.managed === true,
      createdByAccountId: input.createdByAccountId || null,
      createdAt: now,
      updatedAt: now,
    }
    this.headlessAgents.set(record.agentId, record)
    this.recordAuditEvent({
      orgId: record.orgId,
      accountId: record.createdByAccountId,
      actorType: 'system',
      actorId: 'headless_agent.create',
      eventType: 'headless_agent.created',
      targetType: 'headless_agent',
      targetId: record.agentId,
      metadata: { name: record.name, profileName: record.profileName, managed: record.managed },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updateHeadlessAgent(input: UpdateHeadlessAgentInput): HeadlessAgentRecord | null {
    const existing = this.headlessAgents.get(input.agentId)
    if (!existing || existing.orgId !== input.orgId) return null
    const updatedAt = nowIso(input.updatedAt)
    existing.profileName = input.profileName === undefined ? existing.profileName : normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile')
    existing.name = input.name === undefined ? existing.name : normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name')
    existing.status = input.status || existing.status
    existing.managed = input.managed === undefined ? existing.managed : input.managed
    existing.updatedAt = updatedAt
    this.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'headless_agent.updated',
      targetType: 'headless_agent',
      targetId: existing.agentId,
      metadata: {
        profileName: existing.profileName,
        name: existing.name,
        status: existing.status,
        managed: existing.managed,
      },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null {
    const agent = this.headlessAgents.get(agentId)
    return agent && agent.orgId === orgId ? clone(agent) : null
  }

  listHeadlessAgents(orgId: string): HeadlessAgentRecord[] {
    return Array.from(this.headlessAgents.values())
      .filter((agent) => agent.orgId === orgId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId))
      .map((agent) => clone(agent))
  }

  createChannelBinding(input: CreateChannelBindingInput): ChannelBindingRecord {
    const agent = this.headlessAgents.get(input.agentId)
    if (!agent || agent.orgId !== input.orgId) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const existing = this.channelBindings.get(input.bindingId)
    if (existing) return clone(existing)
    const bindingLimit = input.quota?.maxGatewayChannelBindingsPerOrg
    if (bindingLimit && bindingLimit > 0) {
      const activeBindings = Array.from(this.channelBindings.values())
        .filter((binding) => binding.orgId === input.orgId && binding.status !== 'disabled')
        .length
      if (activeBindings >= bindingLimit) {
        quotaExceeded({
          message: 'Gateway channel binding quota exceeded.',
          policyCode: input.quota?.policyCode || 'quota.gateway_channel_bindings_exceeded',
          retryAfterMs: 60_000,
          limit: bindingLimit,
          used: activeBindings,
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
    }
    const now = nowIso(input.createdAt)
    const record: ChannelBindingRecord = {
      bindingId: normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
      orgId: input.orgId,
      agentId: input.agentId,
      provider: normalizeProvider(input.provider),
      externalWorkspaceId: normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
      displayName: normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
      status: input.status || 'active',
      credentialRef: normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
      settings: normalizeRecord(input.settings, 'Channel binding settings'),
      createdAt: now,
      updatedAt: now,
    }
    this.channelBindings.set(record.bindingId, record)
    this.recordAuditEvent({
      orgId: record.orgId,
      actorType: 'system',
      actorId: 'channel_binding.create',
      eventType: 'channel_binding.created',
      targetType: 'channel_binding',
      targetId: record.bindingId,
      metadata: { provider: record.provider, displayName: record.displayName, credentialRefConfigured: Boolean(record.credentialRef) },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updateChannelBinding(input: UpdateChannelBindingInput): ChannelBindingRecord | null {
    const existing = this.channelBindings.get(input.bindingId)
    if (!existing || existing.orgId !== input.orgId) return null
    existing.displayName = input.displayName === undefined ? existing.displayName : normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name')
    existing.status = input.status || existing.status
    existing.credentialRef = input.credentialRef === undefined ? existing.credentialRef : normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref')
    existing.settings = input.settings === undefined ? existing.settings : normalizeRecord(input.settings, 'Channel binding settings')
    existing.updatedAt = nowIso(input.updatedAt)
    this.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'channel_binding.updated',
      targetType: 'channel_binding',
      targetId: existing.bindingId,
      metadata: {
        provider: existing.provider,
        displayName: existing.displayName,
        status: existing.status,
        credentialRefConfigured: Boolean(existing.credentialRef),
        settingsChanged: input.settings !== undefined,
      },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null {
    const binding = this.channelBindings.get(bindingId)
    return binding && binding.orgId === orgId ? clone(binding) : null
  }

  listChannelBindings(orgId: string, agentId?: string | null): ChannelBindingRecord[] {
    return Array.from(this.channelBindings.values())
      .filter((binding) => binding.orgId === orgId && (!agentId || binding.agentId === agentId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.bindingId.localeCompare(right.bindingId))
      .map((binding) => clone(binding))
  }

  upsertChannelIdentity(input: UpsertChannelIdentityInput): ChannelIdentityRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.accountId && !this.accounts.has(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const externalKey = key(input.orgId, channelScopeKey(provider, externalWorkspaceId, externalUserId))
    const existingId = this.channelIdentitiesByExternal.get(externalKey)
    const existing = existingId ? this.channelIdentities.get(existingId) : null
    const now = nowIso(input.updatedAt)
    const record: ChannelIdentityRecord = {
      identityId: existing?.identityId || input.identityId || stableId('chid', input.orgId, provider, externalWorkspaceId || '', externalUserId),
      orgId: input.orgId,
      provider,
      externalWorkspaceId,
      externalUserId,
      accountId: input.accountId === undefined ? existing?.accountId || null : input.accountId || null,
      role: input.role === undefined ? existing?.role || 'viewer' : normalizeChannelIdentityRole(input.role),
      status: input.status || existing?.status || 'pending',
      metadata: input.metadata === undefined ? existing?.metadata || {} : normalizeRecord(input.metadata, 'Channel identity metadata'),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    this.channelIdentities.set(record.identityId, record)
    this.channelIdentitiesByExternal.set(externalKey, record.identityId)
    return clone(record)
  }

  getChannelIdentity(orgId: string, identityId: string): ChannelIdentityRecord | null {
    const identity = this.channelIdentities.get(identityId)
    return identity && identity.orgId === orgId ? clone(identity) : null
  }

  findChannelIdentity(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalUserId: string }): ChannelIdentityRecord | null {
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const identityId = this.channelIdentitiesByExternal.get(key(input.orgId, channelScopeKey(provider, externalWorkspaceId, externalUserId)))
    return identityId ? clone(this.channelIdentities.get(identityId) || null) : null
  }

  bindChannelSession(input: BindChannelSessionInput): ChannelSessionBindingRecord {
    const channelBinding = this.channelBindings.get(input.channelBindingId)
    if (!channelBinding || channelBinding.orgId !== input.orgId) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
    const agent = this.headlessAgents.get(input.agentId)
    if (!agent || agent.orgId !== input.orgId) throw new Error(`Unknown headless agent ${input.agentId}.`)
    if (channelBinding.agentId !== agent.agentId) throw new Error('Channel session binding agent does not match channel binding.')
    const provider = normalizeProvider(input.provider)
    if (channelBinding.provider !== provider) throw new Error('Channel session binding provider does not match channel binding.')
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalChatId = normalizeText(input.externalChatId, CHANNEL_TEXT_MAX_LENGTH, 'External chat id')
    const externalThreadId = normalizeText(input.externalThreadId, CHANNEL_TEXT_MAX_LENGTH, 'External thread id')
    const threadKey = key(input.orgId, channelThreadKey(provider, externalWorkspaceId, externalChatId, externalThreadId))
    const existingId = this.channelSessionBindingsByThread.get(threadKey)
    if (existingId) return clone(this.channelSessionBindings.get(existingId) as ChannelSessionBindingRecord)
    const session = this.getSessionForTenant(this.orgs.get(input.orgId)?.tenantId || input.orgId, input.sessionId)
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

  updateChannelCursor(input: UpdateChannelCursorInput): ChannelSessionBindingRecord | null {
    const existing = this.channelSessionBindings.get(input.bindingId)
    if (!existing || existing.orgId !== input.orgId) return null
    const lastEventSequence = normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence')
    const lastWorkspaceSequence = normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence')
    if (lastEventSequence < existing.lastEventSequence || lastWorkspaceSequence < existing.lastWorkspaceSequence) {
      throw new Error('Channel cursor updates must be monotonic.')
    }
    existing.lastEventSequence = lastEventSequence
    existing.lastWorkspaceSequence = lastWorkspaceSequence
    if (input.lastChatMessageId !== undefined) {
      existing.lastChatMessageId = normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id')
    }
    existing.updatedAt = nowIso(input.updatedAt)
    return clone(existing)
  }

  createChannelInteraction(input: CreateChannelInteractionInput): IssuedChannelInteractionRecord {
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const org = this.orgs.get(input.orgId)
    const agent = this.headlessAgents.get(input.agentId)
    if (!agent || agent.orgId !== input.orgId) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const session = this.getSessionForTenant(org?.tenantId || input.orgId, input.sessionId)
    if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
    if (input.createdByIdentityId) {
      const identity = this.channelIdentities.get(input.createdByIdentityId)
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
    if (!this.orgs.has(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const agent = this.headlessAgents.get(input.agentId)
    if (!agent || agent.orgId !== input.orgId) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const channelBinding = this.channelBindings.get(input.channelBindingId)
    if (!channelBinding || channelBinding.orgId !== input.orgId) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
    const provider = normalizeProvider(input.provider)
    if (channelBinding.agentId !== agent.agentId) throw new Error('Channel delivery binding does not match headless agent.')
    if (channelBinding.provider !== provider) throw new Error('Channel delivery provider does not match channel binding.')
    if (input.sessionBindingId) {
      const sessionBinding = this.channelSessionBindings.get(input.sessionBindingId)
      if (!sessionBinding || sessionBinding.orgId !== input.orgId) throw new Error(`Unknown channel session binding ${input.sessionBindingId}.`)
      if (
        sessionBinding.agentId !== agent.agentId
        || sessionBinding.channelBindingId !== channelBinding.bindingId
        || sessionBinding.provider !== provider
      ) {
        throw new Error('Channel delivery session binding does not match channel binding.')
      }
    }
    const existing = this.channelDeliveries.get(input.deliveryId)
    if (existing) return clone(existing)
    const now = nowIso(input.createdAt)
    const record: ChannelDeliveryRecord = {
      deliveryId: normalizeText(input.deliveryId, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery id'),
      orgId: input.orgId,
      agentId: normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
      channelBindingId: normalizeText(input.channelBindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
      sessionBindingId: normalizeNullableText(input.sessionBindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel session binding id'),
      provider,
      target: normalizeRecord(input.target, 'Channel delivery target'),
      eventType: normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery event type'),
      payload: normalizeRecord(input.payload, 'Channel delivery payload'),
      status: input.status || 'pending',
      attemptCount: 0,
      claimedBy: null,
      claimExpiresAt: null,
      nextAttemptAt: (input.nextAttemptAt || input.createdAt || new Date()).toISOString(),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.channelDeliveries.set(record.deliveryId, record)
    return clone(record)
  }

  listChannelDeliveries(input: ListChannelDeliveriesInput): ChannelDeliveryRecord[] {
    const limit = Math.max(1, Math.min(200, input.limit || 50))
    return Array.from(this.channelDeliveries.values())
      .filter((delivery) => delivery.orgId === input.orgId)
      .filter((delivery) => !input.status || delivery.status === input.status)
      .filter((delivery) => !input.channelBindingId || delivery.channelBindingId === input.channelBindingId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone)
  }

  claimNextChannelDelivery(input: ClaimChannelDeliveryInput): ChannelDeliveryRecord | null {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const candidate = Array.from(this.channelDeliveries.values())
      .filter((delivery) => delivery.orgId === input.orgId)
      .filter((delivery) => (
        (delivery.status === 'pending' && new Date(delivery.nextAttemptAt).getTime() <= nowMs)
        || (delivery.status === 'failed' && new Date(delivery.nextAttemptAt).getTime() <= nowMs)
        || (delivery.status === 'claimed' && delivery.claimExpiresAt && new Date(delivery.claimExpiresAt).getTime() <= nowMs)
      ))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.createdAt.localeCompare(right.createdAt))[0]
    if (!candidate) return null
    if (input.quota) {
      const quota = this.consumeUsageQuota({
        ...input.quota,
        orgId: input.orgId,
        now,
      })
      if (!quota.allowed) {
        quotaExceeded({
          message: 'Gateway delivery quota exceeded.',
          policyCode: quota.policyCode || 'quota.gateway_deliveries_per_hour_exceeded',
          retryAfterMs: quota.retryAfterMs,
          limit: quota.limit,
          used: quota.used,
          resetAt: quota.resetAt,
        })
      }
    }
    candidate.status = 'claimed'
    candidate.claimedBy = normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery claimant')
    candidate.claimExpiresAt = new Date(nowMs + (input.ttlMs || 30_000)).toISOString()
    candidate.attemptCount += 1
    candidate.updatedAt = now.toISOString()
    return clone(candidate)
  }

  ackChannelDelivery(input: AckChannelDeliveryInput): ChannelDeliveryRecord | null {
    const delivery = this.channelDeliveries.get(input.deliveryId)
    if (!delivery || delivery.orgId !== input.orgId) return null
    if (input.claimedBy && delivery.claimedBy !== input.claimedBy) return null
    const updatedAt = nowIso(input.updatedAt)
    delivery.status = input.status
    delivery.claimedBy = null
    delivery.claimExpiresAt = null
    delivery.lastError = input.lastError ? redactOperationalText(input.lastError, CHANNEL_DELIVERY_ERROR_MAX_LENGTH, 'Delivery error') : null
    delivery.nextAttemptAt = (input.nextAttemptAt || input.updatedAt || new Date()).toISOString()
    delivery.updatedAt = updatedAt
    return clone(delivery)
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
      .map((session) => clone(session.record))
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
      items: page.map((session) => clone(session)),
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

  listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0): SessionEventRecord[] {
    const session = this.requireSession(tenantId, sessionId)
    return session.events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
  }

  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    if (input.sessionId) {
      const session = this.requireSession(input.tenantId, input.sessionId)
      if (session.record.userId !== input.userId) {
        throw new Error(`Session ${input.sessionId} does not belong to user ${input.userId}.`)
      }
    }
    const workspaceKey = `${input.tenantId}:${input.userId}`
    const state = this.workspaceEvents.get(workspaceKey) || { nextSequence: 0, events: [] }
    const payload = input.payload || {}
    const eventId = input.eventId || `${input.userId}:${state.nextSequence + 1}`
    const sequence = state.nextSequence + 1
    const entityType = optionalTrimmedText(input.entityType) || (input.sessionId ? 'session' : 'workspace')
    const entityId = optionalTrimmedText(input.entityId) || input.sessionId || input.userId
    const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
    const projectionVersion = Number.isFinite(input.projectionVersion)
      ? Math.max(0, Math.floor(input.projectionVersion || 0))
      : sequence
    const existing = state.events.find((event) => event.eventId === eventId)
    if (existing) {
      const expectedProjectionVersion = Number.isFinite(input.projectionVersion)
        ? projectionVersion
        : existing.projectionVersion
      if (
        existing.type !== input.type
        || stableJson(existing.payload) !== stableJson(payload)
        || (existing.sessionId || null) !== (input.sessionId || null)
        || existing.entityType !== entityType
        || existing.entityId !== entityId
        || existing.operation !== operation
        || existing.projectionVersion !== expectedProjectionVersion
      ) {
        throw new Error(`Workspace event id ${eventId} was reused with different content.`)
      }
      return clone(existing)
    }
    const event: WorkspaceEventRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId || null,
      eventId,
      sequence,
      entityType,
      entityId,
      operation,
      projectionVersion,
      type: input.type,
      payload,
      createdAt: nowIso(input.createdAt),
    }
    state.nextSequence = sequence
    state.events.push(event)
    this.workspaceEvents.set(workspaceKey, state)
    return clone(event)
  }

  listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0): WorkspaceEventRecord[] {
    this.requireTenantUser(tenantId, userId)
    const workspaceKey = `${tenantId}:${userId}`
    return (this.workspaceEvents.get(workspaceKey)?.events || [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
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
    const reaped: ReapedSessionLeaseRecord[] = []
    for (const session of this.sessions.values()) {
      const lease = session.lease
      if (!lease || lease.leaseExpiresAt > nowMs) continue
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
      const orgId = this.orgsByTenant.get(lease.tenantId) || (this.orgs.has(lease.tenantId) ? lease.tenantId : null)
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
      const countersSnapshot = new Map(this.usageCounters)
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
        this.usageCounters.clear(); for (const [counterKey, counter] of countersSnapshot) this.usageCounters.set(counterKey, counter); throw error
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
    const record: WorkerHeartbeatRecord = {
      workerId: input.workerId,
      role: input.role,
      activeSessionIds: [...new Set(input.activeSessionIds || [])],
      lastSeenAt: nowIso(input.now),
    }
    this.heartbeats.set(input.workerId, record)
    return clone(record)
  }

  listWorkerHeartbeats(): WorkerHeartbeatRecord[] {
    return Array.from(this.heartbeats.values()).map((record) => clone(record))
  }

  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): SettingMetadataRecord {
    this.requireTenant(input.tenantId)
    if (input.userId) this.requireTenantUser(input.tenantId, input.userId)
    const record: SettingMetadataRecord = {
      tenantId: input.tenantId,
      userId: input.userId || null,
      key: input.key,
      value: input.value,
      updatedAt: nowIso(input.updatedAt),
    }
    this.settings.set(key(input.tenantId, input.userId || '', input.key), record)
    return clone(record)
  }

  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): SettingMetadataRecord | null {
    this.requireTenant(tenantId)
    return clone(this.settings.get(key(tenantId, userId || '', keyName)) || null)
  }

  listSettingMetadata(tenantId: string, userId?: string | null): SettingMetadataRecord[] {
    this.requireTenant(tenantId)
    if (userId) this.requireTenantUser(tenantId, userId)
    return Array.from(this.settings.values())
      .filter((setting) => setting.tenantId === tenantId && setting.userId === (userId || null))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((setting) => clone(setting))
  }

  createWorkflow(input: CreateWorkflowInput): CloudWorkflowRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const workflowKey = key(input.tenantId, input.workflowId)
    const existing = this.workflows.get(workflowKey)
    if (existing) return clone(existing.record)
    const createdAt = nowIso(input.createdAt)
    const draft = clone(input.draft)
    const record: CloudWorkflowRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      id: input.workflowId,
      title: draft.title,
      instructions: draft.instructions,
      agentName: draft.agentName,
      skillNames: [...(draft.skillNames || [])],
      toolIds: [...(draft.toolIds || [])],
      status: 'active',
      projectDirectory: draft.projectDirectory || null,
      draftSessionId: draft.draftSessionId || null,
      triggers: clone(draft.triggers),
      createdAt,
      updatedAt: createdAt,
      nextRunAt: input.nextRunAt ?? null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: null,
    }
    this.workflows.set(workflowKey, { record, runs: [] })
    return clone(record)
  }

  findWorkflow(workflowId: string): CloudWorkflowRecord | null {
    for (const workflow of this.workflows.values()) {
      if (workflow.record.id === workflowId) return clone(workflow.record)
    }
    return null
  }

  listWorkflows(tenantId: string, userId: string): CloudWorkflowRecord[] {
    this.requireTenantUser(tenantId, userId)
    return Array.from(this.workflows.values())
      .filter((workflow) => workflow.record.tenantId === tenantId && workflow.record.userId === userId)
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .map((workflow) => clone(workflow.record))
  }

  getWorkflow(tenantId: string, userId: string, workflowId: string): CloudWorkflowRecord | null {
    this.requireTenantUser(tenantId, userId)
    const workflow = this.workflows.get(key(tenantId, workflowId))?.record || null
    if (!workflow || workflow.userId !== userId) return null
    return clone(workflow)
  }

  getWorkflowForTenant(tenantId: string, workflowId: string): CloudWorkflowRecord | null {
    this.requireTenant(tenantId)
    return clone(this.workflows.get(key(tenantId, workflowId))?.record || null)
  }

  updateWorkflowStatus(input: UpdateWorkflowStatusInput): CloudWorkflowRecord | null {
    this.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.workflows.get(key(input.tenantId, input.workflowId))
    if (!workflow || workflow.record.userId !== input.userId) return null
    workflow.record.status = input.status
    workflow.record.nextRunAt = input.nextRunAt ?? null
    workflow.record.updatedAt = nowIso(input.updatedAt)
    return clone(workflow.record)
  }

  listWorkflowRuns(tenantId: string, workflowId: string, limit = 25): CloudWorkflowRunRecord[] {
    this.requireTenant(tenantId)
    const workflow = this.requireWorkflow(tenantId, workflowId)
    return workflow.runs
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(1, limit), WORKFLOW_RUN_LIST_LIMIT))
      .map((run) => clone(run))
  }

  createWorkflowRun(input: CreateWorkflowRunInput): CloudWorkflowRunRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    if (workflow.record.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
    this.assertWorkflowRunnable(workflow.record)
    const runKey = key(input.tenantId, input.runId)
    const existing = this.workflowRuns.get(runKey)
    if (existing) return clone(existing)
    this.quotaDomain.assertWorkflowRunQuota({ tenantId: input.tenantId, quota: input.quota, now: input.createdAt })
    const createdAt = nowIso(input.createdAt)
    const claimedBy = input.claimedBy?.trim() || null
    const claimToken = claimedBy ? createWorkClaimToken(input.tenantId, input.runId, claimedBy) : null
    const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
    const run: CloudWorkflowRunRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      id: input.runId,
      workflowId: input.workflowId,
      sessionId: null,
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload || null,
      status: 'queued',
      title: `Run ${workflow.record.title}`,
      summary: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      claimedBy,
      claimToken,
      claimExpiresAt: claimToken ? new Date(new Date(createdAt).getTime() + leaseTtlMs).toISOString() : null,
      attemptCount: claimToken ? 1 : 0,
      idempotencyKey: null,
      checkpointVersion: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
    }
    workflow.runs.push(run)
    this.workflowRuns.set(runKey, run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.updatedAt = createdAt
    return clone(run)
  }

  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): ClaimedWorkflowRunRecord | null {
    const now = input.now || new Date()
    const claimedAt = now.toISOString()
    const claimedBy = input.claimedBy?.trim() || 'scheduler'
    const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
    const retryRun = Array.from(this.workflowRuns.values())
      .filter((run) => (
        this.workflows.get(key(run.tenantId, run.workflowId))?.record.status === 'running'
        &&
        (
          (run.status === 'queued' && run.sessionId === null)
          || (run.status === 'running' && run.sessionId !== null && !this.sessionHasCommands(run.tenantId, run.sessionId))
        )
        && run.claimToken === null
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    if (retryRun) {
      const workflow = this.requireWorkflow(retryRun.tenantId, retryRun.workflowId)
      retryRun.claimedBy = claimedBy
      retryRun.claimToken = createWorkClaimToken(retryRun.tenantId, retryRun.id, claimedBy)
      retryRun.claimExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString()
      retryRun.attemptCount += 1
      retryRun.lastErrorCode = null
      retryRun.lastErrorSummary = null
      workflow.record.status = 'running'
      workflow.record.latestRunId = retryRun.id
      workflow.record.latestRunStatus = retryRun.status
      workflow.record.latestRunSessionId = retryRun.sessionId
      workflow.record.updatedAt = claimedAt
      return {
        workflow: clone(workflow.record),
        run: clone(retryRun),
      }
    }
    const workflow = Array.from(this.workflows.values())
      .filter((entry) => (
        entry.record.status === 'active'
        && entry.record.nextRunAt !== null
        && entry.record.nextRunAt <= claimedAt
      ))
      .sort((left, right) => String(left.record.nextRunAt).localeCompare(String(right.record.nextRunAt)))[0]
    if (!workflow) return null
    const scheduledFor = workflow.record.nextRunAt
    this.quotaDomain.assertWorkflowRunQuota({ tenantId: workflow.record.tenantId, quota: input.quota, now })
    const claimToken = createWorkClaimToken(workflow.record.tenantId, input.runId, claimedBy)
    const run: CloudWorkflowRunRecord = {
      tenantId: workflow.record.tenantId,
      userId: workflow.record.userId,
      id: input.runId,
      workflowId: workflow.record.id,
      sessionId: null,
      triggerType: 'schedule',
      triggerPayload: {
        source: 'schedule',
        scheduledFor,
      },
      status: 'queued',
      title: `Run ${workflow.record.title}`,
      summary: null,
      error: null,
      createdAt: claimedAt,
      startedAt: null,
      finishedAt: null,
      claimedBy,
      claimToken,
      claimExpiresAt: new Date(now.getTime() + leaseTtlMs).toISOString(),
      attemptCount: 1,
      idempotencyKey: `schedule:${workflow.record.id}:${scheduledFor}`,
      checkpointVersion: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
    }
    workflow.runs.push(run)
    this.workflowRuns.set(key(run.tenantId, run.id), run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.updatedAt = claimedAt
    return {
      workflow: clone(workflow.record),
      run: clone(run),
    }
  }

  reapExpiredWorkflowClaims(input: ReapExpiredWorkflowClaimsInput = {}): ReapedWorkflowClaimRecord[] {
    const now = input.now || new Date()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3))
    const reaped: ReapedWorkflowClaimRecord[] = []
    for (const run of this.workflowRuns.values()) {
      if (!run.claimToken || !run.claimExpiresAt || Date.parse(run.claimExpiresAt) > now.getTime()) continue
      if (
        !(run.status === 'queued' && run.sessionId === null)
        && !(run.status === 'running' && run.sessionId !== null && !this.sessionHasCommands(run.tenantId, run.sessionId))
      ) continue
      const workflow = this.workflows.get(key(run.tenantId, run.workflowId))
      if (!workflow) continue
      const claimToken = run.claimToken
      const claimedBy = run.claimedBy || 'unknown'
      const action: WorkReaperAction = run.attemptCount >= maxAttempts ? 'failed' : 'retried'
      if (action === 'failed') {
        run.status = 'failed'
        run.error = 'Workflow run claim expired after the maximum retry attempts.'
        run.summary = run.error
        run.finishedAt = nowIsoValue
        run.lastErrorCode = 'claim_expired_max_attempts'
        run.lastErrorSummary = run.error
        run.claimedBy = null
        run.claimToken = null
        run.claimExpiresAt = null
        workflow.record.status = 'failed'
        workflow.record.latestRunStatus = 'failed'
        workflow.record.latestRunSummary = run.error
        workflow.record.nextRunAt = null
      } else {
        run.claimedBy = null
        run.claimToken = null
        run.claimExpiresAt = null
        run.lastErrorCode = 'claim_expired'
        run.lastErrorSummary = run.sessionId
          ? 'Workflow run claim expired before command enqueue.'
          : 'Workflow run claim expired before session attachment.'
        workflow.record.status = 'running'
        workflow.record.latestRunStatus = run.status
        workflow.record.latestRunSessionId = run.sessionId
      }
      workflow.record.latestRunId = run.id
      workflow.record.updatedAt = nowIsoValue
      reaped.push({
        tenantId: run.tenantId,
        workflowId: run.workflowId,
        runId: run.id,
        claimToken,
        claimedBy,
        action,
        reapedAt: nowIsoValue,
      })
    }
    return reaped
  }

  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): CloudWorkflowRunRecord | null {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Workflow run is not attachable.')
    }
    if (run.status !== 'queued' && !(run.status === 'running' && run.sessionId === input.sessionId)) {
      throw new Error('Workflow run is not attachable.')
    }
    if (run.sessionId && run.sessionId !== input.sessionId) throw new Error('Workflow run is already attached to another session.')
    if (run.claimToken) {
      if (run.claimToken !== (input.claimToken ?? null)) throw new Error('Workflow run claim is stale.')
      if (run.claimExpiresAt && Date.parse(run.claimExpiresAt) <= Date.now()) throw new Error('Workflow run claim is stale.')
    } else if (input.claimToken) {
      throw new Error('Workflow run claim is stale.')
    }
    const startedAt = nowIso(input.startedAt)
    run.sessionId = input.sessionId
    run.status = 'running'
    run.startedAt ||= startedAt
    run.claimedBy = null
    run.claimToken = null
    run.claimExpiresAt = null
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSessionId = input.sessionId
    workflow.record.updatedAt = startedAt
    return clone(run)
  }

  completeWorkflowRun(input: CompleteWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'completed',
      summary: input.summary,
      error: null,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    })
  }

  failWorkflowRun(input: FailWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'failed',
      summary: input.error,
      error: input.error,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    })
  }

  getWorkflowRun(tenantId: string, runId: string): CloudWorkflowRunRecord | null {
    this.requireTenant(tenantId)
    return clone(this.workflowRuns.get(key(tenantId, runId)) || null)
  }

  getWorkflowRunBySession(tenantId: string, sessionId: string): CloudWorkflowRunRecord | null {
    this.requireTenant(tenantId)
    for (const run of this.workflowRuns.values()) {
      if (run.tenantId === tenantId && run.sessionId === sessionId) return clone(run)
    }
    return null
  }

  listThreadTags(tenantId: string): ThreadTagRecord[] {
    this.requireTenant(tenantId)
    return Array.from(this.threadTags.values())
      .filter((tag) => tag.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }

  createThreadTag(input: CreateThreadTagInput): ThreadTagRecord {
    this.requireTenant(input.tenantId)
    const tagKey = key(input.tenantId, input.tagId)
    const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = normalizeTagColor(input.color)
    const existing = this.threadTags.get(tagKey)
    if (existing) {
      if (existing.name !== name || existing.color !== color) {
        throw new Error(`Tag id ${input.tagId} was reused with different content.`)
      }
      return clone(existing)
    }
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    const createdAt = nowIso(input.createdAt)
    const record: ThreadTagRecord = {
      tenantId: input.tenantId,
      tagId: input.tagId,
      name,
      color,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadTags.set(tagKey, record)
    return clone(record)
  }

  updateThreadTag(input: UpdateThreadTagInput): ThreadTagRecord | null {
    this.requireTenant(input.tenantId)
    const tag = this.threadTags.get(key(input.tenantId, input.tagId))
    if (!tag) return null
    const name = normalizeOptionalText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name') ?? tag.name
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    tag.name = name
    if (input.color !== undefined) tag.color = normalizeTagColor(input.color)
    tag.updatedAt = nowIso(input.updatedAt)
    return clone(tag)
  }

  deleteThreadTag(tenantId: string, tagId: string): boolean {
    this.requireTenant(tenantId)
    const deleted = this.threadTags.delete(key(tenantId, tagId))
    for (const [linkKey, tags] of this.threadTagLinks.entries()) {
      if (!linkKey.startsWith(`${tenantId}\0`)) continue
      tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
    return deleted
  }

  applyThreadTags(input: ThreadTagLinkInput): void {
    this.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey) || new Set<string>()
      for (const tagId of tagIds) tags.add(tagId)
      this.threadTagLinks.set(linkKey, tags)
    }
  }

  removeThreadTags(input: ThreadTagLinkInput): void {
    this.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey)
      if (!tags) continue
      for (const tagId of tagIds) tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
  }

  listThreadSmartFilters(tenantId: string): ThreadSmartFilterRecord[] {
    this.requireTenant(tenantId)
    return Array.from(this.threadSmartFilters.values())
      .filter((filter) => filter.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((filter) => clone(filter))
  }

  createThreadSmartFilter(input: CreateThreadSmartFilterInput): ThreadSmartFilterRecord {
    this.requireTenant(input.tenantId)
    const filterKey = key(input.tenantId, input.filterId)
    const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = normalizeThreadQuery(input.query)
    const existing = this.threadSmartFilters.get(filterKey)
    if (existing) {
      if (existing.name !== name || stableJson(existing.query) !== stableJson(query)) {
        throw new Error(`Smart filter id ${input.filterId} was reused with different content.`)
      }
      return clone(existing)
    }
    const createdAt = nowIso(input.createdAt)
    const record: ThreadSmartFilterRecord = {
      tenantId: input.tenantId,
      filterId: input.filterId,
      name,
      query,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadSmartFilters.set(filterKey, record)
    return clone(record)
  }

  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): ThreadSmartFilterRecord | null {
    this.requireTenant(input.tenantId)
    const filter = this.threadSmartFilters.get(key(input.tenantId, input.filterId))
    if (!filter) return null
    filter.name = normalizeOptionalText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name') ?? filter.name
    if (input.query !== undefined) filter.query = normalizeThreadQuery(input.query)
    filter.updatedAt = nowIso(input.updatedAt)
    return clone(filter)
  }

  deleteThreadSmartFilter(tenantId: string, filterId: string): boolean {
    this.requireTenant(tenantId)
    return this.threadSmartFilters.delete(key(tenantId, filterId))
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
        const sessionTagIds = this.threadTagLinks.get(key(input.tenantId, session.record.sessionId))
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
    const existing = this.migrations.get(id)
    if (existing) return clone(existing)
    const record: SchemaMigrationRecord = {
      id,
      appliedAt: appliedAt.toISOString(),
    }
    this.migrations.set(id, record)
    return clone(record)
  }

  listSchemaMigrations(): SchemaMigrationRecord[] {
    return Array.from(this.migrations.values()).map((record) => clone(record))
  }

  private requireTenant(tenantId: string) {
    const tenant = this.tenants.get(tenantId)
    if (!tenant) throw new Error(`Unknown tenant ${tenantId}.`)
    return tenant
  }

  private requireTenantUser(tenantId: string, userId: string) {
    this.requireTenant(tenantId)
    const user = this.users.get(key(tenantId, userId))
    if (!user) throw new Error(`User ${userId} does not belong to tenant ${tenantId}.`)
    return user
  }

  private requireSession(tenantId: string, sessionId: string) {
    this.requireTenant(tenantId)
    const session = this.sessions.get(key(tenantId, sessionId))
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private requireWorkflow(tenantId: string, workflowId: string) {
    this.requireTenant(tenantId)
    const workflow = this.workflows.get(key(tenantId, workflowId))
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}.`)
    return workflow
  }

  private assertWorkflowRunnable(workflow: CloudWorkflowRecord) {
    if (workflow.status === 'archived') throw new Error('Archived workflows cannot run.')
    if (workflow.status === 'paused') throw new Error('Paused workflows cannot run.')
    if (workflow.status === 'running') throw new Error('Workflow is already running.')
  }

  private finishWorkflowRun(input: {
    tenantId: string
    workflowId: string
    runId: string
    status: Extract<WorkflowRunStatus, 'completed' | 'failed'>
    summary: string | null
    error: string | null
    nextStatus: WorkflowStatus
    nextRunAt: string | null
    leaseToken?: string | null
    finishedAt?: Date
  }) {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return clone(run)
    if (input.leaseToken !== undefined) {
      if (!run.sessionId) throw new Error('Workflow run has no execution session to fence.')
      const session = this.requireSession(input.tenantId, run.sessionId)
      this.assertLeaseTokenIfPresent(session, input.leaseToken)
    }
    const finishedAt = nowIso(input.finishedAt)
    run.status = input.status
    run.summary = input.summary
    run.error = input.error
    run.finishedAt = finishedAt
    workflow.record.status = input.nextStatus
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSummary = input.summary
    workflow.record.lastRunAt = input.status === 'completed' ? finishedAt : workflow.record.lastRunAt
    workflow.record.nextRunAt = input.nextRunAt
    workflow.record.updatedAt = finishedAt
    return clone(run)
  }

  private requireThreadTag(tenantId: string, tagId: string) {
    const tag = this.threadTags.get(key(tenantId, tagId))
    if (!tag) throw new Error(`Unknown thread tag ${tagId}.`)
    return tag
  }

  private requireCommand(session: SessionState, commandId: string) {
    const command = session.commands.find((entry) => entry.commandId === commandId)
    if (!command) throw new Error(`Unknown command ${commandId}.`)
    return command
  }

  private sessionHasCommands(tenantId: string, sessionId: string) {
    const session = this.sessions.get(key(tenantId, sessionId))
    return Boolean(session?.commands.length)
  }

  private assertUniqueThreadTagName(tenantId: string, tagId: string, name: string) {
    const normalized = name.toLocaleLowerCase()
    const duplicate = Array.from(this.threadTags.values()).find((tag) => (
      tag.tenantId === tenantId
      && tag.tagId !== tagId
      && tag.name.toLocaleLowerCase() === normalized
    ))
    if (duplicate) throw new Error(`Thread tag "${name}" already exists.`)
  }

  private tagsForSession(tenantId: string, sessionId: string) {
    const tagIds = this.threadTagLinks.get(key(tenantId, sessionId))
    if (!tagIds) return []
    return Array.from(tagIds)
      .map((tagId) => this.threadTags.get(key(tenantId, tagId)))
      .filter((tag): tag is ThreadTagRecord => Boolean(tag))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }

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
