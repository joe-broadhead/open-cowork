import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  COWORK_OPERATION_SCHEMA_VERSION,
  COWORK_WORKSPACE_PROFILE_SCHEMA_VERSION,
  type AutonomyLevel,
  type OperationalQueueAlert,
  type OperationalQueueCaps,
  type OperationalQueueDraft,
  type OperationalQueueItem,
  type OperationalQueueKind,
  type OperationalQueueStatus,
  type WorkspaceAuthority,
  type WorkspaceProfile,
  type WorkspaceProfileKind,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'

export const OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION = 1

const OPERATIONAL_SCHEMA_VERSION_KEY = 'schema_version'
const MAX_TEXT_BYTES = 16 * 1024
const AUTONOMY_ORDER: AutonomyLevel[] = ['observe', 'draft', 'approve', 'supervised', 'bounded-auto']
const RUN_KINDS = new Set<OperationalQueueItem['runKind']>(['agent', 'crew', 'automation', 'sop', 'channel', 'dream'])
const QUEUE_KINDS = new Set<OperationalQueueKind>(['agent', 'crew', 'project', 'channel', 'external_system'])
const QUEUE_STATUSES = new Set<OperationalQueueStatus>(['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'])
const WORKSPACE_PROFILE_KINDS = new Set<WorkspaceProfileKind>(['personal_sandbox', 'project_workspace', 'automation_workspace', 'channel_sandbox', 'high_risk_isolated'])

type DbRow = Record<string, unknown>

let operationalDb: DatabaseSync | null = null
let operationalTransactionCounter = 0

function getOperationalDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'operational-queue.sqlite')
}

