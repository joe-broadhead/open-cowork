import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  WorkLedgerDrilldownRoute,
  WorkLedgerEntry,
  WorkLedgerFacetBucket,
  WorkLedgerFacetSummary,
  WorkLedgerReviewState,
  WorkLedgerSearchQuery,
  WorkLedgerSearchResult,
  WorkLedgerSort,
  WorkLedgerSourceKind,
  WorkLedgerSourceRef,
  WorkLedgerStatus,
  WorkLedgerUpsertInput,
} from '@open-cowork/shared'
import {
  COWORK_WORK_LEDGER_SCHEMA_VERSION,
  WORK_LEDGER_FILTER_MAX_VALUES,
  WORK_LEDGER_QUERY_MAX_LENGTH,
  WORK_LEDGER_SEARCH_DEFAULT_LIMIT,
  WORK_LEDGER_SEARCH_MAX_LIMIT,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'

export const WORK_LEDGER_SCHEMA_VERSION = 1
const WORK_LEDGER_SCHEMA_VERSION_KEY = 'schema_version'
const WORK_LEDGER_METADATA_VERSION = 1
const MAX_ENTRY_TEXT_BYTES = 512
const MAX_SUMMARY_BYTES = 1024
const MAX_JSON_BYTES = 16 * 1024

const SOURCE_KINDS = new Set<WorkLedgerSourceKind>([
  'thread',
  'automation',
  'automation_run',
  'crew',
  'crew_run',
  'delegated_task',
  'approval',
  'question',
  'delivery',
  'channel_event',
  'governance_incident',
])

const STATUSES = new Set<WorkLedgerStatus>([
  'active',
  'approval_required',
  'approved',
  'archived',
  'automation',
  'blocked',
  'cancelled',
  'completed',
  'delivered',
  'delivering',
  'denied',
  'dispatching',
  'dispatched',
  'dismissed',
  'draft',
  'drafted',
  'enriching',
  'error',
  'evaluating',
  'failed',
  'idle',
  'needs_user',
  'paused',
  'planning',
  'queued',
  'ready',
  'received',
  'retired',
  'reverted',
  'review',
  'running',
  'sending',
  'succeeded',
  'unknown',
])

const REVIEW_STATES = new Set<WorkLedgerReviewState>([
  'none',
  'needs_review',
  'approval_requested',
  'approved',
  'denied',
  'resolved',
  'failed',
])

type Row = Record<string, unknown>
type WhereClause = { sql: string; args: SQLInputValue[] }

let workLedgerStore: WorkLedgerStore | null = null

function getWorkLedgerDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'work-ledger.sqlite')
}

function ensureWorkLedgerDbFileModes(dbPath: string) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(next)))
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function json(value: unknown) {
  return JSON.stringify(value)
}

export function redactWorkLedgerText(value: string) {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
}

function normalizeText(value: unknown, maxLength: number, field: string) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const trimmed = redactWorkLedgerText(value.trim())
  if (!trimmed) throw new Error(`${field} is required.`)
  if (Buffer.byteLength(trimmed, 'utf8') > maxLength) throw new Error(`${field} exceeds ${maxLength} bytes.`)
  return trimmed
}

function normalizeOptionalText(value: unknown, maxLength: number, field: string) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const trimmed = redactWorkLedgerText(value.trim())
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > maxLength) throw new Error(`${field} exceeds ${maxLength} bytes.`)
  return trimmed
}

function normalizeOptionalQueryText(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Work ledger query text must be a string.')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (Buffer.byteLength(trimmed, 'utf8') > WORK_LEDGER_QUERY_MAX_LENGTH) {
    throw new Error(`Work ledger query text exceeds ${WORK_LEDGER_QUERY_MAX_LENGTH} bytes.`)
  }
  return trimmed
}

function normalizeIdList(value: unknown, field: string, max = WORK_LEDGER_FILTER_MAX_VALUES) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`)
  if (value.length > max) throw new Error(`${field} exceeds ${max} values.`)
  const entries = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings.`)
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 256) throw new Error(`${field} contains an invalid entry.`)
    return trimmed
  })
  return Array.from(new Set(entries))
}

