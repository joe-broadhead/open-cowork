import { createHash, randomUUID } from 'crypto'
import { cloudArtifactFilePath } from '@open-cowork/shared'
import type {
  CapabilitySkill,
  CapabilityTool,
  PendingApproval,
  PendingQuestion,
  SessionArtifact,
  SessionError,
  SessionTokens,
  TaskRun,
  TodoItem,
  ToolCall,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowStatus,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  getCapabilitySkillBundle,
  getCapabilityTool,
  listCapabilitySkills,
  listCapabilityTools,
} from '../capability-catalog.ts'
import { ControlPlaneQuotaExceededError } from './control-plane-store.ts'
import type {
  ApiTokenScope,
  BillingSubscriptionRecord,
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelIdentityRole,
  ChannelInteractionRecord,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  ControlPlaneStore,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  QuotaPolicyCode,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
  UsageEventRecord,
  WorkerLeaseRecord,
} from './control-plane-store.ts'
import {
  BillingAdapterError,
  evaluateBillingEntitlement,
  isBillingConfigured,
  resolvedBillingEntitlements,
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
import { evaluateCloudProjectDirectoryPolicy, type CloudRuntimePolicy } from './cloud-config.ts'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from './session-event-bus.ts'
import { computeNextWorkflowRunAt, validateWorkflowSchedule } from '../workflow/workflow-schedule.ts'
import {
  verifyWorkflowWebhookAuth,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '../workflow/workflow-webhook-server.ts'
import type { CloudAbuseConfig, CloudBillingConfig } from '../config-types.ts'

export type CloudPrincipal = {
  tenantId: string
  tenantName?: string
  userId: string
  email: string
  orgId?: string
  accountId?: string
  role?: 'owner' | 'admin' | 'member'
  authSource?: 'user' | 'api_token' | 'local' | 'header'
  tokenId?: string
  tokenScopes?: ApiTokenScope[]
}

export type ByokEntitlementVerdict = {
  allowed: boolean
  status?: number
  reason?: string | null
}

export type ByokEntitlementChecker = (input: {
  principal: CloudPrincipal
  orgId: string
  providerId: string
}) => Promise<ByokEntitlementVerdict> | ByokEntitlementVerdict

export type ByokRuntimeEntitlementChecker = (input: {
  orgId: string
  providerId: string
}) => Promise<ByokEntitlementVerdict> | ByokEntitlementVerdict

export type ByokKmsRefPolicy = {
  enabled?: boolean
  allowedPrefixes?: readonly string[] | null
  allowEnvRefs?: boolean
}

export type ByokManagementPolicy = {
  allowedProviderIds?: readonly string[] | null
  checkEntitlement?: ByokEntitlementChecker | null
  checkRuntimeEntitlement?: ByokRuntimeEntitlementChecker | null
  kmsRefs?: ByokKmsRefPolicy | null
}

export class CloudServiceError extends Error {
  readonly status: number
  readonly publicMessage: string
  readonly policyCode: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, message: string, details: {
    policyCode?: string | null
    retryAfterMs?: number | null
  } = {}) {
    super(message)
    this.status = status
    this.publicMessage = message
    this.policyCode = details.policyCode || null
    this.retryAfterMs = details.retryAfterMs || null
  }
}

export type CloudSessionMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export type CloudSessionProjectionView = {
  sessionId: string
  title: string
  status: 'idle' | 'running' | 'closed' | 'errored'
  profileName: string
  isGenerating: boolean
  messages: CloudSessionMessage[]
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  artifacts: SessionArtifact[]
  todos: TodoItem[]
  errors: SessionError[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  lastError: string | null
  updatedAt: string
}

export type CloudSessionView = {
  session: SessionRecord
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
}

export type CloudWorkflowStartResult = {
  tenantId: string
  workflow: WorkflowDetail
  run: WorkflowRun
  sessionId: string
  command: SessionCommandRecord
}

type AppendProjectedEventInput = {
  tenantId: string
  sessionId: string
  type: string
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

type PromptCommandPayload = {
  text: string
  agent: string
}

type QuestionReplyPayload = {
  requestId: string
  answers: unknown[]
}

type QuestionRejectPayload = {
  requestId: string
}

type PermissionRespondPayload = {
  permissionId: string
  response: unknown
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

const WORKFLOW_MAX_TEXT = 50_000
const WORKFLOW_TITLE_MAX_LENGTH = 512
const WORKFLOW_FIELD_MAX_LENGTH = 4096
const WORKFLOW_MAX_LIST_VALUES = 100
const WORKFLOW_VALID_TRIGGER_TYPES = new Set<WorkflowTriggerType>(['manual', 'schedule', 'webhook'])
const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DISABLED_ABUSE_POLICY: CloudAbuseConfig = {
  enabled: false,
  maxConcurrentSessionsPerOrg: null,
  maxActiveWorkersPerOrg: null,
  maxPromptsPerHour: null,
  maxGatewayDeliveriesPerHour: null,
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
const EMPTY_SESSION_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function channelRoleCanPrompt(role: ChannelIdentityRole) {
  return role === 'owner' || role === 'admin' || role === 'member'
}

function channelRoleCanApprove(role: ChannelIdentityRole) {
  return role === 'owner' || role === 'admin' || role === 'member' || role === 'approver'
}

function hasTokenScope(principal: CloudPrincipal, scope: ApiTokenScope) {
  return principal.tokenScopes?.includes(scope) || principal.tokenScopes?.includes('admin') || false
}

function stableCloudId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function principalCanManageChannels(principal: CloudPrincipal) {
  if (principal.authSource === 'local' || principal.authSource === 'header') return true
  if (principal.authSource === 'api_token') return hasTokenScope(principal, 'admin')
  return principal.role === 'owner' || principal.role === 'admin'
}

function principalCanManageByok(principal: CloudPrincipal) {
  if (principal.authSource === 'local' || principal.authSource === 'header') return true
  if (principal.authSource === 'api_token') return hasTokenScope(principal, 'admin')
  return principal.role === 'owner' || principal.role === 'admin'
}

function principalCanManageBilling(principal: CloudPrincipal) {
  if (principal.authSource === 'local' || principal.authSource === 'header') return true
  if (principal.authSource === 'api_token') return hasTokenScope(principal, 'admin')
  return principal.role === 'owner' || principal.role === 'admin'
}

function normalizeByokProviderIdForPolicy(value: string) {
  const providerId = value.trim().toLowerCase()
  if (!providerId || providerId.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new CloudServiceError(400, `Unsupported BYOK provider id ${providerId || '<empty>'}.`)
  }
  return providerId
}

function principalCanUseGatewayRoutes(principal: CloudPrincipal) {
  if (principal.authSource === 'local' || principal.authSource === 'header') return true
  if (principal.authSource === 'api_token') return hasTokenScope(principal, 'gateway')
  return principal.role === 'owner' || principal.role === 'admin'
}

function boundedText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function boundedOptionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, label, maxLength)
}

function normalizeWorkflowStringList(value: unknown, label: string) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return [...new Set(value.slice(0, WORKFLOW_MAX_LIST_VALUES).map((entry) => boundedText(entry, label, 256)))]
}

function readStatus(value: unknown): CloudSessionProjectionView['status'] | null {
  return value === 'idle' || value === 'running' || value === 'closed' || value === 'errored'
    ? value
    : null
}

function toMessage(value: unknown): CloudSessionMessage | null {
  const record = asRecord(value)
  const role = record.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null
  return {
    id: readString(record.id, randomUUID()),
    role,
    content: readString(record.content),
    createdAt: readString(record.createdAt, new Date().toISOString()),
  }
}

function normalizeSessionTokens(value: unknown): SessionTokens {
  const record = asRecord(value)
  const cache = asRecord(record.cache)
  return {
    input: readNumber(record.input),
    output: readNumber(record.output),
    reasoning: readNumber(record.reasoning),
    cacheRead: readNumber(record.cacheRead, readNumber(cache.read)),
    cacheWrite: readNumber(record.cacheWrite, readNumber(cache.write)),
  }
}

function addSessionTokens(current: SessionTokens, delta: SessionTokens): SessionTokens {
  return {
    input: current.input + delta.input,
    output: current.output + delta.output,
    reasoning: current.reasoning + delta.reasoning,
    cacheRead: current.cacheRead + delta.cacheRead,
    cacheWrite: current.cacheWrite + delta.cacheWrite,
  }
}

function normalizeToolStatus(value: unknown): ToolCall['status'] {
  return value === 'complete' || value === 'error' || value === 'running' ? value : 'running'
}

function normalizeTaskStatus(value: unknown): TaskRun['status'] {
  return value === 'queued' || value === 'running' || value === 'complete' || value === 'error'
    ? value
    : 'queued'
}

function toTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value)
  const content = readString(record.content)
  if (!content) return null
  return {
    content,
    status: readString(record.status, 'pending'),
    priority: readString(record.priority, 'medium'),
    ...(readNullableString(record.id) ? { id: readNullableString(record.id) || undefined } : {}),
  }
}

function normalizeTodos(value: unknown): TodoItem[] {
  return Array.isArray(value)
    ? value.map(toTodoItem).filter((entry): entry is TodoItem => Boolean(entry))
    : []
}

function normalizeToolCall(value: unknown): ToolCall | null {
  const record = asRecord(value)
  const id = readString(record.id)
  if (!id) return null
  return {
    id,
    name: readString(record.name, 'tool'),
    input: asRecord(record.input),
    status: normalizeToolStatus(record.status),
    ...(record.output !== undefined ? { output: record.output } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: record.attachments as ToolCall['attachments'] } : {}),
    agent: readNullableString(record.agent),
    sourceSessionId: readNullableString(record.sourceSessionId),
    order: readNumber(record.order),
  }
}

