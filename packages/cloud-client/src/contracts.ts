import type {
  ArtifactIndexPayload,
  ArtifactIndexEntry,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  CloudProjectSourceSummary,
  CloudProjectionFenceToken,
  CloudSessionProjectionRecord,
  CloudSessionEventType,
  CloudSessionViewRecord,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
  SessionImportRequest,
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
} from '@open-cowork/shared'

export type {
  ArtifactIndexPayload,
  ArtifactIndexEntry,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  CloudProjectSourceSummary,
  CloudProjectionFenceToken,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
  SessionImportRequest,
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
}

export type CloudClientSessionStatus = 'idle' | 'running' | 'closed' | 'errored'
export type CloudClientCommandKind = 'prompt' | 'abort' | 'permission.respond' | 'question.reply' | 'question.reject'
export type CloudClientCommandStatus = 'pending' | 'running' | 'acked' | 'failed'
export type CloudChannelProviderKind = 'telegram' | 'slack' | 'email' | 'discord' | 'whatsapp' | 'signal' | 'webhook' | 'cli'
export type CloudChannelProviderId = CloudChannelProviderKind | `${CloudChannelProviderKind}-${string}` | `${string}-${string}`
export type CloudChannelIdentityRole = 'owner' | 'admin' | 'member' | 'approver' | 'viewer'
export type CloudChannelIdentityStatus = 'active' | 'disabled' | 'pending'
export type CloudChannelDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead'
export type CloudChannelProviderEventType = 'message' | 'command' | 'interaction'
export type CloudChannelProviderEventStatus = 'received' | 'processing' | 'processed' | 'failed'
export type CloudByokSecretStatus = 'pending_validation' | 'active' | 'disabled' | 'expired' | 'invalid' | 'unsupported'

