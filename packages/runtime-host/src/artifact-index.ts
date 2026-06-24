import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactIndexEntry,
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactKind,
  ArtifactStatus,
  ArtifactStatusUpdateRequest,
  SessionArtifact,
  SessionView,
  ToolCall,
} from '@open-cowork/shared'
import {
  canAdvanceArtifactStatus,
  defaultArtifactStatusForKind,
  inferArtifactKind,
  isArtifactKind,
  isArtifactStatus,
} from '@open-cowork/shared'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
import { listCoordinationTasks } from './coordination/coordination-service.js'
import { sessionEngine } from './session-engine.js'
import { listSessionRecords, type SessionRecord } from './session-registry.js'
import { syncSessionView } from './session-history-loader.js'

const ARTIFACT_LIFECYCLE_DB_SCHEMA_VERSION = 1
const ARTIFACT_LIFECYCLE_SCHEMA_VERSION_KEY = 'schema_version'
const LOCAL_WORKSPACE_ID = 'local'
const DEFAULT_INDEX_LIMIT = 100
const MAX_INDEX_LIMIT = 500

let lifecycleDb: DatabaseSync | null = null
let lifecycleDbForTests: DatabaseSync | null = null
let transactionCounter = 0

type ArtifactIndexRuntimeDeps = {
  isHydrated: (sessionId: string) => boolean
  getSessionView: (sessionId: string) => SessionView
  syncSessionView: typeof syncSessionView
}

let runtimeDepsForTests: ArtifactIndexRuntimeDeps | null = null

function runtimeDeps(): ArtifactIndexRuntimeDeps {
  return runtimeDepsForTests || {
    isHydrated: (sessionId) => sessionEngine.isHydrated(sessionId),
    getSessionView: (sessionId) => sessionEngine.getSessionView(sessionId),
    syncSessionView,
  }
}

export function setArtifactIndexRuntimeDepsForTests(deps: ArtifactIndexRuntimeDeps | null) {
  runtimeDepsForTests = deps
}

export type ArtifactLifecycleRecord = {
  workspaceId: string
  sessionId: string
  artifactId: string
  kind: ArtifactKind
  status: ArtifactStatus
  authorAgentId: string | null
  projectId: string | null
  taskId: string | null
  statusUpdatedBy: string | null
  statusUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

type TaskProvenance = {
  projectId: string | null
  taskId: string | null
  authorAgentId: string | null
}
type CoordinationTaskCandidate = ReturnType<typeof listCoordinationTasks>[number]

function artifactLifecycleDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'artifact-lifecycle.sqlite')
}

