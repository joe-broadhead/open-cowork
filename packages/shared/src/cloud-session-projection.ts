import { cloudArtifactFilePath, isArtifactKind, isArtifactStatus, type SessionArtifact } from './artifacts.js'
import type {
  Message,
  MessageAttachment,
  PendingApproval,
  PendingQuestion,
  SessionError,
  SessionTokens,
  SessionView,
  TaskRun,
  TodoItem,
  ToolCall,
} from './session.js'
import {
  normalizeCloudProjectSource,
  type CloudProjectSource,
} from './project-source.js'
import type { CloudSessionProjectionEventRecord } from './cloud-session-contract.js'
export {
  CLOUD_PROJECTED_SESSION_EVENT_TYPES,
  CLOUD_AUTOMATION_EVENT_STREAM_VERSION,
  CLOUD_PROJECTION_SYNC_CONTRACT_VERSION,
  CLOUD_SESSION_EVENT_CONTRACT,
  CLOUD_SESSION_EVENT_TYPES,
  CLOUD_SESSION_PROJECTION_CONTRACT_VERSION,
  cloudProjectionFenceIdentityKey,
  cloudProjectionFenceObserved,
  cloudSessionEventContractFor,
  cloudSessionEventHasFacet,
  cloudSessionEventIsChannelRenderable,
  createCloudAutomationTerminalStatusRecord,
  createCloudAutomationEventEnvelope,
  createCloudProjectionCheckpoint,
  createCloudProjectionFenceToken,
  evaluateCloudProjectionFenceCheckpoint,
  formatCloudAutomationTerminalStatusLine,
  isCloudProjectedSessionEventType,
  isCloudSessionEventType,
  parseCloudAutomationTerminalStatusLine,
  waitForCloudProjectionFence,
} from './cloud-session-contract.js'
export type {
  CloudAutomationEventEnvelope,
  CloudAutomationEventSource,
  CloudAutomationTerminalStatusRecord,
  CloudProjectedSessionEventType,
  CloudProjectionCheckpoint,
  CloudProjectionFenceScope,
  CloudProjectionFenceToken,
  CloudProjectionFenceWaitErrorCode,
  CloudProjectionFenceWaitInput,
  CloudProjectionFenceWaitResult,
  CloudProjectionSyncError,
  CloudProjectionSyncErrorKind,
  CloudSessionEventContractEntry,
  CloudSessionEventRecord,
  CloudSessionEventType,
  CloudSessionProjectionEventRecord,
  CloudSessionProjectionConsumer,
  CloudSessionProjectionFacet,
  CloudSessionProjectionProducer,
} from './cloud-session-contract.js'

export type CloudSessionMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  attachments?: MessageAttachment[]
}

export type CloudSessionProjectionStatus = 'idle' | 'running' | 'closed' | 'errored'

export type CloudSessionProjectionOrigin = {
  kind: 'local-session-import'
  sourceFingerprint: string
  importedAt: string
  itemCounts: Record<string, number>
}

export type CloudResolvedApproval = {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  description: string
  allowed: boolean
  order: number
  resolvedAt: string
}

export type CloudResolvedQuestion = {
  id: string
  sessionId: string
  sourceSessionId?: string | null
  questions: PendingQuestion['questions']
  answers: unknown[]
  rejected: boolean
  order: number
  resolvedAt: string
}

export type CloudSessionProjectionView = {
  sessionId: string
  title: string
  status: CloudSessionProjectionStatus
  profileName: string
  isGenerating: boolean
  messages: CloudSessionMessage[]
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  resolvedApprovals: CloudResolvedApproval[]
  resolvedQuestions: CloudResolvedQuestion[]
  artifacts: SessionArtifact[]
  todos: TodoItem[]
  errors: SessionError[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  lastError: string | null
  origin: CloudSessionProjectionOrigin | null
  projectSource: CloudProjectSource | null
  updatedAt: string
}

export type CloudProjectionSessionRecord = {
  tenantId?: string
  userId?: string
  sessionId: string
  profileName: string
  status: CloudSessionProjectionStatus
  title: string | null
  updatedAt: string
}

export type CloudProjectionEventRecord = CloudSessionProjectionEventRecord<string>

export type CloudSessionProjectionRecord = {
  tenantId?: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  updatedAt: string
}

export type CloudSessionViewRecord<Session extends CloudProjectionSessionRecord = CloudProjectionSessionRecord> = {
  session: Session
  projection: CloudSessionProjectionRecord | null
}

const EMPTY_TOKENS: SessionTokens = {
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

function cloneProjectionValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneProjectionValue(entry)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, cloneProjectionValue(entry)]),
    ) as T
  }
  return value
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