function normalizeTaskRun(value: unknown): TaskRun | null {
  const record = asRecord(value)
  const id = readString(record.id)
  if (!id) return null
  return {
    id,
    title: readString(record.title, 'Task'),
    agent: readNullableString(record.agent),
    status: normalizeTaskStatus(record.status),
    sourceSessionId: readNullableString(record.sourceSessionId),
    parentSessionId: readNullableString(record.parentSessionId),
    content: readString(record.content),
    transcript: Array.isArray(record.transcript) ? record.transcript as TaskRun['transcript'] : [],
    reasoning: Array.isArray(record.reasoning) ? record.reasoning as TaskRun['reasoning'] : undefined,
    toolCalls: Array.isArray(record.toolCalls)
      ? record.toolCalls.map(normalizeToolCall).filter((entry): entry is ToolCall => Boolean(entry))
      : [],
    compactions: Array.isArray(record.compactions) ? record.compactions as TaskRun['compactions'] : [],
    todos: normalizeTodos(record.todos),
    error: readNullableString(record.error),
    sessionCost: readNumber(record.sessionCost),
    sessionTokens: normalizeSessionTokens(record.sessionTokens),
    order: readNumber(record.order),
    startedAt: readNullableString(record.startedAt),
    finishedAt: readNullableString(record.finishedAt),
  }
}

function normalizeQuestionPrompt(value: unknown): PendingQuestion['questions'][number] | null {
  const record = asRecord(value)
  const question = readString(record.question)
  if (!question) return null
  return {
    header: readString(record.header),
    question,
    options: Array.isArray(record.options)
      ? record.options.map((option) => {
          const optionRecord = asRecord(option)
          return {
            label: readString(optionRecord.label),
            description: readString(optionRecord.description),
          }
        }).filter((option) => option.label || option.description)
      : [],
    multiple: record.multiple === true,
    custom: record.custom !== false,
  }
}

function normalizePendingQuestion(value: unknown): PendingQuestion | null {
  const record = asRecord(value)
  const id = readString(record.id)
  const sessionId = readString(record.sessionId)
  if (!id || !sessionId) return null
  const tool = asRecord(record.tool)
  return {
    id,
    sessionId,
    sourceSessionId: readNullableString(record.sourceSessionId),
    questions: Array.isArray(record.questions)
      ? record.questions.map(normalizeQuestionPrompt).filter((entry): entry is PendingQuestion['questions'][number] => Boolean(entry))
      : [],
    ...(Object.keys(tool).length > 0
      ? {
          tool: {
            messageId: readString(tool.messageId),
            callId: readString(tool.callId),
          },
        }
      : {}),
  }
}

function normalizePendingApproval(value: unknown): PendingApproval | null {
  const record = asRecord(value)
  const id = readString(record.id)
  const sessionId = readString(record.sessionId)
  if (!id || !sessionId) return null
  return {
    id,
    sessionId,
    taskRunId: readNullableString(record.taskRunId),
    tool: readString(record.tool, 'permission'),
    input: asRecord(record.input),
    description: readString(record.description, 'Permission requested'),
    order: readNumber(record.order),
  }
}

function normalizeSessionError(value: unknown): SessionError | null {
  const record = asRecord(value)
  const id = readString(record.id)
  const message = readString(record.message)
  if (!id || !message) return null
  return {
    id,
    sessionId: readNullableString(record.sessionId),
    message,
    order: readNumber(record.order),
  }
}

function normalizeSessionArtifact(value: unknown, fallbackOrder = 0): SessionArtifact | null {
  const record = asRecord(value)
  const artifactId = readString(record.artifactId, readString(record.cloudArtifactId, readString(record.id)))
  const filename = readString(record.filename, 'artifact')
  const filePath = readString(record.filePath, artifactId ? cloudArtifactFilePath(artifactId, filename) : '')
  if (!artifactId || !filePath) return null
  const size = readNumber(record.size, Number.NaN)
  return {
    id: artifactId,
    toolId: readString(record.toolId, 'cloud-artifact'),
    toolName: readString(record.toolName, 'cloud.artifact'),
    filePath,
    filename,
    order: readNumber(record.order, fallbackOrder),
    source: 'cloud',
    cloudArtifactId: artifactId,
    taskRunId: readNullableString(record.taskRunId),
    mime: readNullableString(record.mime) || readNullableString(record.contentType) || undefined,
    ...(Number.isFinite(size) ? { size } : {}),
    createdAt: readNullableString(record.createdAt) || undefined,
  }
}

function upsertById<T extends { id: string }>(entries: T[], incoming: T): T[] {
  const index = entries.findIndex((entry) => entry.id === incoming.id)
  if (index === -1) return [...entries, incoming]
  return entries.map((entry, entryIndex) => entryIndex === index
    ? (() => {
        const merged = { ...entry, ...incoming } as T
        if ('order' in entry && 'order' in merged) {
          ;(merged as T & { order: unknown }).order = (entry as T & { order: unknown }).order
        }
        return merged
      })()
    : entry)
}

function removeById<T extends { id: string }>(entries: T[], id: string): T[] {
  return entries.filter((entry) => entry.id !== id)
}

function projectionViewFromRecord(session: SessionRecord): CloudSessionProjectionView {
  return {
    sessionId: session.sessionId,
    title: session.title || 'New session',
    status: session.status,
    profileName: session.profileName,
    isGenerating: session.status === 'running',
    messages: [],
    toolCalls: [],
    taskRuns: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    todos: [],
    errors: [],
    sessionCost: 0,
    sessionTokens: { ...EMPTY_SESSION_TOKENS },
    lastInputTokens: 0,
    lastError: null,
    updatedAt: session.updatedAt,
  }
}

function normalizeProjectionView(value: unknown, session: SessionRecord): CloudSessionProjectionView {
  const record = asRecord(value)
  const messages = Array.isArray(record.messages)
    ? record.messages.map(toMessage).filter((entry): entry is CloudSessionMessage => Boolean(entry))
    : []
  return {
    ...projectionViewFromRecord(session),
    sessionId: readString(record.sessionId, session.sessionId),
    title: readString(record.title, session.title || 'New session'),
    status: readStatus(record.status) || session.status,
    profileName: readString(record.profileName, session.profileName),
    isGenerating: typeof record.isGenerating === 'boolean' ? record.isGenerating : session.status === 'running',
    messages,
    toolCalls: Array.isArray(record.toolCalls)
      ? record.toolCalls.map(normalizeToolCall).filter((entry): entry is ToolCall => Boolean(entry))
      : [],
    taskRuns: Array.isArray(record.taskRuns)
      ? record.taskRuns.map(normalizeTaskRun).filter((entry): entry is TaskRun => Boolean(entry))
      : [],
    pendingApprovals: Array.isArray(record.pendingApprovals)
      ? record.pendingApprovals.map(normalizePendingApproval).filter((entry): entry is PendingApproval => Boolean(entry))
      : [],
    pendingQuestions: Array.isArray(record.pendingQuestions)
      ? record.pendingQuestions.map(normalizePendingQuestion).filter((entry): entry is PendingQuestion => Boolean(entry))
      : [],
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.map((entry, index) => normalizeSessionArtifact(entry, index)).filter((entry): entry is SessionArtifact => Boolean(entry))
      : [],
    todos: normalizeTodos(record.todos),
    errors: Array.isArray(record.errors)
      ? record.errors.map(normalizeSessionError).filter((entry): entry is SessionError => Boolean(entry))
      : [],
    sessionCost: readNumber(record.sessionCost),
    sessionTokens: normalizeSessionTokens(record.sessionTokens),
    lastInputTokens: readNumber(record.lastInputTokens),
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    updatedAt: readString(record.updatedAt, session.updatedAt),
  }
}

function addMessage(
  view: CloudSessionProjectionView,
  message: CloudSessionMessage,
): CloudSessionProjectionView {
  if (view.messages.some((entry) => entry.id === message.id)) return view
  return {
    ...view,
    messages: [...view.messages, message],
  }
}

function eventPayloadId(payload: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = readString(payload[key])
    if (value) return value
  }
  return fallback
}

function workspaceOperationFromEventType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

function workspaceEntityForProjectedEvent(input: AppendProjectedEventInput, event: SessionEventRecord) {
  const payload = input.payload || {}
  if (input.type === 'artifact.created') {
    return {
      entityType: 'artifact',
      entityId: eventPayloadId(payload, ['artifactId', 'cloudArtifactId', 'id'], input.sessionId),
      operation: 'create',
      projectionVersion: event.sequence,
    }
  }
  return {
    entityType: 'session',
    entityId: input.sessionId,
    operation: workspaceOperationFromEventType(input.type),
    projectionVersion: event.sequence,
  }
}

function taskRunFromPayload(
  session: SessionRecord,
  payload: Record<string, unknown>,
  event: SessionEventRecord,
): TaskRun {
  const id = eventPayloadId(payload, ['taskRunId', 'id'], `${session.sessionId}:task:${event.sequence}`)
  return {
    id,
    title: readString(payload.title, readString(payload.taskTitle, 'Task')),
    agent: readNullableString(payload.agent),
    status: normalizeTaskStatus(payload.status),
    sourceSessionId: readNullableString(payload.sourceSessionId),
    parentSessionId: readNullableString(payload.parentSessionId),
    content: readString(payload.content),
    transcript: [],
    toolCalls: [],
    compactions: [],
    todos: [],
    error: readNullableString(payload.error),
    sessionCost: readNumber(payload.sessionCost),
    sessionTokens: normalizeSessionTokens(payload.sessionTokens),
    order: event.sequence,
    startedAt: readNullableString(payload.startedAt),
    finishedAt: readNullableString(payload.finishedAt),
  }
}

function toolCallFromPayload(
  session: SessionRecord,
  payload: Record<string, unknown>,
  event: SessionEventRecord,
): ToolCall {
  const id = eventPayloadId(payload, ['id', 'callId', 'toolCallId'], `${session.sessionId}:tool:${event.sequence}`)
  return {
    id,
    name: readString(payload.name, readString(payload.tool, 'tool')),
    input: asRecord(payload.input),
    status: normalizeToolStatus(payload.status),
    ...(payload.output !== undefined ? { output: payload.output } : {}),
    ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments as ToolCall['attachments'] } : {}),
    agent: readNullableString(payload.agent),
    sourceSessionId: readNullableString(payload.sourceSessionId),
    order: event.sequence,
  }
}