function ensureOperationalDbFileModes(dbPath = getOperationalDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function readSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from operational_meta where key = ?')
    .get(OPERATIONAL_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function recordSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into operational_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(OPERATIONAL_SCHEMA_VERSION_KEY, String(OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION))
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readSchemaVersion(db)
  if (version > OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION) {
    throw new Error(`Operational queue schema version ${version} is newer than supported version ${OPERATIONAL_QUEUE_STORE_SCHEMA_VERSION}.`)
  }
}

export function getOperationalQueueDb() {
  if (operationalDb) return operationalDb
  const dbPath = getOperationalDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec(`
      create table if not exists operational_meta (
        key text primary key,
        value text not null
      );
    `)
    assertSupportedSchemaVersion(db)
    db.exec(`
      create table if not exists workspace_profiles (
        id text primary key,
        schema_version integer not null,
        kind text not null,
        name text not null,
        description text not null,
        authority_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists operational_queue_items (
        id text primary key,
        schema_version integer not null,
        run_kind text not null,
        run_id text not null,
        title text not null,
        status text not null,
        requested_autonomy text not null,
        effective_autonomy text not null,
        workspace_profile_id text not null,
        authority_json text not null,
        queue_keys_json text not null,
        caps_json text not null,
        cost_usd real not null,
        attempt integer not null,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        error text
      );

      create unique index if not exists idx_operational_queue_run
        on operational_queue_items (run_kind, run_id);

      create index if not exists idx_operational_queue_status
        on operational_queue_items (status, created_at, id);
    `)
    recordSchemaVersion(db)
    seedWorkspaceProfiles(db)
    ensureOperationalDbFileModes(dbPath)
    operationalDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function clearOperationalQueueStoreCache() {
  if (operationalDb) {
    operationalDb.close()
    operationalDb = null
  }
  operationalTransactionCounter = 0
}

function withOperationalTransaction<T>(fn: () => T): T {
  const db = getOperationalQueueDb()
  const savepoint = `operational_tx_${++operationalTransactionCounter}`
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

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
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

function assertJsonSize(value: unknown, label: string, maxBytes = 256 * 1024) {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error(`${label} must be JSON-serializable.`)
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
}

function autonomyRank(level: AutonomyLevel) {
  const index = AUTONOMY_ORDER.indexOf(level)
  if (index < 0) throw new Error(`Autonomy level ${level} is not supported.`)
  return index
}

export function resolveEffectiveAutonomy(requested: AutonomyLevel, globalMax: AutonomyLevel = 'approve') {
  return AUTONOMY_ORDER[Math.min(autonomyRank(requested), autonomyRank(globalMax))]!
}

function authorityForKind(kind: WorkspaceProfileKind): WorkspaceAuthority {
  const base = {
    schemaVersion: COWORK_WORKSPACE_PROFILE_SCHEMA_VERSION,
    externalSystems: [],
  }
  switch (kind) {
    case 'personal_sandbox':
      return {
        ...base,
        filesystem: { mode: 'sandbox', roots: ['~/Open Cowork Sandbox/personal'], writeAllowed: true },
        cleanup: { retentionDays: 30, deletesUnreferencedArtifacts: true },
        isolation: { projectBound: false, channelBound: false, highRiskIsolated: false },
      }
    case 'project_workspace':
      return {
        ...base,
        filesystem: { mode: 'project', roots: ['<project grant>'], writeAllowed: true },
        cleanup: { retentionDays: 90, deletesUnreferencedArtifacts: false },
        isolation: { projectBound: true, channelBound: false, highRiskIsolated: false },
      }
    case 'automation_workspace':
      return {
        ...base,
        filesystem: { mode: 'sandbox', roots: ['~/Open Cowork Sandbox/automations'], writeAllowed: true },
        cleanup: { retentionDays: 45, deletesUnreferencedArtifacts: true },
        isolation: { projectBound: true, channelBound: false, highRiskIsolated: false },
      }
    case 'channel_sandbox':
      return {
        ...base,
        filesystem: { mode: 'sandbox', roots: ['~/Open Cowork Sandbox/channels'], writeAllowed: false },
        cleanup: { retentionDays: 14, deletesUnreferencedArtifacts: true },
        isolation: { projectBound: false, channelBound: true, highRiskIsolated: false },
      }
    case 'high_risk_isolated':
      return {
        ...base,
        filesystem: { mode: 'sandbox', roots: ['~/Open Cowork Sandbox/isolated'], writeAllowed: false },
        cleanup: { retentionDays: 7, deletesUnreferencedArtifacts: true },
        isolation: { projectBound: false, channelBound: false, highRiskIsolated: true },
      }
  }
}

function seedWorkspaceProfiles(db: DatabaseSync) {
  const now = nowIso()
  const profiles: Array<{ id: string; kind: WorkspaceProfileKind; name: string; description: string }> = [
    { id: 'personal-sandbox', kind: 'personal_sandbox', name: 'Personal sandbox', description: 'Default local sandbox for exploratory personal work.' },
    { id: 'project-workspace', kind: 'project_workspace', name: 'Project workspace', description: 'Project-bound work using explicit filesystem grants.' },
    { id: 'automation-workspace', kind: 'automation_workspace', name: 'Automation workspace', description: 'Durable automation sandbox with bounded retention.' },
    { id: 'channel-sandbox', kind: 'channel_sandbox', name: 'Channel sandbox', description: 'Draft-first channel workspace without direct filesystem writes.' },
    { id: 'high-risk-isolated', kind: 'high_risk_isolated', name: 'High-risk isolated', description: 'Short-lived isolated workspace for risky capabilities.' },
  ]
  for (const profile of profiles) {
    db.prepare(`
      insert into workspace_profiles (
        id, schema_version, kind, name, description, authority_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        schema_version = excluded.schema_version,
        kind = excluded.kind,
        name = excluded.name,
        description = excluded.description,
        authority_json = excluded.authority_json,
        updated_at = excluded.updated_at
    `).run(
      profile.id,
      COWORK_WORKSPACE_PROFILE_SCHEMA_VERSION,
      profile.kind,
      profile.name,
      profile.description,
      JSON.stringify(authorityForKind(profile.kind)),
      now,
      now,
    )
  }
}

function rowToWorkspaceProfile(row: DbRow): WorkspaceProfile {
  const kind = WORKSPACE_PROFILE_KINDS.has(String(row.kind) as WorkspaceProfileKind)
    ? String(row.kind) as WorkspaceProfileKind
    : 'personal_sandbox'
  return {
    schemaVersion: Number(row.schema_version || COWORK_WORKSPACE_PROFILE_SCHEMA_VERSION),
    id: String(row.id || ''),
    kind,
    name: String(row.name || ''),
    description: String(row.description || ''),
    authority: parseJson<WorkspaceAuthority>(row.authority_json, authorityForKind(kind)),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

export function listWorkspaceProfiles() {
  const rows = getOperationalQueueDb().prepare('select * from workspace_profiles order by id asc').all() as DbRow[]
  return rows.map(rowToWorkspaceProfile)
}

export function getWorkspaceProfile(id: string) {
  const row = getOperationalQueueDb().prepare('select * from workspace_profiles where id = ?').get(id) as DbRow | undefined
  return row ? rowToWorkspaceProfile(row) : null
}

function defaultCaps(input: OperationalQueueDraft): OperationalQueueCaps {
  return {
    schemaVersion: COWORK_OPERATION_SCHEMA_VERSION,
    maxParallel: boundedInteger(input.caps?.maxParallel, 1, 1, 50),
    maxRunDurationMinutes: boundedInteger(input.caps?.maxRunDurationMinutes, 60, 1, 24 * 60),
    maxCostUsd: typeof input.caps?.maxCostUsd === 'number' && Number.isFinite(input.caps.maxCostUsd) && input.caps.maxCostUsd >= 0
      ? input.caps.maxCostUsd
      : null,
    maxRetries: boundedInteger(input.caps?.maxRetries, 0, 0, 10),
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeCostUsd(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function queueKey(kind: OperationalQueueKind, value: string) {
  if (!QUEUE_KINDS.has(kind)) throw new Error(`Queue kind ${kind} is not supported.`)
  return `${kind}:${value}`
}

export function buildOperationalQueueKeys(input: {
  writeCapable: boolean
  agentName?: string | null
  crewId?: string | null
  projectId?: string | null
  channelId?: string | null
  externalSystemIds?: string[]
}) {
  if (!input.writeCapable) return []
  const keys = new Set<string>()
  const agentName = optionalBoundedText(input.agentName, 'Queue agent name', 512)
  const crewId = optionalBoundedText(input.crewId, 'Queue crew id', 512)
  const projectId = optionalBoundedText(input.projectId, 'Queue project id', 2048)
  const channelId = optionalBoundedText(input.channelId, 'Queue channel id', 512)
  if (agentName) keys.add(queueKey('agent', agentName))
  if (crewId) keys.add(queueKey('crew', crewId))
  if (projectId) keys.add(queueKey('project', projectId))
  if (channelId) keys.add(queueKey('channel', channelId))
  for (const externalId of input.externalSystemIds || []) {
    keys.add(queueKey('external_system', boundedText(externalId, 'Queue external system id', 512)))
  }
  return [...keys].sort()
}

function rowToQueueItem(row: DbRow): OperationalQueueItem {
  const runKind = RUN_KINDS.has(String(row.run_kind) as OperationalQueueItem['runKind'])
    ? String(row.run_kind) as OperationalQueueItem['runKind']
    : 'agent'
  const status = QUEUE_STATUSES.has(String(row.status) as OperationalQueueStatus)
    ? String(row.status) as OperationalQueueStatus
    : 'queued'
  const authority = parseJson<WorkspaceAuthority>(row.authority_json, authorityForKind('personal_sandbox'))
  return {
    schemaVersion: Number(row.schema_version || COWORK_OPERATION_SCHEMA_VERSION),
    id: String(row.id || ''),
    runKind,
    runId: String(row.run_id || ''),
    title: String(row.title || ''),
    status,
    requestedAutonomy: String(row.requested_autonomy || 'approve') as AutonomyLevel,
    effectiveAutonomy: String(row.effective_autonomy || 'approve') as AutonomyLevel,
    workspaceProfileId: String(row.workspace_profile_id || ''),
    authority,
    queueKeys: parseJson<string[]>(row.queue_keys_json, []),
    caps: parseJson<OperationalQueueCaps>(row.caps_json, defaultCaps({
      runKind: 'agent',
      runId: 'unknown',
      title: 'unknown',
      requestedAutonomy: 'approve',
      workspaceProfileId: 'personal-sandbox',
      writeCapable: false,
    })),
    costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : 0,
    attempt: Number(row.attempt || 0),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    startedAt: typeof row.started_at === 'string' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
    error: typeof row.error === 'string' ? row.error : null,
  }
}

export function enqueueOperationalRun(draft: OperationalQueueDraft) {
  if (!RUN_KINDS.has(draft.runKind)) throw new Error(`Operational run kind ${draft.runKind} is not supported.`)
  const profile = getWorkspaceProfile(boundedText(draft.workspaceProfileId, 'Workspace profile id', 512))
  if (!profile) throw new Error(`Workspace profile ${draft.workspaceProfileId} does not exist.`)
  const title = boundedText(draft.title, 'Operational run title')
  const runId = boundedText(draft.runId, 'Operational run id', 512)
  const effectiveAutonomy = resolveEffectiveAutonomy(draft.requestedAutonomy, draft.globalMaxAutonomy || 'approve')
  const queueKeys = buildOperationalQueueKeys(draft)
  const caps = defaultCaps(draft)
  assertJsonSize(profile.authority, 'Workspace authority')
  assertJsonSize(queueKeys, 'Operational queue keys')
  assertJsonSize(caps, 'Operational queue caps')
  const id = randomUUID()
  const now = nowIso()
  getOperationalQueueDb().prepare(`
    insert into operational_queue_items (
      id, schema_version, run_kind, run_id, title, status, requested_autonomy,
      effective_autonomy, workspace_profile_id, authority_json, queue_keys_json,
      caps_json, cost_usd, attempt, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    COWORK_OPERATION_SCHEMA_VERSION,
    draft.runKind,
    runId,
    title,
    'queued',
    draft.requestedAutonomy,
    effectiveAutonomy,
    profile.id,
    JSON.stringify(profile.authority),
    JSON.stringify(queueKeys),
    JSON.stringify(caps),
    0,
    0,
    now,
    now,
  )
  return getOperationalQueueItem(id)!
}

export function getOperationalQueueItem(id: string) {
  const row = getOperationalQueueDb().prepare('select * from operational_queue_items where id = ?').get(id) as DbRow | undefined
  return row ? rowToQueueItem(row) : null
}

export function getOperationalQueueItemForRun(runKind: OperationalQueueItem['runKind'], runId: string) {
  if (!RUN_KINDS.has(runKind)) throw new Error(`Operational run kind ${runKind} is not supported.`)
  const row = getOperationalQueueDb().prepare('select * from operational_queue_items where run_kind = ? and run_id = ?')
    .get(runKind, boundedText(runId, 'Operational run id', 512)) as DbRow | undefined
  return row ? rowToQueueItem(row) : null
}

export function listOperationalQueueItems() {
  const rows = getOperationalQueueDb().prepare('select * from operational_queue_items order by created_at asc, rowid asc').all() as DbRow[]
  return rows.map(rowToQueueItem)
}

function hasQueueCapacity(active: OperationalQueueItem[], item: OperationalQueueItem) {
  if (item.queueKeys.length === 0) return true
  for (const key of item.queueKeys) {
    const sharing = active.filter((candidate) => candidate.queueKeys.includes(key))
    if (sharing.length === 0) continue
    const allowed = Math.max(1, Math.min(item.caps.maxParallel, ...sharing.map((candidate) => candidate.caps.maxParallel)))
    if (sharing.length >= allowed) return false
  }
  return true
}

function queueItemsConflict(left: OperationalQueueItem, right: OperationalQueueItem) {
  if (left.queueKeys.length === 0 || right.queueKeys.length === 0) return false
  return left.queueKeys.some((key) => right.queueKeys.includes(key))
}

export function startOperationalQueueItem(id: string) {
  return withOperationalTransaction(() => {
    const ordered = listOperationalQueueItems()
    const itemIndex = ordered.findIndex((item) => item.id === id)
    const item = itemIndex >= 0 ? ordered[itemIndex] : null
    if (!item || item.status !== 'queued') return item
    const active = ordered.filter((candidate) => candidate.status === 'running' || candidate.status === 'blocked')
    const earlierQueuedConflict = ordered
      .slice(0, itemIndex)
      .some((candidate) => candidate.status === 'queued' && queueItemsConflict(candidate, item))
    if (earlierQueuedConflict || !hasQueueCapacity(active, item)) return item
    const now = nowIso()
    getOperationalQueueDb().prepare(`
      update operational_queue_items
      set status = ?, started_at = coalesce(started_at, ?), updated_at = ?, attempt = attempt + 1
      where id = ? and status = ?
    `).run('running', now, now, item.id, 'queued')
    return getOperationalQueueItem(item.id)
  })
}

export function startRunnableOperationalQueueItems(limit = 100) {
  return withOperationalTransaction(() => {
    const startLimit = boundedInteger(limit, 100, 1, 1000)
    const started: OperationalQueueItem[] = []
    const running = listOperationalQueueItems().filter((item) => item.status === 'running' || item.status === 'blocked')
    const active = [...running]
    const queued = listOperationalQueueItems().filter((item) => item.status === 'queued')
    const now = nowIso()
    for (const item of queued) {
      if (started.length >= startLimit) break
      if (!hasQueueCapacity(active, item)) continue
      getOperationalQueueDb().prepare(`
        update operational_queue_items
        set status = ?, started_at = coalesce(started_at, ?), updated_at = ?, attempt = attempt + 1
        where id = ? and status = ?
      `).run('running', now, now, item.id, 'queued')
      const updated = getOperationalQueueItem(item.id)
      if (!updated) continue
      started.push(updated)
      active.push(updated)
    }
    return started
  })
}

export function recordOperationalQueueItemCost(id: string, costUsd: number) {
  const now = nowIso()
  getOperationalQueueDb().prepare(`
    update operational_queue_items
    set cost_usd = ?, updated_at = ?
    where id = ? and status = ?
  `).run(normalizeCostUsd(costUsd), now, id, 'running')
  return getOperationalQueueItem(id)
}

export function blockOperationalQueueItem(id: string, reason: string) {
  const now = nowIso()
  getOperationalQueueDb().prepare(`
    update operational_queue_items
    set status = ?, updated_at = ?, error = ?
    where id = ? and status in ('queued', 'running')
  `).run('blocked', now, optionalBoundedText(reason, 'Operational queue block reason', 4096), id)
  return getOperationalQueueItem(id)
}

export function resumeBlockedOperationalQueueItem(id: string) {
  const now = nowIso()
  getOperationalQueueDb().prepare(`
    update operational_queue_items
    set status = ?, started_at = coalesce(started_at, ?), updated_at = ?, error = null
    where id = ? and status = ?
  `).run('running', now, now, id, 'blocked')
  return getOperationalQueueItem(id)
}

export function retryOperationalQueueItem(id: string) {
  return withOperationalTransaction(() => {
    const item = getOperationalQueueItem(id)
    if (!item || (item.status !== 'failed' && item.status !== 'blocked')) return item
    if (item.attempt > item.caps.maxRetries) return item
    const now = nowIso()
    getOperationalQueueDb().prepare(`
      update operational_queue_items
      set status = ?, updated_at = ?, started_at = null, finished_at = null, error = null
      where id = ? and status in ('failed', 'blocked')
    `).run('queued', now, id)
    return getOperationalQueueItem(id)
  })
}

export function finishOperationalQueueItem(id: string, status: Exclude<OperationalQueueStatus, 'queued' | 'running' | 'blocked'>, options: {
  error?: string | null
  costUsd?: number | null
} = {}) {
  const now = nowIso()
  const costUsd = options.costUsd === undefined || options.costUsd === null ? null : normalizeCostUsd(options.costUsd)
  getOperationalQueueDb().prepare(`
    update operational_queue_items
    set status = ?, finished_at = ?, updated_at = ?, error = ?, cost_usd = coalesce(?, cost_usd)
    where id = ? and status in ('queued', 'running', 'blocked')
  `).run(status, now, now, optionalBoundedText(options.error, 'Operational queue error', 4096), costUsd, id)
  return getOperationalQueueItem(id)
}

export function buildOperationalQueueAlerts(now = nowIso()): OperationalQueueAlert[] {
  const nowMs = Date.parse(now)
  const alerts: OperationalQueueAlert[] = []
  for (const item of listOperationalQueueItems()) {
    if (item.status === 'blocked') {
      alerts.push({
        schemaVersion: COWORK_OPERATION_SCHEMA_VERSION,
        queueItemId: item.id,
        severity: 'warning',
        kind: 'blocked_run',
        message: item.error || 'Run is blocked and requires attention.',
        createdAt: now,
      })
      continue
    }
    if (item.status !== 'running') continue
    const startedMs = item.startedAt ? Date.parse(item.startedAt) : Number.NaN
    if (Number.isFinite(startedMs) && Number.isFinite(nowMs)) {
      const ageMinutes = (nowMs - startedMs) / 60000
      if (ageMinutes > item.caps.maxRunDurationMinutes) {
        alerts.push({
          schemaVersion: COWORK_OPERATION_SCHEMA_VERSION,
          queueItemId: item.id,
          severity: 'critical',
          kind: 'stuck_run',
          message: `Run exceeded ${item.caps.maxRunDurationMinutes} minute queue duration cap.`,
          createdAt: now,
        })
      }
    }
    if (item.caps.maxCostUsd !== null && item.costUsd > item.caps.maxCostUsd) {
      alerts.push({
        schemaVersion: COWORK_OPERATION_SCHEMA_VERSION,
        queueItemId: item.id,
        severity: 'critical',
        kind: 'budget_exceeded',
        message: `Run exceeded $${item.caps.maxCostUsd.toFixed(2)} queue budget cap.`,
        createdAt: now,
      })
    }
  }
  return alerts
}
