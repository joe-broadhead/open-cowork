import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CoordinationArtifactLink,
  CoordinationBoardPayload,
  CoordinationProject,
  CoordinationProjectInput,
  CoordinationProjectStatus,
  CoordinationProjectUpdateInput,
  CoordinationTask,
  CoordinationTaskColumn,
  CoordinationTaskInput,
  CoordinationTaskPriority,
  CoordinationTaskStatus,
  CoordinationTaskUpdateInput,
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchChannel,
  CoordinationWatchEventType,
  CoordinationWatchInput,
  CoordinationWatchRecipient,
  CoordinationWatchRecipientRole,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
  CoordinationWatchVerbosity,
} from '@open-cowork/shared'
import {
  WORKSPACE_PRODUCT_SURFACES,
  coordinationTaskColumnForStatus,
  isCoordinationProjectStatus,
  isCoordinationTaskColumn,
  isCoordinationTaskPriority,
  isCoordinationTaskStatus,
  isCoordinationWatchEvent,
  isCoordinationWatchRecipientRole,
  isCoordinationWatchStatus,
  isCoordinationWatchTarget,
  isCoordinationWatchVerbosity,
} from '@open-cowork/shared'
import { getAppDataDir } from '@open-cowork/runtime-host/config'

const COORDINATION_DB_SCHEMA_VERSION = 2
const COORDINATION_SCHEMA_VERSION_KEY = 'schema_version'
const LOCAL_WORKSPACE_ID = 'local'
const MAX_TITLE_BYTES = 240
const MAX_TEXT_BYTES = 32 * 1024
const MAX_AGENT_ID_BYTES = 256
const MAX_ARTIFACT_REFS = 100
const MAX_WATCH_EVENTS = 16
const MAX_CHANNEL_TARGET_BYTES = 16 * 1024

let coordinationDb: DatabaseSync | null = null
let coordinationDbForTests: DatabaseSync | null = null
let transactionCounter = 0

type DbRow = Record<string, unknown>
type CoordinationWriteOptions = {
  now?: Date
  id?: string
}

function coordinationDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'coordination.sqlite')
}

