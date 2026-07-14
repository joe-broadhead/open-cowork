import {
  asArray,
  asRecord,
  CLOUD_TOOL_ATTACHMENT_MAX_DATA_URL_BYTES,
  CLOUD_TOOL_ATTACHMENT_MAX_FILENAME_BYTES,
  readBoolean,
  readRecordNumber,
  readRecordString,
  readString,
  RUNTIME_EVENT_MAX_COLLECTION_ENTRIES,
  RUNTIME_EVENT_MAX_STRING_BYTES,
  sanitizeRuntimeEventValue,
  type JsonRecord,
  type MessageAttachment,
  type TodoItem,
} from '@open-cowork/shared'
import type {
  Event as SdkEvent,
  GlobalEvent as SdkGlobalEvent,
  McpStatus as SdkMcpStatus,
  Message as SdkMessage,
  Part as SdkPart,
  Session as SdkSession,
  SessionMessagesResponse2 as SdkClassicSessionMessagesResponse,
  SessionStatus as SdkSessionStatus,
  SessionMessage as SdkV2SessionMessage,
  SessionMessagesResponse as SdkV2SessionMessagesPage,
  SessionV2Info as SdkV2SessionInfo,
} from '@opencode-ai/sdk/v2'
type SdkSessionMessage = SdkClassicSessionMessagesResponse extends Array<infer T> ? T : never
type SdkRuntimeEventEnvelope = SdkEvent | SdkGlobalEvent | { payload: SdkEvent | SdkGlobalEvent }
const MAX_RUNTIME_OUTPUT_PATH_LENGTH = 4_096

function boundedArray(value: unknown): unknown[] {
  return asArray(value).slice(0, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
}

function hasEnumerableOwnProperty(value: Record<string, unknown>) {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true
  }
  return false
}

export type NormalizedTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type NormalizedAttachment = MessageAttachment

export type NormalizedToolState = {
  input: JsonRecord
  args: JsonRecord
  output?: unknown
  result?: unknown
  error?: unknown
  attachments: NormalizedAttachment[]
  outputPaths: string[]
  metadata: JsonRecord
  title: string | null
  raw: string | null
  status: string | null
}

export type NormalizedMessagePart = {
  type: string
  id: string | null
  text: string | null
  tool: string | null
  callId: string | null
  title: string | null
  name: string | null
  agent: string | null
  description: string | null
  prompt: string | null
  raw: string | null
  auto: boolean
  overflow: boolean
  reason: string | null
  metadata: JsonRecord
  attachments: NormalizedAttachment[]
  state: NormalizedToolState
  tokens: NormalizedTokens
  cost: number | null
}

export type NormalizedSessionInfo = {
  id: string
  title: string | null
  role: string | null
  parentID: string | null
  sessionID: string | null
  time: {
    created?: number
    updated?: number
  }
  model: {
    providerId: string | null
    modelId: string | null
  }
  summary: {
    additions: number
    deletions: number
    files: number
  } | null
  revertedMessageId: string | null
}

export type NormalizedSessionMessage = {
  id: string
  role: string
  time: {
    created?: number
    updated?: number
  }
  info: NormalizedSessionInfo
  parts: NormalizedMessagePart[]
  error: string | null
  structured?: unknown
}

export type NormalizedRuntimeEventEnvelope = {
  type: string
  properties: JsonRecord
}

export type NormalizedSessionStatus = {
  type: string | null
}

export type NormalizedMcpStatusEntry = {
  name: string
  connected: boolean
  rawStatus?: string
  error?: string
}

export type NormalizedRuntimeCommand = {
  name: string
  description?: string
  source?: string
}

function readMcpStatusError(record: JsonRecord): string | null {
  const parts = ['error', 'message', 'error_description']
    .map((key) => readString(record[key]))
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' - ') : null
}

function isLikelyMcpAuthFailure(status: string | null, error: string | null) {
  if (status !== 'failed') return false
  return /missing authorization header|invalid_token|unauthorized|forbidden|oauth|non-200 status code \(40[13]\)|\b40[13]\b/i
    .test(error || '')
}

function normalizeTokens(value: unknown): NormalizedTokens {
  const record = asRecord(value)
  const cache = asRecord(record.cache)
  return {
    input: readRecordNumber(record, ['input']) || 0,
    output: readRecordNumber(record, ['output']) || 0,
    reasoning: readRecordNumber(record, ['reasoning']) || 0,
    cache: {
      read: readRecordNumber(cache, ['read']) || 0,
      write: readRecordNumber(cache, ['write']) || 0,
    },
  }
}