export type CloudByokSecretMetadata = {
  secretId: string
  providerId: string
  status: CloudByokSecretStatus
  credentialKind?: 'plaintext' | 'kms_ref'
  last4: string
  keyFingerprint: string
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export type CloudSetByokSecretInput = {
  plaintext?: string | null
  apiKey?: string | null
  key?: string | null
  secret?: string | null
  kmsRef?: string | null
}

export type HeadlessAgentRecord = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status: 'active' | 'disabled'
  managed: boolean
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  provider: CloudChannelProviderId
  externalWorkspaceId: string | null
  displayName: string
  status: 'active' | 'disabled' | 'auth_required' | 'error'
  credentialRefConfigured: boolean
  credentialRefKind: 'env' | 'gcp-secret-manager' | 'aws-secrets-manager' | 'azure-key-vault' | 'secret-ref' | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelIdentityRecord = {
  identityId: string
  orgId: string
  provider: CloudChannelProviderId
  externalWorkspaceId: string | null
  externalUserId: string
  accountId: string | null
  role: CloudChannelIdentityRole
  status: CloudChannelIdentityStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelSessionBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  channelBindingId: string
  provider: CloudChannelProviderId
  externalWorkspaceId: string | null
  externalThreadId: string
  externalChatId: string
  sessionId: string
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type ChannelCursorUpdateResult = { ok: true, binding: ChannelSessionBindingRecord } | { ok: false, reason: 'stale', binding: ChannelSessionBindingRecord } | { ok: false, reason: 'not_found' }

export type ChannelInteractionRecord = {
  interactionId: string
  orgId: string
  agentId: string
  sessionId: string
  provider: CloudChannelProviderId
  externalInteractionId: string | null
  tokenHash?: string
  kind: 'permission' | 'question'
  targetId: string
  status: 'pending' | 'used' | 'expired' | 'revoked'
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
  provider: CloudChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status: CloudChannelDeliveryStatus
  attemptCount: number
  claimedBy: string | null
  lastClaimedBy: string | null
  claimExpiresAt: string | null
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelProviderEventRecord = {
  eventId: string
  orgId: string
  provider: CloudChannelProviderId
  providerInstanceId: string
  externalWorkspaceId: string | null
  providerEventId: string
  eventType: CloudChannelProviderEventType
  status: CloudChannelProviderEventStatus
  claimedBy: string | null
  claimExpiresAt: string | null
  attemptCount: number
  retryable: boolean
  lastError: string | null
  metadata: Record<string, unknown>
  processedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelProviderEventClaimResult = {
  event: ChannelProviderEventRecord
  claimed: boolean
  duplicate: boolean
}

export type ChannelActorInput = {
  identityId?: string | null
  provider?: CloudChannelProviderId | null
  externalWorkspaceId?: string | null
  externalUserId?: string | null
}

export type SessionRecord = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  status: CloudClientSessionStatus
  title: string | null
  projectSource?: CloudProjectSourceSummary | null
  createdAt: string
  updatedAt: string
}

export type ListSessionsInput = {
  limit?: number | null
  cursor?: string | null
  status?: CloudClientSessionStatus | null
  profileName?: string | null
  query?: string | null
}

export type SessionListPage = {
  sessions: SessionRecord[]
  nextCursor: string | null
  totalEstimate: number
}

export type SessionCommandRecord = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: CloudClientCommandKind
  payload: Record<string, unknown>
  targetLeaseToken: string | null
  createdSequence: number
  createdAt: string
  status: CloudClientCommandStatus
  claimedBy: string | null
  claimedLeaseToken: string | null
  ackedAt: string | null
  error: string | null
}

export type SessionProjectionRecord = CloudSessionProjectionRecord

export type CloudSessionView = CloudSessionViewRecord<SessionRecord>

export type CloudRuntimeStatus = {
  role: string
  profileName: string
  canExecute: boolean
  commandProcessing: 'inline' | 'durable' | 'delegated'
  checkpoints: boolean
  heartbeats: unknown[]
}

export type CloudUsageEventRecord = {
  eventId: string
  orgId: string
  accountId: string | null
  eventType: string
  quantity: number
  unit: string
  metadata: Record<string, unknown>
  createdAt: string
}

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
  totalsScope?: 'recent_events'
  eventSampleLimit?: number
  events: CloudUsageEventRecord[]
  totals: CloudUsageTotalRecord[]
  quotas: CloudUsageQuotaWindowRecord[]
}

export type CloudWorkspaceOverview = {
  tenantId: string
  tenantName: string | null
  orgId: string
  orgName: string
  userId: string
  accountId: string
  email: string
  role: 'owner' | 'admin' | 'member'
  profileName: string
  policy: {
    features: Record<string, boolean>
    allowedAgents: string[] | null
    allowedTools: string[] | null
    allowedMcps: string[] | null
    localFiles: 'disabled'
    localStdioMcps: 'disabled'
    machineRuntimeConfig: 'disabled'
  }
}

export type CloudApiTokenScope = 'desktop' | 'gateway' | 'admin' | 'operator' | 'worker-internal'

export type CloudApiTokenRecord = {
  tokenId: string
  orgId: string
  accountId: string | null
  name: string
  scopes: CloudApiTokenScope[]
  channelBindingIds: string[]
  last4: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CloudIssuedApiTokenRecord = {
  token: CloudApiTokenRecord
  plaintext: string
}

export type CloudApiTokenChannelBindingGrantRecord = {
  orgId: string
  tokenId: string
  channelBindingId: string
  createdAt: string
}

export type CloudOrgMemberRecord = {
  orgId: string
  accountId: string
  email: string
  displayName: string | null
  role: 'owner' | 'admin' | 'member'
  status: 'active' | 'invited' | 'disabled'
  createdAt: string
  updatedAt: string
}

export type CloudAdminPolicyOverview = {
  org: {
    orgId: string
    tenantId: string
    name: string
    planKey: string | null
    status: string
  }
  signup: {
    mode: 'disabled' | 'closed' | 'invite' | 'domain' | 'open'
    allowSelfServiceSignup: boolean
    allowedEmailDomains: string[]
    invitesEnabled: boolean
  }
  profile: {
    name: string
    label: string | null
    description: string | null
  }
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  runtime: {
    configSource: 'app'
    machineRuntimeConfig: 'disabled' | 'allowlisted'
    localStdioMcps: 'disabled' | 'allowlisted'
    hostProjectDirectories: 'disabled' | 'allowlisted'
  }
  projectSources: Record<string, unknown>
  gateway: {
    channelsEnabled: boolean
    webhooksEnabled: boolean
  }
  byok?: {
    allowedProviderIds: string[] | null
    kmsRefsEnabled: boolean
    kmsRefPrefixesConfigured: boolean
    envRefsEnabled: boolean
  }
}

export type CloudAuditEventRecord = {
  eventId: string
  orgId: string
  actorType: string
  actorId: string
  accountId: string | null
  eventType: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type CloudBillingSubscriptionRecord = {
  orgId: string
  providerId: string
  providerCustomerId: string | null
  providerSubscriptionId: string | null
  planKey: string
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete'
  seats: number
  entitlements: Record<string, unknown>
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CloudBillingSubscriptionPayload = {
  enabled: boolean
  mode?: 'disabled' | 'self-host' | 'managed'
  providerId: string
  subscription: CloudBillingSubscriptionRecord | null
  entitlements: Record<string, unknown>
  active: boolean
  plans?: Array<{
    planKey: string
    label: string
    default: boolean
    entitlements: Record<string, unknown>
  }>
}

export type CloudDiagnosticsBundle = {
  generatedAt: string
  redaction: 'secrets-redacted'
  org: Record<string, unknown>
  runtime: Record<string, unknown>
  billing: CloudBillingSubscriptionPayload
  byok: {
    configuredProviders: number
    providers: CloudByokSecretMetadata[]
  }
  usage: CloudUsageSummary
  gateway: {
    agents: Record<string, number>
    bindingsByProvider: Record<string, number>
    deliveriesByStatus: Record<string, number>
    deliveriesByStatusScope?: 'recent_deliveries'
    deliverySampleLimit?: number
  }
  links: Record<string, string>
}

export type CloudBillingCheckoutResult = {
  providerId: string
  providerSessionId: string | null
  url: string
}

export type CloudBillingPortalResult = {
  providerId: string
  url: string
}

export type CloudTransportConfig = {
  role: string
  profileName: string
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
}

export type CloudTransportResponse<T> = {
  status: number
  body: T
}

export type CloudTransportFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'include'
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
}>

export type CloudTransportEventSource = new (
  url: string,
  init?: { withCredentials?: boolean },
) => {
  close(): void
  addEventListener(type: string, listener: (event: { data: string, lastEventId?: string }) => void): void
  onmessage: ((event: { data: string, lastEventId?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type CloudTransportAdapterOptions = {
  baseUrl?: string
  fetch?: CloudTransportFetch
  eventSource?: CloudTransportEventSource
  csrfToken?: string | null
  credentials?: 'include'
  headers?: Record<string, string>
  requestTimeoutMs?: number
  signal?: AbortSignal
}

export type CloudTransportSubscription = {
  close(): void
}

export type CloudTransportSessionEvent = {
  tenantId?: string
  sessionId?: string
  eventId: string
  sequence: number
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: CloudSessionEventType
  payload: Record<string, unknown>
  createdAt?: string
}

export type CloudTransportWorkspaceEvent = CloudTransportSessionEvent

export type CloudTransportSettingMetadata = {
  tenantId?: string
  userId?: string | null
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

export type CloudSessionCommandMutationResponse = {
  command: SessionCommandRecord
  processed: number
  view: CloudSessionView
  projectionFence?: CloudProjectionFenceToken | null
}

export type CloudSessionCommandAckResponse = {
  command: SessionCommandRecord
  processed: number
  projectionFence?: CloudProjectionFenceToken | null
}

export type CloudChannelPromptMutationResponse = {
  binding: ChannelSessionBindingRecord
  command: SessionCommandRecord
  processed: number
  projectionFence?: CloudProjectionFenceToken | null
}

export type CloudChannelInteractionMutationResponse = {
  interaction: ChannelInteractionRecord
  command: SessionCommandRecord
  processed: number
  projectionFence?: CloudProjectionFenceToken | null
}

export type CloudTransportAdapter = {
  getConfig(): Promise<CloudTransportConfig>
  getWorkspace(): Promise<CloudWorkspaceOverview>
  getRuntimeStatus(): Promise<CloudRuntimeStatus>
  listSessions(): Promise<SessionRecord[]>
  listSessionsPage?(input?: ListSessionsInput): Promise<SessionListPage>
  createSession(input?: { profileName?: string | null; projectSource?: CloudProjectSourceInput | null }): Promise<CloudSessionView>
  validateProjectSource(input: CloudProjectSourceInput): Promise<CloudProjectSourcePolicyVerdict>
  uploadProjectSnapshot(input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult>
  importSession(input: SessionImportRequest): Promise<CloudSessionView>
  getSession(sessionId: string): Promise<CloudSessionView>
  promptSession(sessionId: string, input: { text: string, agent?: string | null }): Promise<CloudSessionCommandMutationResponse>
  abortSession(sessionId: string): Promise<CloudSessionCommandMutationResponse>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<CloudSessionCommandAckResponse>
  rejectQuestion(sessionId: string, input: { requestId: string }): Promise<CloudSessionCommandAckResponse>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<CloudSessionCommandAckResponse>
  listWorkflows?(): Promise<WorkflowListPayload>
  getWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  runWorkflow?(workflowId: string, input?: { triggerType?: WorkflowTriggerType, triggerPayload?: Record<string, unknown> | null }): Promise<WorkflowRun | null>
  pauseWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  resumeWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  archiveWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  searchThreads?(query?: ThreadSearchQuery): Promise<ThreadSearchResult>
  threadFacets?(query?: ThreadSearchQuery): Promise<ThreadFacetSummary>
  listThreadTags?(): Promise<ThreadTag[]>
  createThreadTag?(input: ThreadTagInput): Promise<ThreadTag>
  updateThreadTag?(tagId: string, input: ThreadTagInput): Promise<ThreadTag | null>
  deleteThreadTag?(tagId: string): Promise<boolean>
  applyThreadTags?(sessionIds: string[], tagIds: string[]): Promise<boolean>
  removeThreadTags?(sessionIds: string[], tagIds: string[]): Promise<boolean>
  listThreadSmartFilters?(): Promise<ThreadSmartFilter[]>
  createThreadSmartFilter?(input: ThreadSmartFilterInput): Promise<ThreadSmartFilter>
  updateThreadSmartFilter?(filterId: string, input: ThreadSmartFilterInput): Promise<ThreadSmartFilter | null>
  deleteThreadSmartFilter?(filterId: string): Promise<boolean>
  listArtifacts?(sessionId: string): Promise<SessionArtifact[]>
  indexArtifacts?(query?: ArtifactIndexRequest): Promise<ArtifactIndexPayload>
  launchpadFeed?(query?: LaunchpadFeedRequest): Promise<LaunchpadFeedPayload>
  updateArtifactStatus?(input: ArtifactStatusUpdateRequest): Promise<SessionArtifact>
  uploadArtifact?(sessionId: string, input: Omit<SessionArtifactUploadRequest, 'sessionId' | 'workspaceId'>): Promise<SessionArtifact>
  readArtifactAttachment?(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
  listCapabilityTools?(): Promise<CapabilityTool[]>
  getCapabilityTool?(toolId: string): Promise<CapabilityTool | null>
  listCapabilitySkills?(): Promise<CapabilitySkill[]>
  getCapabilitySkillBundle?(skillName: string): Promise<CapabilitySkillBundle | null>
  readCapabilitySkillBundleFile?(skillName: string, filePath: string): Promise<string | null>
  listSettings?(): Promise<CloudTransportSettingMetadata[]>
  getSetting?(key: string): Promise<CloudTransportSettingMetadata | null>
  setSetting?(key: string, value: Record<string, unknown>): Promise<CloudTransportSettingMetadata>
  listByokSecrets?(): Promise<CloudByokSecretMetadata[]>
  getByokSecret?(providerId: string): Promise<CloudByokSecretMetadata | null>
  setByokSecret?(providerId: string, input: CloudSetByokSecretInput): Promise<CloudByokSecretMetadata>
  validateByokSecret?(providerId: string): Promise<CloudByokSecretMetadata | null>
  overrideByokSecretValidation?(providerId: string, input: { reason: string }): Promise<CloudByokSecretMetadata | null>
  deleteByokSecret?(providerId: string): Promise<CloudByokSecretMetadata | null>
  listUsageEvents?(limit?: number): Promise<CloudUsageEventRecord[]>
  getUsageSummary?(limit?: number): Promise<CloudUsageSummary>
  getDiagnosticsBundle?(): Promise<CloudDiagnosticsBundle>
  listApiTokens?(): Promise<CloudApiTokenRecord[]>
  issueApiToken?(input: {
    name: string
    scopes: CloudApiTokenScope[]
    expiresAt?: string | null
    channelBindingIds?: readonly string[] | null
  }): Promise<CloudIssuedApiTokenRecord>
  revokeApiToken?(tokenId: string): Promise<CloudApiTokenRecord | null>
  grantApiTokenChannelBinding?(tokenId: string, input: {
    channelBindingId: string
  }): Promise<{ grant: CloudApiTokenChannelBindingGrantRecord, token: CloudApiTokenRecord }>
  getAdminPolicy?(): Promise<CloudAdminPolicyOverview>
  listOrgMembers?(input?: { query?: string | null, limit?: number | null }): Promise<CloudOrgMemberRecord[]>
  inviteOrgMember?(input: { email: string, role?: 'owner' | 'admin' | 'member' | null }): Promise<CloudOrgMemberRecord>
  updateOrgMember?(accountId: string, input: {
    role?: 'owner' | 'admin' | 'member' | null
    status?: 'active' | 'invited' | 'disabled' | null
    confirm?: string | null
  }): Promise<CloudOrgMemberRecord>
  listAdminAuditEvents?(limit?: number): Promise<CloudAuditEventRecord[]>
  getBillingSubscription?(): Promise<CloudBillingSubscriptionPayload>
  createBillingCheckout?(input?: {
    planKey?: string | null
    successUrl?: string | null
    cancelUrl?: string | null
  }): Promise<CloudBillingCheckoutResult>
  createBillingPortal?(input?: { returnUrl?: string | null }): Promise<CloudBillingPortalResult>
  listHeadlessAgents?(): Promise<HeadlessAgentRecord[]>
  createHeadlessAgent?(input: {
    name: string
    profileName?: string | null
    status?: 'active' | 'disabled'
    managed?: boolean
    agentId?: string | null
  }): Promise<HeadlessAgentRecord>
  updateHeadlessAgent?(agentId: string, input: {
    name?: string
    profileName?: string
    status?: 'active' | 'disabled'
    managed?: boolean
  }): Promise<HeadlessAgentRecord | null>
  listChannelBindings?(agentId?: string | null): Promise<ChannelBindingRecord[]>
  createChannelBinding?(input: {
    agentId: string
    provider: CloudChannelProviderId
    displayName: string
    externalWorkspaceId?: string | null
    status?: 'active' | 'disabled' | 'auth_required' | 'error'
    credentialRef?: string | null
    settings?: Record<string, unknown>
    bindingId?: string | null
  }): Promise<ChannelBindingRecord>
  resolveChannelIdentity?(input: {
    provider: CloudChannelProviderId
    externalUserId: string
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
    identityId?: string | null
    accountId?: string | null
    role?: CloudChannelIdentityRole
    status?: CloudChannelIdentityStatus
    metadata?: Record<string, unknown>
  }): Promise<ChannelIdentityRecord>
  bindChannelSession?(input: ChannelActorInput & {
    channelBindingId: string
    provider: CloudChannelProviderId
    externalChatId: string
    externalThreadId: string
    sessionId?: string | null
    title?: string | null
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }>
  getChannelSessionByThread?(input: {
    provider: CloudChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null>
  promptChannelSession?(input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
    commandId?: string | null
  }): Promise<CloudChannelPromptMutationResponse>
  claimChannelProviderEvent?(input: {
    provider: CloudChannelProviderId
    providerInstanceId: string
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
    providerEventId: string
    eventType: CloudChannelProviderEventType
    claimedBy: string
    ttlMs?: number | null
    metadata?: Record<string, unknown>
  }): Promise<ChannelProviderEventClaimResult>
  completeChannelProviderEvent?(eventId: string, input: {
    channelBindingId?: string | null
    claimedBy: string
    status: Extract<CloudChannelProviderEventStatus, 'processed' | 'failed'>
    retryable?: boolean
    lastError?: string | null
  }): Promise<ChannelProviderEventRecord | null>
  updateChannelCursor?(input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelCursorUpdateResult>
  createChannelInteraction?(input: {
    agentId: string
    sessionId: string
    provider: CloudChannelProviderId
    kind: 'permission' | 'question'
    targetId: string
    externalInteractionId?: string | null
    createdByIdentityId?: string | null
    expiresAt?: string | null
    interactionId?: string | null
  }): Promise<IssuedChannelInteractionRecord>
  resolveChannelInteraction?(input: ChannelActorInput & {
    token?: string | null
    externalInteractionId?: string | null
    response?: unknown
    answers?: unknown[]
    reject?: boolean
  }): Promise<CloudChannelInteractionMutationResponse>
  createChannelDelivery?(input: {
    agentId: string
    channelBindingId: string
    sessionBindingId?: string | null
    provider: CloudChannelProviderId
    target: Record<string, unknown>
    eventType: string
    payload: Record<string, unknown>
    deliveryId?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord>
  ackChannelDelivery?(deliveryId: string, input: {
    claimedBy?: string | null
    status: Extract<CloudChannelDeliveryStatus, 'sent' | 'failed' | 'dead'>
    lastError?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord | null>
  listChannelDeliveries?(input?: {
    deliveryId?: string | null
    status?: CloudChannelDeliveryStatus | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<ChannelDeliveryRecord[]>
  retryChannelDelivery?(deliveryId: string): Promise<ChannelDeliveryRecord | null>
  deadLetterChannelDelivery?(deliveryId: string, input?: { lastError?: string | null }): Promise<ChannelDeliveryRecord | null>
  channelDeliveriesUrl?(input?: { claimedBy?: string, ttlMs?: number, channelBindingIds?: readonly string[] }): string
  subscribeChannelDeliveries?(input: {
    claimedBy?: string
    ttlMs?: number
    channelBindingIds?: readonly string[]
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError?: (error: unknown) => void
    onClose?: () => void
  }): CloudTransportSubscription
  workspaceEventsUrl(afterSequence?: number): string
  sessionEventsUrl(sessionId: string, afterSequence?: number): string
  subscribeWorkspaceEvents(input: {
    afterSequence?: number
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeSessionEvents(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription
}