function readStatus(value: unknown): CloudSessionProjectionStatus | null {
  return value === 'idle' || value === 'running' || value === 'closed' || value === 'errored'
    ? value
    : null
}

function toCloudSessionMessage(value: unknown): CloudSessionMessage | null {
  const record = asRecord(value)
  const role = record.role
  const id = readString(record.id)
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null
  if (!id) return null
  return {
    id,
    role,
    content: readString(record.content),
    createdAt: readString(record.createdAt, new Date().toISOString()),
    ...(Array.isArray(record.attachments) ? { attachments: cloneProjectionValue(record.attachments as MessageAttachment[]) } : {}),
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

function normalizeTodoItem(value: unknown): TodoItem | null {
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
    ? value.map(normalizeTodoItem).filter((entry): entry is TodoItem => Boolean(entry))
    : []
}

function normalizeToolCall(value: unknown): ToolCall | null {
  const record = asRecord(value)
  const id = readString(record.id)
  if (!id) return null
  return {
    id,
    name: readString(record.name, 'tool'),
    input: cloneProjectionValue(asRecord(record.input)),
    status: normalizeToolStatus(record.status),
    ...(record.output !== undefined ? { output: cloneProjectionValue(record.output) } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: cloneProjectionValue(record.attachments as ToolCall['attachments']) } : {}),
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
    transcript: Array.isArray(record.transcript) ? cloneProjectionValue(record.transcript as TaskRun['transcript']) : [],
    reasoning: Array.isArray(record.reasoning) ? cloneProjectionValue(record.reasoning as TaskRun['reasoning']) : undefined,
    toolCalls: Array.isArray(record.toolCalls)
      ? record.toolCalls.map(normalizeToolCall).filter((entry): entry is ToolCall => Boolean(entry))
      : [],
    compactions: Array.isArray(record.compactions) ? cloneProjectionValue(record.compactions as TaskRun['compactions']) : [],
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
    input: cloneProjectionValue(asRecord(record.input)),
    description: readString(record.description, 'Permission requested'),
    order: readNumber(record.order),
  }
}

function normalizeResolvedApproval(value: unknown): CloudResolvedApproval | null {
  const record = asRecord(value)
  const id = readString(record.id)
  const sessionId = readString(record.sessionId)
  if (!id || !sessionId) return null
  return {
    id,
    sessionId,
    taskRunId: readNullableString(record.taskRunId),
    tool: readString(record.tool, 'permission'),
    description: readString(record.description, 'Permission resolved'),
    allowed: record.allowed === true,
    order: readNumber(record.order),
    resolvedAt: readString(record.resolvedAt),
  }
}

function normalizeResolvedQuestion(value: unknown): CloudResolvedQuestion | null {
  const record = asRecord(value)
  const id = readString(record.id)
  const sessionId = readString(record.sessionId)
  if (!id || !sessionId) return null
  return {
    id,
    sessionId,
    sourceSessionId: readNullableString(record.sourceSessionId),
    questions: Array.isArray(record.questions)
      ? record.questions.map(normalizeQuestionPrompt).filter((entry): entry is PendingQuestion['questions'][number] => Boolean(entry))
      : [],
    answers: Array.isArray(record.answers) ? cloneProjectionValue(record.answers) : [],
    rejected: record.rejected === true,
    order: readNumber(record.order),
    resolvedAt: readString(record.resolvedAt),
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
    updatedAt: readNullableString(record.updatedAt) || undefined,
    kind: isArtifactKind(record.kind) ? record.kind : undefined,
    status: isArtifactStatus(record.status) ? record.status : undefined,
    authorAgentId: readNullableString(record.authorAgentId),
    projectId: readNullableString(record.projectId),
    taskId: readNullableString(record.taskId),
    statusUpdatedBy: readNullableString(record.statusUpdatedBy),
    statusUpdatedAt: readNullableString(record.statusUpdatedAt),
  }
}

function normalizeOrigin(value: unknown): CloudSessionProjectionOrigin | null {
  const record = asRecord(value)
  if (record.kind !== 'local-session-import') return null
  const sourceFingerprint = readString(record.sourceFingerprint)
  const importedAt = readString(record.importedAt)
  if (!sourceFingerprint || !importedAt) return null
  const rawCounts = asRecord(record.itemCounts)
  const itemCounts: Record<string, number> = {}
  for (const [key, count] of Object.entries(rawCounts)) {
    if (typeof count === 'number' && Number.isFinite(count)) itemCounts[key] = count
  }
  return {
    kind: 'local-session-import',
    sourceFingerprint,
    importedAt,
    itemCounts,
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

function addMessage(
  view: CloudSessionProjectionView,
  message: CloudSessionMessage,
): CloudSessionProjectionView {
  return {
    ...view,
    messages: upsertById(view.messages, message),
  }
}

function eventPayloadId(payload: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = readString(payload[key])
    if (value) return value
  }
  return fallback
}

function taskRunFromPayload(
  session: CloudProjectionSessionRecord,
  payload: Record<string, unknown>,
  event: CloudProjectionEventRecord,
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
  session: CloudProjectionSessionRecord,
  payload: Record<string, unknown>,
  event: CloudProjectionEventRecord,
): ToolCall {
  const id = eventPayloadId(payload, ['id', 'callId', 'toolCallId'], `${session.sessionId}:tool:${event.sequence}`)
  return {
    id,
    name: readString(payload.name, readString(payload.tool, 'tool')),
    input: cloneProjectionValue(asRecord(payload.input)),
    status: normalizeToolStatus(payload.status),
    ...(payload.output !== undefined ? { output: cloneProjectionValue(payload.output) } : {}),
    ...(Array.isArray(payload.attachments) ? { attachments: cloneProjectionValue(payload.attachments as ToolCall['attachments']) } : {}),
    agent: readNullableString(payload.agent),
    sourceSessionId: readNullableString(payload.sourceSessionId),
    order: event.sequence,
  }
}

function withTaskRunToolCall(
  view: CloudSessionProjectionView,
  session: CloudProjectionSessionRecord,
  taskRunId: string,
  toolCall: ToolCall,
  payload: Record<string, unknown>,
  event: CloudProjectionEventRecord,
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
  session: CloudProjectionSessionRecord,
  payload: Record<string, unknown>,
  event: CloudProjectionEventRecord,
): PendingApproval {
  const id = eventPayloadId(payload, ['permissionId', 'id', 'requestId', 'requestID'], `${session.sessionId}:permission:${event.sequence}`)
  return {
    id,
    sessionId: session.sessionId,
    taskRunId: readNullableString(payload.taskRunId),
    tool: readString(payload.tool, 'permission'),
    input: cloneProjectionValue(asRecord(payload.input)),
    description: readString(payload.description, readString(payload.tool, 'Permission requested')),
    order: event.sequence,
  }
}

function pendingQuestionFromPayload(
  session: CloudProjectionSessionRecord,
  payload: Record<string, unknown>,
  event: CloudProjectionEventRecord,
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

export function createCloudSessionProjectionView(session: CloudProjectionSessionRecord): CloudSessionProjectionView {
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
    resolvedApprovals: [],
    resolvedQuestions: [],
    artifacts: [],
    todos: [],
    errors: [],
    sessionCost: 0,
    sessionTokens: { ...EMPTY_TOKENS },
    lastInputTokens: 0,
    lastError: null,
    origin: null,
    projectSource: null,
    updatedAt: session.updatedAt,
  }
}

export function normalizeCloudSessionProjectionView(
  value: unknown,
  session: CloudProjectionSessionRecord,
): CloudSessionProjectionView {
  const record = asRecord(value)
  const messages = Array.isArray(record.messages)
    ? record.messages.map(toCloudSessionMessage).filter((entry): entry is CloudSessionMessage => Boolean(entry))
    : []
  return {
    ...createCloudSessionProjectionView(session),
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
    resolvedApprovals: Array.isArray(record.resolvedApprovals)
      ? record.resolvedApprovals.map(normalizeResolvedApproval).filter((entry): entry is CloudResolvedApproval => Boolean(entry))
      : [],
    resolvedQuestions: Array.isArray(record.resolvedQuestions)
      ? record.resolvedQuestions.map(normalizeResolvedQuestion).filter((entry): entry is CloudResolvedQuestion => Boolean(entry))
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
    origin: normalizeOrigin(record.origin),
    projectSource: normalizeCloudProjectSource(record.projectSource),
    updatedAt: readString(record.updatedAt, session.updatedAt),
  }
}

export function reduceCloudSessionProjectionEvent(
  session: CloudProjectionSessionRecord,
  current: CloudSessionProjectionView,
  event: CloudProjectionEventRecord,
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
    case 'session.imported':
      return {
        ...current,
        origin: normalizeOrigin({
          kind: 'local-session-import',
          sourceFingerprint: readString(payload.sourceFingerprint),
          importedAt: readString(payload.importedAt, eventTime),
          itemCounts: asRecord(payload.itemCounts),
        }),
        status: 'idle',
        isGenerating: false,
        lastError: null,
        updatedAt: eventTime,
      }
    case 'session.project_source.bound':
      return {
        ...current,
        projectSource: normalizeCloudProjectSource(payload.projectSource),
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
        ...(Array.isArray(payload.attachments) ? { attachments: cloneProjectionValue(payload.attachments as MessageAttachment[]) } : {}),
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
        ...(Array.isArray(payload.attachments) ? { attachments: cloneProjectionValue(payload.attachments as MessageAttachment[]) } : {}),
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
      const pendingApproval = current.pendingApprovals.find((entry) => entry.id === permissionId)
      const resolvedApproval = permissionId ? normalizeResolvedApproval({
        id: permissionId,
        sessionId: session.sessionId,
        taskRunId: pendingApproval?.taskRunId ?? readNullableString(payload.taskRunId),
        tool: pendingApproval?.tool || readString(payload.tool, 'permission'),
        description: pendingApproval?.description || readString(payload.description, 'Permission resolved'),
        allowed: payload.allowed === true || payload.response === true || payload.response === 'allow' || payload.response === 'once',
        order: event.sequence,
        resolvedAt: eventTime,
      }) : null
      return {
        ...current,
        pendingApprovals: permissionId ? removeById(current.pendingApprovals, permissionId) : current.pendingApprovals,
        resolvedApprovals: resolvedApproval ? upsertById(current.resolvedApprovals, resolvedApproval) : current.resolvedApprovals,
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
      const pendingQuestion = current.pendingQuestions.find((entry) => entry.id === questionId)
      const resolvedQuestion = questionId ? normalizeResolvedQuestion({
        id: questionId,
        sessionId: session.sessionId,
        sourceSessionId: pendingQuestion?.sourceSessionId ?? readNullableString(payload.sourceSessionId),
        questions: pendingQuestion?.questions || [],
        answers: Array.isArray(payload.answers) ? payload.answers : [],
        rejected: payload.rejected === true,
        order: event.sequence,
        resolvedAt: eventTime,
      }) : null
      return {
        ...current,
        pendingQuestions: questionId ? removeById(current.pendingQuestions, questionId) : current.pendingQuestions,
        resolvedQuestions: resolvedQuestion ? upsertById(current.resolvedQuestions, resolvedQuestion) : current.resolvedQuestions,
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
    case 'artifact.updated': {
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
      return current
  }
}

function isCloudSessionMessage(value: unknown): value is CloudSessionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CloudSessionMessage>
  return typeof record.id === 'string'
    && (record.role === 'user' || record.role === 'assistant' || record.role === 'system')
    && typeof record.content === 'string'
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ToolCall>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && (record.status === 'running' || record.status === 'complete' || record.status === 'error')
}

function isTaskRun(value: unknown): value is TaskRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TaskRun>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && (record.status === 'queued' || record.status === 'running' || record.status === 'complete' || record.status === 'error')
}

function isPendingApproval(value: unknown): value is PendingApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PendingApproval>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.tool === 'string'
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PendingQuestion>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && Array.isArray(record.questions)
}

function isResolvedApproval(value: unknown): value is CloudResolvedApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CloudResolvedApproval>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.tool === 'string'
    && typeof record.allowed === 'boolean'
}

function isResolvedQuestion(value: unknown): value is CloudResolvedQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CloudResolvedQuestion>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && Array.isArray(record.questions)
    && typeof record.rejected === 'boolean'
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TodoItem>
  return typeof record.content === 'string'
}