function normalizeAttachment(value: unknown): MessageAttachment | null {
  const record = asRecord(value)
  const mime = readRecordString(record, ['mime'])
  const url = readRecordString(record, ['url', 'uri'])
  if (!mime || mime.length > 192 || !url || url.length > CLOUD_TOOL_ATTACHMENT_MAX_DATA_URL_BYTES) return null
  const rawFilename = readRecordString(record, ['filename', 'name'])
  const filename = rawFilename?.slice(0, CLOUD_TOOL_ATTACHMENT_MAX_FILENAME_BYTES) || undefined
  return filename ? { mime, url, filename } : { mime, url }
}

export function normalizeToolAttachments(...values: unknown[]): MessageAttachment[] {
  const attachments: MessageAttachment[] = []
  const seen = new Map<string, Set<string>>()
  let totalUrlBytes = 0
  for (const value of values) {
    for (const candidate of boundedArray(value)) {
      if (attachments.length >= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) return attachments
      const attachment = normalizeAttachment(candidate)
      if (!attachment) continue
      if (totalUrlBytes + attachment.url.length > CLOUD_TOOL_ATTACHMENT_MAX_DATA_URL_BYTES) return attachments
      const key = `${attachment.mime}\0${attachment.filename || ''}`
      const matches = seen.get(attachment.url)
      if (matches?.has(key)) continue
      if (matches) matches.add(key)
      else seen.set(attachment.url, new Set([key]))
      totalUrlBytes += attachment.url.length
      attachments.push(attachment)
    }
  }
  return attachments
}

