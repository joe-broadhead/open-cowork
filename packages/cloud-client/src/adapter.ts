import { CLOUD_SESSION_EVENT_TYPES } from '@open-cowork/shared'
import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
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
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
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

function cloudArtifactFilePath(artifactId: string, filename: string) {
  return `cloud-artifact://${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}`
}

function cloudArtifactIdFromFilePath(filePath: string) {
  const match = /^cloud-artifact:\/\/([^/]+)/.exec(filePath)
  return match ? decodeURIComponent(match[1]) : null
}

export type CloudClientSessionStatus = 'idle' | 'running' | 'closed' | 'errored'
export type CloudClientCommandKind = 'prompt' | 'abort' | 'permission.respond' | 'question.reply' | 'question.reject'
export type CloudClientCommandStatus = 'pending' | 'running' | 'acked' | 'failed'
export type CloudChannelProviderId = 'telegram' | 'slack' | 'email' | 'discord' | 'whatsapp' | 'signal' | 'webhook' | 'cli'
export type CloudChannelIdentityRole = 'owner' | 'admin' | 'member' | 'approver' | 'viewer'
export type CloudChannelIdentityStatus = 'active' | 'disabled' | 'pending'
export type CloudChannelDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead'
export type CloudByokSecretStatus = 'active' | 'disabled' | 'expired' | 'invalid'

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
  credentialRef: string | null
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
  claimExpiresAt: string | null
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
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

export type CloudApiTokenScope = 'desktop' | 'gateway' | 'admin' | 'worker-internal'