function isSessionError(value: unknown): value is SessionError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SessionError>
  return typeof record.id === 'string' && typeof record.message === 'string'
}

function isSessionArtifact(value: unknown): value is SessionArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SessionArtifact>
  return typeof record.id === 'string'
    && typeof record.filePath === 'string'
    && typeof record.filename === 'string'
}

function readSessionTokens(value: unknown): SessionTokens {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_TOKENS }
  const record = value as Partial<SessionTokens>
  return {
    input: typeof record.input === 'number' ? record.input : 0,
    output: typeof record.output === 'number' ? record.output : 0,
    reasoning: typeof record.reasoning === 'number' ? record.reasoning : 0,
    cacheRead: typeof record.cacheRead === 'number' ? record.cacheRead : 0,
    cacheWrite: typeof record.cacheWrite === 'number' ? record.cacheWrite : 0,
  }
}

export function readCloudSessionProjection<Session extends CloudProjectionSessionRecord>(
  view: CloudSessionViewRecord<Session>,
): CloudSessionProjectionView | null {
  const raw = view.projection?.view
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Partial<CloudSessionProjectionView>
  if (typeof record.sessionId !== 'string') return null
  if (!Array.isArray(record.messages)) return null
  return {
    sessionId: record.sessionId,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : view.session.title || 'New session',
    status: record.status === 'running' || record.status === 'closed' || record.status === 'errored' ? record.status : 'idle',
    profileName: typeof record.profileName === 'string' && record.profileName ? record.profileName : view.session.profileName,
    isGenerating: Boolean(record.isGenerating),
    messages: record.messages.filter(isCloudSessionMessage),
    toolCalls: Array.isArray(record.toolCalls) ? record.toolCalls.filter(isToolCall) : [],
    taskRuns: Array.isArray(record.taskRuns) ? record.taskRuns.filter(isTaskRun) : [],
    pendingApprovals: Array.isArray(record.pendingApprovals) ? record.pendingApprovals.filter(isPendingApproval) : [],
    pendingQuestions: Array.isArray(record.pendingQuestions) ? record.pendingQuestions.filter(isPendingQuestion) : [],
    resolvedApprovals: Array.isArray(record.resolvedApprovals) ? record.resolvedApprovals.filter(isResolvedApproval) : [],
    resolvedQuestions: Array.isArray(record.resolvedQuestions) ? record.resolvedQuestions.filter(isResolvedQuestion) : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter(isSessionArtifact) : [],
    todos: Array.isArray(record.todos) ? record.todos.filter(isTodoItem) : [],
    errors: Array.isArray(record.errors) ? record.errors.filter(isSessionError) : [],
    sessionCost: typeof record.sessionCost === 'number' ? record.sessionCost : 0,
    sessionTokens: readSessionTokens(record.sessionTokens),
    lastInputTokens: typeof record.lastInputTokens === 'number' ? record.lastInputTokens : 0,
    lastError: typeof record.lastError === 'string' && record.lastError ? record.lastError : null,
    origin: normalizeOrigin(record.origin),
    projectSource: normalizeCloudProjectSource(record.projectSource),
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : view.session.updatedAt,
  }
}