export function normalizeToolOutputPaths(...values: unknown[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    for (const candidate of boundedArray(value)) {
      if (paths.length >= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) return paths
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      const path = candidate.slice(0, MAX_RUNTIME_OUTPUT_PATH_LENGTH)
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

function normalizeToolState(value: unknown): NormalizedToolState {
  const record = asRecord(value)
  return {
    input: asRecord(record.input),
    args: asRecord(record.args),
    output: record.output,
    result: record.result,
    error: record.error,
    attachments: normalizeToolAttachments(record.attachments, record.content),
    outputPaths: normalizeToolOutputPaths(record.outputPaths),
    metadata: asRecord(record.metadata),
    title: readRecordString(record, ['title']),
    raw: readRecordString(record, ['raw']),
    status: readRecordString(record, ['status']),
  }
}

export function normalizeSessionInfo(value: SdkSession | SdkMessage | SdkV2SessionInfo | SdkV2SessionMessage): NormalizedSessionInfo | null
export function normalizeSessionInfo(value: unknown): NormalizedSessionInfo | null
export function normalizeSessionInfo(value: unknown): NormalizedSessionInfo | null {
  const record = asRecord(value)
  const id = readRecordString(record, ['id'])
  if (!id) return null
  const time = asRecord(record.time)
  const model = asRecord(record.model)
  const summaryRecord = asRecord(record.summary)
  const summary = summaryRecord && (
    typeof summaryRecord.additions === 'number' ||
    typeof summaryRecord.deletions === 'number' ||
    typeof summaryRecord.files === 'number'
  )
    ? {
        additions: readRecordNumber(summaryRecord, ['additions']) || 0,
        deletions: readRecordNumber(summaryRecord, ['deletions']) || 0,
        files: readRecordNumber(summaryRecord, ['files']) || 0,
      }
    : null
  const revertRecord = asRecord(record.revert)
  const revertedMessageId = readRecordString(revertRecord, ['messageID', 'messageId'])
  return {
    id,
    title: readRecordString(record, ['title']),
    role: readRecordString(record, ['role']),
    parentID: readRecordString(record, ['parentID', 'parentId']),
    sessionID: readRecordString(record, ['sessionID', 'sessionId']),
    time: {
      created: readRecordNumber(time, ['created']) || undefined,
      updated: readRecordNumber(time, ['updated', 'completed']) || undefined,
    },
    model: {
      providerId: readRecordString(model, ['providerID', 'providerId']) || readRecordString(record, ['providerID', 'providerId']),
      modelId: readRecordString(model, ['modelID', 'modelId', 'id']) || readRecordString(record, ['modelID', 'modelId']),
    },
    summary,
    revertedMessageId,
  }
}

function normalizeV2ToolContent(value: unknown) {
  const record = asRecord(value)
  if (readRecordString(record, ['type']) === 'text') return readRecordString(record, ['text']) || ''
  if (readRecordString(record, ['type']) === 'file') {
    return {
      type: 'file',
      uri: readRecordString(record, ['uri']) || '',
      mime: readRecordString(record, ['mime']) || 'application/octet-stream',
      name: readRecordString(record, ['name']) || undefined,
    }
  }
  return value
}

function parsePendingToolInput(value: unknown): JsonRecord {
  if (typeof value !== 'string' || !value.trim()) return {}
  if (value.length > RUNTIME_EVENT_MAX_STRING_BYTES) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return asRecord(parsed)
  } catch {
    return {}
  }
}

function normalizeV2ToolPart(value: unknown): NormalizedMessagePart | null {
  const record = asRecord(value)
  if (readRecordString(record, ['type']) !== 'tool') return null
  const state = asRecord(record.state)
  const status = readRecordString(state, ['status'])
  const content = boundedArray(state.content).map(normalizeV2ToolContent)
  const input = status === 'pending'
    ? parsePendingToolInput(state.input)
    : asRecord(state.input)
  const attachments = normalizeToolAttachments(state.attachments, state.content)
  const outputPaths = normalizeToolOutputPaths(state.outputPaths)
  return {
    type: 'tool',
    id: readRecordString(record, ['id']),
    text: null,
    tool: readRecordString(record, ['name']),
    callId: readRecordString(record, ['id']),
    title: readRecordString(record, ['name']),
    name: readRecordString(record, ['name']),
    agent: null,
    description: null,
    prompt: null,
    raw: typeof state.input === 'string' ? state.input : null,
    auto: false,
    overflow: false,
    reason: null,
    metadata: asRecord(asRecord(record.provider).metadata),
    attachments,
    state: {
      input,
      args: input,
      output: state.result !== undefined
        ? state.result
        : content.length === 1
          ? content[0]
          : content.length > 1
            ? content
            : state.structured,
      result: state.result,
      error: state.error,
      attachments,
      outputPaths,
      metadata: asRecord(asRecord(record.provider).resultMetadata),
      title: readRecordString(record, ['name']),
      raw: typeof state.input === 'string' ? state.input : null,
      status,
    },
    tokens: normalizeTokens(undefined),
    cost: null,
  }
}

function normalizeV2SessionMessage(value: unknown): NormalizedSessionMessage | null {
  const record = asRecord(value)
  const type = readRecordString(record, ['type'])
  const id = readRecordString(record, ['id'])
  if (!id || !type) return null
  const time = asRecord(record.time)
  const model = asRecord(record.model)
  const role = type === 'user' ? 'user' : 'assistant'
  const info = normalizeSessionInfo({
    id,
    role,
    time,
    model,
  })
  if (!info) return null

  const parts: NormalizedMessagePart[] = []
  const addPart = (part: NormalizedMessagePart | null) => {
    if (part) parts.push(part)
  }
  const simplePart = (partType: string, partId: string | null, text: string | null): NormalizedMessagePart => ({
    type: partType,
    id: partId,
    text,
    tool: null,
    callId: null,
    title: null,
    name: null,
    agent: null,
    description: null,
    prompt: null,
    raw: null,
    auto: false,
    overflow: false,
    reason: null,
    metadata: {},
    attachments: [],
    state: normalizeToolState(undefined),
    tokens: normalizeTokens(undefined),
    cost: null,
  })

  if (type === 'user') {
    const text = readRecordString(record, ['text'])
    if (text) addPart(simplePart('text', `${id}:text`, text))
    for (const file of boundedArray(record.files)) {
      const attachment = normalizeAttachment(file)
      if (!attachment) continue
      const part = simplePart('file', null, null)
      part.attachments = [attachment]
      parts.push(part)
    }
  } else if (type === 'assistant') {
    for (const content of boundedArray(record.content)) {
      const contentRecord = asRecord(content)
      const contentType = readRecordString(contentRecord, ['type'])
      if (contentType === 'text' || contentType === 'reasoning') {
        addPart(simplePart(
          contentType,
          readRecordString(contentRecord, ['id']),
          readRecordString(contentRecord, ['text']),
        ))
      } else if (contentType === 'tool') {
        addPart(normalizeV2ToolPart(contentRecord))
      }
    }
    if (record.cost !== undefined || record.tokens !== undefined) {
      const finish = simplePart('step-finish', `${id}:step-finish`, null)
      finish.cost = readRecordNumber(record, ['cost'])
      finish.tokens = normalizeTokens(record.tokens)
      finish.reason = readRecordString(record, ['finish'])
      parts.push(finish)
    }
  } else if (type === 'compaction') {
    const part = simplePart('compaction', id, readRecordString(record, ['summary']))
    part.auto = readRecordString(record, ['reason']) === 'auto'
    parts.push(part)
  } else if (type === 'agent-switched') {
    const part = simplePart('agent', id, null)
    part.name = readRecordString(record, ['agent'])
    part.agent = part.name
    parts.push(part)
  } else if (type === 'shell') {
    const part = normalizeV2ToolPart({
      type: 'tool',
      id: readRecordString(record, ['callID']) || id,
      name: 'shell',
      state: {
        status: asRecord(time).completed ? 'completed' : 'running',
        input: { command: readRecordString(record, ['command']) || '' },
        content: [{ type: 'text', text: readRecordString(record, ['output']) || '' }],
      },
    })
    addPart(part)
  } else if (type === 'synthetic' || type === 'system') {
    const text = readRecordString(record, ['text'])
    if (text) addPart(simplePart('text', `${id}:text`, text))
  }

  return {
    id,
    role,
    time: info.time,
    info,
    parts,
    error: normalizeSessionMessageError(record),
  }
}

function normalizeSessionMessageError(value: unknown): string | null {
  const record = asRecord(value)
  const error = asRecord(record.error)
  const message = readRecordString(error, ['message'])
    || readRecordString(record, ['error'])
    || null
  if (!message) return null
  const sanitized = sanitizeRuntimeEventValue(message)
  return typeof sanitized === 'string' && sanitized ? sanitized : null
}

export function normalizeSessionMessage(value: SdkSessionMessage | SdkMessage | SdkV2SessionMessage): NormalizedSessionMessage | null
export function normalizeSessionMessage(value: unknown): NormalizedSessionMessage | null
export function normalizeSessionMessage(value: unknown): NormalizedSessionMessage | null {
  const record = asRecord(value)
  const nativeType = readRecordString(record, ['type'])
  // Model switches are session configuration changes, not conversation turns.
  // Returning an empty assistant message creates a phantom bubble during replay.
  if (nativeType === 'model-switched') return null
  if (
    nativeType === 'user'
    || nativeType === 'assistant'
    || nativeType === 'synthetic'
    || nativeType === 'system'
    || nativeType === 'shell'
    || nativeType === 'agent-switched'
    || nativeType === 'compaction'
  ) {
    return normalizeV2SessionMessage(record)
  }
  const mergedInfo = { ...record, ...asRecord(record.info) }
  const info = normalizeSessionInfo(mergedInfo)
  if (!info) return null
  return {
    id: info.id,
    role: info.role || readRecordString(record, ['role']) || 'assistant',
    time: info.time,
    info,
    error: normalizeSessionMessageError({
      error: record.error ?? asRecord(record.info).error,
    }),
    structured: record.structured,
    parts: boundedArray(record.parts)
      .map(normalizeMessagePart)
      .filter((part): part is NormalizedMessagePart => Boolean(part)),
  }
}

export function normalizeSessionMessages(value: SdkClassicSessionMessagesResponse | SdkV2SessionMessagesPage | SdkV2SessionMessage[]): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[] {
  const record = asRecord(value)
  const messages = Array.isArray(value) ? value : asArray(record.data)
  // The V2 history client has already paginated this aggregate. Applying the
  // per-event collection cap here silently discarded every message after the
  // first page-sized window (and, because history is ascending, discarded the
  // newest conversation state). Keep structural bounds inside each message,
  // while preserving the complete SDK-owned history across pages.
  return messages.map(normalizeSessionMessage)
    .filter((message): message is NormalizedSessionMessage => Boolean(message))
}

export function normalizeMessagePart(value: SdkPart): NormalizedMessagePart | null
export function normalizeMessagePart(value: unknown): NormalizedMessagePart | null
export function normalizeMessagePart(value: unknown): NormalizedMessagePart | null {
  const record = asRecord(value)
  const type = readRecordString(record, ['type'])
  if (!type) return null
  return {
    type,
    id: readRecordString(record, ['id']),
    text: readRecordString(record, ['text']),
    tool: readRecordString(record, ['tool']),
    callId: readRecordString(record, ['callID', 'callId']),
    title: readRecordString(record, ['title']),
    name: readRecordString(record, ['name']),
    agent: readRecordString(record, ['agent']),
    description: readRecordString(record, ['description']),
    prompt: readRecordString(record, ['prompt']),
    raw: readRecordString(record, ['raw']),
    auto: readBoolean(record.auto),
    overflow: readBoolean(record.overflow),
    reason: readRecordString(record, ['reason']),
    metadata: asRecord(record.metadata),
    attachments: normalizeToolAttachments(record.attachments),
    state: normalizeToolState(record.state),
    tokens: normalizeTokens(record.tokens),
    cost: readRecordNumber(record, ['cost']),
  }
}

export function normalizeRuntimeEventEnvelope(value: SdkRuntimeEventEnvelope): NormalizedRuntimeEventEnvelope | null
export function normalizeRuntimeEventEnvelope(value: unknown): NormalizedRuntimeEventEnvelope | null
export function normalizeRuntimeEventEnvelope(value: unknown): NormalizedRuntimeEventEnvelope | null {
  const envelope = asRecord(value)
  const payload = asRecord(envelope.payload)
  const source = readRecordString(payload, ['type']) ? payload : envelope
  const nested = asRecord(source.data)
  const sourceType = readRecordString(source, ['type'])
  const rawType = sourceType === 'sync'
    ? readRecordString(source, ['name']) || readRecordString(nested, ['type'])
    : sourceType || readRecordString(nested, ['type'])
  const type = rawType?.replace(/\.\d+$/, '') || null
  if (!type) return null
  const sourceProperties = asRecord(source.properties)
  const nestedProperties = asRecord(nested.properties)
  const properties = hasEnumerableOwnProperty(sourceProperties)
    ? sourceProperties
    : hasEnumerableOwnProperty(nestedProperties)
      ? nestedProperties
      : nested
  return {
    type,
    properties,
  }
}

export function normalizeSessionStatuses(value: Record<string, SdkSessionStatus>): Record<string, NormalizedSessionStatus>
export function normalizeSessionStatuses(value: unknown): Record<string, NormalizedSessionStatus>
export function normalizeSessionStatuses(value: unknown): Record<string, NormalizedSessionStatus> {
  const record = asRecord(value)
  const statuses: Record<string, NormalizedSessionStatus> = {}
  let count = 0
  for (const sessionId in record) {
    if (!Object.prototype.hasOwnProperty.call(record, sessionId)) continue
    if (count >= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) break
    if (sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') continue
    const normalized = asRecord(record[sessionId])
    statuses[sessionId] = { type: readRecordString(normalized, ['type']) }
    count += 1
  }
  return statuses
}

export function normalizeMcpStatusEntries(value: Record<string, SdkMcpStatus>): NormalizedMcpStatusEntry[]
export function normalizeMcpStatusEntries(value: unknown): NormalizedMcpStatusEntry[]
export function normalizeMcpStatusEntries(value: unknown): NormalizedMcpStatusEntry[] {
  const record = asRecord(value)
  const entries: NormalizedMcpStatusEntry[] = []
  for (const name in record) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) continue
    if (entries.length >= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) break
    const status = record[name]
    const normalized = asRecord(status)
    const reportedStatus = readRecordString(normalized, ['status'])
    const error = readMcpStatusError(normalized)
    const rawStatus = isLikelyMcpAuthFailure(reportedStatus, error)
      ? 'auth_required'
      : reportedStatus
    const entry: NormalizedMcpStatusEntry = {
      name,
      connected: rawStatus === 'connected',
      rawStatus: rawStatus || undefined,
    }
    if (error) entry.error = error
    entries.push(entry)
  }
  return entries
}

export function normalizeRuntimeCommands(value: unknown): NormalizedRuntimeCommand[] {
  const commands: NormalizedRuntimeCommand[] = []
  for (const entry of boundedArray(value)) {
    const record = asRecord(entry)
    const name = readRecordString(record, ['name'])
    if (!name) continue
    const description = readRecordString(record, ['description']) || undefined
    const source = readRecordString(record, ['source']) || undefined
    commands.push({ name, description, source })
  }
  return commands
}

export function normalizeShareUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  const record = asRecord(value)
  const share = asRecord(record.share)
  return readRecordString(share, ['url']) || readRecordString(record, ['url'])
}

export function normalizeTodoItems(value: unknown): TodoItem[] {
  return asArray(value).flatMap((entry) => {
    const record = asRecord(entry)
    const content = readRecordString(record, ['content'])
    const status = readRecordString(record, ['status'])
    const priority = readRecordString(record, ['priority'])
    if (!content || !status || !priority) return []
    const id = readRecordString(record, ['id']) || undefined
    return [{ content, status, priority, id }]
  })
}