function withTaskRunToolCall(
  view: CloudSessionProjectionView,
  session: SessionRecord,
  taskRunId: string,
  toolCall: ToolCall,
  payload: Record<string, unknown>,
  event: SessionEventRecord,
): CloudSessionProjectionView {
  const existing = view.taskRuns.find((entry) => entry.id === taskRunId)
  const taskRun = existing || {
    ...taskRunFromPayload(session, {
      ...payload,
      id: taskRunId,
      status: 'running',
    }, event),
    toolCalls: [],
  }
  const updated: TaskRun = {
    ...taskRun,
    status: taskRun.status === 'queued' ? 'running' : taskRun.status,
    toolCalls: upsertById(taskRun.toolCalls, toolCall),
  }
  return {
    ...view,
    taskRuns: upsertById(view.taskRuns, updated),
  }
}

function pendingApprovalFromPayload(
  session: SessionRecord,
  payload: Record<string, unknown>,
  event: SessionEventRecord,
): PendingApproval {
  const id = eventPayloadId(payload, ['permissionId', 'id', 'requestId', 'requestID'], `${session.sessionId}:permission:${event.sequence}`)
  return {
    id,
    sessionId: session.sessionId,
    taskRunId: readNullableString(payload.taskRunId),
    tool: readString(payload.tool, 'permission'),
    input: asRecord(payload.input),
    description: readString(payload.description, readString(payload.tool, 'Permission requested')),
    order: event.sequence,
  }
}

function pendingQuestionFromPayload(
  session: SessionRecord,
  payload: Record<string, unknown>,
  event: SessionEventRecord,
): PendingQuestion {
  const id = eventPayloadId(payload, ['requestId', 'requestID', 'id'], `${session.sessionId}:question:${event.sequence}`)
  const tool = asRecord(payload.tool)
  return {
    id,
    sessionId: session.sessionId,
    sourceSessionId: readNullableString(payload.sourceSessionId),
    questions: Array.isArray(payload.questions)
      ? payload.questions.map(normalizeQuestionPrompt).filter((entry): entry is PendingQuestion['questions'][number] => Boolean(entry))
      : [],
    ...(Object.keys(tool).length > 0
      ? {
          tool: {
            messageId: readString(tool.messageId, readString(tool.messageID)),
            callId: readString(tool.callId, readString(tool.callID)),
          },
        }
      : {}),
  }
}

function costTokensFromPayload(payload: Record<string, unknown>): SessionTokens {
  return normalizeSessionTokens(payload.tokens)
}

function reduceProjectedEvent(
  session: SessionRecord,
  current: CloudSessionProjectionView,
  event: SessionEventRecord,
): CloudSessionProjectionView {
  const payload = asRecord(event.payload)
  const eventTime = event.createdAt
  switch (event.type) {
    case 'session.created':
      return {
        ...current,
        title: readString(payload.title, current.title),
        status: 'idle',
        isGenerating: false,
        lastError: null,
        updatedAt: eventTime,
      }
    case 'prompt.submitted':
      return addMessage({
        ...current,
        status: 'running',
        isGenerating: true,
        lastError: null,
        updatedAt: eventTime,
      }, {
        id: readString(payload.messageId, `${session.sessionId}:${event.sequence}:user`),
        role: 'user',
        content: readString(payload.text),
        createdAt: eventTime,
      })
    case 'assistant.message':
      return addMessage({
        ...current,
        status: current.status,
        isGenerating: current.isGenerating,
        lastError: null,
        updatedAt: eventTime,
      }, {
        id: readString(payload.messageId, `${session.sessionId}:${event.sequence}:assistant`),
        role: 'assistant',
        content: readString(payload.content),
        createdAt: eventTime,
      })
    case 'tool.call': {
      const toolCall = toolCallFromPayload(session, payload, event)
      const taskRunId = readNullableString(payload.taskRunId)
      const next = {
        ...current,
        status: 'running' as const,
        isGenerating: true,
        lastError: null,
        updatedAt: eventTime,
      }
      if (taskRunId) return withTaskRunToolCall(next, session, taskRunId, toolCall, payload, event)
      return {
        ...next,
        toolCalls: upsertById(next.toolCalls, toolCall),
      }
    }
    case 'task.run': {
      const taskRun = taskRunFromPayload(session, payload, event)
      return {
        ...current,
        taskRuns: upsertById(current.taskRuns, taskRun),
        updatedAt: eventTime,
      }
    }
    case 'permission.requested':
      return {
        ...current,
        status: 'running',
        isGenerating: false,
        pendingApprovals: upsertById(current.pendingApprovals, pendingApprovalFromPayload(session, payload, event)),
        updatedAt: eventTime,
      }
    case 'permission.resolved': {
      const permissionId = eventPayloadId(payload, ['permissionId', 'id', 'requestId', 'requestID'], '')
      return {
        ...current,
        pendingApprovals: permissionId ? removeById(current.pendingApprovals, permissionId) : current.pendingApprovals,
        isGenerating: false,
        updatedAt: eventTime,
      }
    }
    case 'question.asked':
      return {
        ...current,
        status: 'running',
        isGenerating: false,
        pendingQuestions: upsertById(current.pendingQuestions, pendingQuestionFromPayload(session, payload, event)),
        updatedAt: eventTime,
      }
    case 'question.resolved': {
      const questionId = eventPayloadId(payload, ['requestId', 'requestID', 'id'], '')
      return {
        ...current,
        pendingQuestions: questionId ? removeById(current.pendingQuestions, questionId) : current.pendingQuestions,
        isGenerating: false,
        updatedAt: eventTime,
      }
    }
    case 'todos.updated':
      return {
        ...current,
        todos: normalizeTodos(payload.todos),
        updatedAt: eventTime,
      }
    case 'cost.updated': {
      const tokens = costTokensFromPayload(payload)
      const cost = readNumber(payload.cost)
      const lastInputTokens = tokens.input > 0 ? tokens.input : current.lastInputTokens
      return {
        ...current,
        sessionCost: current.sessionCost + cost,
        sessionTokens: addSessionTokens(current.sessionTokens, tokens),
        lastInputTokens,
        updatedAt: eventTime,
      }
    }
    case 'artifact.created': {
      const artifact = normalizeSessionArtifact(payload, event.sequence)
      return {
        ...current,
        artifacts: artifact ? upsertById(current.artifacts, artifact) : current.artifacts,
        updatedAt: eventTime,
      }
    }
    case 'session.aborted':
      return {
        ...current,
        status: 'idle',
        isGenerating: false,
        updatedAt: eventTime,
      }
    case 'session.idle':
      return {
        ...current,
        status: 'idle',
        isGenerating: false,
        updatedAt: eventTime,
      }
    case 'session.status': {
      const statusType = readString(payload.statusType)
      const status = statusType === 'busy' || statusType === 'running'
        ? 'running'
        : statusType === 'idle'
          ? 'idle'
          : current.status
      return {
        ...current,
        status,
        isGenerating: status === 'running',
        updatedAt: eventTime,
      }
    }
    case 'runtime.error': {
      const message = readString(payload.message, 'Runtime command failed.')
      return {
        ...current,
        status: 'errored',
        isGenerating: false,
        lastError: message,
        errors: upsertById(current.errors, {
          id: eventPayloadId(payload, ['id', 'commandId'], `${session.sessionId}:error:${event.sequence}`),
          sessionId: session.sessionId,
          message,
          order: event.sequence,
        }),
        updatedAt: eventTime,
      }
    }
    default:
      return {
        ...current,
        updatedAt: eventTime,
      }
  }
}

function promptParts(text: string): CloudRuntimePromptPart[] {
  return [{ type: 'text', text }]
}

function includesAllowed(value: string | null | undefined, allowed: string[] | null) {
  return !allowed || Boolean(value && allowed.includes(value))
}

function toWorkflowSummary(record: CloudWorkflowRecord) {
  const { tenantId: _tenantId, userId: _userId, ...workflow } = record
  return workflow
}

function toWorkflowRun(record: CloudWorkflowRunRecord): WorkflowRun {
  const { tenantId: _tenantId, userId: _userId, ...run } = record
  return run
}

