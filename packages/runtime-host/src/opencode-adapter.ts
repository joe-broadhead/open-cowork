import { asArray, asRecord, readBoolean, readRecordNumber, readRecordString, readString, type JsonRecord } from '@open-cowork/shared'
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
import type {
  TodoItem,
} from '@open-cowork/shared'
type SdkSessionMessage = SdkClassicSessionMessagesResponse extends Array<infer T> ? T : never
type SdkRuntimeEventEnvelope = SdkEvent | SdkGlobalEvent | { payload: SdkEvent | SdkGlobalEvent }

export type NormalizedTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type NormalizedAttachment = {
  mime: string
  url: string
  filename?: string
}

export type NormalizedToolState = {
  input: JsonRecord
  args: JsonRecord
  output?: unknown
  result?: unknown
  error?: unknown
  attachments: NormalizedAttachment[]
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

function normalizeAttachment(value: unknown): NormalizedAttachment | null {
  const record = asRecord(value)
  const mime = readRecordString(record, ['mime'])
  const url = readRecordString(record, ['url', 'uri'])
  if (!mime || !url) return null
  const filename = readRecordString(record, ['filename', 'name']) || undefined
  return filename ? { mime, url, filename } : { mime, url }
}

function normalizeToolState(value: unknown): NormalizedToolState {
  const record = asRecord(value)
  return {
    input: asRecord(record.input),
    args: asRecord(record.args),
    output: record.output,
    result: record.result,
    error: record.error,
    attachments: asArray(record.attachments)
      .map(normalizeAttachment)
      .filter((entry): entry is NormalizedAttachment => Boolean(entry)),
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
      updated: readRecordNumber(time, ['updated']) || undefined,
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
  const content = asArray(state.content).map(normalizeV2ToolContent)
  const input = status === 'pending'
    ? parsePendingToolInput(state.input)
    : asRecord(state.input)
  const attachments = asArray(state.attachments)
    .map(normalizeAttachment)
    .filter((entry): entry is NormalizedAttachment => Boolean(entry))
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
    for (const file of asArray(record.files)) {
      const attachment = normalizeAttachment(file)
      if (!attachment) continue
      const part = simplePart('file', null, null)
      part.attachments = [attachment]
      parts.push(part)
    }
  } else if (type === 'assistant') {
    for (const content of asArray(record.content)) {
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
  }
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
    structured: record.structured,
    parts: asArray(record.parts)
      .map(normalizeMessagePart)
      .filter((part): part is NormalizedMessagePart => Boolean(part)),
  }
}

export function normalizeSessionMessages(value: SdkClassicSessionMessagesResponse | SdkV2SessionMessagesPage | SdkV2SessionMessage[]): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[] {
  const record = asRecord(value)
  const messages = Array.isArray(value) ? value : asArray(record.data)
  return messages
    .map(normalizeSessionMessage)
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
    attachments: asArray(record.attachments)
      .map(normalizeAttachment)
      .filter((entry): entry is NormalizedAttachment => Boolean(entry)),
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
  const properties = Object.keys(sourceProperties).length > 0
    ? sourceProperties
    : Object.keys(nestedProperties).length > 0
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
  return Object.fromEntries(
    Object.entries(record).map(([sessionId, status]) => {
      const normalized = asRecord(status)
      return [sessionId, { type: readRecordString(normalized, ['type']) }]
    }),
  )
}

export function normalizeMcpStatusEntries(value: Record<string, SdkMcpStatus>): NormalizedMcpStatusEntry[]
export function normalizeMcpStatusEntries(value: unknown): NormalizedMcpStatusEntry[]
export function normalizeMcpStatusEntries(value: unknown): NormalizedMcpStatusEntry[] {
  const record = asRecord(value)
  return Object.entries(record).map(([name, status]) => {
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
    return entry
  })
}

export function normalizeRuntimeCommands(value: unknown): NormalizedRuntimeCommand[] {
  const commands: NormalizedRuntimeCommand[] = []
  for (const entry of asArray(value)) {
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
