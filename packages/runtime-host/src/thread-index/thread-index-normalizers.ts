import type {
  ThreadSearchQuery,
  ThreadSmartFilterInput,
  ThreadStatus,
  ThreadSuggestionInput,
  ThreadTagInput,
} from '@open-cowork/shared'
import {
  THREAD_FILTER_MAX_VALUES,
  THREAD_QUERY_MAX_LENGTH,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  THREAD_SMART_FILTER_NAME_MAX_LENGTH,
  THREAD_SUGGESTION_LABEL_MAX_LENGTH,
  THREAD_SUGGESTION_REASON_MAX_LENGTH,
  THREAD_TAG_NAME_MAX_LENGTH,
} from '@open-cowork/shared'

export const THREAD_INDEX_METADATA_VERSION = 1
export const THREAD_DEFAULT_TAG_COLOR = '#64748b'
const SMART_FILTER_QUERY_MAX_BYTES = 16_384
const MAX_SUGGESTION_EVIDENCE_ITEMS = 12
const SUGGESTION_EVIDENCE_TYPES = new Set(['title', 'project', 'provider', 'model', 'agent', 'tool'])
const THREAD_STATUSES = new Set<ThreadStatus>(['idle', 'running', 'needs_user', 'error', 'reverted', 'workflow'])

export function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

export function asNullableString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(next)))
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function json(value: unknown) {
  return JSON.stringify(value)
}

export function normalizeText(value: unknown, maxLength: number, field: string) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} is required.`)
  if (Buffer.byteLength(trimmed, 'utf8') > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} bytes.`)
  }
  return trimmed
}

function normalizeOptionalQueryText(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Thread query text must be a string.')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (Buffer.byteLength(trimmed, 'utf8') > THREAD_QUERY_MAX_LENGTH) {
    throw new Error(`Thread query text exceeds ${THREAD_QUERY_MAX_LENGTH} bytes.`)
  }
  return trimmed
}

export function normalizeIdList(value: unknown, field: string, max = THREAD_FILTER_MAX_VALUES) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`)
  if (value.length > max) throw new Error(`${field} exceeds ${max} values.`)
  const next = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings.`)
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 256) throw new Error(`${field} contains an invalid entry.`)
    return trimmed
  })
  return Array.from(new Set(next))
}

function normalizeStatuses(value: unknown) {
  const values = normalizeIdList(value, 'statuses')
  if (!values) return undefined
  return values.map((status) => {
    if (!THREAD_STATUSES.has(status as ThreadStatus)) throw new Error(`Invalid thread status: ${status}`)
    return status as ThreadStatus
  })
}

export function normalizeStoredThreadStatus(value: unknown): ThreadStatus {
  const status = asString(value, 'idle')
  return THREAD_STATUSES.has(status as ThreadStatus) ? status as ThreadStatus : 'idle'
}

function normalizeSort(value: unknown) {
  if (value === undefined || value === null) return 'updated_desc' as const
  if (value === 'updated_desc' || value === 'created_desc' || value === 'title_asc') return value
  throw new Error(`Invalid thread sort: ${String(value)}`)
}

function normalizeDateRange(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('dateRange must be an object.')
  const input = value as { from?: unknown; to?: unknown }
  const from = typeof input.from === 'string' && input.from.trim() ? input.from.trim() : undefined
  const to = typeof input.to === 'string' && input.to.trim() ? input.to.trim() : undefined
  return from || to ? { from, to } : undefined
}

export function normalizeThreadSearchQuery(input: unknown = {}): ThreadSearchQuery {
  if (input === undefined || input === null) return { limit: THREAD_SEARCH_DEFAULT_LIMIT, sort: 'updated_desc' }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Thread search query must be an object.')
  const query = input as ThreadSearchQuery
  return {
    text: normalizeOptionalQueryText(query.text),
    cursor: typeof query.cursor === 'string' && query.cursor.trim() ? query.cursor.trim() : null,
    limit: clampInteger(query.limit, THREAD_SEARCH_DEFAULT_LIMIT, 1, THREAD_SEARCH_MAX_LIMIT),
    dateRange: normalizeDateRange(query.dateRange),
    projectLabels: normalizeIdList(query.projectLabels, 'projectLabels'),
    directories: normalizeIdList(query.directories, 'directories'),
    providerIds: normalizeIdList(query.providerIds, 'providerIds'),
    modelIds: normalizeIdList(query.modelIds, 'modelIds'),
    agents: normalizeIdList(query.agents, 'agents'),
    tools: normalizeIdList(query.tools, 'tools'),
    mcps: normalizeIdList(query.mcps, 'mcps'),
    statuses: normalizeStatuses(query.statuses),
    tagIds: normalizeIdList(query.tagIds, 'tagIds'),
    smartFilterId: typeof query.smartFilterId === 'string' && query.smartFilterId.trim() ? query.smartFilterId.trim() : null,
    sort: normalizeSort(query.sort),
  }
}

export function normalizeTagInput(input: ThreadTagInput) {
  if (!input || typeof input !== 'object') throw new Error('Tag input must be an object.')
  const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
  const color = typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color.trim())
    ? input.color.trim()
    : THREAD_DEFAULT_TAG_COLOR
  return { name, color }
}

export function normalizeSmartFilterInput(input: ThreadSmartFilterInput) {
  if (!input || typeof input !== 'object') throw new Error('Smart filter input must be an object.')
  const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
  const query = normalizeThreadSearchQuery({ ...input.query, cursor: null, smartFilterId: null })
  const serialized = json(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return { name, query, serialized }
}

export function normalizeSuggestionInput(input: ThreadSuggestionInput) {
  if (!input || typeof input !== 'object') throw new Error('Suggestion input must be an object.')
  const label = normalizeText(input.label, THREAD_SUGGESTION_LABEL_MAX_LENGTH, 'Suggestion label')
  const reason = normalizeText(input.reason, THREAD_SUGGESTION_REASON_MAX_LENGTH, 'Suggestion reason')
  const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, MAX_SUGGESTION_EVIDENCE_ITEMS).map((entry) => {
    if (!SUGGESTION_EVIDENCE_TYPES.has(entry.type)) throw new Error('Suggestion evidence type is invalid.')
    return {
      type: entry.type,
      value: normalizeText(entry.value, THREAD_SUGGESTION_REASON_MAX_LENGTH, 'Suggestion evidence'),
    }
  }) : []
  return { label, reason, evidence }
}

export function likePattern(text: string) {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

export function makePlaceholders(values: unknown[]) {
  return values.map(() => '?').join(', ')
}

export function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor?: string | null) {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    return clampInteger(parsed.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  } catch {
    throw new Error('Invalid thread cursor.')
  }
}

export function sortSql(sort: ThreadSearchQuery['sort']) {
  if (sort === 'created_desc') return 'created_at desc, session_id asc'
  if (sort === 'title_asc') return 'lower(title) asc, updated_at desc, session_id asc'
  return 'updated_at desc, session_id asc'
}
