import { computeNextWorkflowRunAt } from '@open-cowork/runtime-host/workflow/workflow-schedule'
import { verifyWorkflowWebhookAuth, WebhookHttpError, type WorkflowWebhookAuth, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { createHash, randomUUID } from 'crypto'
import type {
  CapabilitySkill,
  CapabilityTool,
  CloudProjectedSessionEventType,
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchEvent,
  CoordinationWatchInput,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowStatus,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  assertSafeSessionImportPayload,
  coordinationWatchRecipientCanReceive,
  type CloudSessionMessage,
  type CloudSessionProjectionView,
  type CloudSessionViewRecord,
  type CloudProjectSnapshotUploadInput,
  type CloudProjectSnapshotUploadResult,
  type CloudProjectSource,
  type CloudProjectSourceInput,
  type CloudProjectSourcePolicyVerdict,
  type SessionImportItemCounts,
  type SessionImportRequest,
  normalizeCloudProjectSource,
  summarizeCloudProjectSource,
} from '@open-cowork/shared'
import { InvalidSessionPageCursorError } from './control-plane-store.ts'
import type {
  ApiTokenScope,
  ApiTokenRecord,
  BillingSubscriptionRecord,
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  CreateChannelDeliveryInput,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelCursorUpdateResult,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  ControlPlaneMembershipStatus,
  ControlPlaneRole,
  ControlPlaneStore,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerStatus,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  ListSessionsPageInput,
  ListSessionsPageRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
  UsageEventRecord,
  WorkerLeaseRecord,
} from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import { ControlPlaneQuotaExceededError } from './control-plane-errors.ts'
import {
  evaluateBillingEntitlement,
  isBillingConfigured,
  type BillingAdapter,
  type BillingAction,
  type BillingCheckoutResult,
  type BillingPortalResult,
  type BillingWebhookResult,
} from './billing-adapter.ts'
import type { ByokSecretMetadata, ByokSecretStore } from './byok-secret-store.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeExecutionContext,
  CloudRuntimePromptPart,
} from './runtime-adapter.ts'
import {
  type CloudRuntimePolicy,
} from './cloud-config.ts'
import type { CloudProjectSourceService as CloudProjectSourceStore } from './project-source-service.ts'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from './session-event-bus.ts'
import type {
  PublicChannelBindingRecord,
  PublicChannelDeliveryRecord,
  PublicChannelIdentityRecord,
} from './public-channel-records.ts'
import {
  CloudSessionProjectionService,
  type AppendProjectedEventInput,
} from './session-projection-service.ts'
import {
  CloudByokService,
  type ByokManagementPolicy,
} from './services/byok-service.ts'
import {
  CloudMemberService,
  type CloudEmailSender,
  type MembershipInviteResult,
  type PublicOrgMemberRecord,
} from './services/member-service.ts'
import { CloudCoordinationService } from './services/coordination-service.ts'
import { CloudCapabilityService } from './services/capability-service.ts'
import { CloudSettingMetadataService } from './services/setting-metadata-service.ts'
import {
  CloudOverviewService,
  type CloudAdminPolicyOverview,
  type CloudWorkspaceOverview,
} from './services/overview-service.ts'
import { CloudProjectSourceService } from './services/project-source-service.ts'
import {
  normalizePermissionPayload,
  normalizePromptPayload,
  normalizeQuestionRejectPayload,
  normalizeQuestionReplyPayload,
  type PermissionRespondPayload,
  type QuestionRejectPayload,
  type QuestionReplyPayload,
} from './services/session-command-service.ts'
import {
  assertRemoteApprovalInteractionAllowed,
  type RemoteInteractionPolicyInput,
} from './services/remote-approval-policy.ts'
import {
  enforceApiTokenScopePolicy,
  normalizeApiTokenExpiresAt,
  normalizeApiTokenScopes,
  publicApiToken,
  resolvedSignupMode,
  type CloudIdentityPolicy,
  type PublicApiTokenRecord,
} from './services/api-token-policy.ts'
import {
  CloudManagedWorkerService,
  type CreateManagedWorkerPoolRequest,
  type ListManagedWorkersRequest,
  type ManagedWorkerHeartbeatRequest,
  type RegisterManagedWorkerRequest,
  type UpdateManagedWorkerPoolRequest,
} from './services/managed-worker-service.ts'
import { CloudUsageGovernanceService } from './services/usage-governance-service.ts'
import { CloudChannelDomainService } from './services/channel-domain-service.ts'
import { CloudThreadOrganizationService } from './session-thread-organization.ts'
import { CloudBillingOperationsService } from './session-billing-operations.ts'
import {
  principalCanManageApiTokens,
  principalCanManageOrg,
  principalCanViewDiagnostics,
  principalCanViewOperations,
  principalEmailDomain,
} from './session-principal-access.ts'
import {
  toWorkflowRun,
  toWorkflowSummary,
  workflowRunTerminal,
  workflowWebhookReplayKey,
} from './session-workflow-mappers.ts'
import { runOnAbort, throwIfAborted } from './cloud-abort-helpers.ts'
import { boundedImportText, normalizeImportCounts } from './session-import-validation.ts'
import {
  asRecord,
  includesAllowed,
  normalizedCloudListLimit,
  readString,
  stableCloudId,
} from './session-input-validation.ts'
import {
  assertWorkflowDraftAllowed,
  normalizeWorkflowDraft,
  WORKFLOW_VALID_TRIGGER_TYPES,
} from './session-workflow-validation.ts'
import { normalizeChannelProviderId } from './channel-provider-utils.ts'
import { log } from '@open-cowork/shared/node'
import type { CloudAbuseConfig, CloudBillingConfig } from '@open-cowork/shared'

export type CloudPrincipal = {
  tenantId: string
  tenantName?: string
  userId: string
  email: string
  orgId?: string
  accountId?: string
  role?: 'owner' | 'admin' | 'member'
  authSource?: 'user' | 'api_token' | 'local' | 'header' | 'worker'
  tokenId?: string
  tokenScopes?: ApiTokenScope[]
  workerId?: string
  workerPoolId?: string
  workerCredentialId?: string
  workerScopes?: string[]
}

export type { CloudEmailMessage } from './services/member-service.ts'
export type { CloudEmailSender, MembershipInviteResult, PublicOrgMemberRecord }
export type { CloudAdminPolicyOverview, CloudWorkspaceOverview } from './services/overview-service.ts'

export type CloudUsageTotalRecord = {
  eventType: string
  unit: string
  quantity: number
}

export type CloudUsageQuotaWindowRecord = {
  quotaKey: string
  label: string
  unit: 'count' | 'byte' | 'minute'
  enabled: boolean
  limit: number | null
  used: number
  remaining: number | null
  windowMs: number
  windowStartedAt: string
  resetAt: string
  policyCode: string
}

export type CloudUsageSummary = {
  enabled: boolean
  generatedAt: string
  totalsScope: 'recent_events'
  eventSampleLimit: number
  events: UsageEventRecord[]
  totals: CloudUsageTotalRecord[]
  quotas: CloudUsageQuotaWindowRecord[]
}

export type CloudDiagnosticsBundle = {
  generatedAt: string
  redaction: 'secrets-redacted'
  org: {
    orgId: string
    tenantId: string
    role: string
    profileName: string
  }
  runtime: {
    role: CloudRuntimePolicy['role']
    profileName: string
    canExecute: boolean
    commandProcessing: 'inline' | 'durable' | 'delegated'
    checkpoints: boolean
    heartbeatCount: number
    heartbeats: Array<{
      workerId: string
      role: string
      activeSessionCount: number
      lastSeenAt: string
      ageMs: number
      stale: boolean
    }>
  }
  billing: {
    enabled: boolean
    mode: 'disabled' | 'self-host' | 'managed'
    providerId: string
    subscription: BillingSubscriptionRecord | null
    entitlements: Record<string, unknown>
    active: boolean
    plans: Array<{
      planKey: string
      label: string
      default: boolean
      entitlements: Record<string, unknown>
    }>
  }
  byok: {
    configuredProviders: number
    providers: ByokSecretMetadata[]
  }
  usage: CloudUsageSummary
  gateway: {
    agents: {
      total: number
      active: number
      disabled: number
    }
    bindingsByProvider: Record<string, number>
    deliveriesByStatus: Record<string, number>
    deliveriesByStatusScope: 'recent_deliveries'
    deliverySampleLimit: number
  }
  links: {
    deploymentDocs: string
    managedByokRunbook: string
  }
}

export type { CloudIdentityPolicy, PublicApiTokenRecord } from './services/api-token-policy.ts'
export type {
  PublicChannelBindingRecord,
  PublicChannelDeliveryRecord,
  PublicChannelIdentityRecord,
} from './public-channel-records.ts'

export type IssuedPublicApiTokenRecord = {
  token: PublicApiTokenRecord
  plaintext: string
}

export type {
  ByokEntitlementChecker,
  ByokEntitlementVerdict,
  ByokKmsRefPolicy,
  ByokManagementPolicy,
  ByokRuntimeEntitlementChecker,
} from './services/byok-service.ts'

export { CloudServiceError } from './cloud-service-error.ts'

export type { CloudSessionMessage, CloudSessionProjectionView }

export type CloudSessionView = CloudSessionViewRecord<SessionRecord> & {
  projection: SessionProjectionRecord | null
}

type CreateCloudSessionRecordInput = {
  tenantId: string
  userId: string
  orgId?: string | null
  accountId?: string | null
  profileName: string
  sessionId?: string | null
  title?: string | null
  deferRuntime?: boolean
}

export type CloudWorkflowStartResult = {
  tenantId: string
  workflow: WorkflowDetail
  run: WorkflowRun
  sessionId: string
  command: SessionCommandRecord
}

type ChannelActorInput = {
  identityId?: string | null
  provider?: ChannelProviderId | null
  externalWorkspaceId?: string | null
  externalUserId?: string | null
}

type ChannelInteractionResolutionInput = ChannelActorInput & {
  token?: string | null
  externalInteractionId?: string | null
  response?: unknown
  answers?: unknown[]
  reject?: boolean
}

const SESSION_IMPORT_MAX_MESSAGES = 2_000
// Workflow-draft size/trigger limits + the draft validators now live in
// session-workflow-validation.ts; WORKFLOW_VALID_TRIGGER_TYPES is imported back
// for the runWorkflow trigger-type guard.
const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DISABLED_ABUSE_POLICY: CloudAbuseConfig = {
  enabled: false,
  maxConcurrentSessionsPerOrg: null,
  maxConcurrentWorkflowRunsPerOrg: null,
  maxActiveWorkersPerOrg: null,
  maxQueuedCommandsPerOrg: null,
  maxQueueAgeMs: null,
  maxPromptsPerHour: null,
  maxWorkflowRunsPerHour: null,
  maxGatewayPromptsPerHour: null,
  maxWorkerMinutesPerHour: null,
  maxGatewayDeliveriesPerHour: null,
  maxGatewayChannelBindingsPerOrg: null,
  maxArtifactBytesPerDay: null,
  httpRateLimit: {
    enabled: false,
    windowMs: 60 * 1000,
    maxRequests: 600,
  },
  authBackoff: {
    enabled: false,
    windowMs: 60 * 1000,
    maxFailures: 10,
    backoffMs: 60 * 1000,
  },
}


function promptParts(text: string): CloudRuntimePromptPart[] {
  return [{ type: 'text', text }]
}

function importAuditActor(principal: CloudPrincipal): { actorType: 'user' | 'api_token', actorId: string, accountId: string | null } {
  return {
    actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
    actorId: principal.tokenId || principal.userId,
    accountId: principal.accountId || principal.userId,
  }
}