export type CloudApiTokenRecord = {
  tokenId: string
  orgId: string
  accountId: string | null
  name: string
  scopes: CloudApiTokenScope[]
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
    mode: 'closed' | 'invite' | 'domain' | 'open'
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

export type CloudTransportAdapter = {
  getConfig(): Promise<CloudTransportConfig>
  getWorkspace(): Promise<CloudWorkspaceOverview>
  getRuntimeStatus(): Promise<CloudRuntimeStatus>
  listSessions(): Promise<SessionRecord[]>
  createSession(input?: { profileName?: string | null; projectSource?: CloudProjectSourceInput | null }): Promise<CloudSessionView>
  validateProjectSource(input: CloudProjectSourceInput): Promise<CloudProjectSourcePolicyVerdict>
  uploadProjectSnapshot(input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult>
  importSession(input: SessionImportRequest): Promise<CloudSessionView>
  getSession(sessionId: string): Promise<CloudSessionView>
  promptSession(sessionId: string, input: { text: string, agent?: string | null }): Promise<{
    command: SessionCommandRecord
    processed: number
    view: CloudSessionView
  }>
  abortSession(sessionId: string): Promise<{ command: SessionCommandRecord, processed: number, view: CloudSessionView }>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  rejectQuestion(sessionId: string, input: { requestId: string }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
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
  deleteByokSecret?(providerId: string): Promise<CloudByokSecretMetadata | null>
  listUsageEvents?(limit?: number): Promise<CloudUsageEventRecord[]>
  getUsageSummary?(limit?: number): Promise<CloudUsageSummary>
  getDiagnosticsBundle?(): Promise<CloudDiagnosticsBundle>
  listApiTokens?(): Promise<CloudApiTokenRecord[]>
  issueApiToken?(input: {
    name: string
    scopes: CloudApiTokenScope[]
    expiresAt?: string | null
  }): Promise<CloudIssuedApiTokenRecord>
  revokeApiToken?(tokenId: string): Promise<CloudApiTokenRecord | null>
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
  }): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord, processed: number }>
  updateChannelCursor?(input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelSessionBindingRecord | null>
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
  }): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord, processed: number }>
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
    status?: CloudChannelDeliveryStatus | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<ChannelDeliveryRecord[]>
  retryChannelDelivery?(deliveryId: string): Promise<ChannelDeliveryRecord | null>
  deadLetterChannelDelivery?(deliveryId: string, input?: { lastError?: string | null }): Promise<ChannelDeliveryRecord | null>
  channelDeliveriesUrl?(input?: { claimedBy?: string, ttlMs?: number }): string
  subscribeChannelDeliveries?(input: {
    claimedBy?: string
    ttlMs?: number
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError?: (error: unknown) => void
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

type ApiErrorPayload = {
  error?: string
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  let normalized = baseUrl || ''
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function encodePath(value: string) {
  return encodeURIComponent(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeThreadTag(value: unknown): ThreadTag {
  const record = asRecord(value)
  const id = readString(record.id, readString(record.tagId))
  return {
    id,
    name: readString(record.name, 'Tag'),
    color: readString(record.color, '#64748b'),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadSmartFilter(value: unknown): ThreadSmartFilter {
  const record = asRecord(value)
  return {
    id: readString(record.id, readString(record.filterId)),
    name: readString(record.name, 'Smart filter'),
    query: asRecord(record.query) as ThreadSearchQuery,
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadStatus(value: unknown): ThreadListItem['status'] {
  if (value === 'running') return 'running'
  if (value === 'errored' || value === 'error') return 'error'
  return 'idle'
}

function normalizeThreadListItem(value: unknown): ThreadListItem {
  const record = asRecord(value)
  const tags = Array.isArray(record.tags) ? record.tags.map(normalizeThreadTag) : []
  return {
    sessionId: readString(record.sessionId),
    title: readString(record.title, 'New session'),
    directory: null,
    projectLabel: null,
    providerId: null,
    modelId: null,
    status: normalizeThreadStatus(record.status),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
    parentSessionId: null,
    workflowId: null,
    runId: null,
    revertedMessageId: null,
    tags,
    actualAgents: readNullableString(record.profileName) ? [{ name: readString(record.profileName), count: 1 }] : [],
    actualTools: [],
    suggestions: [],
    usage: {
      messages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    changeSummary: null,
  }
}

function normalizeThreadSearchResult(value: unknown): ThreadSearchResult {
  const record = asRecord(value)
  const threads = Array.isArray(record.threads) ? record.threads.map(normalizeThreadListItem) : []
  return {
    threads,
    nextCursor: readNullableString(record.nextCursor),
    totalEstimate: readNumber(record.totalEstimate, threads.length),
  }
}

function normalizeCloudArtifact(value: unknown, fallbackOrder = 0): SessionArtifact {
  const record = asRecord(value)
  const artifactId = readString(record.artifactId, readString(record.cloudArtifactId, readString(record.id)))
  const filename = readString(record.filename, 'artifact')
  return {
    id: artifactId,
    toolId: readString(record.toolId, 'cloud-artifact'),
    toolName: readString(record.toolName, 'cloud.artifact'),
    filePath: readString(record.filePath, cloudArtifactFilePath(artifactId, filename)),
    filename,
    order: readNumber(record.order, fallbackOrder),
    source: 'cloud',
    cloudArtifactId: artifactId,
    taskRunId: readNullableString(record.taskRunId),
    mime: readNullableString(record.mime) || readNullableString(record.contentType) || undefined,
    size: readNumber(record.size),
    createdAt: readNullableString(record.createdAt) || undefined,
  }
}

function normalizeCloudArtifactAttachment(value: unknown): SessionArtifactAttachment {
  const record = asRecord(value)
  const artifact = asRecord(record.artifact || record)
  const mime = readNullableString(artifact.contentType) || readNullableString(artifact.mime) || 'application/octet-stream'
  const dataBase64 = readString(artifact.dataBase64)
  return {
    mime,
    url: `data:${mime};base64,${dataBase64}`,
    filename: readString(artifact.filename, 'artifact'),
  }
}

function normalizeSettingMetadata(value: unknown): CloudTransportSettingMetadata | null {
  const record = asRecord(value)
  const key = readString(record.key)
  if (!key) return null
  return {
    tenantId: readNullableString(record.tenantId) || undefined,
    userId: readNullableString(record.userId),
    key,
    value: asRecord(record.value),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function eventUrl(baseUrl: string, sessionId: string, afterSequence = 0) {
  const path = `${baseUrl}/api/sessions/${encodePath(sessionId)}/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

function workspaceEventUrl(baseUrl: string, afterSequence = 0) {
  const path = `${baseUrl}/api/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

function channelDeliveriesUrl(baseUrl: string, input: { claimedBy?: string, ttlMs?: number } = {}) {
  return `${baseUrl}/api/channels/deliveries/stream${queryString(input)}`
}

function subscribeEventSource(
  EventSourceImpl: CloudTransportEventSource,
  url: string,
  input: {
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  },
) {
  const source = new EventSourceImpl(url, {
    withCredentials: input.credentials === 'include',
  })
  const onEvent = (event: { data: string }) => {
    const parsed = JSON.parse(event.data) as CloudTransportWorkspaceEvent
    input.onEvent(parsed)
  }
  source.onmessage = onEvent
  for (const type of CLOUD_SESSION_EVENT_TYPES) source.addEventListener(type, onEvent)
  source.onerror = (error) => input.onError?.(error)
  return {
    close() {
      source.close()
    },
  }
}

function subscribeFetchSse(
  fetcher: CloudTransportFetch,
  url: string,
  input: {
    headers?: Record<string, string>
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  },
) {
  const controller = new AbortController()
  let closed = false

  const dispatch = (dataLines: string[]) => {
    if (dataLines.length === 0) return
    const parsed = JSON.parse(dataLines.join('\n')) as CloudTransportWorkspaceEvent
    input.onEvent(parsed)
  }

  void (async () => {
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        ...(input.headers || {}),
        accept: 'text/event-stream',
      },
      credentials: input.credentials,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Cloud transport SSE subscription failed with HTTP ${response.status}: ${url}`)
    }
    if (!response.body) {
      throw new Error('Cloud transport SSE response did not include a readable stream.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let dataLines: string[] = []

    const processLine = (rawLine: string) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') {
        dispatch(dataLines)
        dataLines = []
        return
      }
      if (line.startsWith(':')) return
      const delimiter = line.indexOf(':')
      const field = delimiter === -1 ? line : line.slice(0, delimiter)
      const value = delimiter === -1
        ? ''
        : line.slice(delimiter + 1).replace(/^ /, '')
      if (field === 'data') dataLines.push(value)
    }

    try {
      while (!closed) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        let newlineIndex = buffered.indexOf('\n')
        while (newlineIndex >= 0) {
          processLine(buffered.slice(0, newlineIndex))
          buffered = buffered.slice(newlineIndex + 1)
          newlineIndex = buffered.indexOf('\n')
        }
      }
      buffered += decoder.decode()
      if (buffered) processLine(buffered)
      dispatch(dataLines)
    } finally {
      reader.releaseLock()
    }
  })().catch((error) => {
    if (!closed) input.onError?.(error)
  })

  return {
    close() {
      closed = true
      controller.abort()
    },
  }
}

function queryString(input: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry) params.append(key, entry)
      }
    } else if (typeof value === 'string' && value) {
      params.set(key, value)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      params.set(key, String(value))
    }
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

async function parseJson<T>(response: Awaited<ReturnType<CloudTransportFetch>>, url: string): Promise<T> {
  const text = await response.text()
  const body = text ? JSON.parse(text) as T & ApiErrorPayload : {} as T & ApiErrorPayload
  if (!response.ok) {
    throw new Error(body.error || `Cloud transport request failed with HTTP ${response.status}: ${url}`)
  }
  return body
}

export function createHttpSseCloudTransportAdapter(
  options: CloudTransportAdapterOptions = {},
): CloudTransportAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetcher = options.fetch || (globalThis.fetch as unknown as CloudTransportFetch)
  const headers = {
    ...(options.headers || {}),
  }

  async function request<T>(path: string, init: {
    method?: string
    body?: unknown
  } = {}) {
    const method = init.method || 'GET'
    const nextHeaders: Record<string, string> = {
      ...headers,
    }
    let body: string | undefined
    if (init.body !== undefined) {
      nextHeaders['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    if (method !== 'GET' && options.csrfToken) {
      nextHeaders['x-csrf-token'] = options.csrfToken
    }
    // This transport intentionally sends authenticated cloud API payloads, including
    // user-selected artifact uploads that callers validate and authorize upstream.
    // codeql[js/file-access-to-http]
    return parseJson<T>(await fetcher(`${baseUrl}${path}`, {
      method,
      headers: nextHeaders,
      body,
      credentials: options.credentials,
    }), path)
  }

  return {
    getConfig() {
      return request<CloudTransportConfig>('/api/config')
    },
    getWorkspace() {
      return request<CloudWorkspaceOverview>('/api/workspace')
    },
    getRuntimeStatus() {
      return request<CloudRuntimeStatus>('/api/runtime/status')
    },
    async listSessions() {
      return (await request<{ sessions: SessionRecord[] }>('/api/sessions')).sessions
    },
    createSession(input = {}) {
      return request<CloudSessionView>('/api/sessions', {
        method: 'POST',
        body: input,
      })
    },
    validateProjectSource(input) {
      return request<CloudProjectSourcePolicyVerdict>('/api/project-sources/validate', {
        method: 'POST',
        body: { projectSource: input },
      })
    },
    uploadProjectSnapshot(input) {
      return request<CloudProjectSnapshotUploadResult>('/api/project-sources/snapshots', {
        method: 'POST',
        body: input,
      })
    },
    importSession(input) {
      return request<CloudSessionView>('/api/import/sessions', {
        method: 'POST',
        body: input,
      })
    },
    getSession(sessionId) {
      return request<CloudSessionView>(`/api/sessions/${encodePath(sessionId)}`)
    },
    promptSession(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/prompt`, {
        method: 'POST',
        body: input,
      })
    },
    abortSession(sessionId) {
      return request(`/api/sessions/${encodePath(sessionId)}/abort`, {
        method: 'POST',
        body: {},
      })
    },
    replyToQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reply`, {
        method: 'POST',
        body: input,
      })
    },
    rejectQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reject`, {
        method: 'POST',
        body: input,
      })
    },
    respondToPermission(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/permission-respond`, {
        method: 'POST',
        body: input,
      })
    },
    listWorkflows() {
      return request<WorkflowListPayload>('/api/workflows')
    },
    async getWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}`)).workflow
    },
    async runWorkflow(workflowId, input = {}) {
      return (await request<{ run: WorkflowRun | null }>(`/api/workflows/${encodePath(workflowId)}/run`, {
        method: 'POST',
        body: input,
      })).run
    },
    async pauseWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/pause`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async resumeWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/resume`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async archiveWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/archive`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async searchThreads(query = {}) {
      const result = await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`)
      return normalizeThreadSearchResult(result)
    },
    async threadFacets(query = {}) {
      const result = normalizeThreadSearchResult(await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`))
      const tags = (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
      const tagCounts = new Map<string, { label: string, color?: string, count: number }>()
      for (const thread of result.threads) {
        for (const tag of thread.tags || []) {
          const existing = tagCounts.get(tag.id) || { label: tag.name, color: tag.color, count: 0 }
          existing.count += 1
          tagCounts.set(tag.id, existing)
        }
      }
      return {
        projects: [],
        providers: [],
        models: [],
        agents: [],
        tools: [],
        mcps: [],
        statuses: [],
        tags: tags.map((tag) => ({
          value: tag.id,
          label: tag.name,
          color: tag.color,
          count: tagCounts.get(tag.id)?.count || 0,
        })),
      }
    },
    async listThreadTags() {
      return (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
    },
    async createThreadTag(input) {
      return normalizeThreadTag((await request<{ tag: unknown }>('/api/threads/tags', {
        method: 'POST',
        body: input,
      })).tag)
    },
    async updateThreadTag(tagId, input) {
      const tag = (await request<{ tag: unknown | null }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'PATCH',
        body: input,
      })).tag
      return tag ? normalizeThreadTag(tag) : null
    },
    async deleteThreadTag(tagId) {
      return (await request<{ deleted: boolean }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'DELETE',
      })).deleted
    },
    async applyThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/apply`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async removeThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/remove`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async listThreadSmartFilters() {
      return (await request<{ filters: unknown[] }>('/api/threads/smart-filters')).filters.map(normalizeThreadSmartFilter)
    },
    async createThreadSmartFilter(input) {
      return normalizeThreadSmartFilter((await request<{ filter: unknown }>('/api/threads/smart-filters', {
        method: 'POST',
        body: input,
      })).filter)
    },
    async updateThreadSmartFilter(filterId, input) {
      const filter = (await request<{ filter: unknown | null }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'PATCH',
        body: input,
      })).filter
      return filter ? normalizeThreadSmartFilter(filter) : null
    },
    async deleteThreadSmartFilter(filterId) {
      return (await request<{ deleted: boolean }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'DELETE',
      })).deleted
    },
    async listArtifacts(sessionId) {
      return (await request<{ artifacts: unknown[] }>(`/api/sessions/${encodePath(sessionId)}/artifacts`))
        .artifacts
        .map((artifact, index) => normalizeCloudArtifact(artifact, index))
    },
    async uploadArtifact(sessionId, input) {
      return normalizeCloudArtifact((await request<{ artifact: unknown }>(`/api/sessions/${encodePath(sessionId)}/artifacts`, {
        method: 'POST',
        body: {
          filename: input.filename,
          contentType: input.contentType || null,
          dataBase64: input.dataBase64,
        },
      })).artifact)
    },
    async readArtifactAttachment(sessionId, filePathOrArtifactId) {
      const artifactId = cloudArtifactIdFromFilePath(filePathOrArtifactId) || filePathOrArtifactId.trim()
      if (!artifactId) throw new Error('Cloud artifact id is required.')
      return normalizeCloudArtifactAttachment(await request<{ artifact: unknown }>(
        `/api/sessions/${encodePath(sessionId)}/artifacts/${encodePath(artifactId)}`,
      ))
    },
    async listCapabilityTools() {
      return (await request<{ tools: CapabilityTool[] }>('/api/capabilities/tools')).tools
    },
    async getCapabilityTool(toolId) {
      const response = await request<{ tool: CapabilityTool }>(`/api/capabilities/tools/${encodePath(toolId)}`)
      return response.tool || null
    },
    async listCapabilitySkills() {
      return (await request<{ skills: CapabilitySkill[] }>('/api/capabilities/skills')).skills
    },
    async getCapabilitySkillBundle(skillName) {
      const response = await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)
      return response.bundle || null
    },
    async readCapabilitySkillBundleFile(skillName, filePath) {
      const bundle = (await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)).bundle
      const file = bundle?.files.find((entry) => entry.path === filePath) as { content?: unknown } | undefined
      return typeof file?.content === 'string' ? file.content : null
    },
    async listSettings() {
      return (await request<{ settings: unknown[] }>('/api/settings')).settings
        .map(normalizeSettingMetadata)
        .filter((setting): setting is CloudTransportSettingMetadata => Boolean(setting))
    },
    async getSetting(key) {
      const setting = normalizeSettingMetadata((await request<{ setting: unknown | null }>(`/api/settings/${encodePath(key)}`)).setting)
      return setting
    },
    async setSetting(key, value) {
      const setting = normalizeSettingMetadata((await request<{ setting: unknown }>(`/api/settings/${encodePath(key)}`, {
        method: 'PUT',
        body: { value },
      })).setting)
      if (!setting) throw new Error('Cloud setting response was invalid.')
      return setting
    },
    async listByokSecrets() {
      return (await request<{ secrets: CloudByokSecretMetadata[] }>('/api/byok')).secrets
    },
    async getByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(`/api/byok/${encodePath(providerId)}`)).secret
    },
    async setByokSecret(providerId, input) {
      return (await request<{ secret: CloudByokSecretMetadata }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'POST',
        body: input,
      })).secret
    },
    async validateByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(
        `/api/byok/${encodePath(providerId)}/validate`,
        { method: 'POST' },
      )).secret
    },
    async deleteByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'DELETE',
      })).secret
    },
    async listUsageEvents(limit) {
      return (await request<{ events: CloudUsageEventRecord[] }>(`/api/usage/events${queryString({ limit })}`)).events
    },
    getUsageSummary(limit) {
      return request<CloudUsageSummary>(`/api/usage/summary${queryString({ limit })}`)
    },
    getDiagnosticsBundle() {
      return request<CloudDiagnosticsBundle>('/api/diagnostics')
    },
    async listApiTokens() {
      return (await request<{ tokens: CloudApiTokenRecord[] }>('/api/api-tokens')).tokens
    },
    issueApiToken(input) {
      return request<CloudIssuedApiTokenRecord>('/api/api-tokens', {
        method: 'POST',
        body: input,
      })
    },
    async revokeApiToken(tokenId) {
      return (await request<{ token: CloudApiTokenRecord | null }>(`/api/api-tokens/${encodePath(tokenId)}`, {
        method: 'DELETE',
      })).token
    },
    async getAdminPolicy() {
      return (await request<{ policy: CloudAdminPolicyOverview }>('/api/admin/policy')).policy
    },
    async listOrgMembers(input = {}) {
      return (await request<{ members: CloudOrgMemberRecord[] }>(
        `/api/admin/members${queryString({ q: input.query, limit: input.limit })}`,
      )).members
    },
    async inviteOrgMember(input) {
      return (await request<{ member: CloudOrgMemberRecord }>('/api/admin/members', {
        method: 'POST',
        body: input,
      })).member
    },
    async updateOrgMember(accountId, input) {
      return (await request<{ member: CloudOrgMemberRecord }>(
        `/api/admin/members/${encodePath(accountId)}/update`,
        {
          method: 'POST',
          body: input,
        },
      )).member
    },
    async listAdminAuditEvents(limit) {
      return (await request<{ events: CloudAuditEventRecord[] }>(
        `/api/admin/audit${queryString({ limit })}`,
      )).events
    },
    getBillingSubscription() {
      return request<CloudBillingSubscriptionPayload>('/api/billing/subscription')
    },
    createBillingCheckout(input = {}) {
      return request<CloudBillingCheckoutResult>('/api/billing/checkout', {
        method: 'POST',
        body: input,
      })
    },
    createBillingPortal(input = {}) {
      return request<CloudBillingPortalResult>('/api/billing/portal', {
        method: 'POST',
        body: input,
      })
    },
    async listHeadlessAgents() {
      return (await request<{ agents: HeadlessAgentRecord[] }>('/api/channels/agents')).agents
    },
    async createHeadlessAgent(input) {
      return (await request<{ agent: HeadlessAgentRecord }>('/api/channels/agents', {
        method: 'POST',
        body: input,
      })).agent
    },
    async updateHeadlessAgent(agentId, input) {
      return (await request<{ agent: HeadlessAgentRecord | null }>(`/api/channels/agents/${encodePath(agentId)}`, {
        method: 'PATCH',
        body: input,
      })).agent
    },
    async listChannelBindings(agentId) {
      return (await request<{ bindings: ChannelBindingRecord[] }>(`/api/channels/bindings${queryString({ agentId })}`)).bindings
    },
    async createChannelBinding(input) {
      return (await request<{ binding: ChannelBindingRecord }>('/api/channels/bindings', {
        method: 'POST',
        body: input,
      })).binding
    },
    async resolveChannelIdentity(input) {
      return (await request<{ identity: ChannelIdentityRecord }>('/api/channels/identities/resolve', {
        method: 'POST',
        body: input,
      })).identity
    },
    bindChannelSession(input) {
      return request('/api/channels/sessions/bind', {
        method: 'POST',
        body: input,
      })
    },
    async getChannelSessionByThread(input) {
      try {
        return await request(`/api/channels/sessions/by-thread${queryString(input)}`)
      } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) return null
        throw error
      }
    },
    promptChannelSession(input) {
      return request('/api/channels/sessions/prompt', {
        method: 'POST',
        body: input,
      })
    },
    async updateChannelCursor(input) {
      return (await request<{ binding: ChannelSessionBindingRecord | null }>('/api/channels/cursor', {
        method: 'POST',
        body: input,
      })).binding
    },
    createChannelInteraction(input) {
      return request('/api/channels/interactions', {
        method: 'POST',
        body: input,
      })
    },
    resolveChannelInteraction(input) {
      return request('/api/channels/interactions/resolve', {
        method: 'POST',
        body: input,
      })
    },
    async createChannelDelivery(input) {
      return (await request<{ delivery: ChannelDeliveryRecord }>('/api/channels/deliveries', {
        method: 'POST',
        body: input,
      })).delivery
    },
    async ackChannelDelivery(deliveryId, input) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/ack`, {
        method: 'POST',
        body: input,
      })).delivery
    },
    async listChannelDeliveries(input = {}) {
      return (await request<{ deliveries: ChannelDeliveryRecord[] }>(`/api/channels/deliveries${queryString(input)}`)).deliveries
    },
    async retryChannelDelivery(deliveryId) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/retry`, {
        method: 'POST',
        body: {},
      })).delivery
    },
    async deadLetterChannelDelivery(deliveryId, input = {}) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/dead-letter`, {
        method: 'POST',
        body: input,
      })).delivery
    },
    channelDeliveriesUrl(input = {}) {
      return channelDeliveriesUrl(baseUrl, input)
    },
    subscribeChannelDeliveries(input) {
      const url = channelDeliveriesUrl(baseUrl, {
        claimedBy: input.claimedBy,
        ttlMs: input.ttlMs,
      })
      const onEvent = (event: unknown) => {
        const record = asRecord(event)
        const delivery = record.delivery
        if (delivery && typeof delivery === 'object') input.onDelivery(delivery as ChannelDeliveryRecord)
      }
      if (Object.keys(headers).length > 0) {
        return subscribeFetchSse(fetcher, url, {
          headers,
          credentials: options.credentials,
          onEvent,
          onError: input.onError,
        })
      }
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud delivery subscriptions.')
      return subscribeEventSource(EventSourceImpl, url, {
        credentials: options.credentials,
        onEvent,
        onError: input.onError,
      })
    },
    workspaceEventsUrl(afterSequence = 0) {
      return workspaceEventUrl(baseUrl, afterSequence)
    },
    sessionEventsUrl(sessionId, afterSequence = 0) {
      return eventUrl(baseUrl, sessionId, afterSequence)
    },
    subscribeWorkspaceEvents(input) {
      if (Object.keys(headers).length > 0) {
        return subscribeFetchSse(fetcher, workspaceEventUrl(baseUrl, input.afterSequence), {
          headers,
          credentials: options.credentials,
          onEvent: input.onEvent,
          onError: input.onError,
        })
      }
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
      return subscribeEventSource(EventSourceImpl, workspaceEventUrl(baseUrl, input.afterSequence), {
        credentials: options.credentials,
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
    subscribeSessionEvents(sessionId, input) {
      if (Object.keys(headers).length > 0) {
        return subscribeFetchSse(fetcher, eventUrl(baseUrl, sessionId, input.afterSequence), {
          headers,
          credentials: options.credentials,
          onEvent: input.onEvent,
          onError: input.onError,
        })
      }
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
      return subscribeEventSource(EventSourceImpl, eventUrl(baseUrl, sessionId, input.afterSequence), {
        credentials: options.credentials,
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
  }
}