function toMessage(message: CloudSessionMessage, order: number): Message | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    order,
  }
}

export function emptySessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: { ...EMPTY_TOKENS },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    ...overrides,
  }
}

export function cloudSessionViewToSessionView<Session extends CloudProjectionSessionRecord>(
  view: CloudSessionViewRecord<Session>,
): SessionView {
  const projection = readCloudSessionProjection(view)
  if (!projection) return emptySessionView()
  const messages = projection.messages
    .map((message, index) => toMessage(message, index + 1))
    .filter((message): message is Message => Boolean(message))
  return emptySessionView({
    messages,
    toolCalls: projection.toolCalls,
    taskRuns: projection.taskRuns,
    pendingApprovals: projection.pendingApprovals,
    pendingQuestions: projection.pendingQuestions,
    artifacts: projection.artifacts,
    todos: projection.todos,
    errors: projection.errors.length > 0
      ? projection.errors
      : projection.lastError
        ? [{
            id: `${projection.sessionId}:cloud-error`,
            sessionId: projection.sessionId,
            message: projection.lastError,
            order: messages.length + 1,
          }]
        : [],
    sessionCost: projection.sessionCost,
    sessionTokens: projection.sessionTokens,
    lastInputTokens: projection.lastInputTokens,
    revision: view.projection?.sequence || 0,
    lastEventAt: view.projection?.sequence || 0,
    isGenerating: projection.isGenerating && projection.pendingApprovals.length === 0 && projection.pendingQuestions.length === 0,
    isAwaitingPermission: projection.pendingApprovals.length > 0,
    isAwaitingQuestion: projection.pendingQuestions.length > 0,
  })
}
