import type {
  Event as SdkEvent,
  GlobalEvent as SdkGlobalEvent,
  McpStatus as SdkMcpStatus,
  Message as SdkMessage,
  Part as SdkPart,
  Session as SdkSession,
  SessionMessagesResponse as SdkSessionMessagesResponse,
  SessionStatus as SdkSessionStatus,
} from '@opencode-ai/sdk/v2'
import type {
  ExplorerSymbol,
  FileContent,
  FileNode,
  FileStatus,
  TextMatch,
  TodoItem,
} from '@open-cowork/shared'

type JsonRecord = Record<string, unknown>
type SdkSessionMessage = SdkSessionMessagesResponse extends Array<infer T> ? T : never
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

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readRecordString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = readString(record[key])
    if (value) return value
  }
  return null
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

function readRecordNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = readNumber(record[key])
    if (value !== null) return value
  }
  return null
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
  const url = readRecordString(record, ['url'])
  if (!mime || !url) return null
  const filename = readRecordString(record, ['filename']) || undefined
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

export function normalizeSessionInfo(value: SdkSession | SdkMessage): NormalizedSessionInfo | null
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
      modelId: readRecordString(model, ['modelID', 'modelId']) || readRecordString(record, ['modelID', 'modelId']),
    },
    summary,
    revertedMessageId,
  }
}

export function normalizeSessionMessage(value: SdkSessionMessage | SdkMessage): NormalizedSessionMessage | null
export function normalizeSessionMessage(value: unknown): NormalizedSessionMessage | null
export function normalizeSessionMessage(value: unknown): NormalizedSessionMessage | null {
  const record = asRecord(value)
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

export function normalizeSessionMessages(value: SdkSessionMessagesResponse): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[]
export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[] {
  return asArray(value)
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
  const rawType = readRecordString(source, ['type']) || readRecordString(nested, ['type'])
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

export function readRecordArray(record: unknown, key: string): unknown[] {
  return asArray(asRecord(record)[key])
}

export function readRecordValue(record: unknown, key: string): unknown {
  return asRecord(record)[key]
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

// ── Explorer normalizers (SDK find.* + file.*) ────────────────────────────
// Keep renderer callers off snake_case (`line_number`), URI tuples, and
// optional-everywhere SDK shapes. One place to update when SDK types drift.

export function normalizeFileNode(value: unknown): FileNode | null {
  const record = asRecord(value)
  const name = readRecordString(record, ['name'])
  const path = readRecordString(record, ['path'])
  const absolute = readRecordString(record, ['absolute'])
  const type = readRecordString(record, ['type'])
  if (!name || !path || !absolute) return null
  if (type !== 'file' && type !== 'directory') return null
  return {
    name,
    path,
    absolute,
    type,
    ignored: record.ignored === true,
  }
}

export function normalizeFileNodes(value: unknown): FileNode[] {
  return asArray(value)
    .map(normalizeFileNode)
    .filter((node): node is FileNode => node !== null)
}

export function normalizeFileContent(value: unknown): FileContent | null {
  const record = asRecord(value)
  const type = readRecordString(record, ['type'])
  if (type !== 'text' && type !== 'binary') return null
  const content = typeof record.content === 'string' ? record.content : ''
  return {
    type,
    content,
    diff: readRecordString(record, ['diff']),
    // `patch` can be an object on v2; flatten to the reconstructed unified
    // diff string when possible, otherwise fall back to the string form.
    patch: readRecordString(record, ['patch']) ?? flattenPatch(record.patch),
    encoding: readRecordString(record, ['encoding']),
  }
}

function flattenPatch(value: unknown): string | null {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return null
  const hunks = asArray(record.hunks)
  if (hunks.length === 0) return null
  const out: string[] = []
  for (const hunk of hunks) {
    const h = asRecord(hunk)
    const oldStart = readRecordNumber(h, ['oldStart']) ?? 0
    const oldLines = readRecordNumber(h, ['oldLines']) ?? 0
    const newStart = readRecordNumber(h, ['newStart']) ?? 0
    const newLines = readRecordNumber(h, ['newLines']) ?? 0
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`)
    for (const line of asArray(h.lines)) {
      if (typeof line === 'string') out.push(line)
    }
  }
  return out.join('\n')
}

export function normalizeFileStatus(value: unknown): FileStatus | null {
  const record = asRecord(value)
  const path = readRecordString(record, ['path'])
  if (!path) return null
  const status = readRecordString(record, ['status'])
  if (status !== 'added' && status !== 'deleted' && status !== 'modified') return null
  return {
    path,
    added: readRecordNumber(record, ['added']) ?? 0,
    removed: readRecordNumber(record, ['removed']) ?? 0,
    status,
  }
}

export function normalizeFileStatuses(value: unknown): FileStatus[] {
  return asArray(value)
    .map(normalizeFileStatus)
    .filter((entry): entry is FileStatus => entry !== null)
}

function normalizeRangePos(value: unknown) {
  const record = asRecord(value)
  return {
    line: readRecordNumber(record, ['line']) ?? 0,
    col: readRecordNumber(record, ['col', 'character', 'column']) ?? 0,
  }
}

export function normalizeExplorerSymbol(value: unknown): ExplorerSymbol | null {
  const record = asRecord(value)
  const name = readRecordString(record, ['name'])
  if (!name) return null
  const location = asRecord(record.location)
  const uri = readRecordString(location, ['uri']) || ''
  const path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  const range = asRecord(location.range)
  return {
    name,
    kind: readRecordNumber(record, ['kind']) ?? 0,
    path,
    range: {
      start: normalizeRangePos(range.start),
      end: normalizeRangePos(range.end),
    },
  }
}

export function normalizeExplorerSymbols(value: unknown): ExplorerSymbol[] {
  return asArray(value)
    .map(normalizeExplorerSymbol)
    .filter((entry): entry is ExplorerSymbol => entry !== null)
}

export function normalizeTextMatch(value: unknown): TextMatch | null {
  const record = asRecord(value)
  const pathRec = asRecord(record.path)
  const path = readRecordString(pathRec, ['text'])
  if (!path) return null
  const linesRec = asRecord(record.lines)
  const lineText = readRecordString(linesRec, ['text']) ?? ''
  const lineNumber = readRecordNumber(record, ['line_number', 'lineNumber']) ?? 0
  const submatches = asArray(record.submatches).flatMap((entry) => {
    const sub = asRecord(entry)
    const match = asRecord(sub.match)
    const text = readRecordString(match, ['text'])
    const start = readRecordNumber(sub, ['start'])
    const end = readRecordNumber(sub, ['end'])
    if (text === null || start === null || end === null) return []
    return [{ text, start, end }]
  })
  return { path, lineNumber, lineText, submatches }
}

export function normalizeTextMatches(value: unknown): TextMatch[] {
  return asArray(value)
    .map(normalizeTextMatch)
    .filter((entry): entry is TextMatch => entry !== null)
}