function ensureArtifactLifecycleFileModes(dbPath = artifactLifecycleDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function initDb(db: DatabaseSync) {
  db.exec(`
    create table if not exists artifact_lifecycle_meta (
      key text primary key,
      value text not null
    );
    create table if not exists artifact_lifecycle (
      workspace_id text not null,
      session_id text not null,
      artifact_id text not null,
      kind text not null,
      status text not null,
      author_agent_id text,
      project_id text,
      task_id text,
      status_updated_by text,
      status_updated_at text,
      created_at text not null,
      updated_at text not null,
      primary key(workspace_id, session_id, artifact_id)
    );
    create index if not exists idx_artifact_lifecycle_workspace_updated
      on artifact_lifecycle(workspace_id, updated_at);
    create index if not exists idx_artifact_lifecycle_project
      on artifact_lifecycle(workspace_id, project_id, task_id, updated_at);
    create index if not exists idx_artifact_lifecycle_kind_status
      on artifact_lifecycle(workspace_id, kind, status, updated_at);
  `)
  db.prepare(`
    insert into artifact_lifecycle_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(ARTIFACT_LIFECYCLE_SCHEMA_VERSION_KEY, String(ARTIFACT_LIFECYCLE_DB_SCHEMA_VERSION))
}

export function getArtifactLifecycleDb() {
  if (lifecycleDbForTests) return lifecycleDbForTests
  if (lifecycleDb) return lifecycleDb
  const dbPath = artifactLifecycleDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    initDb(db)
    ensureArtifactLifecycleFileModes(dbPath)
    lifecycleDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function setArtifactLifecycleDatabaseForTests(db: DatabaseSync | null) {
  lifecycleDb?.close()
  lifecycleDb = null
  lifecycleDbForTests = db
  transactionCounter = 0
  if (db) initDb(db)
}

export function clearArtifactLifecycleStoreCache() {
  lifecycleDb?.close()
  lifecycleDb = null
  lifecycleDbForTests = null
  transactionCounter = 0
}

function withTransaction<T>(callback: (db: DatabaseSync) => T): T {
  const db = getArtifactLifecycleDb()
  const savepoint = `artifact_lifecycle_tx_${transactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    if (!lifecycleDbForTests) ensureArtifactLifecycleFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      if (!lifecycleDbForTests) ensureArtifactLifecycleFileModes()
    }
    throw error
  }
}

function workspaceId(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || LOCAL_WORKSPACE_ID
}

function rowString(row: Record<string, unknown>, key: string) {
  const value = row[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function lifecycleFromRow(row: unknown): ArtifactLifecycleRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const record = row as Record<string, unknown>
  const kind = rowString(record, 'kind')
  const status = rowString(record, 'status')
  if (!isArtifactKind(kind) || !isArtifactStatus(status)) return null
  const artifactId = rowString(record, 'artifact_id')
  const sessionId = rowString(record, 'session_id')
  const workspace = rowString(record, 'workspace_id')
  const createdAt = rowString(record, 'created_at')
  const updatedAt = rowString(record, 'updated_at')
  if (!artifactId || !sessionId || !workspace || !createdAt || !updatedAt) return null
  return {
    workspaceId: workspace,
    sessionId,
    artifactId,
    kind,
    status,
    authorAgentId: rowString(record, 'author_agent_id'),
    projectId: rowString(record, 'project_id'),
    taskId: rowString(record, 'task_id'),
    statusUpdatedBy: rowString(record, 'status_updated_by'),
    statusUpdatedAt: rowString(record, 'status_updated_at'),
    createdAt,
    updatedAt,
  }
}

function findLifecycle(workspace: string, sessionId: string, artifactId: string): ArtifactLifecycleRecord | null {
  return lifecycleFromRow(getArtifactLifecycleDb().prepare(`
    select *
    from artifact_lifecycle
    where workspace_id = ? and session_id = ? and artifact_id = ?
  `).get(workspace, sessionId, artifactId))
}

export function artifactLifecycleStorageKey(artifact: Pick<SessionArtifact, 'id' | 'filePath' | 'source'>) {
  if (artifact.source !== 'cloud' && isLocalArtifactFilePath(artifact.filePath)) return artifact.filePath
  return artifact.id
}

export function isLocalArtifactFilePath(filePath: string) {
  return isAbsolute(filePath) || win32.isAbsolute(filePath)
}

export function localArtifactFilename(filePath: string) {
  return filePath.includes('\\') || /^[A-Za-z]:/.test(filePath)
    ? win32.basename(filePath) || filePath
    : basename(filePath) || filePath
}

function findLifecycleForArtifact(workspace: string, sessionId: string, artifact: SessionArtifact): ArtifactLifecycleRecord | null {
  const key = artifactLifecycleStorageKey(artifact)
  return findLifecycle(workspace, sessionId, key)
    || (key !== artifact.id ? findLifecycle(workspace, sessionId, artifact.id) : null)
}

function upsertLifecycle(record: ArtifactLifecycleRecord) {
  withTransaction((db) => {
    db.prepare(`
      insert into artifact_lifecycle (
        workspace_id,
        session_id,
        artifact_id,
        kind,
        status,
        author_agent_id,
        project_id,
        task_id,
        status_updated_by,
        status_updated_at,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(workspace_id, session_id, artifact_id) do update set
        kind = excluded.kind,
        status = excluded.status,
        author_agent_id = excluded.author_agent_id,
        project_id = excluded.project_id,
        task_id = excluded.task_id,
        status_updated_by = excluded.status_updated_by,
        status_updated_at = excluded.status_updated_at,
        updated_at = excluded.updated_at
    `).run(
      record.workspaceId,
      record.sessionId,
      record.artifactId,
      record.kind,
      record.status,
      record.authorAgentId,
      record.projectId,
      record.taskId,
      record.statusUpdatedBy,
      record.statusUpdatedAt,
      record.createdAt,
      record.updatedAt,
    )
  })
}

function artifactPathFromTool(tool: ToolCall): string | null {
  const input = tool.input || {}
  const candidate = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.path === 'string'
      ? input.path
      : null

  if (!candidate || !isLocalArtifactFilePath(candidate)) return null
  if (!['write', 'edit', 'multi_edit', 'str_replace', 'apply_patch'].includes(tool.name)) return null
  return candidate
}

function artifactFromTool(tool: ToolCall, taskRunId?: string | null): SessionArtifact | null {
  const filePath = artifactPathFromTool(tool)
  if (!filePath) return null
  const filename = localArtifactFilename(filePath)
  return {
    id: `${taskRunId || 'session'}:${tool.id}:${filePath}`,
    toolId: tool.id,
    toolName: tool.name,
    filePath,
    filename,
    order: tool.order,
    taskRunId: taskRunId || null,
  }
}

function dedupeArtifacts(artifacts: Array<SessionArtifact | null>) {
  const map = new Map<string, SessionArtifact>()
  for (const artifact of artifacts) {
    if (!artifact) continue
    const existing = map.get(artifact.filePath)
    if (!existing || artifact.order > existing.order) {
      map.set(artifact.filePath, artifact)
    }
  }
  return Array.from(map.values()).sort((left, right) => right.order - left.order)
}

function artifactsFromView(view: SessionView): SessionArtifact[] {
  return dedupeArtifacts([
    ...view.toolCalls.map((tool) => artifactFromTool(tool)),
    ...view.taskRuns.flatMap((taskRun) =>
      taskRun.toolCalls.map((tool) => artifactFromTool(tool, taskRun.id)),
    ),
    ...(view.artifacts || []),
  ])
}

function taskProvenanceForArtifact(tasks: CoordinationTaskCandidate[], sessionId: string, artifact: SessionArtifact): TaskProvenance {
  const task = artifact.taskRunId
    ? tasks.find((candidate) => candidate.assignedRunId === artifact.taskRunId)
      || tasks.find((candidate) => candidate.assignedSessionId === sessionId)
    : tasks.find((candidate) => candidate.assignedSessionId === sessionId)
  return {
    projectId: task?.projectId || null,
    taskId: task?.id || null,
    authorAgentId: task?.assigneeAgent || null,
  }
}

export function normalizeArtifactLifecycleEntry(input: {
  workspaceId?: string | null
  sessionId: string
  sessionTitle?: string | null
  artifact: SessionArtifact
  lifecycle?: ArtifactLifecycleRecord | null
  provenance?: TaskProvenance | null
  now?: Date
}): ArtifactIndexEntry {
  const artifact = input.artifact
  const kind = input.lifecycle?.kind
    || artifact.kind
    || inferArtifactKind({
      kind: artifact.kind,
      filename: artifact.filename,
      mime: artifact.mime,
      chart: artifact.chart,
    })
  const status = input.lifecycle?.status || artifact.status || defaultArtifactStatusForKind(kind)
  const createdAt = artifact.createdAt || input.lifecycle?.createdAt || input.now?.toISOString() || new Date().toISOString()
  const updatedAt = input.lifecycle?.updatedAt || artifact.updatedAt || createdAt
  return {
    ...artifact,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle || null,
    workspaceId: workspaceId(input.workspaceId),
    kind,
    status,
    authorAgentId: input.lifecycle?.authorAgentId ?? artifact.authorAgentId ?? input.provenance?.authorAgentId ?? null,
    projectId: input.lifecycle?.projectId ?? artifact.projectId ?? input.provenance?.projectId ?? null,
    taskId: input.lifecycle?.taskId ?? artifact.taskId ?? input.provenance?.taskId ?? null,
    createdAt,
    updatedAt,
    statusUpdatedBy: input.lifecycle?.statusUpdatedBy ?? artifact.statusUpdatedBy ?? null,
    statusUpdatedAt: input.lifecycle?.statusUpdatedAt ?? artifact.statusUpdatedAt ?? null,
  }
}

function matchesIndexRequest(entry: ArtifactIndexEntry, request: ArtifactIndexRequest) {
  if (request.sessionId && entry.sessionId !== request.sessionId) return false
  const taskIds = new Set((request.taskIds || []).filter(Boolean))
  if (request.projectId && entry.projectId !== request.projectId && (!entry.taskId || !taskIds.has(entry.taskId))) return false
  if (request.taskId && entry.taskId !== request.taskId) return false
  if (!request.projectId && taskIds.size > 0 && (!entry.taskId || !taskIds.has(entry.taskId))) return false
  if (request.status && entry.status !== request.status) return false
  if (request.kind && entry.kind !== request.kind) return false
  return true
}

function indexLimit(request: ArtifactIndexRequest) {
  const limit = Number(request.limit)
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_INDEX_LIMIT
  return Math.min(Math.floor(limit), MAX_INDEX_LIMIT)
}

async function sessionView(record: SessionRecord): Promise<SessionView | null> {
  const deps = runtimeDeps()
  if (deps.isHydrated(record.id)) return deps.getSessionView(record.id)
  try {
    return await deps.syncSessionView(record.id, { activate: false })
  } catch {
    return null
  }
}

async function artifactsForRecord(record: SessionRecord, workspace: string, tasks: CoordinationTaskCandidate[]) {
  const view = await sessionView(record)
  if (!view) return []
  return artifactsFromView(view).map((artifact) => {
    const lifecycle = findLifecycleForArtifact(workspace, record.id, artifact)
    return normalizeArtifactLifecycleEntry({
      workspaceId: workspace,
      sessionId: record.id,
      sessionTitle: record.title || null,
      artifact,
      lifecycle,
      provenance: taskProvenanceForArtifact(tasks, record.id, artifact),
    })
  })
}

export async function listLocalArtifactIndex(request: ArtifactIndexRequest = {}): Promise<ArtifactIndexPayload> {
  const workspace = workspaceId(request.workspaceId)
  const limit = indexLimit(request)
  const records = request.sessionId
    ? listSessionRecords().filter((record) => record.id === request.sessionId)
    : listSessionRecords()
  const artifacts: ArtifactIndexEntry[] = []
  // The coordination-task list is workspace-scoped, not per-record — fetch it once and reuse it for
  // every record instead of re-reading up to 1000 tasks once per session in the loop.
  const tasks = listCoordinationTasks({ workspaceId: workspace, limit: 1000 })
  for (const record of records) {
    const entries = await artifactsForRecord(record, workspace, tasks)
    for (const entry of entries) {
      if (!matchesIndexRequest(entry, request)) continue
      artifacts.push(entry)
      if (artifacts.length >= limit) {
        return { artifacts, total: artifacts.length }
      }
    }
  }
  return { artifacts, total: artifacts.length }
}

export async function listLocalSessionArtifacts(sessionId: string, workspaceIdInput?: string | null): Promise<SessionArtifact[]> {
  const index = await listLocalArtifactIndex({ sessionId, workspaceId: workspaceIdInput || undefined, limit: MAX_INDEX_LIMIT })
  return index.artifacts
}

export async function updateLocalArtifactStatus(request: ArtifactStatusUpdateRequest): Promise<SessionArtifact> {
  const workspace = workspaceId(request.workspaceId)
  const artifact = (await listLocalArtifactIndex({
    workspaceId: workspace,
    sessionId: request.sessionId,
    limit: MAX_INDEX_LIMIT,
  })).artifacts.find((entry) =>
    entry.id === request.artifactId
    || entry.cloudArtifactId === request.artifactId
    || entry.filePath === request.artifactId,
  )
  if (!artifact) throw new Error('Artifact was not found.')
  if (!canAdvanceArtifactStatus(artifact.status || 'draft', request.status)) {
    throw new Error('Artifact status cannot move backwards.')
  }
  const now = new Date().toISOString()
  const next: ArtifactLifecycleRecord = {
    workspaceId: workspace,
    sessionId: request.sessionId,
    artifactId: artifactLifecycleStorageKey(artifact),
    kind: request.kind || artifact.kind || inferArtifactKind({
      kind: artifact.kind,
      filename: artifact.filename,
      mime: artifact.mime,
      chart: artifact.chart,
    }),
    status: request.status,
    authorAgentId: request.authorAgentId ?? artifact.authorAgentId ?? null,
    projectId: request.projectId ?? artifact.projectId ?? null,
    taskId: request.taskId ?? artifact.taskId ?? null,
    statusUpdatedBy: request.updatedBy ?? artifact.statusUpdatedBy ?? null,
    statusUpdatedAt: now,
    createdAt: artifact.createdAt || now,
    updatedAt: now,
  }
  upsertLifecycle(next)
  return normalizeArtifactLifecycleEntry({
    workspaceId: workspace,
    sessionId: request.sessionId,
    sessionTitle: artifact.sessionTitle || null,
    artifact,
    lifecycle: next,
  })
}
