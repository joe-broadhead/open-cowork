import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION,
  type GovernanceAuditActor,
  type GovernanceAuditEvent,
  type GovernanceAuditEventDraft,
  type GovernanceAuditEventKind,
  type GovernanceAuditOutcome,
  type GovernanceIncidentControlKind,
  type GovernanceLifecycleState,
  type GovernanceSubjectKind,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'

export const GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION = 1

const GOVERNANCE_AUDIT_SCHEMA_VERSION_KEY = 'schema_version'
const MAX_TEXT_BYTES = 16 * 1024
const MAX_METADATA_BYTES = 128 * 1024
const DEFAULT_AUDIT_LIST_LIMIT = 500
const AUDIT_KINDS = new Set<GovernanceAuditEventKind>(['incident_control'])
const AUDIT_OUTCOMES = new Set<GovernanceAuditOutcome>(['succeeded', 'failed'])
const SUBJECT_KINDS = new Set<GovernanceSubjectKind>(['agent', 'crew'])
const INCIDENT_ACTIONS = new Set<GovernanceIncidentControlKind>([
  'pause_agent',
  'retire_agent',
  'pause_crew',
  'retire_crew',
  'export_audit',
])
const LIFECYCLE_STATES = new Set<GovernanceLifecycleState>(['draft', 'review', 'approved', 'active', 'paused', 'retired'])

type DbRow = Record<string, unknown>

let governanceAuditDb: DatabaseSync | null = null
let governanceAuditTransactionCounter = 0

function getGovernanceAuditDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'governance-audit.sqlite')
}

function ensureGovernanceAuditDbFileModes(dbPath = getGovernanceAuditDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function readSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from governance_audit_meta where key = ?')
    .get(GOVERNANCE_AUDIT_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readSchemaVersion(db)
  if (version > GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION) {
    throw new Error(`Governance audit schema version ${version} is newer than supported version ${GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION}.`)
  }
}

function recordSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into governance_audit_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(GOVERNANCE_AUDIT_SCHEMA_VERSION_KEY, String(GOVERNANCE_AUDIT_STORE_SCHEMA_VERSION))
}