function workflowRunTerminal(status: WorkflowRun['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function workflowWebhookReplayKey(workflowId: string, auth: Extract<WorkflowWebhookAuth, { kind: 'signature' }>) {
  const workflowKey = createHash('sha256').update(workflowId).digest('hex').slice(0, 16)
  return `${workflowKey}:${auth.timestamp}:${auth.signature}`
}

function normalizePromptPayload(payload: Record<string, unknown>): PromptCommandPayload {
  return {
    text: readString(payload.text),
    agent: readString(payload.agent, 'build'),
  }
}

function normalizeQuestionReplyPayload(payload: Record<string, unknown>): QuestionReplyPayload {
  return {
    requestId: readString(payload.requestId),
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  }
}

function normalizeQuestionRejectPayload(payload: Record<string, unknown>): QuestionRejectPayload {
  return {
    requestId: readString(payload.requestId),
  }
}

function normalizePermissionPayload(payload: Record<string, unknown>): PermissionRespondPayload {
  return {
    permissionId: readString(payload.permissionId),
    response: payload.response ?? null,
  }
}

export class CloudSessionService {
  private readonly store: ControlPlaneStore
  private readonly runtime: CloudRuntimeAdapter
  private readonly policy: CloudRuntimePolicy
  private readonly events: CloudSessionEventBus
  private readonly workspaceEvents: CloudWorkspaceEventBus
  private readonly ids: { randomUUID: () => string }
  private readonly byokSecrets: ByokSecretStore | null
  private readonly byokPolicy: ByokManagementPolicy
  private readonly abuse: CloudAbuseConfig
  private readonly billingConfig: CloudBillingConfig | null
  private readonly billingAdapter: BillingAdapter | null

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
  ) {
    this.store = store
    this.runtime = runtime
    this.policy = policy
    this.events = events
    this.workspaceEvents = workspaceEvents
    this.ids = ids
    this.byokSecrets = byokSecrets
    this.byokPolicy = byokPolicy
    this.abuse = abuse
    this.billingConfig = billingConfig
    this.billingAdapter = billingAdapter
  }

  get eventBus() {
    return this.events
  }

  get workspaceEventBus() {
    return this.workspaceEvents
  }

  private quotaLimit(value: number | null | undefined) {
    if (!this.abuse.enabled) return null
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  }

  private quotaError(message: string, policyCode: QuotaPolicyCode | string, retryAfterMs: number | null) {
    return new CloudServiceError(429, message, { policyCode, retryAfterMs })
  }

  private translateQuotaError(error: unknown, fallbackMessage: string, fallbackPolicyCode: QuotaPolicyCode | string): never {
    if (error instanceof ControlPlaneQuotaExceededError) {
      throw this.quotaError(
        error.publicMessage || fallbackMessage,
        error.policyCode || fallbackPolicyCode,
        error.retryAfterMs,
      )
    }
    throw error
  }

  private async consumeQuota(input: {
    orgId: string
    quotaKey: string
    limit: number | null | undefined
    entitlementLimitKey?: 'maxPromptsPerHour' | 'maxGatewayDeliveriesPerHour' | 'maxArtifactBytesPerDay'
    quantity?: number
    windowMs: number
    policyCode: QuotaPolicyCode
    message: string
  }) {
    const limit = this.quotaLimit(await this.effectiveQuotaLimit(
      input.orgId,
      input.limit,
      input.entitlementLimitKey,
    ))
    if (!limit) return null
    const result = await this.store.consumeUsageQuota({
      orgId: input.orgId,
      quotaKey: input.quotaKey,
      limit,
      quantity: input.quantity,
      windowMs: input.windowMs,
      policyCode: input.policyCode,
    })
    if (!result.allowed) {
      throw this.quotaError(input.message, input.policyCode, result.retryAfterMs)
    }
    return result
  }

  private async effectiveQuotaLimit(
    orgId: string,
    fallback: number | null | undefined,
    key?: 'maxConcurrentSessionsPerOrg' | 'maxActiveWorkersPerOrg' | 'maxPromptsPerHour' | 'maxGatewayDeliveriesPerHour' | 'maxArtifactBytesPerDay',
  ) {
    if (!key || !this.billingConfig || !isBillingConfigured(this.billingConfig)) return fallback
    const subscription = await this.store.getBillingSubscription(orgId)
    if (!subscription) return fallback
    const entitlements = resolvedBillingEntitlements(this.billingConfig, subscription)
    const value = entitlements[key]
    return value === undefined ? fallback : value
  }

  private async recordUsage(input: {
    orgId: string
    accountId?: string | null
    eventType: UsageEventRecord['eventType']
    quantity?: number
    unit?: UsageEventRecord['unit']
    metadata?: Record<string, unknown>
  }) {
    if (!this.abuse.enabled) return null
    return this.store.recordUsageEvent(input)
  }

  async ensurePrincipal(principal: CloudPrincipal) {
    await this.store.createTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
    })
    const user = await this.store.ensureUser({
      tenantId: principal.tenantId,
      userId: principal.userId,
      email: principal.email,
      role: principal.role || 'member',
    })
    const org = await this.store.ensureOrgForTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
      orgId: principal.orgId,
    })
    const account = await this.store.createAccount({
      accountId: principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: account.accountId,
      email: account.email,
    })
    if (!membership) {
      await this.store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: principal.role || user.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'principal.bootstrap' },
      })
    } else if (membership.membership.status !== 'active') {
      throw new Error('Cloud membership is not active.')
    }
  }

  async createSession(principal: CloudPrincipal, input: { profileName?: string | null } = {}): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    if (!this.policy.features.chat) throw new Error('Chat is disabled for this cloud profile.')
    const profileName = input.profileName || this.policy.profileName
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
    })
    return this.getSessionView(principal, session.sessionId)
  }

  async listSessions(principal: CloudPrincipal): Promise<SessionRecord[]> {
    await this.ensurePrincipal(principal)
    return this.store.listSessions(principal.tenantId, principal.userId)
  }

  async getSessionView(principal: CloudPrincipal, sessionId: string): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return {
      session,
      projection: await this.store.getSessionProjection(principal.tenantId, sessionId),
    }
  }

  async listEvents(principal: CloudPrincipal, sessionId: string, afterSequence = 0): Promise<SessionEventRecord[]> {
    await this.getSessionView(principal, sessionId)
    return this.store.listSessionEvents(principal.tenantId, sessionId, afterSequence)
  }

  async listWorkspaceEvents(principal: CloudPrincipal, afterSequence = 0) {
    await this.ensurePrincipal(principal)
    return this.store.listWorkspaceEvents(principal.tenantId, principal.userId, afterSequence)
  }

  async listWorkerHeartbeats() {
    return this.store.listWorkerHeartbeats()
  }

  async listByokSecrets(principal: CloudPrincipal): Promise<ByokSecretMetadata[]> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    return this.requireByokSecrets().listMetadata(this.principalOrgId(principal))
  }

  async getByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const normalizedProviderId = await this.assertByokProviderAllowed(principal, providerId)
    return this.requireByokSecrets().getMetadata(this.principalOrgId(principal), normalizedProviderId)
  }

  async setByokSecret(
    principal: CloudPrincipal,
    input: { providerId: string, plaintext?: string | null, kmsRef?: string | null },
  ): Promise<ByokSecretMetadata> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const providerId = await this.assertByokProviderAllowed(principal, input.providerId)
    this.assertByokKmsRefAllowed(providerId, input.kmsRef)
    return this.requireByokSecrets().setSecret({
      orgId: this.principalOrgId(principal),
      providerId,
      plaintext: input.plaintext,
      kmsRef: input.kmsRef,
      createdByAccountId: principal.accountId || principal.userId,
      actor: this.byokAuditActor(principal),
    })
  }

  async disableByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const normalizedProviderId = await this.assertByokProviderAllowed(principal, providerId)
    return this.requireByokSecrets().disableSecret({
      orgId: this.principalOrgId(principal),
      providerId: normalizedProviderId,
      actor: this.byokAuditActor(principal),
    })
  }

  async validateByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const normalizedProviderId = await this.assertByokProviderAllowed(principal, providerId)
    return this.requireByokSecrets().validateActiveSecret({
      orgId: this.principalOrgId(principal),
      providerId: normalizedProviderId,
      actor: this.byokAuditActor(principal),
    })
  }

  async listHeadlessAgents(principal: CloudPrincipal): Promise<HeadlessAgentRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    return this.store.listHeadlessAgents(this.principalOrgId(principal))
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
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    return this.store.createHeadlessAgent({
      agentId: input.agentId || this.ids.randomUUID(),
      orgId: this.principalOrgId(principal),
      tenantId: principal.tenantId,
      profileName: input.profileName || this.policy.profileName,
      name: input.name,
      status: input.status,
      managed: input.managed,
      createdByAccountId: principal.accountId || principal.userId,
    })
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
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    return this.store.updateHeadlessAgent({
      orgId: this.principalOrgId(principal),
      agentId,
      name: input.name,
      profileName: input.profileName,
      status: input.status,
      managed: input.managed,
    })
  }

  async listChannelBindings(principal: CloudPrincipal, agentId?: string | null): Promise<ChannelBindingRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    return this.store.listChannelBindings(this.principalOrgId(principal), agentId)
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
  ): Promise<ChannelBindingRecord> {
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    const orgId = this.principalOrgId(principal)
    const agent = await this.store.getHeadlessAgent(orgId, input.agentId)
    if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
    return this.store.createChannelBinding({
      bindingId: input.bindingId || this.ids.randomUUID(),
      orgId,
      agentId: input.agentId,
      provider: input.provider,
      externalWorkspaceId: input.externalWorkspaceId,
      displayName: input.displayName,
      status: input.status,
      credentialRef: input.credentialRef,
      settings: input.settings,
    })
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
  ): Promise<ChannelBindingRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertChannelSetupAllowed(principal)
    return this.store.updateChannelBinding({
      orgId: this.principalOrgId(principal),
      bindingId,
      displayName: input.displayName,
      status: input.status,
      credentialRef: input.credentialRef,
      settings: input.settings,
    })
  }

  async resolveChannelIdentity(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      externalWorkspaceId?: string | null
      externalUserId: string
      identityId?: string | null
      accountId?: string | null
      role?: ChannelIdentityRecord['role']
      status?: ChannelIdentityRecord['status']
      metadata?: Record<string, unknown>
    },
  ): Promise<ChannelIdentityRecord> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const orgId = this.principalOrgId(principal)
    const existing = await this.store.findChannelIdentity({
      orgId,
      provider: input.provider,
      externalWorkspaceId: input.externalWorkspaceId,
      externalUserId: input.externalUserId,
    })
    const setupAllowed = principalCanManageChannels(principal)
    return this.store.upsertChannelIdentity({
      identityId: existing?.identityId || input.identityId || this.ids.randomUUID(),
      orgId,
      provider: input.provider,
      externalWorkspaceId: input.externalWorkspaceId,
      externalUserId: input.externalUserId,
      accountId: setupAllowed ? input.accountId : existing?.accountId,
      role: setupAllowed ? input.role || existing?.role || 'viewer' : existing?.role || 'viewer',
      status: setupAllowed ? input.status || existing?.status || 'pending' : existing?.status || 'pending',
      metadata: input.metadata || existing?.metadata || {},
    })
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
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const orgId = this.principalOrgId(principal)
    const channelBinding = await this.store.getChannelBinding(orgId, input.channelBindingId)
    if (!channelBinding) throw new CloudServiceError(404, 'Channel binding was not found.')
    if (channelBinding.status !== 'active') throw new CloudServiceError(403, 'Channel binding is not active.')
    if (channelBinding.provider !== input.provider) throw new CloudServiceError(400, 'Channel provider does not match binding.')
    const actor = await this.requireChannelActor(principal, input, 'prompt', {
      provider: channelBinding.provider,
      externalWorkspaceId: channelBinding.externalWorkspaceId,
    })
    const agent = await this.store.getHeadlessAgent(orgId, channelBinding.agentId)
    if (!agent || agent.status !== 'active') throw new CloudServiceError(403, 'Headless agent is not active.')

    const existing = await this.store.findChannelSessionBindingByThread({
      orgId,
      provider: input.provider,
      externalWorkspaceId: channelBinding.externalWorkspaceId,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    })
    if (existing) {
      if (existing.channelBindingId !== channelBinding.bindingId) {
        throw new CloudServiceError(409, 'Channel thread is already bound to a different channel binding.')
      }
      const owned = await this.store.getSession(principal.tenantId, principal.userId, existing.sessionId)
      if (!owned) throw new CloudServiceError(403, 'Channel session binding requires a session owned by the gateway principal.')
      return {
        binding: existing,
        session: {
          session: owned,
          projection: await this.store.getSessionProjection(principal.tenantId, existing.sessionId),
        },
      }
    }

    if (input.sessionId) {
      const owned = await this.store.getSession(principal.tenantId, principal.userId, input.sessionId)
      if (!owned) throw new CloudServiceError(403, 'Channel session binding requires a session owned by the gateway principal.')
    }
    const sessionId = input.sessionId || (await this.createCloudSessionRecord({
      tenantId: principal.tenantId,
      userId: principal.userId,
      profileName: agent.profileName,
      sessionId: stableCloudId(
        'channel_session',
        orgId,
        input.provider,
        channelBinding.externalWorkspaceId || '',
        input.externalChatId,
        input.externalThreadId,
      ),
      title: input.title || `Channel ${input.provider}`,
    })).sessionId
    const binding = await this.store.bindChannelSession({
      bindingId: this.ids.randomUUID(),
      orgId,
      agentId: agent.agentId,
      channelBindingId: channelBinding.bindingId,
      provider: input.provider,
      externalWorkspaceId: channelBinding.externalWorkspaceId,
      externalThreadId: input.externalThreadId,
      externalChatId: input.externalChatId,
      sessionId,
      lastEventSequence: input.lastEventSequence,
      lastWorkspaceSequence: input.lastWorkspaceSequence,
      lastChatMessageId: input.lastChatMessageId,
    })
    await this.store.recordAuditEvent({
      orgId,
      accountId: actor.accountId,
      actorType: 'api_token',
      actorId: principal.tokenId || principal.userId,
      eventType: 'channel_session.bound_by_identity',
      targetType: 'channel_session_binding',
      targetId: binding.bindingId,
      metadata: { identityId: actor.identityId, provider: actor.provider, sessionId },
    })
    return { binding, session: await this.getTenantSessionView(principal.tenantId, sessionId) }
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
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const binding = await this.store.findChannelSessionBindingByThread({
      orgId: this.principalOrgId(principal),
      provider: input.provider,
      externalWorkspaceId: input.externalWorkspaceId,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    })
    if (!binding) return null
    const session = await this.store.getSession(principal.tenantId, principal.userId, binding.sessionId)
    if (!session) throw new CloudServiceError(403, 'Channel thread lookup requires a session owned by the gateway principal.')
    return {
      binding,
      session: {
        session,
        projection: await this.store.getSessionProjection(principal.tenantId, binding.sessionId),
      },
    }
  }

  async updateChannelCursor(
    principal: CloudPrincipal,
    input: {
      bindingId: string
      lastEventSequence: number
      lastWorkspaceSequence: number
      lastChatMessageId?: string | null
    },
  ): Promise<ChannelSessionBindingRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    return this.store.updateChannelCursor({
      orgId: this.principalOrgId(principal),
      bindingId: input.bindingId,
      lastEventSequence: input.lastEventSequence,
      lastWorkspaceSequence: input.lastWorkspaceSequence,
      lastChatMessageId: input.lastChatMessageId,
    })
  }

  async enqueueChannelPrompt(
    principal: CloudPrincipal,
    input: ChannelActorInput & {
      bindingId: string
      text: string
      agent?: string | null
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord }> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const binding = await this.store.getChannelSessionBinding(this.principalOrgId(principal), input.bindingId)
    if (!binding || binding.status !== 'active') throw new CloudServiceError(404, 'Channel session binding was not found.')
    const channelBinding = await this.store.getChannelBinding(this.principalOrgId(principal), binding.channelBindingId)
    if (!channelBinding) throw new CloudServiceError(404, 'Channel binding was not found.')
    const actor = await this.requireChannelActor(principal, input, 'prompt', {
      provider: binding.provider,
      externalWorkspaceId: channelBinding.externalWorkspaceId,
    })
    const session = await this.store.getSession(principal.tenantId, principal.userId, binding.sessionId)
    if (!session) throw new CloudServiceError(403, 'Channel prompt requires a session owned by the gateway principal.')
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'prompt.enqueue',
      profileName: session.profileName,
    })
    await this.store.recordAuditEvent({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      actorType: 'api_token',
      actorId: principal.tokenId || principal.userId,
      eventType: 'channel_prompt.enqueued',
      targetType: 'session',
      targetId: binding.sessionId,
      metadata: { identityId: actor.identityId, provider: actor.provider },
    })
    await this.consumeQuota({
      orgId: this.principalOrgId(principal),
      quotaKey: 'prompts:hour',
      limit: this.abuse.maxPromptsPerHour,
      entitlementLimitKey: 'maxPromptsPerHour',
      windowMs: HOUR_MS,
      policyCode: 'quota.prompts_per_hour_exceeded',
      message: 'Cloud prompt quota exceeded.',
    })
    const command = await this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: session.userId,
      sessionId: binding.sessionId,
      kind: 'prompt',
      payload: {
        text: input.text,
        agent: input.agent || 'build',
      },
    })
    await this.recordUsage({
      orgId: this.principalOrgId(principal),
      accountId: actor.accountId,
      eventType: 'prompt.enqueued',
      unit: 'count',
      metadata: {
        tenantId: principal.tenantId,
        sessionId: binding.sessionId,
        source: 'gateway',
        provider: actor.provider,
      },
    })
    return { binding, command }
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
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const session = await this.store.getSession(principal.tenantId, principal.userId, input.sessionId)
    if (!session) throw new CloudServiceError(403, 'Channel interaction requires a session owned by the gateway principal.')
    const orgId = this.principalOrgId(principal)
    const agent = await this.store.getHeadlessAgent(orgId, input.agentId)
    if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
    return this.store.createChannelInteraction({
      interactionId: input.interactionId || this.ids.randomUUID(),
      orgId,
      agentId: agent.agentId,
      sessionId: input.sessionId,
      provider: input.provider,
      externalInteractionId: input.externalInteractionId,
      kind: input.kind,
      targetId: input.targetId,
      createdByIdentityId: input.createdByIdentityId,
      expiresAt: input.expiresAt || new Date(Date.now() + 10 * 60 * 1000),
      tokenSecret: input.tokenSecret || undefined,
    })
  }

  async resolveChannelInteraction(
    principal: CloudPrincipal,
    input: ChannelInteractionResolutionInput,
  ): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord }> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    const pendingInteraction = await this.store.findChannelInteraction({
      orgId: this.principalOrgId(principal),
      token: input.token,
      externalInteractionId: input.externalInteractionId,
      provider: input.provider,
    })
    if (!pendingInteraction) throw new CloudServiceError(404, 'Channel interaction was not found or is no longer pending.')
    const actor = await this.requireChannelActorForSession(principal, input, 'approve', pendingInteraction.sessionId, pendingInteraction.provider)
    const session = await this.store.getSession(principal.tenantId, principal.userId, pendingInteraction.sessionId)
    if (!session) throw new CloudServiceError(403, 'Channel interaction requires a session owned by the gateway principal.')
    const command = {
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: session.userId,
      sessionId: pendingInteraction.sessionId,
      kind: pendingInteraction.kind === 'permission'
        ? 'permission.respond' as const
        : input.reject
          ? 'question.reject' as const
          : 'question.reply' as const,
      payload: pendingInteraction.kind === 'permission'
        ? {
            permissionId: pendingInteraction.targetId,
            response: input.response ?? null,
          }
        : input.reject
          ? {
              requestId: pendingInteraction.targetId,
            }
          : {
              requestId: pendingInteraction.targetId,
              answers: Array.isArray(input.answers) ? input.answers : [],
            },
    }
    const resolved = await this.store.resolveChannelInteractionWithCommand({
      orgId: this.principalOrgId(principal),
      token: input.token,
      externalInteractionId: input.externalInteractionId,
      provider: input.provider,
      identityId: actor.identityId,
      command,
    })
    if (!resolved) throw new CloudServiceError(409, 'Channel interaction was already resolved.')
    return resolved
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
  ): Promise<ChannelDeliveryRecord> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    return this.store.createChannelDelivery({
      deliveryId: input.deliveryId || this.ids.randomUUID(),
      orgId: this.principalOrgId(principal),
      agentId: input.agentId,
      channelBindingId: input.channelBindingId,
      sessionBindingId: input.sessionBindingId,
      provider: input.provider,
      target: input.target,
      eventType: input.eventType,
      payload: input.payload,
      status: input.status,
      nextAttemptAt: input.nextAttemptAt || undefined,
    })
  }

  async claimNextChannelDelivery(
    principal: CloudPrincipal,
    input: { claimedBy: string, ttlMs?: number, now?: Date },
  ): Promise<ChannelDeliveryRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    try {
      const gatewayDeliveryLimit = await this.effectiveQuotaLimit(
        this.principalOrgId(principal),
        this.abuse.maxGatewayDeliveriesPerHour,
        'maxGatewayDeliveriesPerHour',
      )
      const delivery = await this.store.claimNextChannelDelivery({
        orgId: this.principalOrgId(principal),
        claimedBy: input.claimedBy,
        ttlMs: input.ttlMs,
        now: input.now,
        quota: this.quotaLimit(gatewayDeliveryLimit)
          ? {
              quotaKey: 'gateway_deliveries:hour',
              limit: gatewayDeliveryLimit!,
              windowMs: HOUR_MS,
              policyCode: 'quota.gateway_deliveries_per_hour_exceeded',
            }
          : null,
      })
      if (delivery) {
        await this.recordUsage({
          orgId: this.principalOrgId(principal),
          accountId: principal.accountId || null,
          eventType: 'gateway.delivery.claimed',
          unit: 'count',
          metadata: {
            deliveryId: delivery.deliveryId,
            provider: delivery.provider,
            claimedBy: input.claimedBy,
          },
        })
      }
      return delivery
    } catch (error) {
      this.translateQuotaError(error, 'Gateway delivery quota exceeded.', 'quota.gateway_deliveries_per_hour_exceeded')
    }
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
  ): Promise<ChannelDeliveryRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertGatewayAccess(principal)
    return this.store.ackChannelDelivery({
      orgId: this.principalOrgId(principal),
      deliveryId: input.deliveryId,
      claimedBy: input.claimedBy,
      status: input.status,
      lastError: input.lastError,
      nextAttemptAt: input.nextAttemptAt,
    })
  }

  async listSettingMetadata(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.listSettingMetadata(principal.tenantId, principal.userId)
  }

  async getSettingMetadata(principal: CloudPrincipal, key: string) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.getSettingMetadata(principal.tenantId, key, principal.userId)
  }

  async setSettingMetadata(
    principal: CloudPrincipal,
    input: { key: string, value: Record<string, unknown> },
  ) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.setSettingMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      key: input.key,
      value: input.value,
    })
  }

  async listCapabilityCatalog(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const [tools, skills] = await Promise.all([
      this.listCapabilityTools(principal),
      this.listCapabilitySkills(principal),
    ])
    return { tools, skills }
  }

  async listCapabilityTools(principal: CloudPrincipal): Promise<CapabilityTool[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilityTools())
      .map((tool) => this.filterCapabilityTool(tool))
      .filter((tool): tool is CapabilityTool => Boolean(tool))
  }

  async getCapabilityTool(principal: CloudPrincipal, toolId: string): Promise<CapabilityTool | null> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const tool = await getCapabilityTool(toolId)
    return tool ? this.filterCapabilityTool(tool) : null
  }

  async listCapabilitySkills(principal: CloudPrincipal): Promise<CapabilitySkill[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilitySkills())
      .map((skill) => this.filterCapabilitySkill(skill))
      .filter((skill): skill is CapabilitySkill => Boolean(skill))
  }

  async getCapabilitySkill(principal: CloudPrincipal, skillName: string): Promise<CapabilitySkill | null> {
    const skills = await this.listCapabilitySkills(principal)
    return skills.find((skill) => skill.name === skillName) || null
  }

  async getCapabilitySkillBundle(principal: CloudPrincipal, skillName: string) {
    const skill = await this.getCapabilitySkill(principal, skillName)
    if (!skill) return null
    return getCapabilitySkillBundle(skillName)
  }

  async listThreadTags(principal: CloudPrincipal): Promise<ThreadTagRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadTags(principal.tenantId)
  }

  async createThreadTag(
    principal: CloudPrincipal,
    input: { name: string, color?: string | null },
  ): Promise<ThreadTagRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadTag({
      tenantId: principal.tenantId,
      tagId: this.ids.randomUUID(),
      name: input.name,
      color: input.color,
    })
  }

  async updateThreadTag(
    principal: CloudPrincipal,
    tagId: string,
    input: { name?: string, color?: string | null },
  ): Promise<ThreadTagRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadTag({
      tenantId: principal.tenantId,
      tagId,
      name: input.name,
      color: input.color,
    })
  }

  async deleteThreadTag(principal: CloudPrincipal, tagId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadTag(principal.tenantId, tagId)
  }

  async applyThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.applyThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async removeThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.removeThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async listThreadMetadata(principal: CloudPrincipal, input: { tagIds?: string[], limit?: number } = {}) {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      tagIds: input.tagIds,
      limit: input.limit,
    })
  }

  async listThreadSmartFilters(principal: CloudPrincipal): Promise<ThreadSmartFilterRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadSmartFilters(principal.tenantId)
  }

  async createThreadSmartFilter(
    principal: CloudPrincipal,
    input: { name: string, query: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId: this.ids.randomUUID(),
      name: input.name,
      query: input.query,
    })
  }

  async updateThreadSmartFilter(
    principal: CloudPrincipal,
    filterId: string,
    input: { name?: string, query?: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId,
      name: input.name,
      query: input.query,
    })
  }

  async deleteThreadSmartFilter(principal: CloudPrincipal, filterId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadSmartFilter(principal.tenantId, filterId)
  }

  async listWorkflows(principal: CloudPrincipal): Promise<WorkflowListPayload> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflows = await this.store.listWorkflows(principal.tenantId, principal.userId)
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
    const normalized = this.normalizeWorkflowDraft(draft)
    this.assertWorkflowDraftAllowed(normalized)
    const now = new Date()
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
    const run = await this.store.createWorkflowRun({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      runId: this.ids.randomUUID(),
      triggerType,
      triggerPayload: input.triggerPayload || null,
    })
    return this.startWorkflowRun(workflow, run)
  }

  async claimAndStartDueWorkflow(now = new Date()): Promise<CloudWorkflowStartResult | null> {
    this.assertWorkflowsEnabled()
    const claimed = await this.store.claimDueWorkflowRun({
      runId: this.ids.randomUUID(),
      now,
    })
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
      const run = await this.store.createWorkflowRun({
        tenantId: workflow.tenantId,
        userId: workflow.userId,
        workflowId: workflow.id,
        runId: this.ids.randomUUID(),
        triggerType: 'webhook',
        triggerPayload: input.payload,
      })
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
      type: string
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
    await this.consumeQuota({
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
    await this.recordUsage({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      eventType: 'artifact.uploaded',
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
  }) {
    if (!this.abuse.enabled) return null
    const org = await this.store.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId })
    const minutes = Math.max(1, Math.ceil(input.elapsedMs / 60_000))
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

  async listUsageEvents(principal: CloudPrincipal, limit?: number) {
    await this.ensurePrincipal(principal)
    return this.store.listUsageEvents(this.principalOrgId(principal), limit)
  }

  async getBillingSubscription(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    const subscription = await this.store.getBillingSubscription(this.principalOrgId(principal))
    return {
      enabled: Boolean(this.billingConfig && isBillingConfigured(this.billingConfig)),
      providerId: this.billingAdapter?.providerId || this.billingConfig?.provider || 'none',
      subscription,
      entitlements: this.billingConfig ? resolvedBillingEntitlements(this.billingConfig, subscription) : {},
      active: this.billingConfig ? evaluateBillingEntitlement({
        config: this.billingConfig,
        subscription,
        action: 'session.create',
        profileName: this.policy.profileName,
      }).allowed : true,
    }
  }

  async createBillingCheckout(
    principal: CloudPrincipal,
    input: { planKey?: string | null, successUrl?: string | null, cancelUrl?: string | null },
  ): Promise<BillingCheckoutResult> {
    await this.ensurePrincipal(principal)
    this.assertBillingAdmin(principal)
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    const planKey = input.planKey || this.billingConfig.defaultPlanKey
    if (!this.billingConfig.plans[planKey]) throw new CloudServiceError(400, `Unknown billing plan "${planKey}".`)
    try {
      const result = await this.billingAdapter.createCheckoutSession({
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        email: principal.email,
        planKey,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      })
      if (result.subscription) await this.store.upsertBillingSubscription(result.subscription)
      await this.store.recordAuditEvent({
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        eventType: 'billing.checkout.created',
        targetType: 'billing_subscription',
        targetId: result.providerSessionId || planKey,
        metadata: { providerId: result.providerId, planKey },
      })
      return result
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
  }

  async createBillingPortal(
    principal: CloudPrincipal,
    input: { returnUrl?: string | null },
  ): Promise<BillingPortalResult> {
    await this.ensurePrincipal(principal)
    this.assertBillingAdmin(principal)
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    try {
      const subscription = await this.store.getBillingSubscription(this.principalOrgId(principal))
      return await this.billingAdapter.createPortalSession({
        orgId: this.principalOrgId(principal),
        email: principal.email,
        subscription,
        returnUrl: input.returnUrl,
      })
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
  }

  async handleBillingWebhook(input: {
    headers: Record<string, string | undefined>
    rawBody: string
    body: Record<string, unknown>
  }): Promise<BillingWebhookResult & { subscriptionRecord?: BillingSubscriptionRecord | null }> {
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    try {
      const result = await this.billingAdapter.handleWebhook(input)
      let subscriptionRecord: BillingSubscriptionRecord | null = null
      if (result.subscription) {
        subscriptionRecord = await this.store.upsertBillingSubscription(result.subscription)
        await this.store.recordAuditEvent({
          eventId: `billing_${result.providerId}_${result.eventId}`,
          orgId: result.subscription.orgId,
          actorType: 'system',
          actorId: `billing.${result.providerId}`,
          eventType: 'billing.webhook.processed',
          targetType: 'billing_subscription',
          targetId: result.subscription.providerSubscriptionId || result.subscription.orgId,
          metadata: {
            providerId: result.providerId,
            eventType: result.eventType,
            planKey: result.subscription.planKey,
            status: result.subscription.status,
          },
        })
      }
      return {
        ...result,
        subscriptionRecord,
      }
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
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
      throw this.quotaError('Too many cloud requests. Try again later.', 'rate_limit.http_exceeded', result.retryAfterMs)
    }
    return result
  }

  async checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }) {
    if (!this.abuse.enabled || !this.abuse.authBackoff.enabled) return null
    const result = await this.store.checkCloudAuthBackoff(input)
    if (!result.allowed) {
      throw this.quotaError('Too many rejected cloud authentication attempts. Try again later.', 'auth.backoff', result.retryAfterMs)
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
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'prompt.enqueue',
      profileName: view.session.profileName,
    })
    await this.consumeQuota({
      orgId: this.principalOrgId(principal),
      quotaKey: 'prompts:hour',
      limit: this.abuse.maxPromptsPerHour,
      entitlementLimitKey: 'maxPromptsPerHour',
      windowMs: HOUR_MS,
      policyCode: 'quota.prompts_per_hour_exceeded',
      message: 'Cloud prompt quota exceeded.',
    })
    const commandId = this.ids.randomUUID()
    const command = await this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'prompt',
      payload: {
        text: input.text,
        agent: input.agent || 'build',
      },
    })
    await this.recordUsage({
      orgId: this.principalOrgId(principal),
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
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
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
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
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
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'permission.respond',
      payload,
    })
  }

  async executeCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord): Promise<void> {
    try {
      switch (command.kind) {
        case 'prompt':
          await this.executePromptCommand(lease, command)
          break
        case 'abort':
          await this.executeAbortCommand(lease, command)
          break
        case 'question.reply':
          await this.executeQuestionReplyCommand(lease, command)
          break
        case 'question.reject':
          await this.executeQuestionRejectCommand(lease, command)
          break
        case 'permission.respond':
          await this.executePermissionCommand(lease, command)
          break
        default: {
          const unsupported: never = command.kind
          throw new Error(`Unsupported command kind ${String(unsupported)}.`)
        }
      }
      await this.store.ackSessionCommand(lease, command.commandId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.appendProjectedEvent({
        tenantId: command.tenantId,
        sessionId: command.sessionId,
        type: 'runtime.error',
        payload: { commandId: command.commandId, message },
        leaseToken: lease.leaseToken,
      })
      await this.failWorkflowRunForSession(command.tenantId, command.sessionId, message)
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
    })
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async executePromptCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizePromptPayload(command.payload)
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    const runtimeSessionId = await this.ensureRuntimeSessionBound(lease)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'running',
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
    const result = await this.runtime.promptSession({
      sessionId: runtimeSessionId,
      parts: promptParts(payload.text),
      agent: payload.agent,
      context: this.runtimeContext(session),
    })
    for (const event of result?.events || []) {
      await this.applyRuntimeEvent(lease, command.sessionId, event)
    }
    await this.completeWorkflowRunForSession(
      command.tenantId,
      command.sessionId,
      this.workflowSummaryFromRuntimeEvents(result?.events || []),
    )
  }

  private async executeAbortCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    if (session.opencodeSessionId) {
      await this.runtime.abortSession({
        sessionId: session.opencodeSessionId,
        context: this.runtimeContext(session),
      })
    }
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'idle',
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

  private async executeQuestionReplyCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizeQuestionReplyPayload(command.payload)
    if (!payload.requestId) throw new Error('Question reply requires a request id.')
    if (!this.runtime.replyToQuestion) throw new Error('OpenCode question replies are not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.replyToQuestion({
      requestId: payload.requestId,
      answers: payload.answers,
      context: this.runtimeContext(session),
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executeQuestionRejectCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizeQuestionRejectPayload(command.payload)
    if (!payload.requestId) throw new Error('Question rejection requires a request id.')
    if (!this.runtime.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.rejectQuestion({
      requestId: payload.requestId,
      context: this.runtimeContext(session),
    })
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

  private async executePermissionCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
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
    })
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
    const event = await this.store.appendSessionEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload || {},
      createdAt: input.createdAt,
    })
    const session = await this.requireSessionRecord(input.tenantId, input.sessionId)
    const workspaceEntity = workspaceEntityForProjectedEvent(input, event)
    const workspaceEvent = await this.store.appendWorkspaceEvent({
      tenantId: input.tenantId,
      userId: session.userId,
      sessionId: input.sessionId,
      eventId: event.eventId.startsWith(`${input.sessionId}:`)
        ? event.eventId
        : `${input.sessionId}:${event.eventId}`,
      ...workspaceEntity,
      type: input.type,
      payload: input.payload || {},
      createdAt: new Date(event.createdAt),
    })
    const currentProjection = await this.store.getSessionProjection(input.tenantId, input.sessionId)
    const currentView = normalizeProjectionView(currentProjection?.view, session)
    const nextView = reduceProjectedEvent(session, currentView, event)
    await this.store.writeSessionProjection({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: event.sequence,
      view: nextView,
      leaseToken: input.leaseToken,
      updatedAt: new Date(event.createdAt),
    })
    this.events.publish(event)
    this.workspaceEvents.publish(workspaceEvent)
    return event
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
      const concurrentSessionLimit = await this.effectiveQuotaLimit(
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
        quota: this.quotaLimit(concurrentSessionLimit)
          ? {
              orgId: input.orgId || input.tenantId,
              maxConcurrentSessionsPerOrg: concurrentSessionLimit,
              policyCode: 'quota.concurrent_sessions_exceeded',
            }
          : null,
      })
      await this.recordUsage({
        orgId: input.orgId || input.tenantId,
        accountId: input.accountId || input.userId,
        eventType: 'session.created',
        unit: 'count',
        metadata: { tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId },
      })
      return session
    } catch (error) {
      this.translateQuotaError(error, 'Concurrent cloud session quota exceeded.', 'quota.concurrent_sessions_exceeded')
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

    if (this.shouldCreateRuntimeSessionsEagerly() && !this.quotaLimit(this.abuse.maxConcurrentSessionsPerOrg)) {
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
      updatedAt: new Date(runtimeSession.updatedAt),
    })
    await this.appendProjectedEvent({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      type: 'session.runtime.bound',
      payload: {
        opencodeSessionId: runtimeSession.id,
      },
      leaseToken: lease.leaseToken,
      createdAt: new Date(runtimeSession.updatedAt),
    })
    return runtimeSession.id
  }

  private async workflowDetail(workflow: CloudWorkflowRecord): Promise<WorkflowDetail> {
    return {
      ...toWorkflowSummary(workflow),
      runs: (await this.store.listWorkflowRuns(workflow.tenantId, workflow.id, 25)).map(toWorkflowRun),
    }
  }

  private normalizeWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
    const triggers = this.normalizeWorkflowTriggers(draft.triggers)
    if (!triggers.some((trigger) => trigger.type === 'manual')) {
      triggers.unshift({ id: this.ids.randomUUID(), type: 'manual', enabled: true })
    }
    return {
      title: boundedText(draft.title, 'Workflow title', WORKFLOW_TITLE_MAX_LENGTH),
      instructions: boundedText(draft.instructions, 'Workflow instructions', WORKFLOW_MAX_TEXT),
      agentName: boundedText(draft.agentName || 'build', 'Workflow agent', 256),
      skillNames: normalizeWorkflowStringList(draft.skillNames, 'Workflow skillNames'),
      toolIds: normalizeWorkflowStringList(draft.toolIds, 'Workflow toolIds'),
      projectDirectory: boundedOptionalText(draft.projectDirectory, 'Workflow projectDirectory', WORKFLOW_FIELD_MAX_LENGTH),
      draftSessionId: boundedOptionalText(draft.draftSessionId, 'Workflow draftSessionId', 256),
      triggers,
    }
  }

  private normalizeWorkflowTriggers(value: unknown): WorkflowTrigger[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('Workflow requires at least one trigger.')
    }
    return value.slice(0, 8).map((entry) => {
      const trigger = asRecord(entry)
      const type = readString(trigger.type) as WorkflowTriggerType
      if (!WORKFLOW_VALID_TRIGGER_TYPES.has(type)) throw new Error('Workflow trigger type is invalid.')
      const normalized: WorkflowTrigger = {
        id: readString(trigger.id, this.ids.randomUUID()),
        type,
        enabled: trigger.enabled !== false,
        schedule: null,
        webhookSecret: null,
      }
      if (type === 'schedule') {
        const schedule = asRecord(trigger.schedule) as unknown as WorkflowTrigger['schedule']
        if (!schedule) throw new Error('Scheduled workflow trigger requires a schedule.')
        const scheduleError = validateWorkflowSchedule(schedule)
        if (scheduleError) throw new Error(scheduleError)
        normalized.schedule = schedule
      }
      if (type === 'webhook') {
        normalized.webhookSecret = readNullableString(trigger.webhookSecret) || this.ids.randomUUID()
      }
      return normalized
    })
  }

  private assertWorkflowDraftAllowed(draft: WorkflowDraft) {
    if (!includesAllowed(draft.agentName, this.policy.allowedAgents)) {
      throw new Error(`Agent "${draft.agentName}" is not enabled for cloud profile "${this.policy.profileName}".`)
    }
    for (const toolId of draft.toolIds || []) {
      if (!includesAllowed(toolId, this.policy.allowedTools)) {
        throw new Error(`Tool "${toolId}" is not enabled for cloud profile "${this.policy.profileName}".`)
      }
    }
    if (draft.projectDirectory) {
      const verdict = evaluateCloudProjectDirectoryPolicy(draft.projectDirectory, this.policy)
      if (!verdict.allowed) throw new Error(verdict.reason || 'Workflow project directory is not allowed.')
    }
  }

  private async startClaimedWorkflowRun(claimed: ClaimedWorkflowRunRecord): Promise<CloudWorkflowStartResult> {
    return this.startWorkflowRun(claimed.workflow, claimed.run)
  }

  private async startWorkflowRun(
    workflow: CloudWorkflowRecord,
    run: CloudWorkflowRunRecord,
  ): Promise<CloudWorkflowStartResult> {
    const session = await this.createCloudSessionRecord({
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      profileName: this.policy.profileName,
      title: `Run ${workflow.title}`,
    })
    const attached = await this.store.attachWorkflowRunSession({
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      runId: run.id,
      sessionId: session.sessionId,
    })
    const command = await this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      sessionId: session.sessionId,
      kind: 'prompt',
      payload: {
        text: workflow.instructions,
        agent: workflow.agentName,
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

  private workflowSummaryFromRuntimeEvents(events: CloudRuntimeEvent[]) {
    const assistant = events
      .slice()
      .reverse()
      .find((event) => event.type === 'assistant.message')
    const content = assistant ? readString(asRecord(assistant.payload).content) : ''
    return content ? content.slice(0, 500) : null
  }

  private async completeWorkflowRunForSession(tenantId: string, sessionId: string, summary: string | null) {
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

  private async failWorkflowRunForSession(tenantId: string, sessionId: string, error: string) {
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

  private assertChannelSetupAllowed(principal: CloudPrincipal) {
    if (!principalCanManageChannels(principal)) {
      throw new CloudServiceError(403, 'Channel administration requires an org admin or admin-scoped API token.')
    }
  }

  private assertByokAllowed(principal: CloudPrincipal) {
    if (!principalCanManageByok(principal)) {
      throw new CloudServiceError(403, 'BYOK credential administration requires an org admin or admin-scoped API token.')
    }
  }

  private assertBillingAdmin(principal: CloudPrincipal) {
    if (!principalCanManageBilling(principal)) {
      throw new CloudServiceError(403, 'Billing administration requires an org admin or admin-scoped API token.')
    }
  }

  private translateBillingAdapterError(error: unknown): never {
    if (error instanceof BillingAdapterError) {
      throw new CloudServiceError(error.status, error.publicMessage)
    }
    throw error
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

  async assertWorkerExecutionAllowed(tenantId: string) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    await this.assertBillingAllowed({
      orgId: org.orgId,
      action: 'worker.execute',
      profileName: this.policy.profileName,
    })
  }

  async activeWorkerQuotaForTenant(tenantId: string) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    return this.quotaLimit(await this.effectiveQuotaLimit(
      org.orgId,
      this.abuse.maxActiveWorkersPerOrg,
      'maxActiveWorkersPerOrg',
    ))
  }

  private byokAuditActor(principal: CloudPrincipal) {
    return {
      actorType: principal.authSource === 'api_token' ? 'api_token' as const : 'user' as const,
      actorId: principal.tokenId || principal.userId,
      accountId: principal.accountId || principal.userId,
    }
  }

  private async assertByokProviderAllowed(principal: CloudPrincipal, providerIdInput: string) {
    const providerId = normalizeByokProviderIdForPolicy(providerIdInput)
    const allowedProviderIds = this.byokPolicy.allowedProviderIds
      ? new Set(this.byokPolicy.allowedProviderIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
      : null
    if (allowedProviderIds?.size && !allowedProviderIds.has(providerId)) {
      throw new CloudServiceError(403, `Provider "${providerId}" is not enabled for BYOK in this cloud profile.`)
    }
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'byok.provider',
      providerId,
    })
    const entitlement = await this.byokPolicy.checkEntitlement?.({
      principal,
      orgId: this.principalOrgId(principal),
      providerId,
    })
    if (entitlement && !entitlement.allowed) {
      throw new CloudServiceError(
        entitlement.status || 402,
        entitlement.reason || `Provider "${providerId}" is not available for this org entitlement.`,
      )
    }
    return providerId
  }

  private assertByokKmsRefAllowed(providerId: string, kmsRefInput: string | null | undefined) {
    const kmsRef = typeof kmsRefInput === 'string' ? kmsRefInput.trim() : ''
    if (!kmsRef) return
    const policy = this.byokPolicy.kmsRefs
    if (!policy?.enabled) {
      throw new CloudServiceError(403, 'KMS-backed BYOK references are disabled for this cloud deployment.')
    }
    if (kmsRef.startsWith('env:') && !policy.allowEnvRefs) {
      throw new CloudServiceError(403, 'Environment-backed BYOK references are not enabled for user-managed KMS refs.')
    }
    const allowedPrefixes = (policy.allowedPrefixes || [])
      .map((prefix) => prefix.trim())
      .filter(Boolean)
    if (allowedPrefixes.length === 0) {
      throw new CloudServiceError(403, 'KMS-backed BYOK references require deployer-configured allowed prefixes.')
    }
    if (!allowedPrefixes.some((prefix) => kmsRef.startsWith(prefix))) {
      throw new CloudServiceError(403, `KMS-backed BYOK reference is not allowed for provider "${providerId}".`)
    }
  }

  private requireByokSecrets() {
    if (!this.byokSecrets) throw new CloudServiceError(503, 'BYOK secret storage is not configured.')
    return this.byokSecrets
  }

  private assertGatewayAccess(principal: CloudPrincipal) {
    if (!principalCanUseGatewayRoutes(principal)) {
      throw new CloudServiceError(403, 'Gateway channel access requires a gateway-scoped API token.')
    }
  }

  private async getTenantSessionView(tenantId: string, sessionId: string): Promise<CloudSessionView> {
    const session = await this.store.getSessionForTenant(tenantId, sessionId)
    if (!session) throw new CloudServiceError(404, 'Cloud session was not found.')
    return {
      session,
      projection: await this.store.getSessionProjection(tenantId, sessionId),
    }
  }

  private async requireChannelActor(
    principal: CloudPrincipal,
    input: ChannelActorInput,
    purpose: 'prompt' | 'approve',
    scope: { provider?: ChannelProviderId | null, externalWorkspaceId?: string | null } = {},
  ): Promise<ChannelIdentityRecord> {
    const orgId = this.principalOrgId(principal)
    const identity = input.identityId
      ? await this.store.getChannelIdentity(orgId, input.identityId)
      : input.provider && input.externalUserId
        ? await this.store.findChannelIdentity({
            orgId,
            provider: input.provider,
            externalWorkspaceId: input.externalWorkspaceId,
            externalUserId: input.externalUserId,
          })
        : null
    if (!identity) throw new CloudServiceError(403, 'Channel actor identity is not authorized.')
    if (identity.status !== 'active') throw new CloudServiceError(403, 'Channel actor identity is not active.')
    if (scope.provider && identity.provider !== scope.provider) {
      throw new CloudServiceError(403, 'Channel actor identity is not authorized for this provider.')
    }
    if (scope.externalWorkspaceId !== undefined && identity.externalWorkspaceId !== (scope.externalWorkspaceId || null)) {
      throw new CloudServiceError(403, 'Channel actor identity is not authorized for this channel workspace.')
    }
    if (purpose === 'prompt' && !channelRoleCanPrompt(identity.role)) {
      throw new CloudServiceError(403, 'Channel actor is not allowed to prompt this agent.')
    }
    if (purpose === 'approve' && !channelRoleCanApprove(identity.role)) {
      throw new CloudServiceError(403, 'Channel actor is not allowed to approve this interaction.')
    }
    return identity
  }

  private async requireChannelActorForSession(
    principal: CloudPrincipal,
    input: ChannelActorInput,
    purpose: 'prompt' | 'approve',
    sessionId: string,
    provider: ChannelProviderId,
  ): Promise<ChannelIdentityRecord> {
    const actor = await this.requireChannelActor(principal, input, purpose, { provider })
    const bindings = await this.store.listChannelSessionBindingsForSession(this.principalOrgId(principal), sessionId)
    for (const binding of bindings) {
      if (binding.provider !== provider) continue
      const channelBinding = await this.store.getChannelBinding(this.principalOrgId(principal), binding.channelBindingId)
      if (!channelBinding) continue
      if (channelBinding.externalWorkspaceId === actor.externalWorkspaceId) return actor
    }
    throw new CloudServiceError(403, 'Channel actor identity is not authorized for this channel session.')
  }

  private assertWorkflowsEnabled() {
    if (!this.policy.features.workflows) {
      throw new Error('Workflows are disabled for this cloud profile.')
    }
  }

  private assertThreadIndexEnabled() {
    if (!this.policy.features.threadIndex) {
      throw new Error('Thread index is disabled for this cloud profile.')
    }
  }

  private assertSettingsEnabled() {
    if (!this.policy.features.settings) {
      throw new Error('Settings are disabled for this cloud profile.')
    }
  }

  private assertCapabilitiesEnabled() {
    if (!this.policy.features.agents && !this.policy.features.customSkills && !this.policy.features.customMcps) {
      throw new Error('Capabilities are disabled for this cloud profile.')
    }
  }

  private filterCapabilityTool(tool: CapabilityTool): CapabilityTool | null {
    if (tool.source === 'custom' && !this.policy.features.customMcps) return null
    if (!includesAllowed(tool.id, this.policy.allowedTools)) return null
    if (tool.kind === 'mcp' && !includesAllowed(tool.namespace || tool.id, this.policy.allowedMcps)) return null
    return {
      ...tool,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(tool.agentNames)
        : [],
    }
  }

  private filterCapabilitySkill(skill: CapabilitySkill): CapabilitySkill | null {
    if (skill.source === 'custom' && !this.policy.features.customSkills) return null
    if (this.policy.allowedTools && skill.toolIds?.length) {
      const hasAllowedTool = skill.toolIds.some((toolId) => this.policy.allowedTools?.includes(toolId))
      if (!hasAllowedTool) return null
    }
    return {
      ...skill,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(skill.agentNames)
        : [],
    }
  }

  private filterAgentNames(agentNames: string[]) {
    return this.policy.allowedAgents
      ? agentNames.filter((agentName) => this.policy.allowedAgents?.includes(agentName))
      : agentNames
  }

  private async requireOwnedSessions(principal: CloudPrincipal, sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
      if (!session) throw new Error(`Unknown session ${sessionId}.`)
    }
  }
}
