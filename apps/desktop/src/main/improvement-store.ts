import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AppSettings,
  COWORK_DREAM_RUN_SCHEMA_VERSION,
  COWORK_IMPROVEMENT_SCHEMA_VERSION,
  COWORK_MEMORY_SCHEMA_VERSION,
  COWORK_SOP_SCHEMA_VERSION,
  improvementProposalApprovalBlockReason,
  type AgentColor,
  type AgentMemoryDraft,
  type AgentMemoryEntry,
  type AgentMemoryScopeKind,
  type AgentMemoryStatus,
  type CrewDefinitionDraft,
  type DreamRun,
  type DreamRunDraft,
  type DreamRunStatus,
  type DreamRunStatusCounts,
  type CustomAgentConfig,
  type CustomSkillConfig,
  type ImprovementCandidateDiff,
  type ImprovementDiagnosticsSummary,
  type ImprovementEvidenceKind,
  type ImprovementEvidenceRef,
  type ImprovementPolicyDiagnostics,
  type ImprovementProposal,
  type ImprovementProposalDraft,
  type ImprovementReviewQueue,
  type ImprovementProposalStatus,
  type ImprovementProposalTargetType,
  type ImprovementStatusCounts,
  type MemoryInjectionPlan,
  type MemoryPrivacyClassification,
  type SopDraft,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import {
  isImprovementProposalEnabledForScope,
  type ImprovementProposalPolicyScope,
} from './improvement-policy.ts'
import {
  listCustomAgents,
  listCustomMcps,
  listCustomSkills,
  removeCustomAgent,
  removeCustomSkill,
  saveCustomAgent,
  saveCustomSkill,
} from './native-customizations.ts'
import { loadSettings } from './settings.ts'
import {
  CUSTOM_AGENT_COLORS,
  buildCustomAgentCatalog,
  normalizeCustomAgent,
  validateCustomAgent,
  type CustomAgentCatalog,
} from './custom-agents.ts'
import {
  createCrewFromDraft,
  createCrewEvalCase,
  getCrewDetail,
  updateCrewFromDraft,
  validateCrewDefinitionDraft,
} from './crew-service.ts'
import {
  createSop,
  getSop,
  updateSop,
} from './sop-service.ts'
import {
  sanitizeRetryPolicy,
  sanitizeRunPolicy,
} from './automation-store-model.ts'

export const IMPROVEMENT_STORE_SCHEMA_VERSION = 1

const IMPROVEMENT_SCHEMA_VERSION_KEY = 'schema_version'
const MAX_TEXT_BYTES = 16 * 1024
const MAX_BODY_BYTES = 64 * 1024
const MAX_JSON_BYTES = 256 * 1024
const DEFAULT_MEMORY_INJECTION_LIMIT = 12
const MAX_MEMORY_INJECTION_LIMIT = 50
const DEFAULT_REVIEW_QUEUE_LIMIT = 25
const MAX_REVIEW_QUEUE_LIMIT = 100

const MEMORY_SCOPE_KINDS = new Set<AgentMemoryScopeKind>(['machine', 'project', 'agent', 'crew'])
const MEMORY_STATUSES = new Set<AgentMemoryStatus>(['proposed', 'approved', 'rejected', 'archived'])
const PRIVACY_CLASSIFICATIONS = new Set<MemoryPrivacyClassification>(['public', 'internal', 'sensitive', 'restricted'])
const EVIDENCE_KINDS = new Set<ImprovementEvidenceKind>(['run', 'artifact', 'eval', 'trace', 'thread', 'session', 'sop', 'crew'])
const PROPOSAL_TARGET_TYPES = new Set<ImprovementProposalTargetType>(['memory', 'agent', 'skill', 'sop', 'crew', 'eval_case', 'routing', 'policy'])
const PROPOSAL_STATUSES = new Set<ImprovementProposalStatus>(['proposed', 'approved', 'rejected', 'archived'])
const DREAM_RUN_STATUSES = new Set<DreamRunStatus>(['running', 'completed', 'failed', 'cancelled', 'archived'])

export class ImprovementProposalPolicyDisabledError extends Error {
  constructor() {
    super('Improvement proposals are disabled by governed learning policy.')
    this.name = 'ImprovementProposalPolicyDisabledError'
  }
}

export interface CreateImprovementProposalOptions {
  policyScope?: ImprovementProposalPolicyScope
  settings?: AppSettings
}

function emptyImprovementStatusCounts(): ImprovementStatusCounts {
  return {
    proposed: 0,
    approved: 0,
    rejected: 0,
    archived: 0,
  }
}

function emptyDreamRunStatusCounts(): DreamRunStatusCounts {
  return {
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    archived: 0,
  }
}

type DbRow = Record<string, unknown>

let improvementDb: DatabaseSync | null = null
let improvementTransactionCounter = 0

function getImprovementDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'improvement.sqlite')
}

function ensureImprovementDbFileModes(dbPath = getImprovementDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function readSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from improvement_meta where key = ?')
    .get(IMPROVEMENT_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function recordSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into improvement_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(IMPROVEMENT_SCHEMA_VERSION_KEY, String(IMPROVEMENT_STORE_SCHEMA_VERSION))
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readSchemaVersion(db)
  if (version > IMPROVEMENT_STORE_SCHEMA_VERSION) {
    throw new Error(`Improvement database schema version ${version} is newer than supported version ${IMPROVEMENT_STORE_SCHEMA_VERSION}.`)
  }
}

export function getImprovementDb() {
  if (improvementDb) return improvementDb
  const dbPath = getImprovementDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec(`
      create table if not exists improvement_meta (
        key text primary key,
        value text not null
      );
    `)
    assertSupportedSchemaVersion(db)
    db.exec(`
      create table if not exists agent_memory_entries (
        id text primary key,
        schema_version integer not null,
        scope_kind text not null,
        scope_id text,
        status text not null,
        title text not null,
        body text not null,
        summary text not null,
        tags_json text not null,
        privacy_classification text not null,
        provenance_json text not null,
        source_proposal_id text,
        content_hash text not null,
        created_at text not null,
        updated_at text not null,
        reviewed_at text,
        reviewed_by text,
        review_note text
      );

      create index if not exists idx_agent_memory_entries_scope_status
        on agent_memory_entries (scope_kind, scope_id, status, updated_at);

      create table if not exists improvement_proposals (
        id text primary key,
        schema_version integer not null,
        target_type text not null,
        target_id text,
        status text not null,
        title text not null,
        summary text not null,
        evidence_json text not null,
        candidate_diffs_json text not null,
        created_at text not null,
        updated_at text not null,
        reviewed_at text,
        reviewed_by text,
        review_note text
      );

      create index if not exists idx_improvement_proposals_status
        on improvement_proposals (status, updated_at);

      create table if not exists dream_runs (
        id text primary key,
        schema_version integer not null,
        status text not null,
        title text not null,
        model_id text,
        instructions_hash text not null,
        source_memory_entry_ids_json text not null,
        source_trace_event_ids_json text not null,
        candidate_proposal_ids_json text not null,
        token_usage_json text,
        cost_usd real,
        error text,
        created_at text not null,
        updated_at text not null,
        started_at text not null,
        finished_at text
      );

      create index if not exists idx_dream_runs_status
        on dream_runs (status, updated_at);
    `)
    recordSchemaVersion(db)
    ensureImprovementDbFileModes(dbPath)
    improvementDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function clearImprovementStoreCache() {
  if (improvementDb) {
    improvementDb.close()
    improvementDb = null
  }
  improvementTransactionCounter = 0
}

function withImprovementTransaction<T>(fn: () => T): T {
  const db = getImprovementDb()
  const savepoint = `improvement_tx_${++improvementTransactionCounter}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = fn()
    db.exec(`release ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`rollback to ${savepoint}`)
    db.exec(`release ${savepoint}`)
    throw error
  }
}

function nowIso() {
  return new Date().toISOString()
}

function sha256Text(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function assertJsonSize(value: unknown, label: string, maxBytes = MAX_JSON_BYTES) {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error(`${label} must be JSON-serializable.`)
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
}

function boundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function optionalBoundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized) return null
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function normalizeScope(scopeKind: AgentMemoryScopeKind, scopeId?: string | null) {
  if (!MEMORY_SCOPE_KINDS.has(scopeKind)) throw new Error(`Memory scope ${scopeKind} is not supported.`)
  const normalizedScopeId = optionalBoundedText(scopeId, 'Memory scope id', 512)
  if (scopeKind !== 'machine' && !normalizedScopeId) {
    throw new Error(`Memory scope ${scopeKind} requires a scope id.`)
  }
  return {
    scopeKind,
    scopeId: scopeKind === 'machine' ? null : normalizedScopeId,
  }
}