export class CloudSessionService {
  private readonly store: ControlPlaneStore
  private readonly runtime: CloudRuntimeAdapter
  private readonly policy: CloudRuntimePolicy
  private readonly events: CloudSessionEventBus
  private readonly workspaceEvents: CloudWorkspaceEventBus
  private readonly projections: CloudSessionProjectionService
  private readonly ids: { randomUUID: () => string }
  private readonly byokService: CloudByokService
  private readonly abuse: CloudAbuseConfig
  private readonly billingConfig: CloudBillingConfig | null
  private readonly billingAdapter: BillingAdapter | null
  private readonly identityPolicy: CloudIdentityPolicy
  private readonly projectSources: CloudProjectSourceStore | null
  private readonly projectSourceService: CloudProjectSourceService
  private readonly overviewService: CloudOverviewService
  private readonly managedWorkerService: CloudManagedWorkerService
  private readonly usageGovernance: CloudUsageGovernanceService
  private readonly channelDomain: CloudChannelDomainService
  private readonly memberService: CloudMemberService
  private readonly coordinationService: CloudCoordinationService
  private readonly capabilityService: CloudCapabilityService
  private readonly settingMetadataService: CloudSettingMetadataService
  private readonly threadOrganization: CloudThreadOrganizationService
  private readonly billingOperations: CloudBillingOperationsService
  private readonly inviteSigningSecret: string | Buffer | null
  private readonly emailSender: CloudEmailSender | null
  // Per-(tenant,account) "already bootstrapped" markers. The org-active and
  // membership-active gates still run on EVERY request via
  // resolvePrincipalMembership (a read); this only lets a request SKIP the
  // idempotent bootstrap WRITES (createTenant / ensureOrgForTenant /
  // createAccount / ensureUser / upsertMembership) once a principal has been
  // bootstrapped within the short TTL. No principal/role is cached, so a revoked
  // token, deactivated org, or inactive membership is still rejected on the very
  // next request — there is no revocation window.
  private readonly bootstrappedPrincipals = new Map<string, number>()