function ensureCoordinationDbFileModes(dbPath = coordinationDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function initDb(db: DatabaseSync) {
  db.exec(`
    create table if not exists coordination_meta (
      key text primary key,
      value text not null
    );
    create table if not exists coordination_projects (
      id text primary key,
      workspace_id text not null,
      owner_authority text not null,
      execution_authority text not null,
      state_owner text not null,
      title text not null,
      objective text not null,
      description text,
      status text not null,
      team_json text not null,
      source_session_id text,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists coordination_tasks (
      id text primary key,
      workspace_id text not null,
      owner_authority text not null,
      execution_authority text not null,
      state_owner text not null,
      project_id text not null,
      parent_task_id text,
      title text not null,
      spec text not null,
      description text,
      status text not null,
      column_name text not null,
      priority text not null,
      external_ref text,
      assignee_agent text,
      assigned_run_id text,
      assigned_session_id text,
      artifact_refs_json text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references coordination_projects(id) on delete cascade,
      foreign key(parent_task_id) references coordination_tasks(id) on delete set null
    );
    create table if not exists coordination_watches (
      id text primary key,
      workspace_id text not null,
      owner_authority text not null,
      execution_authority text not null,
      state_owner text not null,
      target_kind text not null,
      target_id text not null,
      events_json text not null,
      delivery_surface text not null,
      channel_json text not null,
      recipient_json text,
      status text not null,
      verbosity text not null,
      cursor_json text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_coordination_projects_workspace on coordination_projects(workspace_id, updated_at);
    create index if not exists idx_coordination_tasks_project on coordination_tasks(project_id, column_name, updated_at);
    create index if not exists idx_coordination_tasks_session on coordination_tasks(assigned_session_id);
    create index if not exists idx_coordination_watches_workspace on coordination_watches(workspace_id, status, updated_at);
    create index if not exists idx_coordination_watches_target on coordination_watches(workspace_id, target_kind, target_id, status);
  `)
  db.prepare(`
    insert into coordination_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(COORDINATION_SCHEMA_VERSION_KEY, String(COORDINATION_DB_SCHEMA_VERSION))
}

export function getCoordinationDb() {
  if (coordinationDbForTests) return coordinationDbForTests
  if (coordinationDb) return coordinationDb
  const dbPath = coordinationDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec('pragma foreign_keys = ON;')
    initDb(db)
    ensureCoordinationDbFileModes(dbPath)
    coordinationDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function setCoordinationDatabaseForTests(db: DatabaseSync | null) {
  coordinationDb?.close()
  coordinationDb = null
  coordinationDbForTests = db
  transactionCounter = 0
  if (db) {
    db.exec('pragma foreign_keys = ON;')
    initDb(db)
  }
}

export function clearCoordinationStoreCache() {
  coordinationDb?.close()
  coordinationDb = null
  coordinationDbForTests = null
  transactionCounter = 0
}

function withTransaction<T>(callback: (db: DatabaseSync) => T): T {
  const db = getCoordinationDb()
  const savepoint = `coordination_tx_${transactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    if (!coordinationDbForTests) ensureCoordinationDbFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      if (!coordinationDbForTests) ensureCoordinationDbFileModes()
    }
    throw error
  }
}

function nowIso(options?: CoordinationWriteOptions) {
  return (options?.now || new Date()).toISOString()
}

function readWorkspaceId(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || LOCAL_WORKSPACE_ID
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function stringValue(value: unknown, label: string, options: { required?: boolean; maxBytes?: number } = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  const maxBytes = options.maxBytes || MAX_TEXT_BYTES
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label} is too large.`)
  return trimmed
}

function optionalString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { maxBytes })
}

function requiredString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { required: true, maxBytes })!
}

function normalizeTeam(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Project team must be an array of agent ids.')
  const unique = new Set<string>()
  for (const entry of value) {
    const agent = optionalString(entry, 'Project team agent', MAX_AGENT_ID_BYTES)
    if (agent) unique.add(agent)
  }
  return Array.from(unique).slice(0, 100)
}

function normalizeArtifactRefs(value: unknown): CoordinationArtifactLink[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Task artifact refs must be an array.')
  return value.slice(0, MAX_ARTIFACT_REFS).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Task artifact ref ${index + 1} must be an object.`)
    const record = entry as Record<string, unknown>
    return {
      artifactId: requiredString(record.artifactId, 'Artifact id', 512),
      title: optionalString(record.title, 'Artifact title', MAX_TITLE_BYTES),
      sessionId: optionalString(record.sessionId, 'Artifact session id', 512),
      runId: optionalString(record.runId, 'Artifact run id', 512),
    }
  })
}

function jsonString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  const json = JSON.stringify(value)
  if (byteLength(json) > maxBytes) throw new Error(`${label} is too large.`)
  return json
}

function normalizeWatchTarget(value: unknown): CoordinationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch target is required.')
  const record = value as Record<string, unknown>
  if (!isCoordinationWatchTarget(record.kind)) throw new Error('Watch target kind is invalid.')
  return {
    kind: record.kind,
    id: requiredString(record.id, 'Watch target id', 512),
  }
}

function assertImplementedWatchTarget(target: CoordinationTarget) {
  if (
    target.kind !== 'project'
    && target.kind !== 'task'
    && target.kind !== 'session'
    && target.kind !== 'conversation'
  ) {
    throw new Error(`Watch target kind "${target.kind}" is not supported until ${target.kind} watch events are implemented.`)
  }
}

function normalizeWatchEvents(value: unknown): CoordinationWatchEventType[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Watch events must be a non-empty array.')
  const unique = new Set<CoordinationWatchEventType>()
  for (const entry of value) {
    if (!isCoordinationWatchEvent(entry)) throw new Error('Watch event is invalid.')
    unique.add(entry)
  }
  return Array.from(unique).slice(0, MAX_WATCH_EVENTS)
}

function normalizeWatchStatus(value: unknown, fallback: CoordinationWatchStatus): CoordinationWatchStatus {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationWatchStatus(value)) throw new Error('Watch status is invalid.')
  return value
}

function normalizeWatchVerbosity(value: unknown, fallback: CoordinationWatchVerbosity): CoordinationWatchVerbosity {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationWatchVerbosity(value)) throw new Error('Watch verbosity is invalid.')
  return value
}