function scopeKey(scopeKind: AgentMemoryScopeKind, scopeId: string | null) {
  return `${scopeKind}:${scopeId || '*'}`
}

function normalizeEvidenceRefs(value: ImprovementEvidenceRef[], label: string): ImprovementEvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${label} requires at least one evidence reference.`)
  if (value.length > 100) throw new Error(`${label} has too many evidence references.`)
  const refs = value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${label} evidence must be an object.`)
    const raw = entry as Partial<ImprovementEvidenceRef>
    if (!EVIDENCE_KINDS.has(raw.kind as ImprovementEvidenceKind)) throw new Error(`${label} evidence kind is invalid.`)
    return {
      schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
      kind: raw.kind as ImprovementEvidenceKind,
      id: boundedText(raw.id, `${label} evidence id`, 512),
      label: boundedText(raw.label, `${label} evidence label`, 1024),
      uri: optionalBoundedText(raw.uri, `${label} evidence uri`, 2048),
      hash: optionalBoundedText(raw.hash, `${label} evidence hash`, 512),
    }
  })
  assertJsonSize(refs, `${label} evidence`)
  return refs
}

function normalizeCandidateDiffs(value: ImprovementCandidateDiff[], label: string): ImprovementCandidateDiff[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${label} requires at least one candidate diff.`)
  if (value.length > 100) throw new Error(`${label} has too many candidate diffs.`)
  const diffs = value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${label} diff must be an object.`)
    const raw = entry as Partial<ImprovementCandidateDiff>
    if (!PROPOSAL_TARGET_TYPES.has(raw.targetType as ImprovementProposalTargetType)) throw new Error(`${label} diff target type is invalid.`)
    if (raw.operation !== 'create' && raw.operation !== 'update' && raw.operation !== 'delete') {
      throw new Error(`${label} diff operation is invalid.`)
    }
    const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {}
    assertJsonSize(payload, `${label} diff payload`)
    return {
      schemaVersion: COWORK_IMPROVEMENT_SCHEMA_VERSION,
      targetType: raw.targetType as ImprovementProposalTargetType,
      targetId: optionalBoundedText(raw.targetId, `${label} diff target id`, 512),
      operation: raw.operation,
      summary: boundedText(raw.summary, `${label} diff summary`, 2048),
      beforeHash: optionalBoundedText(raw.beforeHash, `${label} diff before hash`, 512),
      afterHash: optionalBoundedText(raw.afterHash, `${label} diff after hash`, 512),
      payload,
    }
  })
  assertJsonSize(diffs, `${label} candidate diffs`)
  return diffs
}

function normalizeTags(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Memory tags must be an array.')
  if (value.length > 50) throw new Error('Memory tags has too many entries.')
  return Array.from(new Set(value.map((entry) => boundedText(entry, 'Memory tag', 128)).sort()))
}