export function getGovernanceAuditDb() {
  if (governanceAuditDb) return governanceAuditDb
  const dbPath = getGovernanceAuditDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec(`
      create table if not exists governance_audit_meta (
        key text primary key,
        value text not null
      );
    `)
    assertSupportedSchemaVersion(db)
    db.exec(`
      create table if not exists governance_audit_events (
        sequence integer primary key autoincrement,
        id text not null unique,
        schema_version integer not null,
        kind text not null,
        subject_kind text not null,
        subject_id text not null,
        action text not null,
        outcome text not null,
        actor_kind text not null,
        actor_id text not null,
        actor_display_name text not null,
        reason text,
        before_lifecycle text,
        after_lifecycle text,
        metadata_json text not null,
        created_at text not null
      );

      create index if not exists idx_governance_audit_created
        on governance_audit_events (sequence desc);

      create index if not exists idx_governance_audit_subject
        on governance_audit_events (subject_kind, subject_id, sequence desc);
    `)
    recordSchemaVersion(db)
    ensureGovernanceAuditDbFileModes(dbPath)
    governanceAuditDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function clearGovernanceAuditStoreCache() {
  if (governanceAuditDb) {
    governanceAuditDb.close()
    governanceAuditDb = null
  }
  governanceAuditTransactionCounter = 0
}

function withGovernanceAuditTransaction<T>(fn: () => T): T {
  const db = getGovernanceAuditDb()
  const savepoint = `governance_audit_tx_${++governanceAuditTransactionCounter}`
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

function lifecycleState(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !LIFECYCLE_STATES.has(value as GovernanceLifecycleState)) {
    throw new Error(`${label} is invalid.`)
  }
  return value as GovernanceLifecycleState
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeActor(actor: GovernanceAuditEventDraft['actor']): GovernanceAuditActor {
  const kind = actor?.kind === 'system' || actor?.kind === 'group' || actor?.kind === 'user' ? actor.kind : 'user'
  const id = optionalBoundedText(actor?.id, 'Governance audit actor id') || 'local-user'
  const displayName = optionalBoundedText(actor?.displayName, 'Governance audit actor display name') || (kind === 'system' ? 'Open Cowork' : 'Local user')
  return { kind, id, displayName }
}

function normalizeMetadata(metadata: unknown) {
  const value = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}
  let raw: string | undefined
  try {
    raw = JSON.stringify(value)
  } catch {
    throw new Error('Governance audit metadata must be JSON-serializable.')
  }
  if (raw === undefined) throw new Error('Governance audit metadata must be JSON-serializable.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) throw new Error('Governance audit metadata is too large.')
  return raw
}

function eventFromRow(row: DbRow): GovernanceAuditEvent {
  return {
    schemaVersion: Number(row.schema_version || COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION),
    id: String(row.id || ''),
    kind: String(row.kind || 'incident_control') as GovernanceAuditEventKind,
    subjectKind: String(row.subject_kind || 'agent') as GovernanceSubjectKind,
    subjectId: String(row.subject_id || ''),
    action: String(row.action || 'export_audit') as GovernanceIncidentControlKind,
    outcome: String(row.outcome || 'succeeded') as GovernanceAuditOutcome,
    actor: {
      kind: String(row.actor_kind || 'user') as GovernanceAuditActor['kind'],
      id: String(row.actor_id || ''),
      displayName: String(row.actor_display_name || ''),
    },
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    beforeLifecycle: row.before_lifecycle === null || row.before_lifecycle === undefined ? null : String(row.before_lifecycle) as GovernanceLifecycleState,
    afterLifecycle: row.after_lifecycle === null || row.after_lifecycle === undefined ? null : String(row.after_lifecycle) as GovernanceLifecycleState,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: String(row.created_at || ''),
  }
}

export function recordGovernanceAuditEvent(input: GovernanceAuditEventDraft): GovernanceAuditEvent {
  const subjectKind = input.subjectKind
  if (!SUBJECT_KINDS.has(subjectKind)) throw new Error('Governance audit subject kind is invalid.')
  const action = input.action
  if (!INCIDENT_ACTIONS.has(action)) throw new Error('Governance audit action is invalid.')
  const outcome = input.outcome || 'succeeded'
  if (!AUDIT_OUTCOMES.has(outcome)) throw new Error('Governance audit outcome is invalid.')
  const kind = 'incident_control' satisfies GovernanceAuditEventKind
  if (!AUDIT_KINDS.has(kind)) throw new Error('Governance audit kind is invalid.')
  const actor = normalizeActor(input.actor)
  const metadataJson = normalizeMetadata(input.metadata)
  const event: GovernanceAuditEvent = {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION,
    id: randomUUID(),
    kind,
    subjectKind,
    subjectId: boundedText(input.subjectId, 'Governance audit subject id'),
    action,
    outcome,
    actor,
    reason: optionalBoundedText(input.reason, 'Governance audit reason'),
    beforeLifecycle: lifecycleState(input.beforeLifecycle, 'Governance audit before lifecycle'),
    afterLifecycle: lifecycleState(input.afterLifecycle, 'Governance audit after lifecycle'),
    metadata: parseJson<Record<string, unknown>>(metadataJson, {}),
    createdAt: nowIso(),
  }
  return withGovernanceAuditTransaction(() => {
    getGovernanceAuditDb().prepare(`
      insert into governance_audit_events (
        id, schema_version, kind, subject_kind, subject_id, action, outcome,
        actor_kind, actor_id, actor_display_name, reason,
        before_lifecycle, after_lifecycle, metadata_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.schemaVersion,
      event.kind,
      event.subjectKind,
      event.subjectId,
      event.action,
      event.outcome,
      event.actor.kind,
      event.actor.id,
      event.actor.displayName,
      event.reason,
      event.beforeLifecycle,
      event.afterLifecycle,
      metadataJson,
      event.createdAt,
    )
    return event
  })
}

type GovernanceAuditQueryOptions = {
  subjectKind?: GovernanceSubjectKind
  subjectId?: string
  limit?: number
}

function resolveAuditLimit(
  value: number | undefined,
  defaults: { defaultLimit: number | null; maxLimit: number | null },
) {
  const requestedLimit = typeof value === 'number' && Number.isFinite(value)
    ? value
    : defaults.defaultLimit
  if (requestedLimit === null) return null
  const normalized = Math.max(1, Math.trunc(requestedLimit))
  return defaults.maxLimit === null ? normalized : Math.min(normalized, defaults.maxLimit)
}

function readGovernanceAuditEvents(
  options: GovernanceAuditQueryOptions,
  limits: { defaultLimit: number | null; maxLimit: number | null },
): GovernanceAuditEvent[] {
  const limit = resolveAuditLimit(options.limit, limits)
  if ((options.subjectKind && !options.subjectId) || (!options.subjectKind && options.subjectId)) {
    throw new Error('Governance audit subject filters require both kind and id.')
  }
  const hasSubjectFilter = Boolean(options.subjectKind && options.subjectId)
  if (hasSubjectFilter) {
    const subjectKind = options.subjectKind!
    const subjectId = boundedText(options.subjectId, 'Governance audit subject id')
    if (!SUBJECT_KINDS.has(subjectKind)) throw new Error('Governance audit subject kind is invalid.')
    const sql = `
      select * from governance_audit_events
      where subject_kind = ? and subject_id = ?
      order by sequence desc
      ${limit === null ? '' : 'limit ?'}
    `
    const args = limit === null ? [subjectKind, subjectId] : [subjectKind, subjectId, limit]
    return (getGovernanceAuditDb().prepare(sql).all(...args) as DbRow[])
      .map(eventFromRow)
  }
  const sql = `
    select * from governance_audit_events
    order by sequence desc
    ${limit === null ? '' : 'limit ?'}
  `
  const args = limit === null ? [] : [limit]
  return (getGovernanceAuditDb().prepare(sql).all(...args) as DbRow[]).map(eventFromRow)
}

export function listGovernanceAuditEvents(options: GovernanceAuditQueryOptions = {}): GovernanceAuditEvent[] {
  return readGovernanceAuditEvents(options, {
    defaultLimit: DEFAULT_AUDIT_LIST_LIMIT,
    maxLimit: DEFAULT_AUDIT_LIST_LIMIT,
  })
}

export function listGovernanceAuditEventsForExport(options: GovernanceAuditQueryOptions = {}): GovernanceAuditEvent[] {
  return readGovernanceAuditEvents(options, {
    defaultLimit: null,
    maxLimit: null,
  })
}