function normalizeWatchDeliverySurface(value: unknown, fallback: CoordinationWatch['deliverySurface']): CoordinationWatch['deliverySurface'] {
  if (value === undefined || value === null) return fallback
  if (value === 'gateway_channel' || WORKSPACE_PRODUCT_SURFACES.includes(value as (typeof WORKSPACE_PRODUCT_SURFACES)[number])) {
    return value as CoordinationWatch['deliverySurface']
  }
  throw new Error('Watch delivery surface is invalid.')
}

function normalizeWatchRecipientRole(value: unknown): CoordinationWatchRecipientRole | null {
  if (value === undefined || value === null) return null
  if (!isCoordinationWatchRecipientRole(value)) throw new Error('Watch recipient role is invalid.')
  return value
}

function normalizeWatchChannel(value: unknown): CoordinationWatchChannel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch channel is required.')
  const record = value as Record<string, unknown>
  const target = record.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('Watch channel target is required.')
  const normalized: CoordinationWatchChannel = {
    provider: requiredString(record.provider, 'Watch channel provider', 128),
    agentId: requiredString(record.agentId, 'Watch channel agent id', MAX_AGENT_ID_BYTES),
    channelBindingId: requiredString(record.channelBindingId, 'Watch channel binding id', 512),
    sessionBindingId: optionalString(record.sessionBindingId, 'Watch channel session binding id', 512),
    target: target as Record<string, unknown>,
  }
  jsonString(normalized.target, 'Watch channel target', MAX_CHANNEL_TARGET_BYTES)
  return normalized
}

function normalizeWatchRecipient(value: unknown): CoordinationWatchRecipient | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch recipient must be an object.')
  const record = value as Record<string, unknown>
  const recipient: CoordinationWatchRecipient = {
    identityId: optionalString(record.identityId, 'Watch recipient identity id', 512),
    role: normalizeWatchRecipientRole(record.role),
    label: optionalString(record.label, 'Watch recipient label', MAX_TITLE_BYTES),
  }
  return recipient.identityId || recipient.role || recipient.label ? recipient : null
}

function normalizeWatchCursor(value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return optionalString(value, 'Watch cursor', 512)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('Watch cursor must be a string, number, or null.')
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeProjectStatus(value: unknown, fallback: CoordinationProjectStatus): CoordinationProjectStatus {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationProjectStatus(value)) throw new Error('Project status is invalid.')
  return value
}

function normalizeTaskStatus(value: unknown, fallback: CoordinationTaskStatus): CoordinationTaskStatus {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationTaskStatus(value)) throw new Error('Task status is invalid.')
  return value
}

function normalizeTaskColumn(value: unknown, fallback: CoordinationTaskColumn): CoordinationTaskColumn {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationTaskColumn(value)) throw new Error('Task column is invalid.')
  return value
}

function normalizeTaskPriority(value: unknown, fallback: CoordinationTaskPriority): CoordinationTaskPriority {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationTaskPriority(value)) throw new Error('Task priority is invalid.')
  return value
}