function rowToMemoryEntry(row: DbRow): AgentMemoryEntry {
  const scopeKind = MEMORY_SCOPE_KINDS.has(String(row.scope_kind) as AgentMemoryScopeKind)
    ? String(row.scope_kind) as AgentMemoryScopeKind
    : 'machine'
  const status = MEMORY_STATUSES.has(String(row.status) as AgentMemoryStatus)
    ? String(row.status) as AgentMemoryStatus
    : 'proposed'
  const privacy = PRIVACY_CLASSIFICATIONS.has(String(row.privacy_classification) as MemoryPrivacyClassification)
    ? String(row.privacy_classification) as MemoryPrivacyClassification
    : 'internal'
  return {
    schemaVersion: Number(row.schema_version || COWORK_MEMORY_SCHEMA_VERSION),
    id: String(row.id),
    scopeKind,
    scopeId: typeof row.scope_id === 'string' ? row.scope_id : null,
    status,
    title: String(row.title || ''),
    body: String(row.body || ''),
    summary: String(row.summary || ''),
    tags: parseJson<string[]>(row.tags_json, []),
    privacy,
    provenance: parseJson<ImprovementEvidenceRef[]>(row.provenance_json, []),
    sourceProposalId: typeof row.source_proposal_id === 'string' ? row.source_proposal_id : null,
    contentHash: String(row.content_hash || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
    reviewedBy: typeof row.reviewed_by === 'string' ? row.reviewed_by : null,
    reviewNote: typeof row.review_note === 'string' ? row.review_note : null,
  }
}

function rowToProposal(row: DbRow): ImprovementProposal {
  const targetType = PROPOSAL_TARGET_TYPES.has(String(row.target_type) as ImprovementProposalTargetType)
    ? String(row.target_type) as ImprovementProposalTargetType
    : 'memory'
  const status = PROPOSAL_STATUSES.has(String(row.status) as ImprovementProposalStatus)
    ? String(row.status) as ImprovementProposalStatus
    : 'proposed'
  return {
    schemaVersion: Number(row.schema_version || COWORK_IMPROVEMENT_SCHEMA_VERSION),
    id: String(row.id),
    targetType,
    targetId: typeof row.target_id === 'string' ? row.target_id : null,
    status,
    title: String(row.title || ''),
    summary: String(row.summary || ''),
    evidence: parseJson<ImprovementEvidenceRef[]>(row.evidence_json, []),
    candidateDiffs: parseJson<ImprovementCandidateDiff[]>(row.candidate_diffs_json, []),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
    reviewedBy: typeof row.reviewed_by === 'string' ? row.reviewed_by : null,
    reviewNote: typeof row.review_note === 'string' ? row.review_note : null,
  }
}

function rowToDreamRun(row: DbRow): DreamRun {
  const status = DREAM_RUN_STATUSES.has(String(row.status) as DreamRunStatus)
    ? String(row.status) as DreamRunStatus
    : 'running'
  return {
    schemaVersion: Number(row.schema_version || COWORK_DREAM_RUN_SCHEMA_VERSION),
    id: String(row.id),
    status,
    title: String(row.title || ''),
    modelId: typeof row.model_id === 'string' ? row.model_id : null,
    instructionsHash: String(row.instructions_hash || ''),
    sourceMemoryEntryIds: parseJson<string[]>(row.source_memory_entry_ids_json, []),
    sourceTraceEventIds: parseJson<string[]>(row.source_trace_event_ids_json, []),
    candidateProposalIds: parseJson<string[]>(row.candidate_proposal_ids_json, []),
    tokenUsage: parseJson<DreamRun['tokenUsage']>(row.token_usage_json, null),
    costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    startedAt: String(row.started_at || ''),
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}

export function createAgentMemoryProposal(draft: AgentMemoryDraft): AgentMemoryEntry {
  const scope = normalizeScope(draft.scopeKind, draft.scopeId)
  const title = boundedText(draft.title, 'Memory title', 512)
  const body = boundedText(draft.body, 'Memory body', MAX_BODY_BYTES)
  const summary = optionalBoundedText(draft.summary, 'Memory summary', 2048) || title
  const tags = normalizeTags(draft.tags)
  const privacy = draft.privacy || 'internal'
  if (!PRIVACY_CLASSIFICATIONS.has(privacy)) throw new Error(`Memory privacy classification ${privacy} is not supported.`)
  const provenance = normalizeEvidenceRefs(draft.provenance, 'Memory proposal')
  const sourceProposalId = optionalBoundedText(draft.sourceProposalId, 'Memory source proposal id', 512)
  const contentHash = sha256Text(JSON.stringify({ scope, title, body, summary, tags, privacy, provenance }))
  const id = randomUUID()
  const now = nowIso()
  getImprovementDb().prepare(`
    insert into agent_memory_entries (
      id, schema_version, scope_kind, scope_id, status, title, body, summary,
      tags_json, privacy_classification, provenance_json, source_proposal_id,
      content_hash, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    COWORK_MEMORY_SCHEMA_VERSION,
    scope.scopeKind,
    scope.scopeId,
    'proposed',
    title,
    body,
    summary,
    JSON.stringify(tags),
    privacy,
    JSON.stringify(provenance),
    sourceProposalId,
    contentHash,
    now,
    now,
  )
  return getAgentMemoryEntry(id)!
}

export function getAgentMemoryEntry(id: string) {
  const row = getImprovementDb().prepare('select * from agent_memory_entries where id = ?').get(id) as DbRow | undefined
  return row ? rowToMemoryEntry(row) : null
}

export function listAgentMemoryEntries() {
  const rows = getImprovementDb().prepare('select * from agent_memory_entries order by updated_at desc, id asc').all() as DbRow[]
  return rows.map(rowToMemoryEntry)
}

function reviewMemoryEntry(id: string, status: Exclude<AgentMemoryStatus, 'proposed'>, reviewedBy: string, note?: string | null) {
  return withImprovementTransaction(() => {
    const entry = getAgentMemoryEntry(id)
    if (!entry) return null
    if (entry.status === 'archived' && status !== 'archived') throw new Error('Archived memory entries cannot be reviewed.')
    const reviewer = boundedText(reviewedBy, 'Memory reviewer', 512)
    if (status === 'approved' && entry.provenance.length < 1) {
      throw new Error('Approved memory requires provenance evidence.')
    }
    const now = nowIso()
    getImprovementDb().prepare(`
      update agent_memory_entries
      set status = ?, updated_at = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?
      where id = ?
    `).run(status, now, now, reviewer, optionalBoundedText(note, 'Memory review note', 4096), id)
    return getAgentMemoryEntry(id)
  })
}

export function approveAgentMemoryEntry(id: string, approvedBy: string, note?: string | null) {
  return reviewMemoryEntry(id, 'approved', approvedBy, note)
}

export function rejectAgentMemoryEntry(id: string, rejectedBy: string, note?: string | null) {
  return reviewMemoryEntry(id, 'rejected', rejectedBy, note)
}

export function archiveAgentMemoryEntry(id: string, archivedBy: string, note?: string | null) {
  return reviewMemoryEntry(id, 'archived', archivedBy, note)
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function payloadRawString(payload: Record<string, unknown>, key: string, label: string, maxBytes = MAX_JSON_BYTES) {
  if (!(key in payload)) return null
  const value = payload[key]
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (!value.trim()) return null
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return value
}

function payloadStringArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
}

function payloadStringArrayOrDefault(payload: Record<string, unknown>, key: string, fallback: string[]) {
  if (!(key in payload)) return fallback
  const value = payload[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings.`)
  return Array.from(new Set(value.map((entry) => boundedText(entry, key, 512)))).sort((a, b) => a.localeCompare(b))
}

function payloadBooleanOrDefault(payload: Record<string, unknown>, key: string, fallback: boolean) {
  if (!(key in payload)) return fallback
  const value = payload[key]
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`)
  return value
}

function payloadNullableStringOrDefault(payload: Record<string, unknown>, key: string, fallback: string | null, label: string, maxBytes = 512) {
  if (!(key in payload)) return fallback
  const value = payload[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null.`)
  const normalized = value.trim()
  if (!normalized) return null
  return boundedText(normalized, label, maxBytes)
}

function payloadNullableNumberOrDefault(payload: Record<string, unknown>, key: string, fallback: number | null, label: string) {
  if (!(key in payload)) return fallback
  const value = payload[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number or null.`)
  return value
}

function payloadNullableJsonObjectOrDefault(
  payload: Record<string, unknown>,
  key: string,
  fallback: Record<string, unknown> | null,
  label: string,
) {
  if (!(key in payload)) return fallback
  const value = payload[key]
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object or null.`)
  assertJsonSize(value, label)
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function payloadJsonObjectOrDefault<T extends object>(
  payload: Record<string, unknown>,
  key: string,
  fallback: T,
  label: string,
): T {
  if (!(key in payload)) {
    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) throw new Error(`${label} fallback must be an object.`)
    return JSON.parse(JSON.stringify(fallback)) as T
  }
  const value = payload[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  assertJsonSize(value, label)
  return JSON.parse(JSON.stringify(value)) as T
}

function payloadJsonArrayOrDefault<T>(
  payload: Record<string, unknown>,
  key: string,
  fallback: T[],
  label: string,
): T[] {
  if (!(key in payload)) return JSON.parse(JSON.stringify(fallback)) as T[]
  const value = payload[key]
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  assertJsonSize(value, label)
  return JSON.parse(JSON.stringify(value)) as T[]
}

function payloadSkillFilesOrDefault(
  payload: Record<string, unknown>,
  fallback: NonNullable<CustomSkillConfig['files']>,
): NonNullable<CustomSkillConfig['files']> {
  if (!('files' in payload)) return fallback
  const value = payload.files
  if (!Array.isArray(value)) throw new Error('Skill proposal files must be an array.')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Skill proposal file ${index + 1} must be an object.`)
    }
    const raw = entry as Record<string, unknown>
    if (typeof raw.content !== 'string') {
      throw new Error(`Skill proposal file ${index + 1} content must be a string.`)
    }
    return {
      path: boundedText(raw.path, `Skill proposal file ${index + 1} path`, 1024),
      content: raw.content,
    }
  })
}

export function createImprovementProposal(
  draft: ImprovementProposalDraft,
  options: CreateImprovementProposalOptions = {},
): ImprovementProposal {
  const settings = options.settings || loadSettings()
  if (!isImprovementProposalEnabledForScope(settings, options.policyScope)) {
    throw new ImprovementProposalPolicyDisabledError()
  }
  if (!PROPOSAL_TARGET_TYPES.has(draft.targetType)) throw new Error(`Improvement target ${draft.targetType} is not supported.`)
  const targetId = optionalBoundedText(draft.targetId, 'Improvement target id', 512)
  const title = boundedText(draft.title, 'Improvement proposal title', 512)
  const summary = boundedText(draft.summary, 'Improvement proposal summary', 4096)
  const evidence = normalizeEvidenceRefs(draft.evidence, 'Improvement proposal')
  const candidateDiffs = normalizeCandidateDiffs(draft.candidateDiffs, 'Improvement proposal')
  const id = randomUUID()
  const now = nowIso()
  getImprovementDb().prepare(`
    insert into improvement_proposals (
      id, schema_version, target_type, target_id, status, title, summary,
      evidence_json, candidate_diffs_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    COWORK_IMPROVEMENT_SCHEMA_VERSION,
    draft.targetType,
    targetId,
    'proposed',
    title,
    summary,
    JSON.stringify(evidence),
    JSON.stringify(candidateDiffs),
    now,
    now,
  )
  return getImprovementProposal(id)!
}

export function getImprovementProposal(id: string) {
  const row = getImprovementDb().prepare('select * from improvement_proposals where id = ?').get(id) as DbRow | undefined
  return row ? rowToProposal(row) : null
}

export function listImprovementProposals() {
  const rows = getImprovementDb().prepare('select * from improvement_proposals order by updated_at desc, id asc').all() as DbRow[]
  return rows.map(rowToProposal)
}

export function listImprovementReviewQueue(options: { limit?: number } = {}): ImprovementReviewQueue {
  const limit = Math.max(1, Math.min(MAX_REVIEW_QUEUE_LIMIT, Math.floor(options.limit || DEFAULT_REVIEW_QUEUE_LIMIT)))
  const db = getImprovementDb()
  const memoryRows = db.prepare(`
    select *
    from agent_memory_entries
    where status = ?
    order by updated_at desc, id asc
    limit ?
  `).all('proposed', limit) as DbRow[]
  const proposalRows = db.prepare(`
    select *
    from improvement_proposals
    where status = ?
    order by updated_at desc, id asc
    limit ?
  `).all('proposed', limit) as DbRow[]
  const dreamRows = db.prepare(`
    select *
    from dream_runs
    where status in (?, ?, ?)
    order by updated_at desc, id asc
    limit ?
  `).all('running', 'failed', 'cancelled', limit) as DbRow[]

  return {
    memory: memoryRows.map(rowToMemoryEntry),
    proposals: proposalRows.map(rowToProposal),
    dreamRuns: dreamRows.map(rowToDreamRun),
  }
}

export function updateImprovementProposal(id: string, draft: ImprovementProposalDraft) {
  return withImprovementTransaction(() => {
    const existing = getImprovementProposal(id)
    if (!existing) return null
    if (existing.status !== 'proposed') throw new Error('Only proposed improvement proposals can be edited.')
    if (!PROPOSAL_TARGET_TYPES.has(draft.targetType)) throw new Error(`Improvement target ${draft.targetType} is not supported.`)
    const targetId = optionalBoundedText(draft.targetId, 'Improvement target id', 512)
    const title = boundedText(draft.title, 'Improvement proposal title', 512)
    const summary = boundedText(draft.summary, 'Improvement proposal summary', 4096)
    const evidence = normalizeEvidenceRefs(draft.evidence, 'Improvement proposal')
    const candidateDiffs = normalizeCandidateDiffs(draft.candidateDiffs, 'Improvement proposal')
    const now = nowIso()
    getImprovementDb().prepare(`
      update improvement_proposals
      set target_type = ?, target_id = ?, title = ?, summary = ?,
        evidence_json = ?, candidate_diffs_json = ?, updated_at = ?
      where id = ?
    `).run(
      draft.targetType,
      targetId,
      title,
      summary,
      JSON.stringify(evidence),
      JSON.stringify(candidateDiffs),
      now,
      id,
    )
    return getImprovementProposal(id)
  })
}

function applyApprovedMemoryProposal(proposal: ImprovementProposal, reviewer: string, note: string | null) {
  let appliedMemoryDiffs = 0
  for (const diff of proposal.candidateDiffs) {
    if (diff.targetType !== 'memory') continue
    appliedMemoryDiffs += 1
    const target = diff.targetId ? getAgentMemoryEntry(diff.targetId) : null
    if (diff.operation === 'delete') {
      if (!target) throw new Error('Memory delete proposal target does not exist.')
      archiveAgentMemoryEntry(target.id, reviewer, note || `Archived by improvement proposal ${proposal.id}.`)
      continue
    }
    if (diff.operation === 'update' && !target) {
      throw new Error('Memory update proposal target does not exist.')
    }

    const scopeKind = payloadString(diff.payload, 'scopeKind') as AgentMemoryScopeKind | null
    const privacy = payloadString(diff.payload, 'privacy') as MemoryPrivacyClassification | null
    const memory = createAgentMemoryProposal({
      scopeKind: scopeKind || target?.scopeKind || 'machine',
      scopeId: payloadString(diff.payload, 'scopeId') ?? target?.scopeId ?? null,
      title: payloadString(diff.payload, 'title') || target?.title || proposal.title,
      body: payloadString(diff.payload, 'body') || target?.body || proposal.summary,
      summary: payloadString(diff.payload, 'summary') || target?.summary || diff.summary,
      tags: payloadStringArray(diff.payload, 'tags') || target?.tags || [],
      privacy: privacy || target?.privacy || 'internal',
      provenance: proposal.evidence,
      sourceProposalId: proposal.id,
    })
    approveAgentMemoryEntry(memory.id, reviewer, note || `Approved through improvement proposal ${proposal.id}.`)
    if (diff.operation === 'update' && target) {
      archiveAgentMemoryEntry(target.id, reviewer, `Superseded by improvement proposal ${proposal.id}.`)
    }
  }
  if (appliedMemoryDiffs < 1) throw new Error('Memory improvement proposal has no memory candidate diff to apply.')
}

function proposalArtifactName(diff: ImprovementCandidateDiff) {
  return (payloadString(diff.payload, 'name') || diff.targetId || '').trim().toLowerCase()
}

type AgentProposalRef = {
  scope: 'machine'
  directory: null
  name: string
}

type PlannedAgentProposalApply = {
  ref: AgentProposalRef
  previous: CustomAgentConfig | null
  previousPermission: Record<string, unknown> | null
  next: CustomAgentConfig | null
  nextPermission: Record<string, unknown> | null
}

function agentProposalRef(diff: ImprovementCandidateDiff): AgentProposalRef {
  const scope = payloadString(diff.payload, 'scope') || 'machine'
  if (scope !== 'machine') {
    throw new Error('Project-scoped agent improvement proposals need an explicit project grant before approval.')
  }
  return {
    scope: 'machine',
    directory: null,
    name: proposalArtifactName(diff),
  }
}

function agentRefKey(ref: AgentProposalRef) {
  return `${ref.scope}:${ref.name}`
}

function cloneCustomAgent(agent: CustomAgentConfig | null): CustomAgentConfig | null {
  if (!agent) return null
  return {
    ...agent,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    deniedToolPatterns: agent.deniedToolPatterns ? [...agent.deniedToolPatterns] : undefined,
    options: agent.options ? JSON.parse(JSON.stringify(agent.options)) as Record<string, unknown> : null,
  }
}

function findCustomAgentByRef(ref: AgentProposalRef) {
  return listCustomAgents()
    .find((agent) => agent.scope === ref.scope && agent.name === ref.name) || null
}

function agentColorOrDefault(payload: Record<string, unknown>, fallback: AgentColor): AgentColor {
  if (!('color' in payload)) return fallback
  const color = payloadString(payload, 'color')
  if (color && CUSTOM_AGENT_COLORS.includes(color as AgentColor)) return color as AgentColor
  throw new Error('Agent proposal color must be a supported agent color.')
}

function agentDraftFromDiff(diff: ImprovementCandidateDiff, ref: AgentProposalRef, existing: CustomAgentConfig | null): CustomAgentConfig {
  const instructions = payloadRawString(diff.payload, 'instructions', 'Agent proposal instructions') || existing?.instructions || ''
  if (!instructions) throw new Error('Agent improvement proposal requires instructions.')
  return normalizeCustomAgent({
    scope: ref.scope,
    directory: ref.directory,
    name: ref.name,
    description: payloadString(diff.payload, 'description') || existing?.description || diff.summary || 'Custom agent',
    instructions,
    skillNames: payloadStringArrayOrDefault(diff.payload, 'skillNames', existing?.skillNames || []),
    toolIds: payloadStringArrayOrDefault(diff.payload, 'toolIds', existing?.toolIds || []),
    enabled: payloadBooleanOrDefault(diff.payload, 'enabled', existing?.enabled ?? true),
    color: agentColorOrDefault(diff.payload, existing?.color || 'accent'),
    avatar: payloadNullableStringOrDefault(diff.payload, 'avatar', existing?.avatar || null, 'Agent proposal avatar', 256 * 1024),
    deniedToolPatterns: payloadStringArrayOrDefault(diff.payload, 'deniedToolPatterns', existing?.deniedToolPatterns || []),
    model: payloadNullableStringOrDefault(diff.payload, 'model', existing?.model || null, 'Agent proposal model'),
    variant: payloadNullableStringOrDefault(diff.payload, 'variant', existing?.variant || null, 'Agent proposal variant'),
    temperature: payloadNullableNumberOrDefault(diff.payload, 'temperature', existing?.temperature ?? null, 'Agent proposal temperature'),
    top_p: payloadNullableNumberOrDefault(diff.payload, 'top_p', existing?.top_p ?? null, 'Agent proposal top_p'),
    steps: payloadNullableNumberOrDefault(diff.payload, 'steps', existing?.steps ?? null, 'Agent proposal steps'),
    options: payloadNullableJsonObjectOrDefault(diff.payload, 'options', existing?.options || null, 'Agent proposal options'),
  })
}

function localCustomAgentCatalog(customAgents: CustomAgentConfig[]) {
  const customMcps = listCustomMcps()
  const customSkills = listCustomSkills()
  return buildCustomAgentCatalog({
    customMcps,
    customSkills,
    state: {
      customAgents,
      customMcps,
      customSkills,
    },
  })
}

function buildCustomAgentPermissionFromCatalog(agent: CustomAgentConfig, catalog: CustomAgentCatalog) {
  const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
  const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
  const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
  const deniedPatterns = Array.from(new Set((agent.deniedToolPatterns || []).map((pattern) => pattern.trim()).filter(Boolean)))
  const permission: Record<string, unknown> = {}
  if (agent.skillNames.length > 0) {
    permission.skill = {
      '*': 'deny',
      ...Object.fromEntries(agent.skillNames.map((name) => [name, 'allow'])),
    }
  }
  for (const pattern of allowPatterns) permission[pattern] = 'allow'
  for (const pattern of askPatterns) permission[pattern] = 'ask'
  for (const pattern of deniedPatterns) permission[pattern] = 'deny'
  return permission
}

function listSimulatedAgents(simulatedByKey: Map<string, CustomAgentConfig | null>) {
  return Array.from(simulatedByKey.values()).filter((agent): agent is CustomAgentConfig => Boolean(agent))
}

function permissionForAgent(agent: CustomAgentConfig, simulatedByKey: Map<string, CustomAgentConfig | null>) {
  const catalog = localCustomAgentCatalog(listSimulatedAgents(simulatedByKey))
  return buildCustomAgentPermissionFromCatalog(agent, catalog)
}

function assertAgentProposalDraftValid(agent: CustomAgentConfig, ref: AgentProposalRef, simulatedByKey: Map<string, CustomAgentConfig | null>) {
  const catalog = localCustomAgentCatalog(listSimulatedAgents(simulatedByKey))
  const siblingNames = listSimulatedAgents(simulatedByKey)
    .filter((entry) => !(entry.scope === ref.scope && entry.name === ref.name))
    .map((entry) => normalizeCustomAgent(entry).name)
  const issues = validateCustomAgent(agent, catalog, siblingNames)
  if (issues.length > 0) throw new Error(issues[0]?.message || 'Invalid custom agent proposal.')
}

function planApprovedAgentProposal(proposal: ImprovementProposal): PlannedAgentProposalApply[] {
  let appliedAgentDiffs = 0
  const originalByKey = new Map<string, { ref: AgentProposalRef, agent: CustomAgentConfig | null }>()
  const simulatedByKey = new Map<string, CustomAgentConfig | null>()

  for (const agent of listCustomAgents()) {
    if (agent.scope !== 'machine') continue
    const normalized = normalizeCustomAgent(agent)
    simulatedByKey.set(agentRefKey({ scope: 'machine', directory: null, name: normalized.name }), cloneCustomAgent(normalized))
  }

  for (const diff of proposal.candidateDiffs) {
    if (diff.targetType !== 'agent') continue
    appliedAgentDiffs += 1
    const ref = agentProposalRef(diff)
    if (!ref.name) throw new Error('Agent improvement proposal requires a target agent name.')
    const key = agentRefKey(ref)
    if (!originalByKey.has(key)) {
      const existing = cloneCustomAgent(findCustomAgentByRef(ref))
      originalByKey.set(key, { ref, agent: existing })
      simulatedByKey.set(key, cloneCustomAgent(existing))
    }
    const existing = simulatedByKey.get(key) || null

    if (diff.operation === 'delete') {
      if (!existing) throw new Error('Agent delete proposal target does not exist.')
      simulatedByKey.set(key, null)
      continue
    }
    if (diff.operation === 'create' && existing) {
      throw new Error('Agent create proposal target already exists.')
    }
    if (diff.operation === 'update' && !existing) {
      throw new Error('Agent update proposal target does not exist.')
    }

    const next = agentDraftFromDiff(diff, ref, existing)
    simulatedByKey.set(key, next)
    assertAgentProposalDraftValid(next, ref, simulatedByKey)
  }
  if (appliedAgentDiffs < 1) throw new Error('Agent improvement proposal has no agent candidate diff to apply.')

  return Array.from(originalByKey.entries()).map(([key, original]) => {
    const previous = cloneCustomAgent(original.agent)
    const next = cloneCustomAgent(simulatedByKey.get(key) || null)
    return {
      ref: original.ref,
      previous,
      previousPermission: previous ? permissionForAgent(previous, simulatedByKey) : null,
      next,
      nextPermission: next ? permissionForAgent(next, simulatedByKey) : null,
    }
  })
}

function rollbackAgentProposalPlan(applied: PlannedAgentProposalApply[]) {
  const rollbackErrors: string[] = []
  for (const operation of [...applied].reverse()) {
    try {
      if (operation.previous && operation.previousPermission) {
        saveCustomAgent(operation.previous, operation.previousPermission)
      } else {
        removeCustomAgent(operation.ref)
      }
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (rollbackErrors.length > 0) {
    throw new Error(`Agent improvement proposal rollback failed: ${rollbackErrors.join('; ')}`)
  }
}

function applyApprovedAgentProposal(proposal: ImprovementProposal) {
  const plan = planApprovedAgentProposal(proposal)
  const applied: PlannedAgentProposalApply[] = []
  try {
    for (const operation of plan) {
      if (operation.next && operation.nextPermission) {
        saveCustomAgent(operation.next, operation.nextPermission)
      } else if (operation.previous) {
        removeCustomAgent(operation.ref)
      }
      applied.push(operation)
    }
  } catch (error) {
    try {
      rollbackAgentProposalPlan(applied)
    } catch (rollbackError) {
      throw new Error(
        `Agent improvement proposal failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete.`,
        { cause: rollbackError },
      )
    }
    throw error
  }
}

type PlannedCrewProposalApply = {
  operation: 'create' | 'update'
  crewId: string | null
  draft: CrewDefinitionDraft
}

function payloadCrewMembersOrDefault(
  payload: Record<string, unknown>,
  fallback: CrewDefinitionDraft['members'],
): CrewDefinitionDraft['members'] {
  if (!('members' in payload)) return fallback
  const value = payload.members
  if (!Array.isArray(value)) throw new Error('Crew proposal members must be an array.')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Crew proposal member ${index + 1} must be an object.`)
    }
    const record = entry as Record<string, unknown>
    const required = 'required' in record ? payloadBooleanOrDefault(record, 'required', true) : undefined
    return {
      role: boundedText(record.role, `Crew proposal member ${index + 1} role`, 64) as CrewDefinitionDraft['members'][number]['role'],
      agentName: boundedText(record.agentName, `Crew proposal member ${index + 1} agent name`, 128),
      displayName: optionalBoundedText(record.displayName, `Crew proposal member ${index + 1} display name`, 256) || undefined,
      description: optionalBoundedText(record.description, `Crew proposal member ${index + 1} description`, 2048) || undefined,
      ...(required === undefined ? {} : { required }),
    }
  })
}

function crewDraftFromDetail(detail: NonNullable<ReturnType<typeof getCrewDetail>>): CrewDefinitionDraft {
  const activeVersion = detail.activeVersion
  if (!activeVersion) throw new Error(`Crew ${detail.definition.id} has no active version.`)
  return {
    name: detail.definition.name,
    description: detail.definition.description,
    members: activeVersion.members.map((member) => ({
      role: member.role,
      agentName: member.agentName,
      displayName: member.displayName,
      description: member.description,
      required: member.required,
    })),
    workspaceProfileId: activeVersion.workspaceProfileId,
    outcomeRubricId: activeVersion.outcomeRubricId,
    evalSuiteId: activeVersion.evalSuiteId,
    budgetCapUsd: activeVersion.budgetCapUsd,
  }
}

function crewDraftFromDiff(diff: ImprovementCandidateDiff, existing: NonNullable<ReturnType<typeof getCrewDetail>> | null): CrewDefinitionDraft {
  const fallback = existing ? crewDraftFromDetail(existing) : null
  const draft = {
    name: payloadString(diff.payload, 'name') || fallback?.name || diff.summary || 'Untitled crew',
    description: payloadString(diff.payload, 'description') || fallback?.description || diff.summary || 'Crew proposed from governed learning.',
    members: payloadCrewMembersOrDefault(diff.payload, fallback?.members || []),
    workspaceProfileId: payloadNullableStringOrDefault(diff.payload, 'workspaceProfileId', fallback?.workspaceProfileId || null, 'Crew proposal workspace profile id'),
    outcomeRubricId: payloadNullableStringOrDefault(diff.payload, 'outcomeRubricId', fallback?.outcomeRubricId || null, 'Crew proposal outcome rubric id'),
    evalSuiteId: payloadNullableStringOrDefault(diff.payload, 'evalSuiteId', fallback?.evalSuiteId || null, 'Crew proposal eval suite id'),
    budgetCapUsd: payloadNullableNumberOrDefault(diff.payload, 'budgetCapUsd', fallback?.budgetCapUsd ?? null, 'Crew proposal budget cap'),
  }
  validateCrewDefinitionDraft(draft)
  return draft
}

function crewProposalTargetId(diff: ImprovementCandidateDiff) {
  const targetId = typeof diff.targetId === 'string' && diff.targetId.trim() ? diff.targetId.trim() : null
  const payloadId = payloadString(diff.payload, 'id')
  if (targetId && payloadId && targetId !== payloadId) {
    throw new Error('Crew proposal payload id must match the candidate target id.')
  }
  if (diff.operation === 'update' && !targetId) {
    throw new Error('Crew update proposal requires a target crew id.')
  }
  return targetId || payloadId || ''
}

function planApprovedCrewProposal(proposal: ImprovementProposal): PlannedCrewProposalApply {
  const crewDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'crew')
  if (crewDiffs.length !== 1) throw new Error('Crew improvement proposals must contain exactly one crew candidate diff.')
  const diff = crewDiffs[0]!
  if (diff.operation === 'delete') throw new Error('Crew delete proposals do not have a typed approval path yet.')
  const crewId = crewProposalTargetId(diff)
  const existing = crewId ? getCrewDetail(crewId) : null
  if (diff.operation === 'create' && existing) throw new Error('Crew create proposal target already exists.')
  if (diff.operation === 'update' && !existing) throw new Error('Crew update proposal target does not exist.')
  return {
    operation: diff.operation,
    crewId: crewId || null,
    draft: crewDraftFromDiff(diff, existing),
  }
}

function applyApprovedCrewProposal(proposal: ImprovementProposal) {
  const plan = planApprovedCrewProposal(proposal)
  if (plan.operation === 'create') {
    createCrewFromDraft(plan.draft)
    return
  }
  if (!plan.crewId) throw new Error('Crew update proposal requires a target crew id.')
  updateCrewFromDraft(plan.crewId, plan.draft)
}

type PlannedSopProposalApply = {
  operation: 'create' | 'update'
  sopId: string | null
  draft: SopDraft
}

const DEFAULT_SOP_APPROVAL_POLICY: NonNullable<SopDraft['approvalPolicy']> = {
  schemaVersion: COWORK_SOP_SCHEMA_VERSION,
  reviewFirst: true,
  approvalBoundary: null,
}

const DEFAULT_SOP_DELIVERY_POLICY: NonNullable<SopDraft['deliveryPolicy']> = {
  schemaVersion: COWORK_SOP_SCHEMA_VERSION,
  provider: 'in_app',
  target: 'automation-inbox',
  draftFirst: true,
}

const SOP_TRIGGER_TYPES = new Set<SopDraft['triggerTypes'][number]>(['manual', 'schedule', 'inbox', 'webhook'])

function payloadSopTriggerTypesOrDefault(payload: Record<string, unknown>, fallback: SopDraft['triggerTypes']) {
  if (!('triggerTypes' in payload)) return fallback
  const value = payload.triggerTypes
  if (!Array.isArray(value)) throw new Error('SOP proposal triggerTypes must be an array.')
  assertJsonSize(value, 'SOP proposal triggerTypes')
  const triggerTypes = Array.from(new Set(value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`SOP proposal trigger type ${index + 1} must be a string.`)
    const triggerType = entry.trim()
    if (!SOP_TRIGGER_TYPES.has(triggerType as SopDraft['triggerTypes'][number])) {
      throw new Error(`SOP proposal trigger type ${index + 1} is invalid.`)
    }
    return triggerType as SopDraft['triggerTypes'][number]
  })))
  if (triggerTypes.length < 1) throw new Error('SOP proposal triggerTypes must include at least one trigger.')
  return triggerTypes
}

function sopDraftFromDetail(detail: NonNullable<ReturnType<typeof getSop>>): SopDraft {
  const activeVersion = detail.activeVersion
  if (!activeVersion) throw new Error(`SOP ${detail.definition.id} has no active version.`)
  return {
    name: detail.definition.name,
    description: detail.definition.description,
    triggerTypes: [...activeVersion.triggerTypes],
    requiredInputs: activeVersion.requiredInputs.map((input) => ({ ...input })),
    workflow: activeVersion.workflow.map((step) => ({ ...step })),
    approvalPolicy: { ...activeVersion.approvalPolicy },
    retryPolicy: { ...activeVersion.retryPolicy },
    runPolicy: { ...activeVersion.runPolicy },
    deliveryPolicy: { ...activeVersion.deliveryPolicy },
    outcomeRubricId: activeVersion.outcomeRubricId,
  }
}

function sopDraftFromDiff(diff: ImprovementCandidateDiff, existing: NonNullable<ReturnType<typeof getSop>> | null): SopDraft {
  const fallback = existing ? sopDraftFromDetail(existing) : null
  return {
    name: payloadString(diff.payload, 'name') || fallback?.name || diff.summary || 'Untitled SOP',
    description: payloadString(diff.payload, 'description') || fallback?.description || diff.summary || 'SOP proposed from governed learning.',
    triggerTypes: payloadSopTriggerTypesOrDefault(diff.payload, fallback?.triggerTypes || ['manual']),
    requiredInputs: payloadJsonArrayOrDefault(diff.payload, 'requiredInputs', fallback?.requiredInputs || [], 'SOP proposal requiredInputs'),
    workflow: payloadJsonArrayOrDefault(diff.payload, 'workflow', fallback?.workflow || [], 'SOP proposal workflow'),
    approvalPolicy: payloadJsonObjectOrDefault(diff.payload, 'approvalPolicy', fallback?.approvalPolicy || DEFAULT_SOP_APPROVAL_POLICY, 'SOP proposal approvalPolicy'),
    retryPolicy: sanitizeRetryPolicy(payloadJsonObjectOrDefault(diff.payload, 'retryPolicy', fallback?.retryPolicy || {}, 'SOP proposal retryPolicy')),
    runPolicy: sanitizeRunPolicy(payloadJsonObjectOrDefault(diff.payload, 'runPolicy', fallback?.runPolicy || {}, 'SOP proposal runPolicy')),
    deliveryPolicy: payloadJsonObjectOrDefault(diff.payload, 'deliveryPolicy', fallback?.deliveryPolicy || DEFAULT_SOP_DELIVERY_POLICY, 'SOP proposal deliveryPolicy'),
    outcomeRubricId: payloadNullableStringOrDefault(diff.payload, 'outcomeRubricId', fallback?.outcomeRubricId || null, 'SOP proposal outcome rubric id'),
  }
}

function sopProposalTargetId(diff: ImprovementCandidateDiff) {
  const targetId = typeof diff.targetId === 'string' && diff.targetId.trim() ? diff.targetId.trim() : null
  const payloadId = payloadString(diff.payload, 'id')
  if (targetId && payloadId && targetId !== payloadId) {
    throw new Error('SOP proposal payload id must match the candidate target id.')
  }
  if (diff.operation === 'update' && !targetId) {
    throw new Error('SOP update proposal requires a target SOP id.')
  }
  return targetId || payloadId || ''
}

function planApprovedSopProposal(proposal: ImprovementProposal): PlannedSopProposalApply {
  const sopDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'sop')
  if (proposal.candidateDiffs.length !== 1 || sopDiffs.length !== 1) {
    throw new Error('SOP improvement proposals must contain exactly one SOP candidate diff.')
  }
  const diff = sopDiffs[0]!
  if (diff.operation === 'delete') throw new Error('SOP delete proposals do not have a typed approval path yet.')
  const sopId = sopProposalTargetId(diff)
  const existing = sopId ? getSop(sopId) : null
  if (diff.operation === 'create' && existing) throw new Error('SOP create proposal target already exists.')
  if (diff.operation === 'update' && !existing) throw new Error('SOP update proposal target does not exist.')
  return {
    operation: diff.operation,
    sopId: sopId || null,
    draft: sopDraftFromDiff(diff, existing),
  }
}

function applyApprovedSopProposal(proposal: ImprovementProposal) {
  const plan = planApprovedSopProposal(proposal)
  if (plan.operation === 'create') {
    createSop(plan.draft)
    return
  }
  if (!plan.sopId) throw new Error('SOP update proposal requires a target SOP id.')
  updateSop(plan.sopId, plan.draft)
}

type PlannedEvalCaseProposalApply = {
  suiteId: string
  name: string
  inputRef: string
  expectedOutcome: string
}

function evalCaseDraftFromDiff(diff: ImprovementCandidateDiff): PlannedEvalCaseProposalApply {
  const targetId = typeof diff.targetId === 'string' && diff.targetId.trim() ? diff.targetId.trim() : null
  const payloadId = payloadString(diff.payload, 'id')
  if (targetId || payloadId) {
    throw new Error('Eval case create proposals must not target an existing eval case id.')
  }
  const suiteId = payloadString(diff.payload, 'suiteId')
  if (!suiteId) throw new Error('Eval case proposal requires a suiteId.')
  return {
    suiteId,
    name: payloadString(diff.payload, 'name') || diff.summary || 'Untitled eval case',
    inputRef: payloadString(diff.payload, 'inputRef') || diff.summary || 'improvement-proposal',
    expectedOutcome: payloadString(diff.payload, 'expectedOutcome') || diff.summary || 'Expected outcome proposed from governed learning.',
  }
}

function planApprovedEvalCaseProposal(proposal: ImprovementProposal): PlannedEvalCaseProposalApply {
  const evalCaseDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'eval_case')
  if (proposal.candidateDiffs.length !== 1 || evalCaseDiffs.length !== 1) {
    throw new Error('Eval case improvement proposals must contain exactly one eval case candidate diff.')
  }
  const diff = evalCaseDiffs[0]!
  if (diff.operation !== 'create') throw new Error('Eval case update/delete proposals do not have a typed approval path yet.')
  return evalCaseDraftFromDiff(diff)
}

function applyApprovedEvalCaseProposal(proposal: ImprovementProposal) {
  createCrewEvalCase(planApprovedEvalCaseProposal(proposal))
}

type SkillProposalRef = {
  scope: 'machine'
  directory: null
  name: string
}

type PlannedSkillProposalApply = {
  ref: SkillProposalRef
  previous: CustomSkillConfig | null
  next: CustomSkillConfig | null
}

function skillProposalRef(diff: ImprovementCandidateDiff): SkillProposalRef {
  const scope = payloadString(diff.payload, 'scope') || 'machine'
  if (scope !== 'machine') {
    throw new Error('Project-scoped skill improvement proposals need an explicit project grant before approval.')
  }
  return {
    scope: 'machine',
    directory: null,
    name: proposalArtifactName(diff),
  }
}

function findCustomSkillByRef(ref: SkillProposalRef) {
  return listCustomSkills()
    .find((skill) => skill.scope === ref.scope && skill.name === ref.name) || null
}

function skillRefKey(ref: SkillProposalRef) {
  return `${ref.scope}:${ref.name}`
}

function cloneCustomSkill(skill: CustomSkillConfig | null): CustomSkillConfig | null {
  if (!skill) return null
  return {
    ...skill,
    files: skill.files?.map((file) => ({ ...file })),
    toolIds: skill.toolIds ? [...skill.toolIds] : undefined,
  }
}

function skillDraftFromDiff(diff: ImprovementCandidateDiff, ref: SkillProposalRef, existing: CustomSkillConfig | null): CustomSkillConfig {
  const content = payloadRawString(diff.payload, 'content', 'Skill proposal content') || existing?.content || ''
  if (!content) throw new Error('Skill improvement proposal requires SKILL.md content.')
  return {
    scope: ref.scope,
    directory: ref.directory,
    name: ref.name,
    content,
    files: payloadSkillFilesOrDefault(diff.payload, existing?.files || []),
    toolIds: payloadStringArrayOrDefault(diff.payload, 'toolIds', existing?.toolIds || []),
  }
}

function planApprovedSkillProposal(proposal: ImprovementProposal): PlannedSkillProposalApply[] {
  let appliedSkillDiffs = 0
  const originalByKey = new Map<string, { ref: SkillProposalRef, skill: CustomSkillConfig | null }>()
  const simulatedByKey = new Map<string, CustomSkillConfig | null>()

  for (const diff of proposal.candidateDiffs) {
    if (diff.targetType !== 'skill') continue
    appliedSkillDiffs += 1
    const ref = skillProposalRef(diff)
    if (!ref.name) throw new Error('Skill improvement proposal requires a target skill name.')
    const key = skillRefKey(ref)
    if (!originalByKey.has(key)) {
      const existing = cloneCustomSkill(findCustomSkillByRef(ref))
      originalByKey.set(key, { ref, skill: existing })
      simulatedByKey.set(key, cloneCustomSkill(existing))
    }
    const existing = simulatedByKey.get(key) || null

    if (diff.operation === 'delete') {
      if (!existing) throw new Error('Skill delete proposal target does not exist.')
      simulatedByKey.set(key, null)
      continue
    }
    if (diff.operation === 'create' && existing) {
      throw new Error('Skill create proposal target already exists.')
    }
    if (diff.operation === 'update' && !existing) {
      throw new Error('Skill update proposal target does not exist.')
    }

    simulatedByKey.set(key, skillDraftFromDiff(diff, ref, existing))
  }
  if (appliedSkillDiffs < 1) throw new Error('Skill improvement proposal has no skill candidate diff to apply.')

  return Array.from(originalByKey.entries()).map(([key, original]) => ({
    ref: original.ref,
    previous: cloneCustomSkill(original.skill),
    next: cloneCustomSkill(simulatedByKey.get(key) || null),
  }))
}

function rollbackSkillProposalPlan(applied: PlannedSkillProposalApply[]) {
  const rollbackErrors: string[] = []
  for (const operation of [...applied].reverse()) {
    try {
      if (operation.previous) {
        saveCustomSkill(operation.previous)
      } else {
        removeCustomSkill(operation.ref)
      }
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (rollbackErrors.length > 0) {
    throw new Error(`Skill improvement proposal rollback failed: ${rollbackErrors.join('; ')}`)
  }
}

function applyApprovedSkillProposal(proposal: ImprovementProposal) {
  const plan = planApprovedSkillProposal(proposal)
  const applied: PlannedSkillProposalApply[] = []
  try {
    for (const operation of plan) {
      if (operation.next) {
        saveCustomSkill(operation.next)
      } else if (operation.previous) {
        removeCustomSkill(operation.ref)
      }
      applied.push(operation)
    }
  } catch (error) {
    try {
      rollbackSkillProposalPlan(applied)
    } catch (rollbackError) {
      throw new Error(
        `Skill improvement proposal failed (${error instanceof Error ? error.message : String(error)}) and rollback was incomplete.`,
        { cause: rollbackError },
      )
    }
    throw error
  }
}

function reviewImprovementProposal(id: string, status: Exclude<ImprovementProposalStatus, 'proposed'>, reviewedBy: string, note?: string | null) {
  return withImprovementTransaction(() => {
    const proposal = getImprovementProposal(id)
    if (!proposal) return null
    if (proposal.status === 'archived' && status !== 'archived') throw new Error('Archived improvement proposals cannot be reviewed.')
    if (proposal.status !== 'proposed' && status !== 'archived') throw new Error('Only proposed improvement proposals can be reviewed.')
    const reviewer = boundedText(reviewedBy, 'Improvement reviewer', 512)
    const reviewNote = optionalBoundedText(note, 'Improvement review note', 4096)
    if (status === 'approved') {
      const approvalBlockReason = improvementProposalApprovalBlockReason(proposal)
      if (approvalBlockReason === 'target-type') {
        throw new Error(`Approval for ${proposal.targetType} improvement proposals is not wired to an existing persistence path yet.`)
      } else if (approvalBlockReason === 'operation') {
        throw new Error(`Approval for this ${proposal.targetType} improvement proposal operation is not wired to an existing persistence path yet.`)
      } else if (approvalBlockReason === 'agent-scope') {
        throw new Error('Project-scoped agent improvement proposals need an explicit project grant before approval.')
      } else if (approvalBlockReason === 'skill-scope') {
        throw new Error('Project-scoped skill improvement proposals need an explicit project grant before approval.')
      }
      if (proposal.targetType === 'memory') {
        applyApprovedMemoryProposal(proposal, reviewer, reviewNote)
      } else if (proposal.targetType === 'agent') {
        applyApprovedAgentProposal(proposal)
      } else if (proposal.targetType === 'crew') {
        applyApprovedCrewProposal(proposal)
      } else if (proposal.targetType === 'sop') {
        applyApprovedSopProposal(proposal)
      } else if (proposal.targetType === 'eval_case') {
        applyApprovedEvalCaseProposal(proposal)
      } else if (proposal.targetType === 'skill') {
        applyApprovedSkillProposal(proposal)
      }
    }
    const now = nowIso()
    getImprovementDb().prepare(`
      update improvement_proposals
      set status = ?, updated_at = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?
      where id = ?
    `).run(status, now, now, reviewer, reviewNote, id)
    return getImprovementProposal(id)
  })
}

export function approveImprovementProposal(id: string, approvedBy: string, note?: string | null) {
  return reviewImprovementProposal(id, 'approved', approvedBy, note)
}

export function rejectImprovementProposal(id: string, rejectedBy: string, note?: string | null) {
  return reviewImprovementProposal(id, 'rejected', rejectedBy, note)
}

export function archiveImprovementProposal(id: string, archivedBy: string, note?: string | null) {
  return reviewImprovementProposal(id, 'archived', archivedBy, note)
}

function assertMemoryEntriesExist(memoryEntryIds: string[]) {
  for (const id of memoryEntryIds) {
    if (!getAgentMemoryEntry(id)) throw new Error(`Memory entry ${id} does not exist.`)
  }
}

function assertImprovementProposalsExist(proposalIds: string[]) {
  for (const id of proposalIds) {
    if (!getImprovementProposal(id)) throw new Error(`Improvement proposal ${id} does not exist.`)
  }
}

function assertDreamRunIsRunning(id: string) {
  const run = getDreamRun(id)
  if (!run) throw new Error(`Dream run ${id} does not exist.`)
  if (run.status !== 'running') throw new Error(`Dream run ${id} is already ${run.status}.`)
}

export function startDreamRun(draft: DreamRunDraft): DreamRun {
  const title = boundedText(draft.title, 'Dream run title', 512)
  const modelId = optionalBoundedText(draft.modelId, 'Dream run model id', 512)
  const instructions = boundedText(draft.instructions, 'Dream run instructions', MAX_BODY_BYTES)
  const sourceMemoryEntryIds = Array.from(new Set((draft.sourceMemoryEntryIds || []).map((id) => boundedText(id, 'Dream source memory id', 512)))).sort()
  const sourceTraceEventIds = Array.from(new Set((draft.sourceTraceEventIds || []).map((id) => boundedText(id, 'Dream source trace id', 512)))).sort()
  assertMemoryEntriesExist(sourceMemoryEntryIds)
  assertJsonSize(sourceMemoryEntryIds, 'Dream source memory entry ids')
  assertJsonSize(sourceTraceEventIds, 'Dream source trace event ids')
  const id = randomUUID()
  const now = nowIso()
  getImprovementDb().prepare(`
    insert into dream_runs (
      id, schema_version, status, title, model_id, instructions_hash,
      source_memory_entry_ids_json, source_trace_event_ids_json, candidate_proposal_ids_json,
      created_at, updated_at, started_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    COWORK_DREAM_RUN_SCHEMA_VERSION,
    'running',
    title,
    modelId,
    sha256Text(instructions),
    JSON.stringify(sourceMemoryEntryIds),
    JSON.stringify(sourceTraceEventIds),
    JSON.stringify([]),
    now,
    now,
    now,
  )
  return getDreamRun(id)!
}

export function getDreamRun(id: string) {
  const row = getImprovementDb().prepare('select * from dream_runs where id = ?').get(id) as DbRow | undefined
  return row ? rowToDreamRun(row) : null
}

export function getRunningDreamRun() {
  const row = getImprovementDb().prepare(`
    select *
    from dream_runs
    where status = ?
    order by updated_at desc, id asc
    limit 1
  `).get('running') as DbRow | undefined
  return row ? rowToDreamRun(row) : null
}

export function getLatestDreamRun() {
  const row = getImprovementDb().prepare(`
    select *
    from dream_runs
    order by started_at desc, id asc
    limit 1
  `).get() as DbRow | undefined
  return row ? rowToDreamRun(row) : null
}

export function completeDreamRun(
  id: string,
  options: {
    candidateProposalIds?: string[]
    tokenUsage?: DreamRun['tokenUsage']
    costUsd?: number | null
  } = {},
) {
  const candidateProposalIds = Array.from(new Set((options.candidateProposalIds || []).map((proposalId) => boundedText(proposalId, 'Dream candidate proposal id', 512)))).sort()
  assertImprovementProposalsExist(candidateProposalIds)
  assertDreamRunIsRunning(id)
  const tokenUsage = options.tokenUsage || null
  if (tokenUsage) assertJsonSize(tokenUsage, 'Dream token usage', 16 * 1024)
  const costUsd = typeof options.costUsd === 'number' && Number.isFinite(options.costUsd) && options.costUsd >= 0 ? options.costUsd : null
  const now = nowIso()
  getImprovementDb().prepare(`
    update dream_runs
    set status = ?, candidate_proposal_ids_json = ?, token_usage_json = ?, cost_usd = ?, updated_at = ?, finished_at = ?
    where id = ?
  `).run('completed', JSON.stringify(candidateProposalIds), tokenUsage ? JSON.stringify(tokenUsage) : null, costUsd, now, now, id)
  return getDreamRun(id)
}

export function failDreamRun(id: string, error: string) {
  assertDreamRunIsRunning(id)
  const now = nowIso()
  getImprovementDb().prepare(`
    update dream_runs
    set status = ?, error = ?, updated_at = ?, finished_at = ?
    where id = ?
  `).run('failed', boundedText(error, 'Dream run error', 4096), now, now, id)
  return getDreamRun(id)
}

export function cancelDreamRun(id: string, note = 'Dream run cancelled.') {
  assertDreamRunIsRunning(id)
  const now = nowIso()
  getImprovementDb().prepare(`
    update dream_runs
    set status = ?, error = ?, updated_at = ?, finished_at = ?
    where id = ?
  `).run('cancelled', boundedText(note, 'Dream cancellation note', 4096), now, now, id)
  return getDreamRun(id)
}

export function archiveDreamRun(id: string, note = 'Dream run archived.') {
  return withImprovementTransaction(() => {
    const run = getDreamRun(id)
    if (!run) return null
    if (run.status === 'running') throw new Error('Running dream runs must be cancelled before archiving.')
    if (run.status === 'completed') throw new Error('Completed dream runs are retained as governed learning history.')
    if (run.status === 'archived') return run
    const now = nowIso()
    getImprovementDb().prepare(`
      update dream_runs
      set status = ?, error = coalesce(error, ?), updated_at = ?
      where id = ?
    `).run('archived', boundedText(note, 'Dream archive note', 4096), now, id)
    return getDreamRun(id)
  })
}

export function buildMemoryInjectionPlan(
  scopes: Array<{ scopeKind: AgentMemoryScopeKind; scopeId?: string | null }>,
  options: {
    limit?: number
    includeRestricted?: boolean
  } = {},
): MemoryInjectionPlan {
  const normalizedScopes = scopes.map((scope) => normalizeScope(scope.scopeKind, scope.scopeId))
  const scopeKeys = new Set(normalizedScopes.map((scope) => scopeKey(scope.scopeKind, scope.scopeId)))
  const limit = Math.max(1, Math.min(MAX_MEMORY_INJECTION_LIMIT, Math.floor(options.limit || DEFAULT_MEMORY_INJECTION_LIMIT)))
  const rows = getImprovementDb().prepare(`
    select *
    from agent_memory_entries
    where status = ?
    order by updated_at desc, id asc
  `).all('approved') as DbRow[]
  const matching = rows
    .map(rowToMemoryEntry)
    .filter((entry) => scopeKeys.has(scopeKey(entry.scopeKind, entry.scopeId)))
  const visible = options.includeRestricted ? matching : matching.filter((entry) => entry.privacy !== 'restricted')
  const entries = visible.slice(0, limit)
  return {
    entries,
    diagnostics: {
      consideredCount: matching.length,
      returnedCount: entries.length,
      limit,
      excludedRestrictedCount: matching.length - visible.length,
      scopeKeys: [...scopeKeys].sort(),
    },
  }
}

export function buildImprovementDiagnosticsSummary(
  policy: ImprovementPolicyDiagnostics,
): ImprovementDiagnosticsSummary {
  const db = getImprovementDb()
  const memory = emptyImprovementStatusCounts()
  const memoryRows = db.prepare(`
    select status, count(*) as count
    from agent_memory_entries
    group by status
  `).all() as Array<{ status: string; count: number }>
  for (const row of memoryRows) {
    if (MEMORY_STATUSES.has(row.status as AgentMemoryStatus)) {
      memory[row.status as AgentMemoryStatus] = Number(row.count || 0)
    }
  }

  const proposalCounts = emptyImprovementStatusCounts()
  const proposalRows = db.prepare(`
    select status, count(*) as count
    from improvement_proposals
    group by status
  `).all() as Array<{ status: string; count: number }>
  for (const row of proposalRows) {
    if (PROPOSAL_STATUSES.has(row.status as ImprovementProposalStatus)) {
      proposalCounts[row.status as ImprovementProposalStatus] = Number(row.count || 0)
    }
  }

  const dreamRuns = emptyDreamRunStatusCounts()
  const dreamRows = db.prepare(`
    select status, count(*) as count
    from dream_runs
    group by status
  `).all() as Array<{ status: string; count: number }>
  for (const row of dreamRows) {
    if (DREAM_RUN_STATUSES.has(row.status as DreamRunStatus)) {
      dreamRuns[row.status as DreamRunStatus] = Number(row.count || 0)
    }
  }

  const restrictedApprovedRow = db.prepare(`
    select count(*) as count
    from agent_memory_entries
    where status = ? and privacy_classification = ?
  `).get('approved', 'restricted') as { count?: number } | undefined
  const injection = buildMemoryInjectionPlan([{ scopeKind: 'machine' }]).diagnostics

  return {
    memory: {
      ...memory,
      approvedRestrictedCount: Number(restrictedApprovedRow?.count || 0),
      injection,
    },
    proposals: proposalCounts,
    dreamRuns,
    policy,
  }
}