function normalizeSourceKinds(value: unknown) {
  const values = normalizeIdList(value, 'sourceKinds')
  if (!values) return undefined
  return values.map((kind) => {
    if (!SOURCE_KINDS.has(kind as WorkLedgerSourceKind)) throw new Error(`Invalid work ledger source kind: ${kind}`)
    return kind as WorkLedgerSourceKind
  })
}

function normalizeStatuses(value: unknown) {
  const values = normalizeIdList(value, 'statuses')
  if (!values) return undefined
  return values.map((status) => {
    if (!STATUSES.has(status as WorkLedgerStatus)) throw new Error(`Invalid work ledger status: ${status}`)
    return status as WorkLedgerStatus
  })
}

function normalizeReviewStates(value: unknown) {
  const values = normalizeIdList(value, 'reviewStates')
  if (!values) return undefined
  return values.map((state) => {
    if (!REVIEW_STATES.has(state as WorkLedgerReviewState)) throw new Error(`Invalid work ledger review state: ${state}`)
    return state as WorkLedgerReviewState
  })
}

function normalizeDateRange(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('dateRange must be an object.')
  const input = value as { from?: unknown; to?: unknown }
  const from = typeof input.from === 'string' && input.from.trim() ? input.from.trim() : undefined
  const to = typeof input.to === 'string' && input.to.trim() ? input.to.trim() : undefined
  return from || to ? { from, to } : undefined
}

function normalizeSort(value: unknown): WorkLedgerSort {
  if (value === undefined || value === null) return 'updated_desc'
  if (value === 'updated_desc' || value === 'created_desc' || value === 'title_asc') return value
  throw new Error(`Invalid work ledger sort: ${String(value)}`)
}

export function normalizeWorkLedgerSearchQuery(input: unknown = {}): WorkLedgerSearchQuery {
  if (input === undefined || input === null) return { limit: WORK_LEDGER_SEARCH_DEFAULT_LIMIT, sort: 'updated_desc' }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Work ledger search query must be an object.')
  const query = input as WorkLedgerSearchQuery
  return {
    text: normalizeOptionalQueryText(query.text),
    cursor: typeof query.cursor === 'string' && query.cursor.trim() ? query.cursor.trim() : null,
    limit: clampInteger(query.limit, WORK_LEDGER_SEARCH_DEFAULT_LIMIT, 1, WORK_LEDGER_SEARCH_MAX_LIMIT),
    dateRange: normalizeDateRange(query.dateRange),
    sourceKinds: normalizeSourceKinds(query.sourceKinds),
    statuses: normalizeStatuses(query.statuses),
    owners: normalizeIdList(query.owners, 'owners'),
    agents: normalizeIdList(query.agents, 'agents'),
    capabilities: normalizeIdList(query.capabilities, 'capabilities'),
    riskLabels: normalizeIdList(query.riskLabels, 'riskLabels'),
    governanceLabels: normalizeIdList(query.governanceLabels, 'governanceLabels'),
    reviewStates: normalizeReviewStates(query.reviewStates),
    needsUserAttention: typeof query.needsUserAttention === 'boolean' ? query.needsUserAttention : null,
    sort: normalizeSort(query.sort),
  }
}

