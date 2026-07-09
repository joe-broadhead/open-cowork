import { type WorkflowWebhookAuth, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { randomUUID } from 'crypto'
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
  WorkflowStatus,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  type CloudSessionMessage,
  type CloudSessionProjectionView,
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
  BillingSubscriptionRecord,
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelCursorUpdateResult,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  ControlPlaneMembershipStatus,
  ControlPlaneRole,
  ControlPlaneStore,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  ListCloudArtifactIndexInput,
  ListCloudLaunchpadSessionSummariesInput,
  ManagedWorkerPoolStatus,
  ManagedWorkerStatus,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  UpsertCloudArtifactIndexInput,
  ListSessionsPageInput,
  ListSessionsPageRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
  WorkerLeaseRecord,
} from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
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
} from './runtime-adapter.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
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
import { CloudPrincipalService } from './services/principal-service.ts'
import {
  CloudRoleService,
  type CreateCustomRoleRequest,
  type UpdateCustomRoleRequest,
} from './services/role-service.ts'
import {
  CloudPolicyService,
  type SetManagedPolicyRequest,
} from './services/policy-service.ts'
import {
  CloudSsoService,
  type UpsertSsoConfigRequest,
} from './services/sso-service.ts'
import { CloudScimService } from './services/scim-service.ts'
import { CloudScimReconciler } from './scim-reconciler.ts'
import { createSsoVerifierRegistry, type SsoAssertionVerifier } from './sso-assertion.ts'
import type { SecretAdapter } from './secret-adapter.ts'
import type { SsoProtocol } from './control-plane-sso.ts'
import type { ScimGroupInput, ScimUserInput, ScimUserPatch } from './scim-schema.ts'
import { CloudSessionImportService } from './services/session-import-service.ts'
import { CloudCoordinationDispatchService } from './session-coordination-dispatch.ts'
import { CloudSessionExecutionService } from './session-execution-operations.ts'
import { CloudCapabilityService } from './services/capability-service.ts'
import { CloudSettingMetadataService } from './services/setting-metadata-service.ts'
import {
  CloudOverviewService,
  type CloudAdminPolicyOverview,
  type CloudWorkspaceOverview,
} from './services/overview-service.ts'
import {
  CloudAuditService,
  type AuditExportOptions,
  type AuditExportStream,
  type AuditQueryFilters,
  type AuditQueryPage,
  type DataPlaneAuditInput,
} from './services/audit-service.ts'
import { CloudProjectSourceService } from './services/project-source-service.ts'
import {
  type PermissionRespondPayload,
  type QuestionRejectPayload,
  type QuestionReplyPayload,
} from './services/session-command-service.ts'
import {
  assertRemoteApprovalInteractionAllowed,
  type RemoteInteractionPolicyInput,
} from './services/remote-approval-policy.ts'
import {
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
import { CloudEntitlementService } from './services/entitlement-service.ts'
import { UnlimitedEntitlementResolver, type EntitlementResolver } from './entitlements/entitlement-resolver.ts'
import { CloudChannelDomainService } from './services/channel-domain-service.ts'
import { CloudThreadOrganizationService } from './session-thread-organization.ts'
import { CloudBillingOperationsService } from './session-billing-operations.ts'
import { CloudDiagnosticsOperationsService } from './session-diagnostics-operations.ts'
import { CloudApiTokenOperationsService } from './session-api-token-operations.ts'
import { CloudUsageOperationsService } from './session-usage-operations.ts'
import { CloudWorkflowOperationsService } from './session-workflow-operations.ts'
import {
  principalCanViewOperations,
} from './session-principal-access.ts'
import {
  principalHasPrivilegedTokenScope,
  principalHasTokenScope,
} from './principal-access.ts'
import {
  stableCloudId,
} from './session-input-validation.ts'
import type { CloudAbuseConfig, CloudBillingConfig } from '@open-cowork/shared'

import {
  DISABLED_ABUSE_POLICY,
  HOUR_MS,
  type ChannelActorInput,
  type ChannelInteractionResolutionInput,
  type CloudDiagnosticsBundle,
  type CloudPrincipal,
  type CloudSessionView,
  type CloudUsageSummary,
  type CloudWorkflowStartResult,
  type CreateCloudSessionRecordInput,
  type IssuedPublicApiTokenRecord,
} from './session-service-types.ts'

export type {
  CloudPrincipal,
  CloudSessionView,
  CloudUsageTotalRecord,
  CloudUsageQuotaWindowRecord,
  CloudUsageSummary,
  CloudDiagnosticsBundle,
  IssuedPublicApiTokenRecord,
  CloudWorkflowStartResult,
} from './session-service-types.ts'

export type { CloudEmailMessage } from './services/member-service.ts'
export type { CloudEmailSender, MembershipInviteResult, PublicOrgMemberRecord }
export type { CloudAdminPolicyOverview, CloudWorkspaceOverview } from './services/overview-service.ts'

export type { CloudIdentityPolicy, PublicApiTokenRecord } from './services/api-token-policy.ts'
export type {
  PublicChannelBindingRecord,
  PublicChannelDeliveryRecord,
  PublicChannelIdentityRecord,
} from './public-channel-records.ts'

export type {
  ByokEntitlementChecker,
  ByokEntitlementVerdict,
  ByokKmsRefPolicy,
  ByokManagementPolicy,
  ByokRuntimeEntitlementChecker,
} from './services/byok-service.ts'

export { CloudServiceError } from './cloud-service-error.ts'

export type { CloudSessionMessage, CloudSessionProjectionView }

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
  private readonly entitlements: CloudEntitlementService
  private readonly channelDomain: CloudChannelDomainService
  private readonly memberService: CloudMemberService
  private readonly roleService: CloudRoleService
  private readonly policyService: CloudPolicyService
  private readonly ssoService: CloudSsoService
  private readonly scimService: CloudScimService
  private readonly scimReconciler: CloudScimReconciler
  private readonly coordinationService: CloudCoordinationService
  private readonly capabilityService: CloudCapabilityService
  private readonly settingMetadataService: CloudSettingMetadataService
  private readonly threadOrganization: CloudThreadOrganizationService
  private readonly billingOperations: CloudBillingOperationsService
  private readonly diagnosticsOperations: CloudDiagnosticsOperationsService
  private readonly apiTokenOperations: CloudApiTokenOperationsService
  private readonly usageOperations: CloudUsageOperationsService
  private readonly workflowOperations: CloudWorkflowOperationsService
  private readonly inviteSigningSecret: string | Buffer | null
  private readonly emailSender: CloudEmailSender | null
  private readonly principalService: CloudPrincipalService
  private readonly sessionImportService: CloudSessionImportService
  private readonly coordinationDispatch: CloudCoordinationDispatchService
  private readonly sessionExecution: CloudSessionExecutionService
  private readonly auditService: CloudAuditService

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
    // Optional, pluggable monetization (#897). Defaults to the unlimited resolver
    // so billing never gates a deployment that has not opted in.
    entitlementResolver: EntitlementResolver = new UnlimitedEntitlementResolver(),
    // Optional telemetry sink (#899). When present, data-plane audit events also
    // fan out to the metric pipeline so operators can alert on audit volume.
    observability: CloudObservabilityAdapter | null = null,
    // Envelope-encryption adapter used to seal enterprise SSO IdP secrets (#895).
    // Null ⇒ SSO config CRUD that stores a secret fails closed with a clear error.
    secretAdapter: SecretAdapter | null = null,
    // Optional operator-supplied SSO assertion verifiers (#895). The SAML default is a
    // fail-closed seam; an operator plugs in a real SAML response validator here.
    ssoVerifiers: Partial<Record<SsoProtocol, SsoAssertionVerifier>> = {},
  ) {
    this.store = store
    this.runtime = runtime
    this.policy = policy
    this.events = events
    this.workspaceEvents = workspaceEvents
    this.projections = new CloudSessionProjectionService(store, events, workspaceEvents)
    this.ids = ids
    this.identityPolicy = identityPolicy
    this.principalService = new CloudPrincipalService({ store, identityPolicy })
    this.coordinationDispatch = new CloudCoordinationDispatchService({
      store,
      resolveOrgIdForTenant: (tenantId) => this.resolveOrgIdForTenant(tenantId),
    })
    this.byokService = new CloudByokService({
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertPermission: (principal, permission) => this.principalService.assertPermission(principal, permission),
      byokSecrets,
      byokPolicy,
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
    })
    this.abuse = abuse
    this.billingConfig = billingConfig
    this.billingAdapter = billingAdapter
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
    this.entitlements = new CloudEntitlementService({ resolver: entitlementResolver })
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
    this.roleService = new CloudRoleService({
      store,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      assertPermission: (principal, permission) => this.principalService.assertPermission(principal, permission),
      principalOrgId: (principal) => this.principalOrgId(principal),
      auditActor: (principal) => this.auditActor(principal),
    })
    this.policyService = new CloudPolicyService({
      store,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      assertPermission: (principal, permission) => this.principalService.assertPermission(principal, permission),
      principalOrgId: (principal) => this.principalOrgId(principal),
      auditActor: (principal) => this.auditActor(principal),
    })
    this.ssoService = new CloudSsoService({
      store,
      secretAdapter,
      verifiers: createSsoVerifierRegistry(ssoVerifiers),
      ensurePrincipal: (principal) => this.principalService.ensurePrincipal(principal),
      assertPermission: (principal, permission) => this.principalService.assertPermission(principal, permission),
      principalOrgId: (principal) => this.principalOrgId(principal),
      auditActor: (principal) => this.auditActor(principal),
    })
    this.scimReconciler = new CloudScimReconciler({ store })
    this.scimService = new CloudScimService({ store, reconciler: this.scimReconciler })
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
    this.diagnosticsOperations = new CloudDiagnosticsOperationsService({
      store,
      policy,
      byokService: this.byokService,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      getBillingSubscription: (principal) => this.getBillingSubscription(principal),
      getUsageSummary: (principal, limit) => this.getUsageSummary(principal, limit),
    })
    this.apiTokenOperations = new CloudApiTokenOperationsService({
      store,
      identityPolicy,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
    })
    this.usageOperations = new CloudUsageOperationsService({
      store,
      policy,
      abuse,
      usageGovernance: this.usageGovernance,
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
      getSessionView: (principal, sessionId) => this.getSessionView(principal, sessionId),
      appendProjectedEvent: (input) => this.appendProjectedEvent(input),
    })
    this.workflowOperations = new CloudWorkflowOperationsService({
      store,
      policy,
      ids,
      usageGovernance: this.usageGovernance,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
      createCloudSessionRecord: (input) => this.createCloudSessionRecord(input),
    })
    this.sessionImportService = new CloudSessionImportService({
      store,
      policy,
      ids,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
      createCloudSessionRecord: (input) => this.createCloudSessionRecord(input),
      appendProjectedEvent: (input) => this.appendProjectedEvent(input),
      getSessionView: (principal, sessionId) => this.getSessionView(principal, sessionId),
    })
    this.sessionExecution = new CloudSessionExecutionService({
      store,
      runtime,
      policy,
      ids,
      abuse,
      usageGovernance: this.usageGovernance,
      workflowOperations: this.workflowOperations,
      appendProjectedEvent: (input) => this.appendProjectedEvent(input),
      getSessionView: (principal, sessionId) => this.getSessionView(principal, sessionId),
      principalOrgId: (principal) => this.principalOrgId(principal),
      assertBillingAllowed: (input) => this.assertBillingAllowed(input),
      assertRemoteInteractionAllowed: (principal, input) => this.assertRemoteInteractionAllowed(principal, input),
    })
    this.auditService = new CloudAuditService({
      store,
      observability,
      ensurePrincipal: (principal) => this.ensurePrincipal(principal),
      assertPermission: (principal, permission) => this.principalService.assertPermission(principal, permission),
      assertOrgAdmin: (principal) => this.assertOrgAdmin(principal),
      principalOrgId: (principal) => this.principalOrgId(principal),
      auditActor: (principal) => this.auditActor(principal),
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
    // SSO-only enforcement (#895): reject a non-SSO login on a domain an org has enforced
    // SSO for, BEFORE bootstrapping. Local/self-host and SSO-verified principals are exempt.
    await this.ssoService.assertNonSsoLoginAllowed(principal)
    return this.principalService.ensurePrincipal(principal)
  }

  // --- Enterprise SSO configuration (#895), gated on sso:manage ---
  getSsoConfig(principal: CloudPrincipal) {
    return this.ssoService.getSsoConfig(principal)
  }

  upsertSsoConfig(principal: CloudPrincipal, input: UpsertSsoConfigRequest) {
    return this.ssoService.upsertSsoConfig(principal, input)
  }

  deleteSsoConfig(principal: CloudPrincipal) {
    return this.ssoService.deleteSsoConfig(principal)
  }

  rotateScimToken(principal: CloudPrincipal) {
    return this.ssoService.rotateScimToken(principal)
  }

  // The SSO login binding: verify a raw IdP assertion → bootstrapped principal.
  authenticateSso(input: { orgId: string, rawAssertion: string }) {
    return this.ssoService.authenticateSso(input)
  }

  // --- SCIM 2.0 provisioning (#895), authenticated by the per-org SCIM bearer token ---
  authenticateScim(bearerToken: string | null) {
    return this.scimService.authenticate(bearerToken)
  }

  listScimMembers(orgId: string, filter: { email?: string | null } = {}) {
    return this.scimService.listMembers(orgId, filter)
  }

  getScimMember(orgId: string, accountId: string) {
    return this.scimService.getMember(orgId, accountId)
  }

  createScimUser(orgId: string, input: ScimUserInput) {
    return this.scimService.createUser(orgId, input)
  }

  replaceScimUser(orgId: string, accountId: string, input: ScimUserInput) {
    return this.scimService.replaceUser(orgId, accountId, input)
  }

  patchScimUser(orgId: string, accountId: string, patch: ScimUserPatch) {
    return this.scimService.patchUser(orgId, accountId, patch)
  }

  deprovisionScimUser(orgId: string, accountId: string) {
    return this.scimService.deprovisionUser(orgId, accountId)
  }

  syncScimGroup(orgId: string, input: ScimGroupInput) {
    return this.scimService.syncGroup(orgId, input)
  }

  // Drain the durable SCIM sync-event queue (retry with backoff); run periodically by the
  // scheduler and directly by tests. Returns processed/succeeded/failed counts.
  drainScimSyncQueue(input: { orgId?: string | null, limit?: number } = {}) {
    return this.scimReconciler.drain(input)
  }

  enqueueScimReconcile(orgId: string) {
    return this.scimReconciler.enqueueReconcile(orgId)
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

  deprovisionOrgMember(principal: CloudPrincipal, accountId: string): Promise<PublicOrgMemberRecord> {
    return this.memberService.deprovisionOrgMember(principal, accountId)
  }

  listPermissionCatalog() {
    return this.roleService.listPermissionCatalog()
  }

  listCustomRoles(principal: CloudPrincipal) {
    return this.roleService.listCustomRoles(principal)
  }

  createCustomRole(principal: CloudPrincipal, input: CreateCustomRoleRequest) {
    return this.roleService.createCustomRole(principal, input)
  }

  updateCustomRole(principal: CloudPrincipal, roleKey: string, input: UpdateCustomRoleRequest) {
    return this.roleService.updateCustomRole(principal, roleKey, input)
  }

  deleteCustomRole(principal: CloudPrincipal, roleKey: string) {
    return this.roleService.deleteCustomRole(principal, roleKey)
  }

  assignMemberRole(principal: CloudPrincipal, accountId: string, input: { roleKey: string | null }) {
    return this.roleService.assignMemberRole(principal, accountId, input)
  }

  resolveMemberPermissions(principal: CloudPrincipal, accountId: string) {
    return this.roleService.resolveMemberPermissions(principal, accountId)
  }

  getManagedPolicy(principal: CloudPrincipal) {
    return this.policyService.getManagedPolicy(principal)
  }

  setManagedPolicy(principal: CloudPrincipal, input: SetManagedPolicyRequest) {
    return this.policyService.setManagedPolicy(principal, input)
  }

  getEffectiveManagedPolicy(principal: CloudPrincipal) {
    return this.policyService.getEffectiveManagedPolicy(principal)
  }

  async listAuditEvents(
    principal: CloudPrincipal,
    input: { limit?: number | null } = {},
  ) {
    return this.overviewService.listAuditEvents(principal, input)
  }

  // Filterable, keyset-paginated audit query (#899). Gated on audit:read.
  queryAuditEvents(principal: CloudPrincipal, filters: AuditQueryFilters = {}): Promise<AuditQueryPage> {
    return this.auditService.queryAuditEvents(principal, filters)
  }

  // Streamed, redacted-by-default JSON/CSV export (#899). Unredacted mode is
  // org-admin-only and records its own audit event.
  exportAuditEvents(principal: CloudPrincipal, options: AuditExportOptions = {}): Promise<AuditExportStream> {
    return this.auditService.exportAuditEvents(principal, options)
  }

  // Fire-and-forget data-plane audit emission for callers outside this service
  // (e.g. the artifact service, which already holds a session-service handle).
  // Best-effort by construction: emitDataPlaneEvent never rejects on a write error.
  emitDataPlaneAuditEvent(input: DataPlaneAuditInput): void {
    void this.auditService.emitDataPlaneEvent(input)
  }

  // Build a data-plane audit input for a principal-driven action, resolving the
  // actor + org from the principal so call sites stay one line. Public so callers
  // that already hold a session-service handle (e.g. the artifact service) can
  // audit their own data-plane actions without re-plumbing the actor/org.
  auditPrincipalAction(
    principal: CloudPrincipal,
    event: {
      eventType: string
      targetType?: string | null
      targetId?: string | null
      result?: 'success' | 'failure' | 'denied'
      metadata?: Record<string, unknown>
    },
  ): void {
    this.emitDataPlaneAuditEvent({
      orgId: this.principalOrgId(principal),
      actor: this.auditActor(principal),
      ...event,
    })
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
    this.auditPrincipalAction(principal, {
      eventType: 'session.created',
      targetType: 'session',
      targetId: session.sessionId,
      metadata: { profileName, hasProjectSource: Boolean(projectSource) },
    })
    return this.getSessionView(principal, session.sessionId)
  }

  async createImportedSession(principal: CloudPrincipal, input: SessionImportRequest): Promise<CloudSessionView> {
    const view = await this.sessionImportService.createImportedSession(principal, input)
    this.auditPrincipalAction(principal, {
      eventType: 'session.imported',
      targetType: 'session',
      targetId: view.session.sessionId,
      metadata: { profileName: view.session.profileName },
    })
    return view
  }

  async completeSessionImport(
    principal: CloudPrincipal,
    sessionId: string,
    input: { sourceFingerprint: string, itemCounts: SessionImportItemCounts },
  ) {
    return this.sessionImportService.completeSessionImport(principal, sessionId, input)
  }

  async recordImportFailed(
    principal: CloudPrincipal,
    input: { sourceFingerprint: string, itemCounts?: Partial<SessionImportItemCounts>, sessionId?: string | null, error: unknown },
  ) {
    return this.sessionImportService.recordImportFailed(principal, input)
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
    await this.assertGatewayTokenCanReadSession(principal, sessionId)
    const projection = await this.store.getSessionProjection(principal.tenantId, sessionId)
    return {
      session: this.withProjectionProjectSource(session, projection),
      projection,
    }
  }

  private async assertGatewayTokenCanReadSession(principal: CloudPrincipal, sessionId: string) {
    if (!this.requiresGatewayChannelSessionScope(principal)) return
    const tokenId = principal.tokenId
    if (!tokenId) throw new CloudServiceError(403, 'Gateway session reads require a gateway API token.')
    const orgId = this.principalOrgId(principal)
    const grants = await this.store.listApiTokenChannelBindingGrants({ orgId, tokenId })
    const grantedBindingIds = new Set(grants.map((grant) => grant.channelBindingId))
    if (grantedBindingIds.size === 0) {
      throw new CloudServiceError(403, 'Gateway API token is not authorized for any channel bindings.')
    }
    const bindings = await this.store.listChannelSessionBindingsForSession(orgId, sessionId)
    if (!bindings.some((binding) => grantedBindingIds.has(binding.channelBindingId))) {
      throw new CloudServiceError(403, 'Gateway API token is not authorized for this channel session.')
    }
  }

  private requiresGatewayChannelSessionScope(principal: CloudPrincipal) {
    if (principal.authSource !== 'api_token') return false
    if (!principalHasPrivilegedTokenScope(principal, 'gateway')) return false
    return !principalHasTokenScope(principal, 'desktop')
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

  async upsertCloudArtifactIndex(principal: CloudPrincipal, input: Omit<UpsertCloudArtifactIndexInput, 'tenantId' | 'userId'>): Promise<CloudArtifactIndexRecord> {
    await this.ensurePrincipal(principal)
    await this.assertGatewayTokenCanReadSession(principal, input.sessionId)
    return this.store.upsertCloudArtifactIndex({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
    })
  }

  async getCloudArtifactIndexRecord(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
  ): Promise<CloudArtifactIndexRecord | null> {
    await this.ensurePrincipal(principal)
    await this.assertGatewayTokenCanReadSession(principal, sessionId)
    return this.store.getCloudArtifactIndexRecord({
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      artifactId,
    })
  }

  async listCloudArtifactIndex(
    principal: CloudPrincipal,
    input: Omit<ListCloudArtifactIndexInput, 'tenantId' | 'userId'> = {},
  ) {
    await this.ensurePrincipal(principal)
    if (input.sessionId) await this.assertGatewayTokenCanReadSession(principal, input.sessionId)
    return this.store.listCloudArtifactIndex({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
    })
  }

  async listCloudLaunchpadSessionSummaries(
    principal: CloudPrincipal,
    input: Omit<ListCloudLaunchpadSessionSummariesInput, 'tenantId' | 'userId'> = {},
  ): Promise<{
    items: CloudLaunchpadSessionSummaryRecord[]
    totalEstimate: number
    truncated: boolean
  }> {
    await this.ensurePrincipal(principal)
    return this.store.listCloudLaunchpadSessionSummaries({
      ...input,
      tenantId: principal.tenantId,
      userId: principal.userId,
    })
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
    return this.workflowOperations.listWorkflows(principal, input)
  }

  async getWorkflow(principal: CloudPrincipal, workflowId: string): Promise<WorkflowDetail | null> {
    return this.workflowOperations.getWorkflow(principal, workflowId)
  }

  async createWorkflow(principal: CloudPrincipal, draft: WorkflowDraft): Promise<WorkflowDetail> {
    return this.workflowOperations.createWorkflow(principal, draft)
  }

  async updateWorkflowStatus(
    principal: CloudPrincipal,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<WorkflowDetail | null> {
    return this.workflowOperations.updateWorkflowStatus(principal, workflowId, status)
  }

  async runWorkflow(
    principal: CloudPrincipal,
    workflowId: string,
    input: {
      triggerType?: WorkflowTriggerType
      triggerPayload?: Record<string, unknown> | null
    } = {},
  ): Promise<CloudWorkflowStartResult> {
    return this.workflowOperations.runWorkflow(principal, workflowId, input)
  }

  async claimAndStartDueWorkflow(now = new Date(), claimedBy?: string | null): Promise<CloudWorkflowStartResult | null> {
    return this.workflowOperations.claimAndStartDueWorkflow(now, claimedBy)
  }

  async runWorkflowWebhook(input: {
    workflowId: string
    auth: WorkflowWebhookAuth
    payload: Record<string, unknown>
    securityStore: WorkflowWebhookSecurityStore
    now?: Date
  }): Promise<CloudWorkflowStartResult> {
    return this.workflowOperations.runWorkflowWebhook(input)
  }

  async appendProductEvent(
    principal: CloudPrincipal,
    sessionId: string,
    input: {
      eventId?: string
      type: CloudProjectedSessionEventType
      payload?: Record<string, unknown>
      createdAt?: Date
    },
  ) {
    return this.usageOperations.appendProductEvent(principal, sessionId, input)
  }

  async assertArtifactUploadAllowed(principal: CloudPrincipal, bytes: number) {
    return this.usageOperations.assertArtifactUploadAllowed(principal, bytes)
  }

  async reserveArtifactUploadQuota(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    objectKey: string
    filename: string
    contentType: string | null
    expectedBytes: number
    expiresAt: string
  }) {
    return this.usageOperations.reserveArtifactUploadQuota(principal, input)
  }

  async getArtifactUploadReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
  }) {
    return this.usageOperations.getArtifactUploadReservation(principal, input)
  }

  async settleArtifactUploadQuotaReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    actualBytes: number
  }) {
    return this.usageOperations.settleArtifactUploadQuotaReservation(principal, input)
  }

  async releaseArtifactUploadQuotaReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    status: 'expired' | 'failed'
  }) {
    return this.usageOperations.releaseArtifactUploadQuotaReservation(principal, input)
  }

  async recordArtifactUploaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    return this.usageOperations.recordArtifactUploaded(principal, sessionId, artifactId, bytes)
  }

  async recordArtifactDownloaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    return this.usageOperations.recordArtifactDownloaded(principal, sessionId, artifactId, bytes)
  }

  async recordWorkerMinutes(input: {
    tenantId: string
    sessionId: string
    workerId: string
    elapsedMs: number
    reservedMinutes?: number
  }) {
    return this.usageOperations.recordWorkerMinutes(input)
  }

  async recordManagedWorkClaimed(input: {
    tenantId: string
    sessionId: string
    workerId: string
    leaseToken: string
  }) {
    const result = await this.usageGovernance.recordManagedWorkClaimed(input)
    // Worker lease claim (data-plane). Actor is the system/worker, not a principal;
    // resolve the org from the tenant. Best-effort — never blocks the claim.
    try {
      const orgId = await this.resolveOrgIdForTenant(input.tenantId)
      this.emitDataPlaneAuditEvent({
        orgId,
        actor: { actorType: 'system', actorId: input.workerId },
        eventType: 'worker.lease_claimed',
        targetType: 'session',
        targetId: input.sessionId,
        metadata: { result: 'success', workerId: input.workerId },
      })
    } catch {
      // Org resolution can fail for an orphaned tenant; the claim itself still stands.
    }
    return result
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
    return this.diagnosticsOperations.getDiagnosticsBundle(principal)
  }

  async listApiTokens(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<PublicApiTokenRecord[]> {
    return this.apiTokenOperations.listApiTokens(principal, input)
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
    return this.apiTokenOperations.issueApiToken(principal, input)
  }

  async revokeApiToken(principal: CloudPrincipal, tokenId: string): Promise<PublicApiTokenRecord | null> {
    return this.apiTokenOperations.revokeApiToken(principal, tokenId)
  }

  async grantApiTokenChannelBinding(
    principal: CloudPrincipal,
    tokenId: string,
    input: { channelBindingId: string },
  ): Promise<{ grant: { orgId: string, tokenId: string, channelBindingId: string, createdAt: string }, token: PublicApiTokenRecord }> {
    return this.apiTokenOperations.grantApiTokenChannelBinding(principal, tokenId, input)
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
    const command = await this.sessionExecution.enqueuePrompt(principal, sessionId, input)
    this.auditPrincipalAction(principal, {
      eventType: 'command.prompt',
      targetType: 'session',
      targetId: sessionId,
      metadata: { commandId: command.commandId, agent: input.agent || null },
    })
    return command
  }

  async enqueueAbort(principal: CloudPrincipal, sessionId: string): Promise<SessionCommandRecord> {
    const command = await this.sessionExecution.enqueueAbort(principal, sessionId)
    this.auditPrincipalAction(principal, {
      eventType: 'command.aborted',
      targetType: 'session',
      targetId: sessionId,
      metadata: { commandId: command.commandId },
    })
    return command
  }

  async enqueueQuestionReply(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionReplyPayload,
  ): Promise<SessionCommandRecord> {
    return this.sessionExecution.enqueueQuestionReply(principal, sessionId, payload)
  }

  async enqueueQuestionReject(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionRejectPayload,
  ): Promise<SessionCommandRecord> {
    return this.sessionExecution.enqueueQuestionReject(principal, sessionId, payload)
  }

  async enqueuePermissionResponse(
    principal: CloudPrincipal,
    sessionId: string,
    payload: PermissionRespondPayload,
  ): Promise<SessionCommandRecord> {
    const command = await this.sessionExecution.enqueuePermissionResponse(principal, sessionId, payload)
    this.auditPrincipalAction(principal, {
      eventType: 'command.permission_responded',
      targetType: 'session',
      targetId: sessionId,
      metadata: { commandId: command.commandId, permissionId: payload.permissionId },
    })
    return command
  }

  async executeCommand(
    lease: WorkerLeaseRecord,
    command: SessionCommandRecord,
    options: { signal?: AbortSignal, deferAck?: boolean } = {},
  ): Promise<void> {
    return this.sessionExecution.executeCommand(lease, command, options)
  }

  appendRuntimeEvent(input: {
    tenantId: string
    sessionId: string
    event: CloudRuntimeEvent
    leaseToken?: string | null
  }): Promise<SessionEventRecord> {
    return this.sessionExecution.appendRuntimeEvent(input)
  }

  private async appendProjectedEvent(input: AppendProjectedEventInput) {
    const event = await this.projections.appendProjectedEvent(input)
    this.dispatchCloudCoordinationWatchEvent(input, event)
    return event
  }

  private dispatchCloudCoordinationWatchEvent(input: AppendProjectedEventInput, event: SessionEventRecord) {
    this.coordinationDispatch.dispatchCloudCoordinationWatchEvent(input, event)
  }

  private deliverCloudCoordinationWatchEvent(event: CoordinationWatchEvent) {
    return this.coordinationDispatch.deliverCloudCoordinationWatchEvent(event)
  }

  private createCloudSessionRecord(input: CreateCloudSessionRecordInput): Promise<SessionRecord> {
    return this.sessionExecution.createCloudSessionRecord(input)
  }

  private principalOrgId(principal: CloudPrincipal) {
    return this.principalService.principalOrgId(principal)
  }

  private async principalIsActiveWorkspaceMember(principal: CloudPrincipal) {
    return this.principalService.principalIsActiveWorkspaceMember(principal)
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

  private assertOrgAdmin(principal: CloudPrincipal) {
    return this.principalService.assertOrgAdmin(principal)
  }

  private async assertBillingAllowed(input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) {
    // Legacy billing-config gate (unchanged): active only when billing is
    // explicitly configured. This is a WRITE-only helper — every caller is a
    // create/write path, so reads/exports/deletes/admin never reach here.
    if (this.billingConfig && isBillingConfigured(this.billingConfig)) {
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
    // Pluggable entitlements gate (#897). A no-op when the kill switch is off /
    // the provider is `none` (the default resolver never denies).
    await this.entitlements.assertAction(input.action, {
      orgId: input.orgId,
      profileName: input.profileName,
      providerId: input.providerId,
    })
  }

  // Read-only entitlement/plan status for the admin plane and the future Billing
  // UI (#896). Never gates; `gatingEnabled`/`billingEnabled` let the admin plane
  // decide whether to surface a Billing section.
  async describeEntitlements(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    return this.entitlements.describe({ orgId: this.principalOrgId(principal), profileName: this.policy.profileName })
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
    return this.principalService.auditActor(principal)
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

}