function rowToProject(row: DbRow): CoordinationProject {
  return {
    id: String(row.id || ''),
    kind: 'project',
    workspaceId: String(row.workspace_id || LOCAL_WORKSPACE_ID),
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    title: String(row.title || ''),
    objective: String(row.objective || ''),
    description: typeof row.description === 'string' ? row.description : null,
    status: isCoordinationProjectStatus(row.status) ? row.status : 'active',
    team: parseJson<string[]>(row.team_json, []),
    sourceSessionId: typeof row.source_session_id === 'string' ? row.source_session_id : null,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToTask(row: DbRow): CoordinationTask {
  const status = isCoordinationTaskStatus(row.status) ? row.status : 'open'
  return {
    id: String(row.id || ''),
    kind: 'task',
    workspaceId: String(row.workspace_id || LOCAL_WORKSPACE_ID),
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    projectId: String(row.project_id || ''),
    parentTaskId: typeof row.parent_task_id === 'string' ? row.parent_task_id : null,
    title: String(row.title || ''),
    spec: String(row.spec || ''),
    description: typeof row.description === 'string' ? row.description : null,
    status,
    column: isCoordinationTaskColumn(row.column_name) ? row.column_name : coordinationTaskColumnForStatus(status),
    priority: isCoordinationTaskPriority(row.priority) ? row.priority : 'med',
    externalRef: typeof row.external_ref === 'string' ? row.external_ref : null,
    assigneeAgent: typeof row.assignee_agent === 'string' ? row.assignee_agent : null,
    assignedRunId: typeof row.assigned_run_id === 'string' ? row.assigned_run_id : null,
    assignedSessionId: typeof row.assigned_session_id === 'string' ? row.assigned_session_id : null,
    artifactRefs: parseJson<CoordinationArtifactLink[]>(row.artifact_refs_json, []),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function watchAuthoritiesForWorkspace(workspaceId: string) {
  return workspaceId.startsWith('cloud:')
    ? {
        ownerAuthority: 'cloud_channel_gateway' as const,
        executionAuthority: 'cloud_channel_gateway' as const,
        stateOwner: 'cloud_control_plane' as const,
      }
    : {
        ownerAuthority: 'desktop_local' as const,
        executionAuthority: 'desktop_local' as const,
        stateOwner: 'desktop_local_store' as const,
      }
}

function rowToWatch(row: DbRow): CoordinationWatch {
  const targetKind = isCoordinationWatchTarget(row.target_kind) ? row.target_kind : 'conversation'
  const status = isCoordinationWatchStatus(row.status) ? row.status : 'paused'
  const verbosity = isCoordinationWatchVerbosity(row.verbosity) ? row.verbosity : 'normal'
  const workspaceId = String(row.workspace_id || LOCAL_WORKSPACE_ID)
  const fallbackAuthorities = watchAuthoritiesForWorkspace(workspaceId)
  return {
    id: String(row.id || ''),
    kind: 'watch',
    workspaceId,
    ownerAuthority: String(row.owner_authority || fallbackAuthorities.ownerAuthority) as CoordinationWatch['ownerAuthority'],
    executionAuthority: String(row.execution_authority || fallbackAuthorities.executionAuthority) as CoordinationWatch['executionAuthority'],
    stateOwner: String(row.state_owner || fallbackAuthorities.stateOwner) as CoordinationWatch['stateOwner'],
    status,
    target: {
      kind: targetKind,
      id: String(row.target_id || ''),
    },
    events: parseJson<CoordinationWatchEventType[]>(row.events_json, []).filter(isCoordinationWatchEvent),
    channel: parseJson<CoordinationWatchChannel>(row.channel_json, {
      provider: '',
      agentId: '',
      channelBindingId: '',
      sessionBindingId: null,
      target: {},
    }),
    recipient: parseJson<CoordinationWatchRecipient | null>(row.recipient_json, null),
    deliverySurface: normalizeWatchDeliverySurface(row.delivery_surface, 'gateway_channel'),
    verbosity,
    cursor: parseJson<string | number | null>(row.cursor_json, null),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

export function listCoordinationProjects(options: { workspaceId?: string | null; limit?: number } = {}) {
  const workspaceId = readWorkspaceId(options.workspaceId)
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0 ? Math.min(Number(options.limit), 500) : 100
  const rows = getCoordinationDb().prepare(`
    select * from coordination_projects
    where workspace_id = ?
    order by updated_at desc
    limit ?
  `).all(workspaceId, limit) as DbRow[]
  return rows.map(rowToProject)
}

export function listCoordinationTasks(options: { workspaceId?: string | null; projectId?: string | null; limit?: number } = {}) {
  const workspaceId = readWorkspaceId(options.workspaceId)
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0 ? Math.min(Number(options.limit), 1000) : 500
  const projectId = options.projectId?.trim()
  const rows = projectId
    ? getCoordinationDb().prepare(`
      select * from coordination_tasks
      where workspace_id = ? and project_id = ?
      order by updated_at desc
      limit ?
    `).all(workspaceId, projectId, limit) as DbRow[]
    : getCoordinationDb().prepare(`
      select * from coordination_tasks
      where workspace_id = ?
      order by updated_at desc
      limit ?
    `).all(workspaceId, limit) as DbRow[]
  return rows.map(rowToTask)
}

export function listCoordinationWatches(options: {
  workspaceId?: string | null
  target?: CoordinationTarget | null
  status?: CoordinationWatchStatus | null
  limit?: number
} = {}) {
  const workspaceId = readWorkspaceId(options.workspaceId)
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0 ? Math.min(Number(options.limit), 1000) : 500
  const status = options.status === undefined || options.status === null ? null : normalizeWatchStatus(options.status, 'active')
  const target = options.target ? normalizeWatchTarget(options.target) : null
  const rows = target && status
    ? getCoordinationDb().prepare(`
      select * from coordination_watches
      where workspace_id = ? and target_kind = ? and target_id = ? and status = ?
      order by updated_at desc
      limit ?
    `).all(workspaceId, target.kind, target.id, status, limit) as DbRow[]
    : target
      ? getCoordinationDb().prepare(`
        select * from coordination_watches
        where workspace_id = ? and target_kind = ? and target_id = ?
        order by updated_at desc
        limit ?
      `).all(workspaceId, target.kind, target.id, limit) as DbRow[]
      : status
        ? getCoordinationDb().prepare(`
          select * from coordination_watches
          where workspace_id = ? and status = ?
          order by updated_at desc
          limit ?
        `).all(workspaceId, status, limit) as DbRow[]
        : getCoordinationDb().prepare(`
          select * from coordination_watches
          where workspace_id = ?
          order by updated_at desc
          limit ?
        `).all(workspaceId, limit) as DbRow[]
  return rows.map(rowToWatch)
}

export function listMatchingCoordinationWatches(options: {
  workspaceId?: string | null
  eventType: CoordinationWatchEventType
  targets: readonly CoordinationTarget[]
}) {
  const workspaceId = readWorkspaceId(options.workspaceId)
  if (!isCoordinationWatchEvent(options.eventType) || options.targets.length === 0) return []
  const targets = options.targets.map(normalizeWatchTarget)
  const predicates = targets.map(() => '(target_kind = ? and target_id = ?)').join(' or ')
  const values: SQLInputValue[] = [workspaceId, 'active']
  for (const target of targets) values.push(target.kind, target.id)
  const rows = getCoordinationDb().prepare(`
    select * from coordination_watches
    where workspace_id = ? and status = ? and (${predicates})
    order by updated_at desc
  `).all(...values) as DbRow[]
  return rows.map(rowToWatch).filter((watch) => watch.events.includes(options.eventType))
}

export function listCoordinationBoard(options: { workspaceId?: string | null; limit?: number } = {}): CoordinationBoardPayload {
  return {
    projects: listCoordinationProjects(options),
    tasks: listCoordinationTasks(options),
  }
}

export function getCoordinationProject(projectId: string) {
  const row = getCoordinationDb().prepare('select * from coordination_projects where id = ?').get(projectId) as DbRow | undefined
  return row ? rowToProject(row) : null
}

export function getCoordinationTask(taskId: string) {
  const row = getCoordinationDb().prepare('select * from coordination_tasks where id = ?').get(taskId) as DbRow | undefined
  return row ? rowToTask(row) : null
}

export function getCoordinationWatch(watchId: string) {
  const row = getCoordinationDb().prepare('select * from coordination_watches where id = ?').get(watchId) as DbRow | undefined
  return row ? rowToWatch(row) : null
}

function assertWatchTargetInWorkspace(target: CoordinationTarget, workspaceId: string) {
  if (target.kind === 'project') {
    const project = getCoordinationProject(target.id)
    if (!project || project.workspaceId !== workspaceId) throw new Error('Watch project target was not found.')
  }
  if (target.kind === 'task') {
    const task = getCoordinationTask(target.id)
    if (!task || task.workspaceId !== workspaceId) throw new Error('Watch task target was not found.')
  }
}

export function createCoordinationProject(input: CoordinationProjectInput, options?: CoordinationWriteOptions): CoordinationProject {
  const now = nowIso(options)
  const id = options?.id || crypto.randomUUID()
  const workspaceId = readWorkspaceId(input.workspaceId)
  const title = requiredString(input.title, 'Project title', MAX_TITLE_BYTES)
  const objective = requiredString(input.objective, 'Project objective', MAX_TEXT_BYTES)
  const status = normalizeProjectStatus(input.status, 'active')
  const team = normalizeTeam(input.team)
  withTransaction((db) => {
    db.prepare(`
      insert into coordination_projects (
        id, workspace_id, owner_authority, execution_authority, state_owner, title,
        objective, description, status, team_json, source_session_id, created_at, updated_at
      ) values (?, ?, 'desktop_local', 'desktop_local', 'desktop_local_store', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      title,
      objective,
      optionalString(input.description, 'Project description'),
      status,
      JSON.stringify(team),
      optionalString(input.sourceSessionId, 'Project source session id', 512),
      now,
      now,
    )
  })
  return getCoordinationProject(id)!
}

export function updateCoordinationProject(projectId: string, input: CoordinationProjectUpdateInput, options?: CoordinationWriteOptions) {
  const existing = getCoordinationProject(projectId)
  if (!existing) return null
  const now = nowIso(options)
  const title = input.title === undefined ? existing.title : requiredString(input.title, 'Project title', MAX_TITLE_BYTES)
  const objective = input.objective === undefined ? existing.objective : requiredString(input.objective, 'Project objective', MAX_TEXT_BYTES)
  const description = input.description === undefined ? existing.description ?? null : optionalString(input.description, 'Project description')
  const status = input.status === undefined ? existing.status : normalizeProjectStatus(input.status, existing.status)
  const team = input.team === undefined ? existing.team : normalizeTeam(input.team)
  const sourceSessionId = input.sourceSessionId === undefined
    ? existing.sourceSessionId ?? null
    : optionalString(input.sourceSessionId, 'Project source session id', 512)
  withTransaction((db) => {
    db.prepare(`
      update coordination_projects
      set title = ?, objective = ?, description = ?, status = ?, team_json = ?,
        source_session_id = ?, updated_at = ?
      where id = ?
    `).run(title, objective, description, status, JSON.stringify(team), sourceSessionId, now, projectId)
  })
  return getCoordinationProject(projectId)
}

export function createCoordinationWatch(input: CoordinationWatchInput, options?: CoordinationWriteOptions): CoordinationWatch {
  const now = nowIso(options)
  const id = options?.id || crypto.randomUUID()
  const workspaceId = readWorkspaceId(input.workspaceId)
  const target = normalizeWatchTarget(input.target)
  assertImplementedWatchTarget(target)
  assertWatchTargetInWorkspace(target, workspaceId)
  const events = normalizeWatchEvents(input.events)
  const channel = normalizeWatchChannel(input.channel)
  const recipient = normalizeWatchRecipient(input.recipient)
  const status = normalizeWatchStatus(input.status, 'active')
  const deliverySurface = normalizeWatchDeliverySurface(input.deliverySurface, 'gateway_channel')
  const verbosity = normalizeWatchVerbosity(input.verbosity, 'normal')
  const cursor = normalizeWatchCursor(input.cursor)
  const authorities = watchAuthoritiesForWorkspace(workspaceId)
  withTransaction((db) => {
    db.prepare(`
      insert into coordination_watches (
        id, workspace_id, owner_authority, execution_authority, state_owner, target_kind,
        target_id, events_json, delivery_surface, channel_json, recipient_json, status,
        verbosity, cursor_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      authorities.ownerAuthority,
      authorities.executionAuthority,
      authorities.stateOwner,
      target.kind,
      target.id,
      jsonString(events, 'Watch events'),
      deliverySurface,
      jsonString(channel, 'Watch channel'),
      recipient ? jsonString(recipient, 'Watch recipient') : null,
      status,
      verbosity,
      cursor === null ? null : jsonString(cursor, 'Watch cursor'),
      now,
      now,
    )
  })
  return getCoordinationWatch(id)!
}

export function updateCoordinationWatch(watchId: string, input: CoordinationWatchUpdateInput, options?: CoordinationWriteOptions) {
  const existing = getCoordinationWatch(watchId)
  if (!existing) return null
  const now = nowIso(options)
  const target = input.target === undefined ? existing.target : normalizeWatchTarget(input.target)
  assertImplementedWatchTarget(target)
  assertWatchTargetInWorkspace(target, existing.workspaceId)
  const events = input.events === undefined ? existing.events : normalizeWatchEvents(input.events)
  const channel = input.channel === undefined ? existing.channel : normalizeWatchChannel(input.channel)
  const recipient = input.recipient === undefined ? existing.recipient ?? null : normalizeWatchRecipient(input.recipient)
  const status = input.status === undefined ? existing.status : normalizeWatchStatus(input.status, existing.status)
  const deliverySurface = normalizeWatchDeliverySurface(input.deliverySurface, existing.deliverySurface)
  const verbosity = input.verbosity === undefined ? existing.verbosity : normalizeWatchVerbosity(input.verbosity, existing.verbosity)
  const cursor = input.cursor === undefined ? existing.cursor ?? null : normalizeWatchCursor(input.cursor)
  withTransaction((db) => {
    db.prepare(`
      update coordination_watches
      set target_kind = ?, target_id = ?, events_json = ?, delivery_surface = ?,
        channel_json = ?, recipient_json = ?, status = ?, verbosity = ?, cursor_json = ?,
        updated_at = ?
      where id = ?
    `).run(
      target.kind,
      target.id,
      jsonString(events, 'Watch events'),
      deliverySurface,
      jsonString(channel, 'Watch channel'),
      recipient ? jsonString(recipient, 'Watch recipient') : null,
      status,
      verbosity,
      cursor === null ? null : jsonString(cursor, 'Watch cursor'),
      now,
      watchId,
    )
  })
  return getCoordinationWatch(watchId)
}

export function deleteCoordinationWatch(watchId: string) {
  const result = withTransaction((db) => db.prepare('delete from coordination_watches where id = ?').run(watchId))
  return result.changes > 0
}

export function createCoordinationTask(input: CoordinationTaskInput, options?: CoordinationWriteOptions): CoordinationTask {
  const project = getCoordinationProject(input.projectId)
  if (!project) throw new Error('Coordination project was not found.')
  const workspaceId = readWorkspaceId(input.workspaceId || project.workspaceId)
  if (workspaceId !== project.workspaceId) throw new Error('Task workspace must match its project workspace.')
  const parentTaskId = optionalString(input.parentTaskId, 'Parent task id', 512)
  const parentTask = parentTaskId ? getCoordinationTask(parentTaskId) : null
  if (parentTaskId && !parentTask) throw new Error('Parent coordination task was not found.')
  if (parentTask && (parentTask.workspaceId !== workspaceId || parentTask.projectId !== project.id)) {
    throw new Error('Parent coordination task must belong to the same project.')
  }
  const status = normalizeTaskStatus(input.status, 'open')
  const column = input.column === undefined
    ? coordinationTaskColumnForStatus(status)
    : normalizeTaskColumn(input.column, coordinationTaskColumnForStatus(status))
  const now = nowIso(options)
  const id = options?.id || crypto.randomUUID()
  withTransaction((db) => {
    db.prepare(`
      insert into coordination_tasks (
        id, workspace_id, owner_authority, execution_authority, state_owner, project_id,
        parent_task_id, title, spec, description, status, column_name, priority, external_ref,
        assignee_agent, assigned_run_id, assigned_session_id, artifact_refs_json, created_at, updated_at
      ) values (?, ?, 'desktop_local', 'desktop_local', 'desktop_local_store', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      project.id,
      parentTaskId,
      requiredString(input.title, 'Task title', MAX_TITLE_BYTES),
      requiredString(input.spec, 'Task spec', MAX_TEXT_BYTES),
      optionalString(input.description, 'Task description'),
      status,
      column,
      normalizeTaskPriority(input.priority, 'med'),
      optionalString(input.externalRef, 'Task external ref', 512),
      optionalString(input.assigneeAgent, 'Task assignee agent', MAX_AGENT_ID_BYTES),
      optionalString(input.assignedRunId, 'Assigned run id', 512),
      optionalString(input.assignedSessionId, 'Assigned session id', 512),
      JSON.stringify(normalizeArtifactRefs(input.artifactRefs)),
      now,
      now,
    )
  })
  return getCoordinationTask(id)!
}

export function updateCoordinationTask(taskId: string, input: CoordinationTaskUpdateInput, options?: CoordinationWriteOptions) {
  const existing = getCoordinationTask(taskId)
  if (!existing) return null
  const parentTaskId = input.parentTaskId === undefined
    ? existing.parentTaskId ?? null
    : optionalString(input.parentTaskId, 'Parent task id', 512)
  if (parentTaskId && parentTaskId === taskId) throw new Error('Task cannot be its own parent.')
  const parentTask = parentTaskId ? getCoordinationTask(parentTaskId) : null
  if (parentTaskId && !parentTask) throw new Error('Parent coordination task was not found.')
  if (parentTask && (parentTask.workspaceId !== existing.workspaceId || parentTask.projectId !== existing.projectId)) {
    throw new Error('Parent coordination task must belong to the same project.')
  }
  const status = input.status === undefined ? existing.status : normalizeTaskStatus(input.status, existing.status)
  const column = input.column === undefined
    ? (input.status === undefined ? existing.column : coordinationTaskColumnForStatus(status, existing.column))
    : normalizeTaskColumn(input.column, existing.column)
  const now = nowIso(options)
  withTransaction((db) => {
    db.prepare(`
      update coordination_tasks
      set parent_task_id = ?, title = ?, spec = ?, description = ?, status = ?,
        column_name = ?, priority = ?, external_ref = ?, assignee_agent = ?,
        assigned_run_id = ?, assigned_session_id = ?, artifact_refs_json = ?, updated_at = ?
      where id = ?
    `).run(
      parentTaskId,
      input.title === undefined ? existing.title : requiredString(input.title, 'Task title', MAX_TITLE_BYTES),
      input.spec === undefined ? existing.spec : requiredString(input.spec, 'Task spec', MAX_TEXT_BYTES),
      input.description === undefined ? existing.description ?? null : optionalString(input.description, 'Task description'),
      status,
      column,
      input.priority === undefined ? existing.priority : normalizeTaskPriority(input.priority, existing.priority),
      input.externalRef === undefined ? existing.externalRef ?? null : optionalString(input.externalRef, 'Task external ref', 512),
      input.assigneeAgent === undefined ? existing.assigneeAgent ?? null : optionalString(input.assigneeAgent, 'Task assignee agent', MAX_AGENT_ID_BYTES),
      input.assignedRunId === undefined ? existing.assignedRunId ?? null : optionalString(input.assignedRunId, 'Assigned run id', 512),
      input.assignedSessionId === undefined ? existing.assignedSessionId ?? null : optionalString(input.assignedSessionId, 'Assigned session id', 512),
      input.artifactRefs === undefined ? JSON.stringify(existing.artifactRefs || []) : JSON.stringify(normalizeArtifactRefs(input.artifactRefs)),
      now,
      taskId,
    )
  })
  return getCoordinationTask(taskId)
}

export function moveCoordinationTask(taskId: string, column: CoordinationTaskColumn, options?: CoordinationWriteOptions) {
  const existing = getCoordinationTask(taskId)
  if (!existing) return null
  const nextColumn = normalizeTaskColumn(column, existing.column)
  const now = nowIso(options)
  withTransaction((db) => {
    db.prepare('update coordination_tasks set column_name = ?, updated_at = ? where id = ?')
      .run(nextColumn, now, taskId)
  })
  return getCoordinationTask(taskId)
}

export function assignCoordinationTask(taskId: string, assigneeAgent: string | null | undefined, options?: CoordinationWriteOptions) {
  const existing = getCoordinationTask(taskId)
  if (!existing) return null
  const now = nowIso(options)
  withTransaction((db) => {
    db.prepare('update coordination_tasks set assignee_agent = ?, updated_at = ? where id = ?')
      .run(optionalString(assigneeAgent, 'Task assignee agent', MAX_AGENT_ID_BYTES), now, taskId)
  })
  return getCoordinationTask(taskId)
}

export function linkCoordinationTaskWork(
  taskId: string,
  input: {
    assignedSessionId: string
    assignedRunId?: string | null
    assigneeAgent?: string | null
    status?: CoordinationTaskStatus
  },
  options?: CoordinationWriteOptions,
) {
  const existing = getCoordinationTask(taskId)
  if (!existing) return null
  const status = input.status === undefined ? existing.status : normalizeTaskStatus(input.status, existing.status)
  const column = input.status === undefined ? existing.column : coordinationTaskColumnForStatus(status, existing.column)
  const now = nowIso(options)
  withTransaction((db) => {
    db.prepare(`
      update coordination_tasks
      set assigned_session_id = ?, assigned_run_id = ?, assignee_agent = coalesce(?, assignee_agent),
        status = ?, column_name = ?, updated_at = ?
      where id = ?
    `).run(
      requiredString(input.assignedSessionId, 'Assigned session id', 512),
      optionalString(input.assignedRunId, 'Assigned run id', 512),
      optionalString(input.assigneeAgent, 'Task assignee agent', MAX_AGENT_ID_BYTES),
      status,
      column,
      now,
      taskId,
    )
  })
  return getCoordinationTask(taskId)
}