function likePattern(text: string) {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

function makePlaceholders(values: unknown[]) {
  return values.map(() => '?').join(', ')
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor?: string | null) {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    return clampInteger(parsed.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  } catch {
    throw new Error('Invalid work ledger cursor.')
  }
}

function sortSql(sort: WorkLedgerSort | undefined) {
  if (sort === 'created_desc') return 'created_at desc, id asc'
  if (sort === 'title_asc') return 'lower(title) asc, updated_at desc, id asc'
  return 'updated_at desc, id asc'
}

function tokensFromRow(row: Row) {
  return {
    input: asNumber(row.input_tokens),
    output: asNumber(row.output_tokens),
    reasoning: asNumber(row.reasoning_tokens),
    cacheRead: asNumber(row.cache_read_tokens),
    cacheWrite: asNumber(row.cache_write_tokens),
  }
}

function normalizeSidecarValues(values: string[] | undefined, field: string) {
  if (!values) return []
  return (normalizeIdList(values, field, WORK_LEDGER_FILTER_MAX_VALUES) || [])
    .map((value) => redactWorkLedgerText(value))
}

function assertJsonSize(value: unknown, label: string) {
  const serialized = json(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} is too large.`)
  return serialized
}

function normalizeEntry(input: WorkLedgerUpsertInput): WorkLedgerEntry {
  if (!SOURCE_KINDS.has(input.sourceKind)) throw new Error(`Invalid work ledger source kind: ${input.sourceKind}`)
  if (!STATUSES.has(input.status)) throw new Error(`Invalid work ledger status: ${input.status}`)
  if (!REVIEW_STATES.has(input.reviewState)) throw new Error(`Invalid work ledger review state: ${input.reviewState}`)
  const sourceId = normalizeText(input.sourceId, 512, 'Work ledger source id')
  const id = normalizeText(input.id || `${input.sourceKind}:${sourceId}`, 768, 'Work ledger id')
  const sourceRef = { ...input.sourceRef, kind: input.sourceKind, id: input.sourceRef?.id || sourceId } satisfies WorkLedgerSourceRef
  assertJsonSize(sourceRef, 'Work ledger source reference')
  assertJsonSize(input.route, 'Work ledger route')
  return {
    schemaVersion: input.schemaVersion || COWORK_WORK_LEDGER_SCHEMA_VERSION,
    id,
    sourceKind: input.sourceKind,
    sourceId,
    title: normalizeText(input.title || 'Untitled work', MAX_ENTRY_TEXT_BYTES, 'Work ledger title'),
    summary: normalizeOptionalText(input.summary, MAX_SUMMARY_BYTES, 'Work ledger summary'),
    status: input.status,
    sourceLabel: normalizeText(input.sourceLabel || input.sourceKind, 256, 'Work ledger source label'),
    owner: normalizeOptionalText(input.owner, 256, 'Work ledger owner'),
    agents: normalizeSidecarValues(input.agents, 'agents'),
    capabilities: normalizeSidecarValues(input.capabilities, 'capabilities'),
    usage: {
      cost: Math.max(0, Number(input.usage?.cost || 0) || 0),
      tokens: {
        input: Math.max(0, Math.trunc(Number(input.usage?.tokens?.input || 0) || 0)),
        output: Math.max(0, Math.trunc(Number(input.usage?.tokens?.output || 0) || 0)),
        reasoning: Math.max(0, Math.trunc(Number(input.usage?.tokens?.reasoning || 0) || 0)),
        cacheRead: Math.max(0, Math.trunc(Number(input.usage?.tokens?.cacheRead || 0) || 0)),
        cacheWrite: Math.max(0, Math.trunc(Number(input.usage?.tokens?.cacheWrite || 0) || 0)),
      },
    },
    riskLabels: normalizeSidecarValues(input.riskLabels, 'riskLabels'),
    governanceLabels: normalizeSidecarValues(input.governanceLabels, 'governanceLabels'),
    reviewState: input.reviewState,
    needsUserAttention: Boolean(input.needsUserAttention),
    sourceRef,
    route: input.route,
    createdAt: normalizeText(input.createdAt, 64, 'Work ledger createdAt'),
    updatedAt: normalizeText(input.updatedAt, 64, 'Work ledger updatedAt'),
    startedAt: normalizeOptionalText(input.startedAt, 64, 'Work ledger startedAt'),
    finishedAt: normalizeOptionalText(input.finishedAt, 64, 'Work ledger finishedAt'),
    indexedAt: input.indexedAt || nowIso(),
  }
}

export class WorkLedgerStore {
  private db: DatabaseSync
  private transactionCounter = 0
  private readonly dbPath: string

  constructor(dbPath = getWorkLedgerDbPath()) {
    this.dbPath = dbPath
    mkdirSync(join(dbPath, '..'), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    try {
      this.db.exec('pragma journal_mode = WAL;')
      this.migrate()
      ensureWorkLedgerDbFileModes(this.dbPath)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private migrate() {
    this.db.exec(`
      create table if not exists work_ledger_meta (
        key text primary key,
        value text not null
      );
    `)
    const version = this.readSchemaVersion()
    if (version > WORK_LEDGER_SCHEMA_VERSION) {
      throw new Error(`Work ledger schema version ${version} is newer than supported version ${WORK_LEDGER_SCHEMA_VERSION}.`)
    }
    this.db.exec(`
      create table if not exists work_ledger_entries (
        id text primary key,
        source_kind text not null,
        source_id text not null,
        title text not null,
        summary text,
        status text not null,
        source_label text not null,
        owner text,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        cost real not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        review_state text not null,
        needs_user_attention integer not null default 0,
        source_ref_json text not null,
        route_json text not null,
        indexed_at text not null,
        schema_version integer not null,
        metadata_version integer not null,
        unique(source_kind, source_id)
      );

      create table if not exists work_ledger_entry_agents (
        entry_id text not null,
        value text not null,
        primary key(entry_id, value)
      );

      create table if not exists work_ledger_entry_capabilities (
        entry_id text not null,
        value text not null,
        primary key(entry_id, value)
      );

      create table if not exists work_ledger_entry_risk_labels (
        entry_id text not null,
        value text not null,
        primary key(entry_id, value)
      );

      create table if not exists work_ledger_entry_governance_labels (
        entry_id text not null,
        value text not null,
        primary key(entry_id, value)
      );

      create index if not exists idx_work_ledger_updated on work_ledger_entries(updated_at desc, id);
      create index if not exists idx_work_ledger_created on work_ledger_entries(created_at desc, id);
      create index if not exists idx_work_ledger_title on work_ledger_entries(lower(title), id);
      create index if not exists idx_work_ledger_source on work_ledger_entries(source_kind, source_id);
      create index if not exists idx_work_ledger_status on work_ledger_entries(status);
      create index if not exists idx_work_ledger_owner on work_ledger_entries(owner);
      create index if not exists idx_work_ledger_attention on work_ledger_entries(needs_user_attention, updated_at desc);
      create index if not exists idx_work_ledger_review on work_ledger_entries(review_state);
      create index if not exists idx_work_ledger_agents_value on work_ledger_entry_agents(value);
      create index if not exists idx_work_ledger_capabilities_value on work_ledger_entry_capabilities(value);
      create index if not exists idx_work_ledger_risk_value on work_ledger_entry_risk_labels(value);
      create index if not exists idx_work_ledger_governance_value on work_ledger_entry_governance_labels(value);
    `)
    this.recordSchemaVersion()
  }

  private readSchemaVersion() {
    const row = this.db.prepare('select value from work_ledger_meta where key = ?')
      .get(WORK_LEDGER_SCHEMA_VERSION_KEY) as { value?: string } | undefined
    const version = Number(row?.value || 0)
    return Number.isInteger(version) && version >= 0 ? version : 0
  }

  private recordSchemaVersion() {
    this.db.prepare(`
      insert into work_ledger_meta (key, value)
      values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(WORK_LEDGER_SCHEMA_VERSION_KEY, String(WORK_LEDGER_SCHEMA_VERSION))
  }

  private withTransaction<T>(callback: () => T): T {
    const savepoint = `work_ledger_tx_${this.transactionCounter += 1}`
    this.db.exec(`savepoint ${savepoint}`)
    try {
      const result = callback()
      this.db.exec(`release savepoint ${savepoint}`)
      ensureWorkLedgerDbFileModes(this.dbPath)
      return result
    } catch (error) {
      try {
        this.db.exec(`rollback to savepoint ${savepoint}`)
      } finally {
        this.db.exec(`release savepoint ${savepoint}`)
        ensureWorkLedgerDbFileModes(this.dbPath)
      }
      throw error
    }
  }

  upsertEntries(inputs: WorkLedgerUpsertInput[]) {
    const entries = inputs.map(normalizeEntry)
    this.withTransaction(() => {
      for (const entry of entries) this.upsertEntryInTransaction(entry)
    })
    return entries
  }

  upsertEntry(input: WorkLedgerUpsertInput) {
    return this.upsertEntries([input])[0]!
  }

  private upsertEntryInTransaction(entry: WorkLedgerEntry) {
    this.db.prepare(`
      insert into work_ledger_entries (
        id, source_kind, source_id, title, summary, status, source_label, owner,
        created_at, updated_at, started_at, finished_at,
        cost, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
        review_state, needs_user_attention, source_ref_json, route_json, indexed_at, schema_version, metadata_version
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        title = excluded.title,
        summary = excluded.summary,
        status = excluded.status,
        source_label = excluded.source_label,
        owner = excluded.owner,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        cost = excluded.cost,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        review_state = excluded.review_state,
        needs_user_attention = excluded.needs_user_attention,
        source_ref_json = excluded.source_ref_json,
        route_json = excluded.route_json,
        indexed_at = excluded.indexed_at,
        schema_version = excluded.schema_version,
        metadata_version = excluded.metadata_version
    `).run(
      entry.id,
      entry.sourceKind,
      entry.sourceId,
      entry.title,
      entry.summary,
      entry.status,
      entry.sourceLabel,
      entry.owner,
      entry.createdAt,
      entry.updatedAt,
      entry.startedAt,
      entry.finishedAt,
      entry.usage.cost,
      entry.usage.tokens.input,
      entry.usage.tokens.output,
      entry.usage.tokens.reasoning,
      entry.usage.tokens.cacheRead,
      entry.usage.tokens.cacheWrite,
      entry.reviewState,
      entry.needsUserAttention ? 1 : 0,
      assertJsonSize(entry.sourceRef, 'Work ledger source reference'),
      assertJsonSize(entry.route, 'Work ledger route'),
      entry.indexedAt,
      entry.schemaVersion,
      WORK_LEDGER_METADATA_VERSION,
    )
    this.replaceSidecar('work_ledger_entry_agents', entry.id, entry.agents)
    this.replaceSidecar('work_ledger_entry_capabilities', entry.id, entry.capabilities)
    this.replaceSidecar('work_ledger_entry_risk_labels', entry.id, entry.riskLabels)
    this.replaceSidecar('work_ledger_entry_governance_labels', entry.id, entry.governanceLabels)
  }

  deleteEntriesNotIn(entryIds: string[]) {
    const ids = normalizeIdList(entryIds, 'entryIds', Number.MAX_SAFE_INTEGER) || []
    this.withTransaction(() => {
      this.db.exec('create temp table if not exists work_ledger_keep_ids (id text primary key);')
      this.db.exec('delete from work_ledger_keep_ids;')
      const insert = this.db.prepare('insert into work_ledger_keep_ids (id) values (?)')
      for (const id of ids) insert.run(id)
      this.db.prepare(`
        delete from work_ledger_entries
        where not exists (
          select 1 from work_ledger_keep_ids keep where keep.id = work_ledger_entries.id
        )
      `).run()
      this.deleteOrphanSidecars()
      this.db.exec('delete from work_ledger_keep_ids;')
    })
  }

  private replaceSidecar(tableName: string, entryId: string, values: string[]) {
    this.db.prepare(`delete from ${tableName} where entry_id = ?`).run(entryId)
    const insert = this.db.prepare(`insert into ${tableName} (entry_id, value) values (?, ?)`)
    for (const value of values.slice(0, WORK_LEDGER_FILTER_MAX_VALUES)) {
      insert.run(entryId, normalizeText(value, 256, 'Work ledger sidecar value'))
    }
  }

  private deleteOrphanSidecars() {
    for (const table of [
      'work_ledger_entry_agents',
      'work_ledger_entry_capabilities',
      'work_ledger_entry_risk_labels',
      'work_ledger_entry_governance_labels',
    ]) {
      this.db.prepare(`
        delete from ${table}
        where not exists (
          select 1 from work_ledger_entries entry where entry.id = ${table}.entry_id
        )
      `).run()
    }
  }

  private buildWhere(input: WorkLedgerSearchQuery): WhereClause {
    const query = normalizeWorkLedgerSearchQuery(input)
    const clauses: string[] = []
    const args: SQLInputValue[] = []
    if (query.text) {
      const pattern = likePattern(query.text)
      clauses.push(`(
        lower(title) like ? escape '\\'
        or lower(coalesce(summary, '')) like ? escape '\\'
        or lower(source_label) like ? escape '\\'
        or lower(coalesce(owner, '')) like ? escape '\\'
        or exists (select 1 from work_ledger_entry_agents agent where agent.entry_id = work_ledger_entries.id and lower(agent.value) like ? escape '\\')
        or exists (select 1 from work_ledger_entry_capabilities capability where capability.entry_id = work_ledger_entries.id and lower(capability.value) like ? escape '\\')
        or exists (select 1 from work_ledger_entry_risk_labels risk where risk.entry_id = work_ledger_entries.id and lower(risk.value) like ? escape '\\')
        or exists (select 1 from work_ledger_entry_governance_labels governance where governance.entry_id = work_ledger_entries.id and lower(governance.value) like ? escape '\\')
      )`)
      args.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
    }
    if (query.dateRange?.from) {
      clauses.push('updated_at >= ?')
      args.push(query.dateRange.from)
    }
    if (query.dateRange?.to) {
      clauses.push('updated_at <= ?')
      args.push(query.dateRange.to)
    }
    const addInClause = (field: string, values?: string[]) => {
      if (!values?.length) return
      clauses.push(`${field} in (${makePlaceholders(values)})`)
      args.push(...values)
    }
    addInClause('source_kind', query.sourceKinds)
    addInClause('status', query.statuses)
    addInClause('owner', query.owners)
    addInClause('review_state', query.reviewStates)
    if (query.needsUserAttention !== null && query.needsUserAttention !== undefined) {
      clauses.push('needs_user_attention = ?')
      args.push(query.needsUserAttention ? 1 : 0)
    }
    const addSidecarFilter = (tableName: string, values?: string[]) => {
      if (!values?.length) return
      clauses.push(`exists (select 1 from ${tableName} sidecar where sidecar.entry_id = work_ledger_entries.id and sidecar.value in (${makePlaceholders(values)}))`)
      args.push(...values)
    }
    addSidecarFilter('work_ledger_entry_agents', query.agents)
    addSidecarFilter('work_ledger_entry_capabilities', query.capabilities)
    addSidecarFilter('work_ledger_entry_risk_labels', query.riskLabels)
    addSidecarFilter('work_ledger_entry_governance_labels', query.governanceLabels)
    return { sql: clauses.length ? `where ${clauses.join(' and ')}` : '', args }
  }

  searchEntries(input: WorkLedgerSearchQuery = {}): WorkLedgerSearchResult {
    const query = normalizeWorkLedgerSearchQuery(input)
    const limit = query.limit || WORK_LEDGER_SEARCH_DEFAULT_LIMIT
    const offset = decodeCursor(query.cursor)
    const where = this.buildWhere(query)
    const total = this.db.prepare(`select count(*) as count from work_ledger_entries ${where.sql}`)
      .get(...where.args) as { count?: number } | undefined
    const rows = this.db.prepare(`
      select *
      from work_ledger_entries
      ${where.sql}
      order by ${sortSql(query.sort)}
      limit ? offset ?
    `).all(...where.args, limit, offset) as Row[]
    const entries = this.hydrateRows(rows)
    const totalEstimate = Number(total?.count || 0)
    const nextOffset = offset + rows.length
    return {
      entries,
      nextCursor: nextOffset < totalEstimate ? encodeCursor(nextOffset) : null,
      totalEstimate,
    }
  }

  listFacets(input: WorkLedgerSearchQuery = {}): WorkLedgerFacetSummary {
    const query = normalizeWorkLedgerSearchQuery({ ...input, cursor: null })
    const where = this.buildWhere(query)
    const bucket = (sql: string, args: SQLInputValue[] = where.args): WorkLedgerFacetBucket[] => (
      this.db.prepare(sql).all(...args) as Row[]
    ).map((row) => ({
      value: asString(row.value),
      label: asString(row.label, asString(row.value)),
      count: asNumber(row.count),
    }))
    const baseWhere = where.sql
    const whereAnd = (extra: string) => baseWhere ? `${baseWhere} and ${extra}` : `where ${extra}`
    return {
      sourceKinds: bucket(`select source_kind as value, source_kind as label, count(*) as count from work_ledger_entries ${baseWhere} group by source_kind order by count desc, source_kind asc`),
      statuses: bucket(`select status as value, status as label, count(*) as count from work_ledger_entries ${baseWhere} group by status order by count desc, status asc`),
      owners: bucket(`select owner as value, owner as label, count(*) as count from work_ledger_entries ${whereAnd('owner is not null')} group by owner order by count desc, owner asc`),
      reviewStates: bucket(`select review_state as value, review_state as label, count(*) as count from work_ledger_entries ${baseWhere} group by review_state order by count desc, review_state asc`),
      agents: bucket(`select sidecar.value as value, sidecar.value as label, count(*) as count from work_ledger_entries join work_ledger_entry_agents sidecar on sidecar.entry_id = work_ledger_entries.id ${baseWhere} group by sidecar.value order by count desc, sidecar.value asc`),
      capabilities: bucket(`select sidecar.value as value, sidecar.value as label, count(*) as count from work_ledger_entries join work_ledger_entry_capabilities sidecar on sidecar.entry_id = work_ledger_entries.id ${baseWhere} group by sidecar.value order by count desc, sidecar.value asc`),
      riskLabels: bucket(`select sidecar.value as value, sidecar.value as label, count(*) as count from work_ledger_entries join work_ledger_entry_risk_labels sidecar on sidecar.entry_id = work_ledger_entries.id ${baseWhere} group by sidecar.value order by count desc, sidecar.value asc`),
      governanceLabels: bucket(`select sidecar.value as value, sidecar.value as label, count(*) as count from work_ledger_entries join work_ledger_entry_governance_labels sidecar on sidecar.entry_id = work_ledger_entries.id ${baseWhere} group by sidecar.value order by count desc, sidecar.value asc`),
    }
  }

  private hydrateRows(rows: Row[]): WorkLedgerEntry[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => asString(row.id))
    const agents = this.groupSidecar('work_ledger_entry_agents', ids)
    const capabilities = this.groupSidecar('work_ledger_entry_capabilities', ids)
    const riskLabels = this.groupSidecar('work_ledger_entry_risk_labels', ids)
    const governanceLabels = this.groupSidecar('work_ledger_entry_governance_labels', ids)
    return rows.map((row) => {
      const id = asString(row.id)
      const sourceKind = asString(row.source_kind, 'thread') as WorkLedgerSourceKind
      const sourceId = asString(row.source_id)
      return {
        schemaVersion: asNumber(row.schema_version) || COWORK_WORK_LEDGER_SCHEMA_VERSION,
        id,
        sourceKind,
        sourceId,
        title: asString(row.title, 'Untitled work'),
        summary: asNullableString(row.summary),
        status: asString(row.status, 'unknown') as WorkLedgerStatus,
        sourceLabel: asString(row.source_label, sourceKind),
        owner: asNullableString(row.owner),
        agents: agents.get(id) || [],
        capabilities: capabilities.get(id) || [],
        usage: {
          cost: asNumber(row.cost),
          tokens: tokensFromRow(row),
        },
        riskLabels: riskLabels.get(id) || [],
        governanceLabels: governanceLabels.get(id) || [],
        reviewState: asString(row.review_state, 'none') as WorkLedgerReviewState,
        needsUserAttention: Number(row.needs_user_attention || 0) === 1,
        sourceRef: parseJson<WorkLedgerSourceRef>(row.source_ref_json, { kind: sourceKind, id: sourceId }),
        route: parseJson<WorkLedgerDrilldownRoute>(row.route_json, { surface: 'operations' }),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
        startedAt: asNullableString(row.started_at),
        finishedAt: asNullableString(row.finished_at),
        indexedAt: asString(row.indexed_at),
      }
    })
  }

  private groupSidecar(tableName: string, entryIds: string[]) {
    const map = new Map<string, string[]>()
    if (entryIds.length === 0) return map
    const placeholders = makePlaceholders(entryIds)
    const rows = this.db.prepare(`
      select entry_id, value
      from ${tableName}
      where entry_id in (${placeholders})
      order by value asc
    `).all(...entryIds) as Row[]
    for (const row of rows) {
      const entryId = asString(row.entry_id)
      map.set(entryId, [...(map.get(entryId) || []), asString(row.value)])
    }
    return map
  }
}

export function getWorkLedgerStore() {
  if (!workLedgerStore) workLedgerStore = new WorkLedgerStore()
  return workLedgerStore
}

export function clearWorkLedgerStoreCache() {
  workLedgerStore?.close()
  workLedgerStore = null
}
