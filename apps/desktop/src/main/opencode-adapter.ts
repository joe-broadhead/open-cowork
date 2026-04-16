import type { TodoItem } from '@open-cowork/shared'

type JsonRecord = Record<string, unknown>

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
}

export type NormalizedRuntimeCommand = {
  name: string
  description?: string
  source?: string
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string | null {
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

export function normalizeSessionInfo(value: unknown): NormalizedSessionInfo | null {
  const record = asRecord(value)
  const id = readRecordString(record, ['id'])
  if (!id) return null
  const time = asRecord(record.time)
  const model = asRecord(record.model)
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
      providerId: readRecordString(model, ['providerID', 'providerId']),
      modelId: readRecordString(model, ['modelID', 'modelId']),
    },
  }
}

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
    parts: asArray(record.parts)
      .map(normalizeMessagePart)
      .filter((part): part is NormalizedMessagePart => Boolean(part)),
  }
}

export function normalizeSessionMessages(value: unknown): NormalizedSessionMessage[] {
  return asArray(value)
    .map(normalizeSessionMessage)
    .filter((message): message is NormalizedSessionMessage => Boolean(message))
}

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

export function normalizeSessionStatuses(value: unknown): Record<string, NormalizedSessionStatus> {
  const record = asRecord(value)
  return Object.fromEntries(
    Object.entries(record).map(([sessionId, status]) => {
      const normalized = asRecord(status)
      return [sessionId, { type: readRecordString(normalized, ['type']) }]
    }),
  )
}

export function normalizeMcpStatusEntries(value: unknown): NormalizedMcpStatusEntry[] {
  const record = asRecord(value)
  return Object.entries(record).map(([name, status]) => {
    const normalized = asRecord(status)
    const rawStatus = readRecordString(normalized, ['status'])
    return {
      name,
      connected: rawStatus === 'connected',
      rawStatus: rawStatus || undefined,
    }
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

export function readRecord(record: unknown): JsonRecord {
  return asRecord(record)
}

export function readRecordArray(record: unknown, key: string): unknown[] {
  return asArray(asRecord(record)[key])
}

export function readRecordValue(record: unknown, key: string): unknown {
  return asRecord(record)[key]
}

export function readStringValue(value: unknown): string | null {
  return readString(value)
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