  constructor(
    store: ControlPlaneStore,
    runtime: CloudRuntimeAdapter,
    policy: CloudRuntimePolicy,
    events = new CloudSessionEventBus(),
    ids: { randomUUID: () => string } = { randomUUID },
    workspaceEvents = new CloudWorkspaceEventBus(),
    byokSecrets: ByokSecretStore | null = null,
    byokPolicy: ByokManagementPolicy = {},
    abuse: CloudAbuseConfig = DISABLED_ABUSE_POLICY,
    billingConfig: CloudBillingConfig | null = null,
    billingAdapter: BillingAdapter | null = null,
    identityPolicy: CloudIdentityPolicy = { allowSelfServiceSignup: true },
    projectSources: CloudProjectSourceStore | null = null,
    inviteSigningSecret: string | Buffer | null = null,
    emailSender: CloudEmailSender | null = null,
  ) {
    this.store = store
    this.runtime = runtime
    this.policy = policy
    this.events = events
    this.workspaceEvents = workspaceEvents
    this.projections = new CloudSessionProjectionService(store, events, workspaceEvents)
    this.ids = ids
    this.byokService = new CloudByokService({
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      byokSecrets,
      byokPolicy,
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
    })
    this.abuse = abuse
    this.billingConfig = billingConfig
    this.billingAdapter = billingAdapter
    this.identityPolicy = identityPolicy
    this.projectSources = projectSources
    this.inviteSigningSecret = inviteSigningSecret
    this.emailSender = emailSender
    this.projectSourceService = new CloudProjectSourceService({
      store,
      policy,
      projectSources,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
    })
    this.overviewService = new CloudOverviewService({
      store,
      policy,
      identityPolicy,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      assertOrgAdmin: (principal) => this.assertOrgAdmin(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      byokPolicyOverview: () => this.byokService.getPolicyOverview(),
    })
    this.managedWorkerService = new CloudManagedWorkerService(store, (principal) => this.ensurePrincipal(principal))
    this.usageGovernance = new CloudUsageGovernanceService({ store, abuse, billingConfig })
    this.channelDomain = new CloudChannelDomainService({
      store,
      policy,
      ids,
      abuse,
      usageGovernance: this.usageGovernance,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
      normalizeAndValidateProjectSource: (source, tenantId) => this.normalizeAndValidateProjectSource(source as CloudProjectSourceInput | null | undefined, tenantId),
      createCloudSessionRecord: (input) => this.createCloudSessionRecord(input),
      bindSessionProjectSource: (tenantId, sessionId, projectSource) => this.bindSessionProjectSource(tenantId, sessionId, projectSource),
      getTenantSessionView: (tenantId, sessionId) => this.getTenantSessionView(tenantId, sessionId),
      assertRemoteInteractionAllowed: (principal, input) => this.assertRemoteInteractionAllowed(principal, input),
      auditActor: (principal) => this.auditActor(principal),
      stableCloudId,
    })
    this.memberService = new CloudMemberService({
      store,
      identityPolicy,
      inviteSigningSecret,
      emailSender,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      assertOrgAdmin: (principal) => this.assertOrgAdmin(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
    })
    this.coordinationService = new CloudCoordinationService({
      store,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      deliverCloudCoordinationWatchEvent: (event) => this.deliverCloudCoordinationWatchEvent(event),
    })
    this.capabilityService = new CloudCapabilityService({
      policy,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
    })
    this.settingMetadataService = new CloudSettingMetadataService({
      store,
      policy,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
    })
    this.threadOrganization = new CloudThreadOrganizationService({
      store,
      policy,
      ids,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
    })
    this.billingOperations = new CloudBillingOperationsService({
      store,
      policy,
      billingConfig,
      billingAdapter,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
    })
  }

  get eventBus() {
    return this.events
  }

  get workspaceEventBus() {
    return this.workspaceEvents
  }

  validateProjectSource(source: CloudProjectSourceInput | null | undefined): CloudProjectSourcePolicyVerdict {
    return this.projectSourceService.validateProjectSource(source)
  }

  async uploadProjectSnapshot(
    principal: CloudPrincipal,
    input: CloudProjectSnapshotUploadInput,
  ): Promise<CloudProjectSnapshotUploadResult> {
    return this.projectSourceService.uploadProjectSnapshot(principal, input)
  }

  async getSessionProjectSource(tenantId: string, sessionId: string): Promise<CloudProjectSource | null> {
    return this.projectSourceService.getSessionProjectSource(tenantId, sessionId)
  }

  private normalizeAndValidateProjectSource(
    source: CloudProjectSourceInput | null | undefined,
    tenantId: string,
  ) {
    return this.projectSourceService.normalizeAndValidateProjectSource(source, tenantId)
  }

  private async bindSessionProjectSource(
    tenantId: string,
    sessionId: string,
    projectSource: CloudProjectSource,
  ) {
    await this.appendProjectedEvent({
      tenantId,
      sessionId,
      type: 'session.project_source.bound',
      payload: { projectSource },
    })
  }

  async ensurePrincipal(principal: CloudPrincipal) {
    const signupMode = resolvedSignupMode(this.identityPolicy)
    const allowedDomains = (this.identityPolicy.allowedEmailDomains || [])
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
    if (principal.authSource !== 'local' && signupMode === 'domain' && allowedDomains.length > 0) {
      const emailDomain = principalEmailDomain(principal.email)
      if (!emailDomain || !allowedDomains.includes(emailDomain)) {
        throw new CloudServiceError(403, 'Cloud signup is restricted to approved email domains.')
      }
    }
    const existingMembership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    const requiresExistingMembership = principal.authSource !== 'local' && principal.authSource !== 'api_token'
      && (!this.identityPolicy.allowSelfServiceSignup || signupMode === 'disabled' || signupMode === 'closed' || signupMode === 'invite')
    if (requiresExistingMembership) {
      const acceptableStatuses: ControlPlaneMembershipStatus[] = signupMode === 'invite'
        ? ['active', 'invited']
        : ['active']
      if (
        !existingMembership
        || !acceptableStatuses.includes(existingMembership.membership.status)
      ) {
        throw new CloudServiceError(403, 'Cloud membership is not active.')
      }
    }
    // Fast path: once a (tenant, account) has been bootstrapped within the TTL,
    // skip the idempotent bootstrap WRITES below. Every security gate is still
    // enforced on THIS request from the fresh `existingMembership` read above —
    // org must be active, membership must be active — so a deactivated org or
    // revoked/expired membership is rejected on the very next request. Nothing
    // is mutated server-side; only the redundant upserts are avoided.
    const bootstrapKey = `${principal.tenantId}\u0000${principal.accountId || principal.userId}`
    const bootstrappedUntil = this.bootstrappedPrincipals.get(bootstrapKey)
    if (
      bootstrappedUntil !== undefined
      && bootstrappedUntil > Date.now()
      && existingMembership
      && existingMembership.membership.status === 'active'
      && (principal.authSource === 'local' || existingMembership.org.status === 'active')
    ) {
      principal.tenantId = existingMembership.org.tenantId
      principal.orgId = existingMembership.org.orgId
      principal.tenantName = existingMembership.org.name
      principal.accountId = existingMembership.account.accountId
      principal.email = existingMembership.account.email
      principal.role = existingMembership.membership.role
      return
    }
    await this.store.createTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
      orgId: principal.orgId,
    })
    const org = await this.store.ensureOrgForTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
      orgId: principal.orgId,
    })
    if (principal.authSource !== 'local' && org.status !== 'active') {
      throw new CloudServiceError(403, 'Cloud org is not active.')
    }
    const account = await this.store.createAccount({
      accountId: existingMembership?.account.accountId || principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    const role = existingMembership?.membership.role || principal.role || 'member'
    const user = await this.store.ensureUser({
      tenantId: principal.tenantId,
      userId: principal.userId,
      email: principal.email,
      role,
    })
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: account.accountId,
      email: account.email,
    })
    let effectiveRole: ControlPlaneRole
    if (!membership) {
      if (requiresExistingMembership) {
        throw new CloudServiceError(403, 'Cloud membership is not active.')
      }
      const createdMembership = await this.store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: principal.role || user.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'principal.bootstrap' },
      })
      effectiveRole = createdMembership.role
    } else if (membership.membership.status === 'invited' && principal.authSource === 'user' && signupMode === 'invite') {
      const activatedMembership = await this.store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: membership.membership.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'membership.invite.accepted' },
      })
      effectiveRole = activatedMembership.role
    } else if (membership.membership.status !== 'active') {
      throw new CloudServiceError(403, 'Cloud membership is not active.')
    } else {
      effectiveRole = membership.membership.role
    }
    principal.tenantId = org.tenantId
    principal.orgId = org.orgId
    principal.tenantName = org.name
    principal.accountId = account.accountId
    principal.email = account.email
    principal.role = effectiveRole
    // Mark bootstrapped so subsequent requests within the TTL take the fast path
    // above and skip these idempotent writes (the gates still re-run each time).
    this.bootstrappedPrincipals.set(bootstrapKey, Date.now() + 60_000)
  }

  async getWorkspaceOverview(principal: CloudPrincipal): Promise<CloudWorkspaceOverview> {
    return this.overviewService.getWorkspaceOverview(principal)
  }

  async getAdminPolicyOverview(principal: CloudPrincipal): Promise<CloudAdminPolicyOverview> {
    return this.overviewService.getAdminPolicyOverview(principal)
  }

  listOrgMembers(
    principal: CloudPrincipal,
    input: { query?: string | null, limit?: number | null } = {},
  ): Promise<PublicOrgMemberRecord[]> {
    return this.memberService.listOrgMembers(principal, input)
  }

  inviteOrgMember(
    principal: CloudPrincipal,
    input: { email: string, role?: ControlPlaneRole | null },
  ): Promise<MembershipInviteResult> {
    return this.memberService.inviteOrgMember(principal, input)
  }

  acceptMembershipInvite(token: string): Promise<{
    orgId: string
    accountId: string
    email: string
    role: ControlPlaneRole
    status: ControlPlaneMembershipStatus
  }> {
    return this.memberService.acceptMembershipInvite(token)
  }

  updateOrgMember(
    principal: CloudPrincipal,
    accountId: string,
    input: {
      role?: ControlPlaneRole | null
      status?: ControlPlaneMembershipStatus | null
      confirm?: string | null
    },
  ): Promise<PublicOrgMemberRecord> {
    return this.memberService.updateOrgMember(principal, accountId, input)
  }

  async listAuditEvents(
    principal: CloudPrincipal,
    input: { limit?: number | null } = {},
  ) {
    return this.overviewService.listAuditEvents(principal, input)
  }

  createManagedWorkerPool(principal: CloudPrincipal, input: CreateManagedWorkerPoolRequest) {
    return this.managedWorkerService.createPool(principal, input)
  }

  updateManagedWorkerPool(principal: CloudPrincipal, poolId: string, input: UpdateManagedWorkerPoolRequest) {
    return this.managedWorkerService.updatePool(principal, poolId, input)
  }

  listManagedWorkerPools(principal: CloudPrincipal, input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {}) {
    return this.managedWorkerService.listPools(principal, input)
  }

  registerManagedWorker(principal: CloudPrincipal, input: RegisterManagedWorkerRequest) {
    return this.managedWorkerService.registerWorker(principal, input)
  }

  listManagedWorkers(principal: CloudPrincipal, input: ListManagedWorkersRequest = {}) {
    return this.managedWorkerService.listWorkers(principal, input)
  }

  getManagedWorker(principal: CloudPrincipal, workerId: string) {
    return this.managedWorkerService.getWorker(principal, workerId)
  }

  updateManagedWorkerLifecycle(principal: CloudPrincipal, workerId: string, status: ManagedWorkerStatus, input: { reason?: string | null } = {}) {
    return this.managedWorkerService.updateWorkerLifecycle(principal, workerId, status, input)
  }

  issueManagedWorkerCredential(principal: CloudPrincipal, workerId: string, input: { scopes?: string[] | null, expiresAt?: Date | null } = {}) {
    return this.managedWorkerService.issueCredential(principal, workerId, input)
  }

  listManagedWorkerCredentials(principal: CloudPrincipal, workerId: string) {
    return this.managedWorkerService.listCredentials(principal, workerId)
  }

  rotateManagedWorkerCredential(principal: CloudPrincipal, workerId: string, credentialId: string, input: { expiresAt?: Date | null } = {}) {
    return this.managedWorkerService.rotateCredential(principal, workerId, credentialId, input)
  }

  revokeManagedWorkerCredential(principal: CloudPrincipal, workerId: string, credentialId: string) {
    return this.managedWorkerService.revokeCredential(principal, workerId, credentialId)
  }

  recordManagedWorkerHeartbeat(principal: CloudPrincipal, workerId: string, input: ManagedWorkerHeartbeatRequest = {}) {
    return this.managedWorkerService.recordHeartbeat(principal, workerId, input)
  }

  listManagedWorkerHeartbeats(principal: CloudPrincipal, input: { workerId?: string | null, limit?: number | null } = {}) {
    return this.managedWorkerService.listHeartbeats(principal, input)
  }

  async createSession(principal: CloudPrincipal, input: {
    profileName?: string | null
    projectSource?: CloudProjectSourceInput | null
  } = {}): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    if (!this.policy.features.chat) throw new Error('Chat is disabled for this cloud profile.')
    const profileName = input.profileName || this.policy.profileName
    const projectSource = this.normalizeAndValidateProjectSource(input.projectSource, principal.tenantId)
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'session.create',
      profileName,
    })
    const session = await this.createCloudSessionRecord({
      tenantId: principal.tenantId,
      userId: principal.userId,
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      profileName,
      deferRuntime: Boolean(projectSource),
    })
    if (projectSource) await this.bindSessionProjectSource(principal.tenantId, session.sessionId, projectSource)
    return this.getSessionView(principal, session.sessionId)
  }

  async createImportedSession(principal: CloudPrincipal, input: SessionImportRequest): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    if (!this.policy.features.chat) throw new Error('Chat is disabled for this cloud profile.')
    try {
      assertSafeSessionImportPayload(input)
    } catch (error) {
      throw new CloudServiceError(400, error instanceof Error ? error.message : 'Session import payload is unsafe.')
    }
    const source = input.source
    if (!source || source.kind !== 'local-session' || !source.fingerprint) {
      throw new CloudServiceError(400, 'Session import requires a redacted local source fingerprint.')
    }
    const profileName = input.profileName || this.policy.profileName
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'session.create',
      profileName,
    })
    const itemCounts = normalizeImportCounts(input.itemCounts)
    const actor = importAuditActor(principal)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.requested',
      targetType: 'session',
      targetId: null,
      metadata: {
        sourceKind: source.kind,
        sourceFingerprint: source.fingerprint,
        title: boundedImportText(input.title, 'Import title', 512),
        itemCounts,
      },
    })

    try {
      const title = boundedImportText(input.title, 'Import title', 512) || source.title || 'Imported session'
      const session = await this.createCloudSessionRecord({
        tenantId: principal.tenantId,
        userId: principal.userId,
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        profileName,
        sessionId: this.ids.randomUUID(),
        title,
      })
      const importedAt = new Date()
      await this.appendProjectedEvent({
        tenantId: principal.tenantId,
        sessionId: session.sessionId,
        type: 'session.imported',
        payload: {
          sourceFingerprint: source.fingerprint,
          importedAt: importedAt.toISOString(),
          itemCounts,
        },
        createdAt: importedAt,
      })

      const messages = Array.isArray(input.messages) ? input.messages.slice(0, SESSION_IMPORT_MAX_MESSAGES) : []
      for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const content = boundedImportText(message.content, 'Imported message')
        const createdAt = message.timestamp ? new Date(message.timestamp) : importedAt
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: message.role === 'user' ? 'prompt.submitted' : 'assistant.message',
          payload: message.role === 'user'
            ? {
                messageId: message.id,
                text: content,
                imported: true,
                attachments: Array.isArray(message.attachments) ? message.attachments : [],
              }
            : {
                messageId: message.id,
                content,
                imported: true,
                attachments: Array.isArray(message.attachments) ? message.attachments : [],
              },
          createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : importedAt,
        })
      }

      const todos = Array.isArray(input.todos) ? input.todos.slice(0, 500) : []
      if (todos.length) {
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: 'todos.updated',
          payload: { todos },
          createdAt: importedAt,
        })
      }

      if (input.sessionCost || input.sessionTokens) {
        await this.appendProjectedEvent({
          tenantId: principal.tenantId,
          sessionId: session.sessionId,
          type: 'cost.updated',
          payload: {
            cost: typeof input.sessionCost === 'number' && Number.isFinite(input.sessionCost) ? input.sessionCost : 0,
            tokens: input.sessionTokens || {},
            imported: true,
          },
          createdAt: importedAt,
        })
      }

      await this.appendProjectedEvent({
        tenantId: principal.tenantId,
        sessionId: session.sessionId,
        type: 'session.idle',
        payload: { imported: true },
        createdAt: importedAt,
      })

      return this.getSessionView(principal, session.sessionId)
    } catch (error) {
      await this.recordImportFailed(principal, {
        sourceFingerprint: source.fingerprint,
        itemCounts,
        error,
      })
      throw error
    }
  }

  async completeSessionImport(
    principal: CloudPrincipal,
    sessionId: string,
    input: { sourceFingerprint: string, itemCounts: SessionImportItemCounts },
  ) {
    await this.getSessionView(principal, sessionId)
    const actor = importAuditActor(principal)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.completed',
      targetType: 'session',
      targetId: sessionId,
      metadata: {
        sourceKind: 'local-session',
        sourceFingerprint: input.sourceFingerprint,
        destinationSessionId: sessionId,
        itemCounts: normalizeImportCounts(input.itemCounts),
      },
    })
  }

  async recordImportFailed(
    principal: CloudPrincipal,
    input: { sourceFingerprint: string, itemCounts?: Partial<SessionImportItemCounts>, sessionId?: string | null, error: unknown },
  ) {
    const actor = importAuditActor(principal)
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: 'session_import.failed',
      targetType: input.sessionId ? 'session' : null,
      targetId: input.sessionId || null,
      metadata: {
        sourceKind: 'local-session',
        sourceFingerprint: input.sourceFingerprint,
        destinationSessionId: input.sessionId || null,
        itemCounts: normalizeImportCounts(input.itemCounts),
        error: boundedImportText(message, 'Import error', 512),
      },
    })
  }

  async listSessions(principal: CloudPrincipal): Promise<SessionRecord[]> {
    await this.ensurePrincipal(principal)
    return this.store.listSessions(principal.tenantId, principal.userId)
  }

  async listSessionsPage(
    principal: CloudPrincipal,
    input: Omit<ListSessionsPageInput, 'tenantId' | 'userId'> = {},
  ): Promise<ListSessionsPageRecord> {
    await this.ensurePrincipal(principal)
    try {
      return await this.store.listSessionsPage({
        ...input,
        tenantId: principal.tenantId,
        userId: principal.userId,
      })
    } catch (error) {
      if (error instanceof InvalidSessionPageCursorError) {
        throw new CloudServiceError(400, 'Session list cursor is invalid.', {
          policyCode: 'sessions.cursor.invalid',
        })
      }
      throw error
    }
  }

  async getSessionView(principal: CloudPrincipal, sessionId: string): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
    if (!session) throw new CloudServiceError(404, 'Cloud session was not found.')
    const projection = await this.store.getSessionProjection(principal.tenantId, sessionId)
    return {
      session: this.withProjectionProjectSource(session, projection),
      projection,
    }
  }

  private withProjectionProjectSource(session: SessionRecord, projection: SessionProjectionRecord | null): SessionRecord {
    const source = normalizeCloudProjectSource(projection?.view?.projectSource)
    return {
      ...session,
      projectSource: summarizeCloudProjectSource(source),
    }
  }

  async listEvents(principal: CloudPrincipal, sessionId: string, afterSequence = 0, limit?: number): Promise<SessionEventRecord[]> {
    await this.getSessionView(principal, sessionId)
    return this.store.listSessionEvents(principal.tenantId, sessionId, afterSequence, limit)
  }

  // Read paths for the SSE replay poll, which runs every pollMs for the life of a
  // connection. The connection authorized the principal+session ONCE at connect; re-running
  // the full membership/session/projection authorization on every poll was the dominant
  // idle-connection cost (~6 queries/poll). These read directly, tenant-scoped by the query.
  listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    return this.store.listSessionEventsForStream(tenantId, sessionId, afterSequence, limit)
  }

  listWorkspaceEventsForStream(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    return this.store.listWorkspaceEventsForStream(tenantId, userId, afterSequence, limit)
  }

  async getSessionProjectionStatus(principal: CloudPrincipal, sessionId: string) {
    await this.getSessionView(principal, sessionId)
    if (!principalCanViewOperations(principal)) {
      throw new CloudServiceError(403, 'Projection status requires operator privileges.')
    }
    const [stats, projection] = await Promise.all([
      this.store.getSessionEventStats(principal.tenantId, sessionId),
      this.store.getSessionProjection(principal.tenantId, sessionId),
    ])
    const latestEventSequence = stats.latestSequence
    const projectionSequence = projection?.sequence || 0
    return {
      sessionId,
      eventCount: stats.count,
      latestEventSequence,
      projectionSequence,
      lag: Math.max(0, latestEventSequence - projectionSequence),
      projectionUpdatedAt: projection?.updatedAt || null,
    }
  }

  async repairSessionProjection(principal: CloudPrincipal, sessionId: string) {
    await this.getSessionView(principal, sessionId)
    if (!principalCanViewOperations(principal)) {
      throw new CloudServiceError(403, 'Projection repair requires operator privileges.')
    }
    return this.projections.repairSessionProjection({
      tenantId: principal.tenantId,
      sessionId,
    })
  }

  async listWorkspaceEvents(principal: CloudPrincipal, afterSequence = 0, limit?: number) {
    await this.ensurePrincipal(principal)
    return this.store.listWorkspaceEvents(principal.tenantId, principal.userId, afterSequence, limit)
  }

  async getWorkspaceEventCursor(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    return this.store.getWorkspaceEventCursor(principal.tenantId, principal.userId)
  }

  async listWorkerHeartbeats(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    if (!principalCanViewOperations(principal)) {
      throw new CloudServiceError(403, 'Cloud worker status requires operator privileges.')
    }
    return this.store.listWorkerHeartbeats()
  }

  async listByokSecrets(principal: CloudPrincipal): Promise<ByokSecretMetadata[]> {
    return this.byokService.listSecrets(principal)
  }

  async getByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    return this.byokService.getSecret(principal, providerId)
  }

  async setByokSecret(
    principal: CloudPrincipal,
    input: { providerId: string, plaintext?: string | null, kmsRef?: string | null },
  ): Promise<ByokSecretMetadata> {
    return this.byokService.setSecret(principal, input)
  }

  async disableByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    return this.byokService.disableSecret(principal, providerId)
  }

  async validateByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    return this.byokService.validateSecret(principal, providerId)
  }

  async overrideByokSecretValidation(
    principal: CloudPrincipal,
    providerId: string,
    reason: string,
  ): Promise<ByokSecretMetadata | null> {
    return this.byokService.overrideValidation(principal, providerId, reason)
  }

  async listHeadlessAgents(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<HeadlessAgentRecord[]> {
    return this.channelDomain.listHeadlessAgents(principal, input)
  }

  async createHeadlessAgent(
    principal: CloudPrincipal,
    input: {
      name: string
      profileName?: string | null
      status?: HeadlessAgentRecord['status']
      managed?: boolean
      agentId?: string | null
    },
  ): Promise<HeadlessAgentRecord> {
    return this.channelDomain.createHeadlessAgent(principal, input)
  }

  async updateHeadlessAgent(
    principal: CloudPrincipal,
    agentId: string,
    input: {
      name?: string
      profileName?: string
      status?: HeadlessAgentRecord['status']
      managed?: boolean
    },
  ): Promise<HeadlessAgentRecord | null> {
    return this.channelDomain.updateHeadlessAgent(principal, agentId, input)
  }

  async listChannelBindings(
    principal: CloudPrincipal,
    agentId?: string | null,
    input: { limit?: number | null } = {},
  ): Promise<PublicChannelBindingRecord[]> {
    return this.channelDomain.listChannelBindings(principal, agentId, input)
  }

  async createChannelBinding(
    principal: CloudPrincipal,
    input: {
      agentId: string
      provider: ChannelProviderId
      displayName: string
      externalWorkspaceId?: string | null
      status?: ChannelBindingRecord['status']
      credentialRef?: string | null
      settings?: Record<string, unknown>
      bindingId?: string | null
    },
  ): Promise<PublicChannelBindingRecord> {
    return this.channelDomain.createChannelBinding(principal, input)
  }

  async updateChannelBinding(
    principal: CloudPrincipal,
    bindingId: string,
    input: {
      displayName?: string
      status?: ChannelBindingRecord['status']
      credentialRef?: string | null
      settings?: Record<string, unknown>
    },
  ): Promise<PublicChannelBindingRecord | null> {
    return this.channelDomain.updateChannelBinding(principal, bindingId, input)
  }

  async resolveChannelIdentity(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      channelBindingId?: string | null
      externalWorkspaceId?: string | null
      externalUserId: string
      identityId?: string | null
      accountId?: string | null
      role?: ChannelIdentityRecord['role']
      status?: ChannelIdentityRecord['status']
      metadata?: Record<string, unknown>
    },
  ): Promise<ChannelIdentityRecord> {
    return this.channelDomain.resolveChannelIdentity(principal, input)
  }

  async listChannelIdentities(
    principal: CloudPrincipal,
    input: {
      provider?: ChannelProviderId | null
      externalWorkspaceId?: string | null
      role?: ChannelIdentityRecord['role'] | null
      status?: ChannelIdentityRecord['status'] | null
      limit?: number | null
    } = {},
  ): Promise<PublicChannelIdentityRecord[]> {
    return this.channelDomain.listChannelIdentities(principal, input)
  }

  async bindChannelSession(
    principal: CloudPrincipal,
    input: ChannelActorInput & {
      channelBindingId: string
      provider: ChannelProviderId
      externalChatId: string
      externalThreadId: string
      sessionId?: string | null
      title?: string | null
      lastEventSequence?: number
      lastWorkspaceSequence?: number
      lastChatMessageId?: string | null
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }> {
    return this.channelDomain.bindChannelSession(principal, input)
  }

  async getChannelSessionByThread(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      externalWorkspaceId?: string | null
      externalChatId: string
      externalThreadId: string
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null> {
    return this.channelDomain.getChannelSessionByThread(principal, input)
  }

  async updateChannelCursor(
    principal: CloudPrincipal,
    input: {
      bindingId: string
      lastEventSequence: number
      lastWorkspaceSequence: number
      lastChatMessageId?: string | null
    },
  ): Promise<ChannelCursorUpdateResult> {
    return this.channelDomain.updateChannelCursor(principal, input)
  }

  async enqueueChannelPrompt(
    principal: CloudPrincipal,
    input: ChannelActorInput & {
      bindingId: string
      text: string
      agent?: string | null
      commandId?: string | null
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
    return this.channelDomain.enqueueChannelPrompt(principal, input)
  }

  async createChannelInteraction(
    principal: CloudPrincipal,
    input: {
      agentId: string
      sessionId: string
      provider: ChannelProviderId
      kind: ChannelInteractionRecord['kind']
      targetId: string
      externalInteractionId?: string | null
      createdByIdentityId?: string | null
      expiresAt?: Date | null
      interactionId?: string | null
      tokenSecret?: string | null
    },
  ): Promise<IssuedChannelInteractionRecord> {
    return this.channelDomain.createChannelInteraction(principal, input)
  }

  async resolveChannelInteraction(
    principal: CloudPrincipal,
    input: ChannelInteractionResolutionInput,
  ): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
    return this.channelDomain.resolveChannelInteraction(principal, input)
  }

  async createChannelDelivery(
    principal: CloudPrincipal,
    input: {
      agentId: string
      channelBindingId: string
      sessionBindingId?: string | null
      provider: ChannelProviderId
      target: Record<string, unknown>
      eventType: string
      payload: Record<string, unknown>
      status?: ChannelDeliveryRecord['status']
      nextAttemptAt?: Date | null
      deliveryId?: string | null
    },
  ): Promise<PublicChannelDeliveryRecord> {
    return this.channelDomain.createChannelDelivery(principal, input)
  }

  async validateChannelDeliveryTarget(
    principal: CloudPrincipal,
    input: {
      agentId: string
      channelBindingId: string
      sessionBindingId?: string | null
      provider: ChannelProviderId
    },
  ): Promise<void> {
    return this.channelDomain.validateChannelDeliveryTarget(principal, input)
  }

  async createCloudCoordinationWatch(
    principal: CloudPrincipal,
    input: CoordinationWatchInput & { workspaceId: string },
  ): Promise<CoordinationWatch> {
    return this.coordinationService.createCloudCoordinationWatch(principal, input)
  }

  async updateCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
    patch: CoordinationWatchUpdateInput,
  ): Promise<CoordinationWatch | null> {
    return this.coordinationService.updateCloudCoordinationWatch(principal, workspaceId, watchId, patch)
  }

  async getCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
  ): Promise<CoordinationWatch | null> {
    return this.coordinationService.getCloudCoordinationWatch(principal, workspaceId, watchId)
  }

  async listCloudCoordinationWatches(
    principal: CloudPrincipal,
    input: {
      workspaceId: string
      target?: CoordinationTarget | null
      status?: CoordinationWatchStatus | null
      limit?: number | null
    },
  ): Promise<CoordinationWatch[]> {
    return this.coordinationService.listCloudCoordinationWatches(principal, input)
  }

  async deleteCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
  ): Promise<boolean> {
    return this.coordinationService.deleteCloudCoordinationWatch(principal, workspaceId, watchId)
  }

  async emitCloudCoordinationWatchEvent(
    principal: CloudPrincipal,
    event: CoordinationWatchEvent,
  ): Promise<void> {
    return this.coordinationService.emitCloudCoordinationWatchEvent(principal, event)
  }

  async resolveOrgIdForTenant(tenantId: string): Promise<string> {
    const normalizedTenantId = tenantId.trim() || 'default'
    const org = await this.store.ensureOrgForTenant({
      tenantId: normalizedTenantId,
      name: normalizedTenantId,
    })
    return org.orgId
  }

  async listChannelDeliveries(
    principal: CloudPrincipal,
    input: {
      deliveryId?: string | null
      status?: ChannelDeliveryRecord['status'] | null
      channelBindingId?: string | null
      limit?: number | null
    } = {},
  ): Promise<PublicChannelDeliveryRecord[]> {
    return this.channelDomain.listChannelDeliveries(principal, input)
  }

  async retryChannelDelivery(
    principal: CloudPrincipal,
    deliveryId: string,
  ): Promise<PublicChannelDeliveryRecord | null> {
    return this.channelDomain.retryChannelDelivery(principal, deliveryId)
  }

  async deadLetterChannelDelivery(
    principal: CloudPrincipal,
    input: { deliveryId: string, lastError?: string | null },
  ): Promise<PublicChannelDeliveryRecord | null> {
    return this.channelDomain.deadLetterChannelDelivery(principal, input)
  }

  async claimNextChannelDelivery(
    principal: CloudPrincipal,
    input: { claimedBy: string, ttlMs?: number, now?: Date, channelBindingIds?: readonly string[] | null },
  ): Promise<ChannelDeliveryRecord | null> {
    return this.channelDomain.claimNextChannelDelivery(principal, input)
  }

  async ackChannelDelivery(
    principal: CloudPrincipal,
    input: {
      deliveryId: string
      claimedBy?: string | null
      status: Extract<ChannelDeliveryRecord['status'], 'sent' | 'failed' | 'dead'>
      lastError?: string | null
      nextAttemptAt?: Date | null
    },
  ): Promise<PublicChannelDeliveryRecord | null> {
    return this.channelDomain.ackChannelDelivery(principal, input)
  }

  async claimChannelProviderEvent(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      providerInstanceId: string
      channelBindingId?: string | null
      externalWorkspaceId?: string | null
      providerEventId: string
      eventType: ChannelProviderEventType
      claimedBy: string
      ttlMs?: number | null
      metadata?: Record<string, unknown>
    },
  ): Promise<ChannelProviderEventClaimResult> {
    return this.channelDomain.claimChannelProviderEvent(principal, input)
  }

  async completeChannelProviderEvent(
    principal: CloudPrincipal,
    input: {
      eventId: string
      channelBindingId?: string | null
      claimedBy: string
      status: Extract<ChannelProviderEventRecord['status'], 'processed' | 'failed'>
      retryable?: boolean
      lastError?: string | null
    },
  ): Promise<ChannelProviderEventRecord | null> {
    return this.channelDomain.completeChannelProviderEvent(principal, input)
  }

  async listSettingMetadata(principal: CloudPrincipal) {
    return this.settingMetadataService.listSettingMetadata(principal)
  }

  async getSettingMetadata(principal: CloudPrincipal, key: string) {
    return this.settingMetadataService.getSettingMetadata(principal, key)
  }

  async setSettingMetadata(
    principal: CloudPrincipal,
    input: { key: string, value: Record<string, unknown> },
  ) {
    return this.settingMetadataService.setSettingMetadata(principal, input)
  }

  async listCapabilityCatalog(principal: CloudPrincipal) {
    return this.capabilityService.listCapabilityCatalog(principal)
  }

  async listCapabilityTools(principal: CloudPrincipal): Promise<CapabilityTool[]> {
    return this.capabilityService.listCapabilityTools(principal)
  }

  async getCapabilityTool(principal: CloudPrincipal, toolId: string): Promise<CapabilityTool | null> {
    return this.capabilityService.getCapabilityTool(principal, toolId)
  }

  async listCapabilitySkills(principal: CloudPrincipal): Promise<CapabilitySkill[]> {
    return this.capabilityService.listCapabilitySkills(principal)
  }

  async getCapabilitySkill(principal: CloudPrincipal, skillName: string): Promise<CapabilitySkill | null> {
    return this.capabilityService.getCapabilitySkill(principal, skillName)
  }

  async getCapabilitySkillBundle(principal: CloudPrincipal, skillName: string) {
    return this.capabilityService.getCapabilitySkillBundle(principal, skillName)
  }

  async listThreadTags(principal: CloudPrincipal): Promise<ThreadTagRecord[]> {
    return this.threadOrganization.listThreadTags(principal)
  }

  async createThreadTag(
    principal: CloudPrincipal,
    input: { name: string, color?: string | null },
  ): Promise<ThreadTagRecord> {
    return this.threadOrganization.createThreadTag(principal, input)
  }

  async updateThreadTag(
    principal: CloudPrincipal,
    tagId: string,
    input: { name?: string, color?: string | null },
  ): Promise<ThreadTagRecord | null> {
    return this.threadOrganization.updateThreadTag(principal, tagId, input)
  }

  async deleteThreadTag(principal: CloudPrincipal, tagId: string): Promise<boolean> {
    return this.threadOrganization.deleteThreadTag(principal, tagId)
  }

  async applyThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    return this.threadOrganization.applyThreadTag(principal, tagId, sessionIds)
  }

  async removeThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    return this.threadOrganization.removeThreadTag(principal, tagId, sessionIds)
  }

  async listThreadMetadata(principal: CloudPrincipal, input: { tagIds?: string[], limit?: number } = {}) {
    return this.threadOrganization.listThreadMetadata(principal, input)
  }

  async listThreadSmartFilters(principal: CloudPrincipal): Promise<ThreadSmartFilterRecord[]> {
    return this.threadOrganization.listThreadSmartFilters(principal)
  }

  async createThreadSmartFilter(
    principal: CloudPrincipal,
    input: { name: string, query: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord> {
    return this.threadOrganization.createThreadSmartFilter(principal, input)
  }

  async updateThreadSmartFilter(
    principal: CloudPrincipal,
    filterId: string,
    input: { name?: string, query?: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord | null> {
    return this.threadOrganization.updateThreadSmartFilter(principal, filterId, input)
  }

  async deleteThreadSmartFilter(principal: CloudPrincipal, filterId: string): Promise<boolean> {
    return this.threadOrganization.deleteThreadSmartFilter(principal, filterId)
  }

  async listWorkflows(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<WorkflowListPayload> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflows = (await this.store.listWorkflows(principal.tenantId, principal.userId))
      .slice(0, normalizedCloudListLimit(input.limit))
    const runs = (await Promise.all(workflows.map((workflow) => (
      this.store.listWorkflowRuns(principal.tenantId, workflow.id, 25)
    )))).flat()
    return {
      workflows: workflows.map(toWorkflowSummary),
      runs: runs
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 100)
        .map(toWorkflowRun),
    }
  }

  async getWorkflow(principal: CloudPrincipal, workflowId: string): Promise<WorkflowDetail | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflow = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    return workflow ? this.workflowDetail(workflow) : null
  }

  async createWorkflow(principal: CloudPrincipal, draft: WorkflowDraft): Promise<WorkflowDetail> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const now = new Date()
    let normalized: WorkflowDraft
    try {
      normalized = normalizeWorkflowDraft(draft, this.ids, now)
    } catch (error) {
      throw new CloudServiceError(400, error instanceof Error ? error.message : 'Workflow draft is invalid.')
    }
    assertWorkflowDraftAllowed(normalized, this.policy)
    const workflow = await this.store.createWorkflow({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId: this.ids.randomUUID(),
      draft: normalized,
      nextRunAt: computeNextWorkflowRunAt(normalized.triggers, now),
      createdAt: now,
    })
    return this.workflowDetail(workflow)
  }

  async updateWorkflowStatus(
    principal: CloudPrincipal,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<WorkflowDetail | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    if (status !== 'active' && status !== 'paused' && status !== 'archived') {
      throw new Error('Cloud workflow status updates must be active, paused, or archived.')
    }
    const current = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!current) return null
    const now = new Date()
    const updated = await this.store.updateWorkflowStatus({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      status,
      nextRunAt: status === 'active' ? computeNextWorkflowRunAt(current.triggers, now) : null,
      updatedAt: now,
    })
    return updated ? this.workflowDetail(updated) : null
  }

  private async assertWorkflowExecutionStartAllowed(tenantId: string, orgId: string) {
    await this.assertBillingAllowed({
      orgId,
      action: 'worker.execute',
      profileName: this.policy.profileName,
    })
    try {
      await this.store.assertSessionCommandQueueQuota({
        tenantId,
        quota: await this.usageGovernance.commandQueueQuotaForOrg(orgId),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
  }

  async runWorkflow(
    principal: CloudPrincipal,
    workflowId: string,
    input: {
      triggerType?: WorkflowTriggerType
      triggerPayload?: Record<string, unknown> | null
    } = {},
  ): Promise<CloudWorkflowStartResult> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflow = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}.`)
    const triggerType = input.triggerType || 'manual'
    if (!WORKFLOW_VALID_TRIGGER_TYPES.has(triggerType)) throw new Error('Workflow trigger type is invalid.')
    const orgId = this.principalOrgId(principal)
    await this.assertWorkflowExecutionStartAllowed(principal.tenantId, orgId)
    let run: CloudWorkflowRunRecord
    try {
      run = await this.store.createWorkflowRun({
        tenantId: principal.tenantId,
        userId: principal.userId,
        workflowId,
        runId: this.ids.randomUUID(),
        triggerType,
        triggerPayload: input.triggerPayload || null,
        claimedBy: `workflow-api:${principal.userId}`,
        quota: await this.usageGovernance.workflowRunQuotaForOrg(orgId),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud workflow run quota exceeded.', 'quota.workflow_runs_per_hour_exceeded')
    }
    return this.startWorkflowRun(workflow, run)
  }

  async claimAndStartDueWorkflow(now = new Date(), claimedBy?: string | null): Promise<CloudWorkflowStartResult | null> {
    this.assertWorkflowsEnabled()
    let claimed: ClaimedWorkflowRunRecord | null
    try {
      claimed = await this.store.claimDueWorkflowRun({
        runId: this.ids.randomUUID(),
        claimedBy,
        now,
        quota: this.usageGovernance.workflowRunDefaultQuota(),
      })
    } catch (error) {
      if (error instanceof ControlPlaneQuotaExceededError) return null
      throw error
    }
    if (!claimed) return null
    return this.startClaimedWorkflowRun(claimed)
  }

  async runWorkflowWebhook(input: {
    workflowId: string
    auth: WorkflowWebhookAuth
    payload: Record<string, unknown>
    securityStore: WorkflowWebhookSecurityStore
    now?: Date
  }): Promise<CloudWorkflowStartResult> {
    this.assertWorkflowsEnabled()
    if (!this.policy.features.webhooks) {
      throw new WebhookHttpError(404, 'Workflow webhook was not found.')
    }
    if (input.auth.kind !== 'signature') {
      throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
    }
    const workflow = await this.store.findWorkflow(input.workflowId)
    const webhook = workflow?.triggers.find((trigger) => (
      trigger.enabled
      && trigger.type === 'webhook'
      && typeof trigger.webhookSecret === 'string'
      && verifyWorkflowWebhookAuth(input.auth, trigger.webhookSecret, input.now || new Date())
    ))
    if (!workflow || !webhook) {
      throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    }
    const replayClaim = await input.securityStore.claimSignature({
      key: workflowWebhookReplayKey(workflow.id, input.auth),
      nowMs: (input.now || new Date()).getTime(),
      windowMs: WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS,
      cacheLimit: WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT,
    })
    if (!replayClaim) throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    try {
      const org = await this.store.ensureOrgForTenant({ tenantId: workflow.tenantId, name: workflow.tenantId })
      await this.assertWorkflowExecutionStartAllowed(workflow.tenantId, org.orgId)
      let run: CloudWorkflowRunRecord
      try {
        run = await this.store.createWorkflowRun({
          tenantId: workflow.tenantId,
          userId: workflow.userId,
          workflowId: workflow.id,
          runId: this.ids.randomUUID(),
          triggerType: 'webhook',
          triggerPayload: input.payload,
          claimedBy: `workflow-webhook:${workflow.id}`,
          quota: await this.usageGovernance.workflowRunQuotaForOrg(org.orgId),
        })
      } catch (error) {
        this.usageGovernance.translateQuotaError(error, 'Cloud workflow run quota exceeded.', 'quota.workflow_runs_per_hour_exceeded')
      }
      const started = await this.startWorkflowRun(workflow, run)
      await replayClaim.accept()
      return started
    } catch (error) {
      await replayClaim.release()
      throw error
    }
  }

  async appendProductEvent(
    principal: CloudPrincipal,
    sessionId: string,
    input: {
      type: CloudProjectedSessionEventType
      payload?: Record<string, unknown>
      createdAt?: Date
    },
  ) {
    await this.getSessionView(principal, sessionId)
    return this.appendProjectedEvent({
      tenantId: principal.tenantId,
      sessionId,
      type: input.type,
      payload: input.payload || {},
      createdAt: input.createdAt,
    })
  }

  async assertArtifactUploadAllowed(principal: CloudPrincipal, bytes: number) {
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'artifact.upload',
      profileName: this.policy.profileName,
    })
    await this.usageGovernance.consumeQuota({
      orgId: this.principalOrgId(principal),
      quotaKey: 'artifact_bytes:day',
      limit: this.abuse.maxArtifactBytesPerDay,
      entitlementLimitKey: 'maxArtifactBytesPerDay',
      quantity: bytes,
      windowMs: DAY_MS,
      policyCode: 'quota.artifact_bytes_per_day_exceeded',
      message: 'Cloud artifact upload quota exceeded.',
    })
  }

  async recordArtifactUploaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    await this.usageGovernance.recordUsage({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      eventType: 'artifact.uploaded',
      quantity: bytes,
      unit: 'byte',
      metadata: { tenantId: principal.tenantId, sessionId, artifactId },
    })
  }

  async recordArtifactDownloaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    await this.usageGovernance.recordUsage({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      eventType: 'artifact.downloaded',
      quantity: bytes,
      unit: 'byte',
      metadata: { tenantId: principal.tenantId, sessionId, artifactId },
    })
  }

  async recordWorkerMinutes(input: {
    tenantId: string
    sessionId: string
    workerId: string
    elapsedMs: number
    reservedMinutes?: number
  }) {
    if (!this.abuse.enabled) return null
    const org = await this.store.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId })
    const minutes = Math.max(1, Math.ceil(input.elapsedMs / 60_000))
    const unreservedMinutes = Math.max(0, minutes - Math.max(0, Math.floor(input.reservedMinutes || 0)))
    const workerMinuteLimit = this.usageGovernance.quotaLimit(await this.usageGovernance.effectiveQuotaLimit(
      org.orgId,
      this.abuse.maxWorkerMinutesPerHour,
      'maxWorkerMinutesPerHour',
    ))
    if (workerMinuteLimit && unreservedMinutes > 0) {
      const now = new Date()
      const quota = await this.store.consumeUsageQuota({
        orgId: org.orgId,
        quotaKey: 'worker_minutes:hour',
        limit: workerMinuteLimit,
        quantity: unreservedMinutes,
        windowMs: HOUR_MS,
        now,
        policyCode: 'quota.worker_minutes_per_hour_exceeded',
      })
      if (!quota.allowed && quota.remaining > 0) {
        await this.store.consumeUsageQuota({
          orgId: org.orgId,
          quotaKey: 'worker_minutes:hour',
          limit: workerMinuteLimit,
          quantity: quota.remaining,
          windowMs: HOUR_MS,
          now,
          policyCode: 'quota.worker_minutes_per_hour_exceeded',
        })
      }
    }
    return this.store.recordUsageEvent({
      orgId: org.orgId,
      eventType: 'worker.minute',
      quantity: minutes,
      unit: 'minute',
      metadata: {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        workerId: input.workerId,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      },
    })
  }

  async recordManagedWorkClaimed(input: {
    tenantId: string
    sessionId: string
    workerId: string
    leaseToken: string
  }) {
    return this.usageGovernance.recordManagedWorkClaimed(input)
  }

  async recordManagedExecutionEvent(input: {
    tenantId: string
    sessionId: string
    workerId: string
    commandId: string
    commandKind: string
    eventType: 'worker.execution_started' | 'worker.execution_completed' | 'worker.execution_failed'
    elapsedMs?: number | null
    errorCode?: string | null
  }) {
    return this.usageGovernance.recordManagedExecutionEvent(input)
  }

  async listUsageEvents(principal: CloudPrincipal, limit?: number) {
    await this.ensurePrincipal(principal)
    return this.store.listUsageEvents(this.principalOrgId(principal), limit)
  }

  async getUsageSummary(principal: CloudPrincipal, limit = 100): Promise<CloudUsageSummary> {
    await this.ensurePrincipal(principal)
    return this.usageGovernance.getUsageSummary(this.principalOrgId(principal), limit)
  }

  async getDiagnosticsBundle(principal: CloudPrincipal): Promise<CloudDiagnosticsBundle> {
    await this.ensurePrincipal(principal)
    if (!principalCanViewDiagnostics(principal)) {
      throw new CloudServiceError(403, 'Cloud diagnostics require operator privileges.')
    }
    const orgId = this.principalOrgId(principal)
    const deliverySampleLimit = 200
    const [billing, usage, byok, heartbeats, agents, deliveries] = await Promise.all([
      this.getBillingSubscription(principal),
      this.getUsageSummary(principal, 200),
      this.byokService.listSecretMetadataForOrg(orgId),
      this.store.listWorkerHeartbeats(),
      this.store.listHeadlessAgents(orgId),
      this.store.listChannelDeliveries({ orgId, limit: deliverySampleLimit }),
    ])
    const bindings = (await Promise.all(agents.map((agent) => this.store.listChannelBindings(orgId, agent.agentId)))).flat()
    const deliveryCounts: Record<string, number> = {
      pending: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      dead: 0,
    }
    for (const delivery of deliveries) {
      deliveryCounts[delivery.status] = (deliveryCounts[delivery.status] || 0) + 1
    }
    const bindingsByProvider: Record<string, number> = {}
    for (const binding of bindings) {
      bindingsByProvider[binding.provider] = (bindingsByProvider[binding.provider] || 0) + 1
    }
    const now = Date.now()
    const runtimeHeartbeats = heartbeats.map((heartbeat) => {
      const ageMs = Math.max(0, now - Date.parse(heartbeat.lastSeenAt))
      return {
        workerId: heartbeat.workerId,
        role: heartbeat.role,
        activeSessionCount: heartbeat.activeSessionIds.length,
        lastSeenAt: heartbeat.lastSeenAt,
        ageMs,
        stale: ageMs > 60_000,
      }
    })
    return {
      generatedAt: new Date().toISOString(),
      redaction: 'secrets-redacted',
      org: {
        orgId,
        tenantId: principal.tenantId,
        role: principal.role || principal.authSource || 'unknown',
        profileName: this.policy.profileName,
      },
      runtime: {
        role: this.policy.role,
        profileName: this.policy.profileName,
        canExecute: this.policy.role === 'all-in-one' || this.policy.role === 'worker',
        commandProcessing: this.policy.role === 'all-in-one' ? 'inline' : this.policy.role === 'worker' ? 'durable' : 'delegated',
        checkpoints: this.policy.role === 'all-in-one' || this.policy.role === 'worker',
        heartbeatCount: heartbeats.length,
        heartbeats: runtimeHeartbeats,
      },
      billing,
      byok: {
        configuredProviders: byok.length,
        providers: byok,
      },
      usage,
      gateway: {
        agents: {
          total: agents.length,
          active: agents.filter((agent) => agent.status === 'active').length,
          disabled: agents.filter((agent) => agent.status === 'disabled').length,
        },
        bindingsByProvider,
        deliveriesByStatus: deliveryCounts,
        deliveriesByStatusScope: 'recent_deliveries',
        deliverySampleLimit,
      },
      links: {
        deploymentDocs: '/docs/open-cowork-cloud',
        managedByokRunbook: '/runbooks/managed-byok-saas',
      },
    }
  }

  async listApiTokens(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<PublicApiTokenRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const tokens = (await this.store.listApiTokens(this.principalOrgId(principal)))
      .slice(0, normalizedCloudListLimit(input.limit))
    return Promise.all(tokens.map((token) => this.publicApiTokenWithChannelBindings(token)))
  }

  async issueApiToken(
    principal: CloudPrincipal,
    input: {
      name: string
      scopes: ApiTokenScope[]
      expiresAt?: Date | null
      channelBindingIds?: readonly string[] | null
    },
  ): Promise<IssuedPublicApiTokenRecord> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const scopes = enforceApiTokenScopePolicy(normalizeApiTokenScopes(input.scopes), this.identityPolicy)
    const channelBindingIds = await this.normalizeApiTokenChannelBindingIds(principal, input.channelBindingIds, scopes)
    const issued = await this.store.issueApiToken({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      name: input.name,
      scopes,
      expiresAt: normalizeApiTokenExpiresAt(input.expiresAt, this.identityPolicy),
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    for (const channelBindingId of channelBindingIds) {
      await this.store.grantApiTokenChannelBinding({
        orgId: this.principalOrgId(principal),
        tokenId: issued.token.tokenId,
        channelBindingId,
        actor: {
          actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
          actorId: principal.tokenId || principal.userId,
          accountId: principal.accountId || principal.userId,
        },
      })
    }
    return {
      token: publicApiToken(issued.token, channelBindingIds),
      plaintext: issued.plaintext,
    }
  }

  async revokeApiToken(principal: CloudPrincipal, tokenId: string): Promise<PublicApiTokenRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const revoked = await this.store.revokeApiToken({
      tokenId,
      orgId: this.principalOrgId(principal),
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    return revoked ? this.publicApiTokenWithChannelBindings(revoked) : null
  }

  async grantApiTokenChannelBinding(
    principal: CloudPrincipal,
    tokenId: string,
    input: { channelBindingId: string },
  ): Promise<{ grant: { orgId: string, tokenId: string, channelBindingId: string, createdAt: string }, token: PublicApiTokenRecord }> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const orgId = this.principalOrgId(principal)
    const token = (await this.store.listApiTokens(orgId)).find((candidate) => candidate.tokenId === tokenId)
    if (!token) throw new CloudServiceError(404, 'API token was not found.')
    if (!token.scopes.includes('gateway')) {
      throw new CloudServiceError(400, 'Channel binding grants require a gateway-scoped API token.')
    }
    const channelBindingId = await this.normalizeSingleApiTokenChannelBindingId(principal, input.channelBindingId)
    const grant = await this.store.grantApiTokenChannelBinding({
      orgId,
      tokenId,
      channelBindingId,
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    return {
      grant,
      token: await this.publicApiTokenWithChannelBindings(token),
    }
  }

  async getBillingSubscription(principal: CloudPrincipal) {
    return this.billingOperations.getBillingSubscription(principal)
  }

  async createBillingCheckout(
    principal: CloudPrincipal,
    input: { planKey?: string | null, successUrl?: string | null, cancelUrl?: string | null },
  ): Promise<BillingCheckoutResult> {
    return this.billingOperations.createBillingCheckout(principal, input)
  }

  async createBillingPortal(
    principal: CloudPrincipal,
    input: { returnUrl?: string | null },
  ): Promise<BillingPortalResult> {
    return this.billingOperations.createBillingPortal(principal, input)
  }

  async verifyBillingWebhook(input: {
    headers: Record<string, string | undefined>
    rawBody: string
    body: Record<string, unknown>
  }): Promise<BillingWebhookResult> {
    return this.billingOperations.verifyBillingWebhook(input)
  }

  async applyBillingWebhookResult(result: BillingWebhookResult): Promise<BillingWebhookResult & { subscriptionRecord?: BillingSubscriptionRecord | null }> {
    return this.billingOperations.applyBillingWebhookResult(result)
  }

  async handleBillingWebhook(input: {
    headers: Record<string, string | undefined>
    rawBody: string
    body: Record<string, unknown>
  }): Promise<BillingWebhookResult & { subscriptionRecord?: BillingSubscriptionRecord | null }> {
    return this.billingOperations.handleBillingWebhook(input)
  }

  async claimHttpRateLimit(input: {
    scope: string
    source: string
    now?: Date
  }) {
    if (!this.abuse.enabled || !this.abuse.httpRateLimit.enabled) return null
    const result = await this.store.claimRateLimit({
      scope: input.scope,
      source: input.source,
      limit: this.abuse.httpRateLimit.maxRequests,
      windowMs: this.abuse.httpRateLimit.windowMs,
      now: input.now,
      policyCode: 'rate_limit.http_exceeded',
    })
    if (!result.allowed) {
      throw this.usageGovernance.quotaError('Too many cloud requests. Try again later.', 'rate_limit.http_exceeded', result.retryAfterMs)
    }
    return result
  }

  async checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }) {
    if (!this.abuse.enabled || !this.abuse.authBackoff.enabled) return null
    const result = await this.store.checkCloudAuthBackoff(input)
    if (!result.allowed) {
      throw this.usageGovernance.quotaError('Too many rejected cloud authentication attempts. Try again later.', 'auth.backoff', result.retryAfterMs)
    }
    return result
  }

  async recordCloudAuthFailure(input: { scope: string, source: string, now?: Date }) {
    if (!this.abuse.enabled || !this.abuse.authBackoff.enabled) return null
    return this.store.recordCloudAuthFailure({
      ...input,
      windowMs: this.abuse.authBackoff.windowMs,
      limit: this.abuse.authBackoff.maxFailures,
      backoffMs: this.abuse.authBackoff.backoffMs,
    })
  }

  async enqueuePrompt(
    principal: CloudPrincipal,
    sessionId: string,
    input: { text: string, agent?: string | null },
  ): Promise<SessionCommandRecord> {
    const view = await this.getSessionView(principal, sessionId)
    // Enforce the deployer's agent allowlist on the prompt path, mirroring the
    // workflow-draft check (`assertWorkflowDraftAllowed`). Without this, a caller
    // could request an arbitrary agent name on a prompt and bypass a profile that
    // restricts `agents`. `allowedAgents === null` (the default) imposes no limit.
    const agentName = input.agent || 'build'
    if (!includesAllowed(agentName, this.policy.allowedAgents)) {
      throw new CloudServiceError(
        403,
        `Agent "${agentName}" is not enabled for cloud profile "${this.policy.profileName}".`,
        { policyCode: 'policy.agent_not_enabled' },
      )
    }
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'prompt.enqueue',
      profileName: view.session.profileName,
    })
    const orgId = this.principalOrgId(principal)
    const promptQuota = await this.usageGovernance.usageQuotaForOrg({
      orgId,
      quotaKey: 'prompts:hour',
      limit: this.abuse.maxPromptsPerHour,
      entitlementLimitKey: 'maxPromptsPerHour',
      windowMs: HOUR_MS,
      policyCode: 'quota.prompts_per_hour_exceeded',
    })
    const commandId = this.ids.randomUUID()
    let command: SessionCommandRecord
    try {
      command = await this.store.enqueueSessionCommand({
        commandId,
        tenantId: principal.tenantId,
        userId: principal.userId,
        sessionId,
        kind: 'prompt',
        payload: {
          text: input.text,
          agent: input.agent || 'build',
        },
        quota: await this.usageGovernance.commandQueueQuotaForOrg(orgId),
        usageQuotas: [promptQuota].filter((quota) => quota !== null),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
    await this.usageGovernance.recordUsage({
      orgId,
      accountId: principal.accountId || principal.userId,
      eventType: 'work.queued',
      unit: 'count',
      metadata: { tenantId: principal.tenantId, sessionId, commandId, commandKind: command.kind, source: 'api' },
    })
    await this.usageGovernance.recordUsage({
      orgId,
      accountId: principal.accountId || principal.userId,
      eventType: 'prompt.enqueued',
      unit: 'count',
      metadata: { tenantId: principal.tenantId, sessionId, source: 'api' },
    })
    return command
  }

  async enqueueAbort(principal: CloudPrincipal, sessionId: string): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'abort',
      payload: {},
    })
  }

  async enqueueQuestionReply(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionReplyPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'question-reply',
      targetId: payload.requestId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'question.reply',
      payload,
    })
  }

  async enqueueQuestionReject(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionRejectPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'question-reject',
      targetId: payload.requestId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'question.reject',
      payload,
    })
  }

  async enqueuePermissionResponse(
    principal: CloudPrincipal,
    sessionId: string,
    payload: PermissionRespondPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'permission-approval',
      targetId: payload.permissionId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'permission.respond',
      payload,
    })
  }

  async executeCommand(
    lease: WorkerLeaseRecord,
    command: SessionCommandRecord,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    try {
      throwIfAborted(options.signal)
      switch (command.kind) {
        case 'prompt':
          await this.executePromptCommand(lease, command, options.signal)
          break
        case 'abort':
          await this.executeAbortCommand(lease, command, options.signal)
          break
        case 'question.reply':
          await this.executeQuestionReplyCommand(lease, command, options.signal)
          break
        case 'question.reject':
          await this.executeQuestionRejectCommand(lease, command, options.signal)
          break
        case 'permission.respond':
          await this.executePermissionCommand(lease, command, options.signal)
          break
        default: {
          const unsupported: never = command.kind
          throw new Error(`Unsupported command kind ${String(unsupported)}.`)
        }
      }
      throwIfAborted(options.signal)
      await this.store.ackSessionCommand(lease, command.commandId)
    } catch (error) {
      if (options.signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      await this.appendProjectedEvent({
        tenantId: command.tenantId,
        sessionId: command.sessionId,
        type: 'runtime.error',
        payload: { commandId: command.commandId, message },
        leaseToken: lease.leaseToken,
      })
      await this.failWorkflowRunForSession(command.tenantId, command.sessionId, message, lease.leaseToken)
      await this.store.failSessionCommand(lease, command.commandId, message)
      throw error
    }
  }

  appendRuntimeEvent(input: {
    tenantId: string
    sessionId: string
    event: CloudRuntimeEvent
    leaseToken?: string | null
  }): Promise<SessionEventRecord> {
    if (input.event.type === 'session.idle') {
      return this.updateStatusThenAppendRuntimeEvent(input, 'idle')
    } else if (input.event.type === 'session.status') {
      const statusType = readString(input.event.payload.statusType)
      if (statusType === 'busy' || statusType === 'running' || statusType === 'idle') {
        return this.updateStatusThenAppendRuntimeEvent(input, statusType === 'idle' ? 'idle' : 'running')
      }
    } else if (input.event.type === 'runtime.error') {
      return this.updateStatusThenAppendRuntimeEvent(input, 'errored')
    }
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async updateStatusThenAppendRuntimeEvent(
    input: {
      tenantId: string
      sessionId: string
      event: CloudRuntimeEvent
      leaseToken?: string | null
    },
    status: SessionRecord['status'],
  ) {
    await this.store.updateSessionStatus({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      status,
      leaseToken: input.leaseToken,
    })
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async executePromptCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizePromptPayload(command.payload)
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    const runtimeSessionId = await this.ensureRuntimeSessionBound(lease)
    const context = this.runtimeContext(session)
    throwIfAborted(signal)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'running',
      leaseToken: lease.leaseToken,
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'prompt.submitted',
      payload: {
        commandId: command.commandId,
        messageId: `${command.commandId}:user`,
        text: payload.text,
        agent: payload.agent,
      },
      leaseToken: lease.leaseToken,
    })
    const stopAbortHandler = runOnAbort(signal, () => this.runtime.abortSession({
      sessionId: runtimeSessionId,
      context,
    }))
    let result: Awaited<ReturnType<CloudRuntimeAdapter['promptSession']>>
    try {
      result = await this.runtime.promptSession({
        sessionId: runtimeSessionId,
        parts: promptParts(payload.text),
        agent: payload.agent,
        context,
        messageId: command.commandId,
        signal,
      })
    } finally {
      stopAbortHandler()
    }
    throwIfAborted(signal)
    for (const event of result?.events || []) {
      await this.applyRuntimeEvent(lease, command.sessionId, event)
    }
    await this.completeWorkflowRunForSession(
      command.tenantId,
      command.sessionId,
      this.workflowSummaryFromRuntimeEvents(result?.events || []),
      lease.leaseToken,
    )
  }

  private async executeAbortCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    if (session.opencodeSessionId) {
      await this.runtime.abortSession({
        sessionId: session.opencodeSessionId,
        context: this.runtimeContext(session),
        signal,
      })
    }
    throwIfAborted(signal)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'idle',
      leaseToken: lease.leaseToken,
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'session.aborted',
      payload: {
        commandId: command.commandId,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executeQuestionReplyCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizeQuestionReplyPayload(command.payload)
    if (!payload.requestId) throw new Error('Question reply requires a request id.')
    if (!this.runtime.replyToQuestion) throw new Error('OpenCode question replies are not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.replyToQuestion({
      requestId: payload.requestId,
      answers: payload.answers,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
        answers: payload.answers,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executeQuestionRejectCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizeQuestionRejectPayload(command.payload)
    if (!payload.requestId) throw new Error('Question rejection requires a request id.')
    if (!this.runtime.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.rejectQuestion({
      requestId: payload.requestId,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
        rejected: true,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executePermissionCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizePermissionPayload(command.payload)
    if (!payload.permissionId) throw new Error('Permission response requires a permission id.')
    if (!this.runtime.respondToPermission) throw new Error('OpenCode permission responses are not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    const allowed = asRecord(payload.response).allowed === true
      || payload.response === true
      || payload.response === 'allow'
      || payload.response === 'once'
    await this.runtime.respondToPermission({
      permissionId: payload.permissionId,
      allowed,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'permission.resolved',
      payload: {
        commandId: command.commandId,
        permissionId: payload.permissionId,
        allowed,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async applyRuntimeEvent(lease: WorkerLeaseRecord, sessionId: string, event: CloudRuntimeEvent) {
    await this.appendRuntimeEvent({
      tenantId: lease.tenantId,
      sessionId,
      event,
      leaseToken: lease.leaseToken,
    })
  }

  private async appendProjectedEvent(input: AppendProjectedEventInput) {
    const event = await this.projections.appendProjectedEvent(input)
    this.dispatchCloudCoordinationWatchEvent(input, event)
    return event
  }

  private dispatchCloudCoordinationWatchEvent(input: AppendProjectedEventInput, event: SessionEventRecord) {
    const watchEvent = this.coordinationWatchEventFromProjectedEvent(input, event)
    if (!watchEvent) return
    void this.deliverCloudCoordinationWatchEvent(watchEvent).catch((error: unknown) => {
      log('coordination', `Cloud watch event dispatch failed event=${input.type} session=${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async deliverCloudCoordinationWatchEvent(event: CoordinationWatchEvent) {
    const workspaceId = event.workspaceId?.trim() || 'cloud:default'
    const watches = await this.store.listMatchingCloudCoordinationWatches({
      workspaceId,
      eventType: event.eventType,
      targets: this.cloudWatchRelatedTargets(event),
    })
    if (watches.length === 0) return

    const tenantId = workspaceId.startsWith('cloud:') ? workspaceId.slice('cloud:'.length) : workspaceId
    const normalizedTenantId = tenantId.trim() || 'default'
    const orgId = await this.resolveOrgIdForTenant(normalizedTenantId)

    for (const watch of watches) {
      if (!coordinationWatchRecipientCanReceive(watch.recipient?.role, event.eventType)) continue
      try {
        await this.createSystemChannelDelivery({
          orgId,
          agentId: watch.channel.agentId,
          channelBindingId: watch.channel.channelBindingId,
          sessionBindingId: watch.channel.sessionBindingId || null,
          provider: normalizeChannelProviderId(watch.channel.provider),
          target: watch.channel.target,
          eventType: event.eventType,
          payload: this.cloudWatchPayload(watch, event),
          deliveryId: this.cloudWatchDeliveryId(watch, event),
        })
      } catch (error) {
        log('coordination', `Cloud watch delivery failed watch=${watch.id} event=${event.eventType}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async createSystemChannelDelivery(input: CreateChannelDeliveryInput) {
    await this.store.createChannelDelivery(input)
  }

  private cloudWatchRelatedTargets(event: CoordinationWatchEvent): CoordinationTarget[] {
    return [event.target, ...(event.relatedTargets || [])]
  }

  private cloudWatchPayload(watch: CoordinationWatch, event: CoordinationWatchEvent): Record<string, unknown> {
    return {
      watchId: watch.id,
      eventType: event.eventType,
      target: event.target,
      relatedTargets: event.relatedTargets || [],
      title: event.title || null,
      message: event.message || null,
      severity: event.severity || 'info',
      occurredAt: event.occurredAt || new Date().toISOString(),
      metadata: event.metadata || {},
    }
  }

  private cloudWatchDeliveryId(watch: CoordinationWatch, event: CoordinationWatchEvent) {
    const timestampScopedEvent = event.eventType === 'task.moved'
      || event.eventType === 'task.review_ready'
      || event.eventType === 'run.finished'
      || event.eventType === 'daily_summary'
    const eventKey = {
      watchId: watch.id,
      eventType: event.eventType,
      target: event.target,
      relatedTargets: event.relatedTargets || [],
      metadata: event.metadata || {},
      occurredAt: timestampScopedEvent ? event.occurredAt || null : null,
    }
    const digest = createHash('sha256').update(JSON.stringify(eventKey)).digest('hex').slice(0, 40)
    return `watch:${event.eventType}:${digest}`
  }

  private coordinationWatchEventFromProjectedEvent(
    input: AppendProjectedEventInput,
    event: SessionEventRecord,
  ): CoordinationWatchEvent | null {
    const workspaceId = `cloud:${input.tenantId}`
    const sessionTarget = { kind: 'session' as const, id: input.sessionId }
    const conversationTarget = { kind: 'conversation' as const, id: input.sessionId }
    const payload = input.payload || {}
    const occurredAt = event.createdAt
    if (input.type === 'session.idle') {
      return {
        eventType: 'run.finished',
        workspaceId,
        target: sessionTarget,
        relatedTargets: [conversationTarget],
        title: 'Run finished',
        message: 'OpenCode finished processing the cloud run.',
        severity: 'success',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          runtimeSessionId: readString(payload.sessionId) || null,
          cloudEventType: input.type,
        },
      }
    }
    if (input.type === 'permission.requested') {
      const requestId = readString(payload.permissionId) || readString(payload.id) || readString(payload.requestId) || null
      return {
        eventType: 'needs_input',
        workspaceId,
        target: conversationTarget,
        relatedTargets: [sessionTarget],
        title: 'Approval needed',
        message: readString(payload.description) || readString(payload.tool) || 'A cloud run needs approval.',
        severity: 'warning',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          requestId,
          kind: input.type,
          tool: readString(payload.tool) || null,
        },
      }
    }
    if (input.type === 'question.asked') {
      const requestId = readString(payload.requestId) || readString(payload.id) || null
      const questions = Array.isArray(payload.questions) ? payload.questions : []
      const firstQuestion = readString(asRecord(questions[0]).question)
      return {
        eventType: 'needs_input',
        workspaceId,
        target: conversationTarget,
        relatedTargets: [sessionTarget],
        title: 'Question needs an answer',
        message: firstQuestion || 'A cloud run needs an answer.',
        severity: 'warning',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          requestId,
          kind: input.type,
        },
      }
    }
    return null
  }

  private async requireSessionRecord(tenantId: string, sessionId: string) {
    const session = await this.store.getSessionForTenant(tenantId, sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private shouldCreateRuntimeSessionsEagerly() {
    if (this.runtime.requiresWorkerContext) return false
    return this.policy.role === 'all-in-one' || this.policy.role === 'worker'
  }

  private runtimeContext(input: { tenantId: string, sessionId: string, profileName?: string | null }): CloudRuntimeExecutionContext {
    return {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      profileName: input.profileName || this.policy.profileName,
    }
  }

  private async createStoredSession(input: {
    tenantId: string
    userId: string
    orgId?: string | null
    accountId?: string | null
    sessionId: string
    opencodeSessionId: string
    profileName: string
    title?: string | null
    createdAt?: Date
  }) {
    try {
      const concurrentSessionLimit = await this.usageGovernance.effectiveQuotaLimit(
        input.orgId || input.tenantId,
        this.abuse.maxConcurrentSessionsPerOrg,
        'maxConcurrentSessionsPerOrg',
      )
      const session = await this.store.createSession({
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        opencodeSessionId: input.opencodeSessionId,
        profileName: input.profileName,
        title: input.title,
        createdAt: input.createdAt,
        quota: this.usageGovernance.quotaLimit(concurrentSessionLimit)
          ? {
              orgId: input.orgId || input.tenantId,
              maxConcurrentSessionsPerOrg: concurrentSessionLimit,
              policyCode: 'quota.concurrent_sessions_exceeded',
            }
          : null,
      })
      await this.usageGovernance.recordUsage({
        orgId: input.orgId || input.tenantId,
        accountId: input.accountId || input.userId,
        eventType: 'session.created',
        unit: 'count',
        metadata: { tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId },
      })
      return session
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Concurrent cloud session quota exceeded.', 'quota.concurrent_sessions_exceeded')
    }
  }

  private async createCloudSessionRecord(input: CreateCloudSessionRecordInput): Promise<SessionRecord> {
    if (input.sessionId) {
      const existing = await this.store.getSessionForTenant(input.tenantId, input.sessionId)
      if (existing) return existing
      const now = new Date()
      const title = input.title || 'New session'
      await this.createStoredSession({
        tenantId: input.tenantId,
        userId: input.userId,
        orgId: input.orgId,
        accountId: input.accountId,
        sessionId: input.sessionId,
        opencodeSessionId: '',
        profileName: input.profileName,
        title,
        createdAt: now,
      })
      await this.appendProjectedEvent({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        type: 'session.created',
        payload: {
          title,
          runtimePending: true,
        },
        createdAt: now,
      })
      return this.requireSessionRecord(input.tenantId, input.sessionId)
    }

    if (!input.deferRuntime && this.shouldCreateRuntimeSessionsEagerly() && !this.usageGovernance.quotaLimit(this.abuse.maxConcurrentSessionsPerOrg)) {
      const runtimeSession = await this.runtime.createSession({
        profileName: input.profileName,
        context: this.runtimeContext({
          tenantId: input.tenantId,
          sessionId: input.sessionId || '',
          profileName: input.profileName,
        }),
      })
      const title = input.title || runtimeSession.title
      await this.createStoredSession({
        tenantId: input.tenantId,
        userId: input.userId,
        orgId: input.orgId,
        accountId: input.accountId,
        sessionId: runtimeSession.id,
        opencodeSessionId: runtimeSession.id,
        profileName: input.profileName,
        title,
        createdAt: new Date(runtimeSession.createdAt),
      })
      await this.appendProjectedEvent({
        tenantId: input.tenantId,
        sessionId: runtimeSession.id,
        type: 'session.created',
        payload: { title },
        createdAt: new Date(runtimeSession.updatedAt),
      })
      return this.requireSessionRecord(input.tenantId, runtimeSession.id)
    }

    const now = new Date()
    const sessionId = this.ids.randomUUID()
    const title = input.title || 'New session'
    await this.createStoredSession({
      tenantId: input.tenantId,
      userId: input.userId,
      orgId: input.orgId,
      accountId: input.accountId,
      sessionId,
      opencodeSessionId: '',
      profileName: input.profileName,
      title,
      createdAt: now,
    })
    await this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId,
      type: 'session.created',
      payload: {
        title,
        runtimePending: true,
      },
      createdAt: now,
    })
    return this.requireSessionRecord(input.tenantId, sessionId)
  }

  private async ensureRuntimeSessionBound(lease: WorkerLeaseRecord) {
    const session = await this.requireSessionRecord(lease.tenantId, lease.sessionId)
    if (session.opencodeSessionId) return session.opencodeSessionId

    const runtimeSession = await this.runtime.createSession({
      profileName: session.profileName,
      context: this.runtimeContext(session),
    })
    await this.store.bindSessionRuntime({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      opencodeSessionId: runtimeSession.id,
      title: session.title || runtimeSession.title,
      leaseToken: lease.leaseToken,
      updatedAt: new Date(runtimeSession.updatedAt),
    })
    return runtimeSession.id
  }

  private async workflowDetail(workflow: CloudWorkflowRecord): Promise<WorkflowDetail> {
    return {
      ...toWorkflowSummary(workflow),
      runs: (await this.store.listWorkflowRuns(workflow.tenantId, workflow.id, 25)).map(toWorkflowRun),
    }
  }

  private async startClaimedWorkflowRun(claimed: ClaimedWorkflowRunRecord): Promise<CloudWorkflowStartResult | null> {
    try {
      return await this.startWorkflowRun(claimed.workflow, claimed.run)
    } catch (error) {
      if (error instanceof CloudServiceError && (error.status === 402 || error.status === 429)) {
        const now = new Date()
        const nextStatus = this.nextWorkflowStatusAfterRun(claimed.workflow)
        await this.store.failWorkflowRun({
          tenantId: claimed.workflow.tenantId,
          workflowId: claimed.workflow.id,
          runId: claimed.run.id,
          error: error.message,
          nextStatus,
          nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(claimed.workflow.triggers, now) : null,
          finishedAt: now,
        })
        return null
      }
      throw error
    }
  }

  private async startWorkflowRun(
    workflow: CloudWorkflowRecord,
    run: CloudWorkflowRunRecord,
  ): Promise<CloudWorkflowStartResult> {
    const org = await this.store.ensureOrgForTenant({ tenantId: workflow.tenantId, name: workflow.tenantId })
    await this.assertWorkflowExecutionStartAllowed(workflow.tenantId, org.orgId)
    const session = await this.createCloudSessionRecord({
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      sessionId: run.sessionId || undefined,
      profileName: this.policy.profileName,
      title: `Run ${workflow.title}`,
    })
    const attached = await this.store.attachWorkflowRunSession({
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      runId: run.id,
      sessionId: session.sessionId,
      claimToken: run.claimToken,
    })
    let command: SessionCommandRecord
    try {
      command = await this.store.enqueueSessionCommand({
        commandId: this.workflowPromptCommandId(workflow, run),
        tenantId: workflow.tenantId,
        userId: workflow.userId,
        sessionId: session.sessionId,
        kind: 'prompt',
        payload: {
          text: workflow.instructions,
          agent: workflow.agentName,
        },
        quota: await this.usageGovernance.commandQueueQuotaForOrg(org.orgId),
      })
    } catch (error) {
      if (error instanceof ControlPlaneQuotaExceededError) {
        const now = new Date()
        const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
        await this.store.failWorkflowRun({
          tenantId: workflow.tenantId,
          workflowId: workflow.id,
          runId: run.id,
          error: error.publicMessage || 'Cloud command queue is full.',
          nextStatus,
          nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
          finishedAt: now,
        })
      }
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
    await this.usageGovernance.recordUsage({
      orgId: org.orgId,
      accountId: workflow.userId,
      eventType: 'work.queued',
      unit: 'count',
      metadata: {
        tenantId: workflow.tenantId,
        sessionId: session.sessionId,
        workflowId: workflow.id,
        runId: run.id,
        commandId: command.commandId,
        commandKind: command.kind,
        source: `workflow:${run.triggerType}`,
      },
    })
    const updatedWorkflow = await this.store.getWorkflowForTenant(workflow.tenantId, workflow.id)
    return {
      tenantId: workflow.tenantId,
      workflow: updatedWorkflow ? await this.workflowDetail(updatedWorkflow) : {
        ...toWorkflowSummary(workflow),
        runs: [toWorkflowRun(attached || run)],
      },
      run: toWorkflowRun(attached || run),
      sessionId: session.sessionId,
      command,
    }
  }

  private workflowPromptCommandId(workflow: CloudWorkflowRecord, run: CloudWorkflowRunRecord) {
    return `workflow:${workflow.tenantId}:${workflow.id}:${run.id}:prompt`
  }

  private workflowSummaryFromRuntimeEvents(events: CloudRuntimeEvent[]) {
    const assistant = events
      .slice()
      .reverse()
      .find((event) => event.type === 'assistant.message')
    const content = assistant ? readString(asRecord(assistant.payload).content) : ''
    return content ? content.slice(0, 500) : null
  }

  private async completeWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    summary: string | null,
    leaseToken?: string | null,
  ) {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || workflowRunTerminal(run.status)) return
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return
    const now = new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    await this.store.completeWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      summary,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    })
    await this.enqueueWorkflowChannelDeliveries(tenantId, sessionId, {
      eventType: 'workflow.completed',
      workflowId: workflow.id,
      runId: run.id,
      status: 'completed',
      summary,
      finishedAt: now.toISOString(),
    })
  }

  private async failWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    error: string,
    leaseToken?: string | null,
  ) {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || workflowRunTerminal(run.status)) return
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return
    const now = new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    await this.store.failWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      error,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    })
    await this.enqueueWorkflowChannelDeliveries(tenantId, sessionId, {
      eventType: 'workflow.failed',
      workflowId: workflow.id,
      runId: run.id,
      status: 'failed',
      error,
      finishedAt: now.toISOString(),
    })
  }

  private nextWorkflowStatusAfterRun(workflow: CloudWorkflowRecord): WorkflowStatus {
    return workflow.status === 'paused' || workflow.status === 'archived'
      ? workflow.status
      : 'active'
  }

  private async enqueueWorkflowChannelDeliveries(
    tenantId: string,
    sessionId: string,
    input: {
      eventType: string
      workflowId: string
      runId: string
      status: string
      summary?: string | null
      error?: string | null
      finishedAt: string
    },
  ) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    const bindings = await this.store.listChannelSessionBindingsForSession(org.orgId, sessionId)
    await Promise.all(bindings.map((binding) => this.store.createChannelDelivery({
      deliveryId: stableCloudId('channel_delivery', org.orgId, input.eventType, input.runId, binding.bindingId),
      orgId: org.orgId,
      agentId: binding.agentId,
      channelBindingId: binding.channelBindingId,
      sessionBindingId: binding.bindingId,
      provider: binding.provider,
      target: {
        externalChatId: binding.externalChatId,
        externalThreadId: binding.externalThreadId,
        lastChatMessageId: binding.lastChatMessageId,
      },
      eventType: input.eventType,
      payload: {
        workflowId: input.workflowId,
        runId: input.runId,
        sessionId,
        status: input.status,
        summary: input.summary || null,
        error: input.error || null,
        finishedAt: input.finishedAt,
      },
    })))
  }

  private principalOrgId(principal: CloudPrincipal) {
    return principal.orgId || principal.tenantId
  }

  private async principalIsActiveWorkspaceMember(principal: CloudPrincipal) {
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    return membership?.membership.status === 'active'
  }

  private assertRemoteInteractionAllowed(principal: CloudPrincipal, input: RemoteInteractionPolicyInput) {
    return assertRemoteApprovalInteractionAllowed({
      store: this.store,
      policy: this.policy,
      principal,
      orgId: this.principalOrgId(principal),
      actor: this.auditActor(principal),
      input,
      resolveActorWorkspaceMember: () => this.principalIsActiveWorkspaceMember(principal),
    })
  }

  private async publicApiTokenWithChannelBindings(token: ApiTokenRecord): Promise<PublicApiTokenRecord> {
    const grants = await this.store.listApiTokenChannelBindingGrants({
      orgId: token.orgId,
      tokenId: token.tokenId,
    })
    return publicApiToken(token, grants.map((grant) => grant.channelBindingId))
  }

  private async normalizeApiTokenChannelBindingIds(
    principal: CloudPrincipal,
    input: readonly string[] | null | undefined,
    scopes: ApiTokenScope[],
  ): Promise<string[]> {
    const ids = [...new Set((input || []).map((value) => value.trim()).filter(Boolean))]
    if (ids.length === 0) return []
    if (!scopes.includes('gateway')) {
      throw new CloudServiceError(400, 'Channel binding grants require a gateway-scoped API token.')
    }
    const normalized: string[] = []
    for (const channelBindingId of ids) {
      normalized.push(await this.normalizeSingleApiTokenChannelBindingId(principal, channelBindingId))
    }
    return normalized
  }

  private async normalizeSingleApiTokenChannelBindingId(principal: CloudPrincipal, input: string): Promise<string> {
    const channelBindingId = input.trim()
    if (!channelBindingId) throw new CloudServiceError(400, 'Channel binding id is required.')
    const binding = await this.store.getChannelBinding(this.principalOrgId(principal), channelBindingId)
    if (!binding) throw new CloudServiceError(404, 'Channel binding was not found.')
    return binding.bindingId
  }

  private assertApiTokenAdmin(principal: CloudPrincipal) {
    if (!principalCanManageApiTokens(principal)) {
      throw new CloudServiceError(403, 'API token administration requires an org admin or admin-scoped API token.')
    }
  }

  private assertOrgAdmin(principal: CloudPrincipal) {
    if (!principalCanManageOrg(principal)) {
      throw new CloudServiceError(403, 'Org administration requires an org admin or admin-scoped API token.')
    }
  }

  private async assertBillingAllowed(input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) {
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig)) return
    const subscription = await this.store.getBillingSubscription(input.orgId)
    const verdict = evaluateBillingEntitlement({
      config: this.billingConfig,
      subscription,
      action: input.action,
      profileName: input.profileName,
      providerId: input.providerId,
    })
    if (!verdict.allowed) {
      throw new CloudServiceError(
        verdict.status || 402,
        verdict.reason || 'Billing entitlement does not allow this action.',
        { policyCode: verdict.policyCode || 'billing.entitlement_denied' },
      )
    }
  }

  async assertWorkerLeaseAllowed(tenantId: string) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    await this.assertBillingAllowed({
      orgId: org.orgId,
      action: 'worker.execute',
      profileName: this.policy.profileName,
    })
  }

  async reserveWorkerExecutionCapacity(tenantId: string) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    await this.assertBillingAllowed({
      orgId: org.orgId,
      action: 'worker.execute',
      profileName: this.policy.profileName,
    })
    const workerMinuteLimit = this.usageGovernance.quotaLimit(await this.usageGovernance.effectiveQuotaLimit(
      org.orgId,
      this.abuse.maxWorkerMinutesPerHour,
      'maxWorkerMinutesPerHour',
    ))
    if (workerMinuteLimit) {
      const now = new Date()
      const result = await this.store.consumeUsageQuota({
        orgId: org.orgId,
        quotaKey: 'worker_minutes:hour',
        limit: workerMinuteLimit,
        quantity: 1,
        windowMs: HOUR_MS,
        now,
        policyCode: 'quota.worker_minutes_per_hour_exceeded',
      })
      if (!result.allowed) {
        throw this.usageGovernance.quotaError(
          'Cloud worker minute quota exceeded.',
          'quota.worker_minutes_per_hour_exceeded',
          result.retryAfterMs,
        )
      }
    }
  }

  async assertWorkerExecutionAllowed(tenantId: string) {
    await this.reserveWorkerExecutionCapacity(tenantId)
  }

  async activeWorkerQuotaForTenant(tenantId: string) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    const limit = this.usageGovernance.quotaLimit(await this.usageGovernance.effectiveQuotaLimit(
      org.orgId,
      this.abuse.maxActiveWorkersPerOrg,
      'maxActiveWorkersPerOrg',
    ))
    return limit ? { orgId: org.orgId, limit } : null
  }

  private auditActor(principal: CloudPrincipal) {
    return importAuditActor(principal)
  }

  private async getTenantSessionView(tenantId: string, sessionId: string): Promise<CloudSessionView> {
    const session = await this.store.getSessionForTenant(tenantId, sessionId)
    if (!session) throw new CloudServiceError(404, 'Cloud session was not found.')
    const projection = await this.store.getSessionProjection(tenantId, sessionId)
    return {
      session: this.withProjectionProjectSource(session, projection),
      projection,
    }
  }

  private assertWorkflowsEnabled() {
    if (!this.policy.features.workflows) {
      throw new Error('Workflows are disabled for this cloud profile.')
    }
  }

}
