import electron from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type {
  SessionArtifact,
  SessionInfo,
  SessionView,
  WorkflowListPayload,
} from '@open-cowork/shared'
import { isArtifactKind, isArtifactStatus } from '@open-cowork/shared'
import type { CloudTransportSettingMetadata } from './cloud/transport-adapter.ts'
import { getAppDataDir } from './config-loader.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import {
  readSafeStorageBackendForPolicy,
  resolveSecretStorageMode,
  type SecretStorageMode,
} from './secure-storage-policy.ts'

const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
const electronSafeStorageBackend = electronSafeStorage as (typeof import('electron').safeStorage & {
  getSelectedStorageBackend?: () => string
}) | undefined

type SecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type CloudWorkspaceCacheMode = 'full' | 'metadata-only' | 'disabled'
export type CloudWorkspaceCacheEncryptionFallback = 'metadata-only' | 'disabled' | 'fail-startup'

export type CloudWorkspaceCacheRecord = {
  workspaceId: string
  sessions: SessionInfo[]
  views: Record<string, SessionView>
  eventCursors: Record<string, number>
  workflows: WorkflowListPayload | null
  settings: CloudTransportSettingMetadata[]
  artifactsBySession: Record<string, SessionArtifact[]>
  updatedAt: string
}

export type CloudWorkspaceCache = {
  mode: CloudWorkspaceCacheMode
  listSessions(workspaceId: string): SessionInfo[] | null
  getSessionInfo(workspaceId: string, sessionId: string): SessionInfo | null
  getSessionView(workspaceId: string, sessionId: string): SessionView | null
  getEventCursor(workspaceId: string, scope: string): number | null
  setEventCursor(workspaceId: string, scope: string, sequence: number, now?: Date): void
  resetEventCursor(workspaceId: string, scope: string, sequence?: number, now?: Date): void
  getWorkflowList(workspaceId: string): WorkflowListPayload | null
  upsertWorkflowList(workspaceId: string, workflows: WorkflowListPayload, now?: Date): void
  listSettings(workspaceId: string): CloudTransportSettingMetadata[] | null
  getSetting(workspaceId: string, key: string): CloudTransportSettingMetadata | null
  upsertSettings(workspaceId: string, settings: CloudTransportSettingMetadata[], now?: Date): void
  upsertSetting(workspaceId: string, setting: CloudTransportSettingMetadata, now?: Date): void
  listArtifacts(workspaceId: string, sessionId: string): SessionArtifact[] | null
  upsertArtifactList(workspaceId: string, sessionId: string, artifacts: SessionArtifact[], now?: Date): void
  upsertSessionList(workspaceId: string, sessions: SessionInfo[], now?: Date): void
  upsertSessionInfo(workspaceId: string, session: SessionInfo, now?: Date): void
  upsertSessionView(workspaceId: string, sessionId: string, view: SessionView, now?: Date): void
  removeWorkspace(workspaceId: string): void
}

function defaultCachePath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'cloud-workspace-cache.json')
}

function defaultSecretStorageMode() {
  return resolveSecretStorageMode({
    isPackaged: Boolean(electron.app?.isPackaged),
    encryptionAvailable: Boolean(electronSafeStorage?.isEncryptionAvailable?.()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      electronSafeStorageBackend?.getSelectedStorageBackend?.bind(electronSafeStorageBackend),
    ),
  })
}

function requireSafeStorage() {
  if (!electronSafeStorage) throw new Error('Electron safeStorage is unavailable')
  return electronSafeStorage
}

function normalizeWorkspaceId(value: unknown) {
  return typeof value === 'string' && value.trim() && Buffer.byteLength(value.trim(), 'utf8') <= 512
    ? value.trim()
    : null
}

function normalizeSessionInfo(value: unknown): SessionInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<SessionInfo>
  if (typeof record.id !== 'string' || !record.id.trim()) return null
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return null
  return {
    id: record.id,
    title: typeof record.title === 'string' ? record.title : undefined,
    directory: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: record.kind,
    workflowId: record.workflowId ?? null,
    runId: record.runId ?? null,
    parentSessionId: record.parentSessionId ?? null,
    changeSummary: record.changeSummary ?? null,
    revertedMessageId: record.revertedMessageId ?? null,
    composerAgentName: record.composerAgentName ?? null,
    composerModelId: record.composerModelId ?? null,
    composerReasoningVariant: record.composerReasoningVariant ?? null,
  }
}

function normalizeEventCursors(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const cursors: Record<string, number> = {}
  for (const [scope, sequence] of Object.entries(value as Record<string, unknown>)) {
    if (!scope || Buffer.byteLength(scope, 'utf8') > 512) continue
    if (typeof sequence !== 'number' || !Number.isFinite(sequence) || sequence < 0) continue
    cursors[scope] = Math.floor(sequence)
  }
  return cursors
}

function normalizeWorkflowList(value: unknown): WorkflowListPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<WorkflowListPayload>
  return {
    workflows: Array.isArray(record.workflows) ? record.workflows as WorkflowListPayload['workflows'] : [],
    runs: Array.isArray(record.runs) ? record.runs as WorkflowListPayload['runs'] : [],
  }
}

function normalizeSetting(value: unknown): CloudTransportSettingMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudTransportSettingMetadata>
  if (typeof record.key !== 'string' || !record.key.trim()) return null
  if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) return null
  return {
    tenantId: typeof record.tenantId === 'string' ? record.tenantId : undefined,
    userId: typeof record.userId === 'string' ? record.userId : record.userId === null ? null : undefined,
    key: record.key.trim(),
    value: record.value as Record<string, unknown>,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : new Date(0).toISOString(),
  }
}

function normalizeSettings(value: unknown): CloudTransportSettingMetadata[] {
  return Array.isArray(value)
    ? value.map(normalizeSetting).filter((setting): setting is CloudTransportSettingMetadata => Boolean(setting))
    : []
}

function normalizeArtifact(value: unknown): SessionArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<SessionArtifact>
  if (typeof record.id !== 'string' || !record.id.trim()) return null
  if (typeof record.filePath !== 'string' || !record.filePath.trim()) return null
  return {
    id: record.id,
    toolId: typeof record.toolId === 'string' ? record.toolId : 'cloud-artifact',
    toolName: typeof record.toolName === 'string' ? record.toolName : 'cloud.artifact',
    taskRunId: typeof record.taskRunId === 'string' ? record.taskRunId : record.taskRunId === null ? null : undefined,
    filename: typeof record.filename === 'string' && record.filename ? record.filename : record.id,
    filePath: record.filePath,
    order: typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : 0,
    mime: typeof record.mime === 'string' ? record.mime : undefined,
    source: record.source === 'local' || record.source === 'cloud' ? record.source : undefined,
    cloudArtifactId: typeof record.cloudArtifactId === 'string' ? record.cloudArtifactId : undefined,
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    kind: isArtifactKind(record.kind) ? record.kind : undefined,
    status: isArtifactStatus(record.status) ? record.status : undefined,
    authorAgentId: typeof record.authorAgentId === 'string' ? record.authorAgentId : record.authorAgentId === null ? null : undefined,
    projectId: typeof record.projectId === 'string' ? record.projectId : record.projectId === null ? null : undefined,
    taskId: typeof record.taskId === 'string' ? record.taskId : record.taskId === null ? null : undefined,
    statusUpdatedBy: typeof record.statusUpdatedBy === 'string' ? record.statusUpdatedBy : record.statusUpdatedBy === null ? null : undefined,
    statusUpdatedAt: typeof record.statusUpdatedAt === 'string' ? record.statusUpdatedAt : record.statusUpdatedAt === null ? null : undefined,
    chart: record.chart ?? undefined,
  }
}

function normalizeArtifactsBySession(value: unknown): Record<string, SessionArtifact[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const artifactsBySession: Record<string, SessionArtifact[]> = {}
  for (const [sessionId, artifacts] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || Buffer.byteLength(sessionId, 'utf8') > 512 || !Array.isArray(artifacts)) continue
    artifactsBySession[sessionId] = artifacts
      .map(normalizeArtifact)
      .filter((artifact): artifact is SessionArtifact => Boolean(artifact))
  }
  return artifactsBySession
}

function normalizeRecord(value: unknown): CloudWorkspaceCacheRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<CloudWorkspaceCacheRecord>
  const workspaceId = normalizeWorkspaceId(raw.workspaceId)
  if (!workspaceId) return null
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map(normalizeSessionInfo).filter((session): session is SessionInfo => Boolean(session))
    : []
  const views = raw.views && typeof raw.views === 'object' && !Array.isArray(raw.views)
    ? raw.views as Record<string, SessionView>
    : {}
  return {
    workspaceId,
    sessions,
    views,
    eventCursors: normalizeEventCursors(raw.eventCursors),
    workflows: normalizeWorkflowList(raw.workflows),
    settings: normalizeSettings(raw.settings),
    artifactsBySession: normalizeArtifactsBySession(raw.artifactsBySession),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString(),
  }
}

function mergeSession(sessions: SessionInfo[], session: SessionInfo) {
  const normalized = normalizeSessionInfo(session)
  if (!normalized) return sessions
  const next = sessions.some((entry) => entry.id === normalized.id)
    ? sessions.map((entry) => entry.id === normalized.id ? normalized : entry)
    : [normalized, ...sessions]
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export class FileCloudWorkspaceCache implements CloudWorkspaceCache {
  readonly mode: CloudWorkspaceCacheMode
  private readonly path: string
  private readonly secretStorage: SecretStorageAdapter | null

  constructor(options: {
    path?: string
    mode?: CloudWorkspaceCacheMode
    encryptionFallback?: CloudWorkspaceCacheEncryptionFallback
    secretStorage?: SecretStorageAdapter | null
  } = {}) {
    this.path = options.path || defaultCachePath()
    const requestedMode = options.mode || 'full'
    this.secretStorage = options.secretStorage === undefined ? null : options.secretStorage
    if (requestedMode === 'full' && this.storageMode() === 'unavailable') {
      const fallback = options.encryptionFallback || 'metadata-only'
      if (fallback === 'fail-startup') {
        throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist full cloud workspace cache in production without OS-backed secret storage.')
      }
      this.mode = fallback
      return
    }
    this.mode = requestedMode
  }

  listSessions(workspaceId: string): SessionInfo[] | null {
    return this.readRecord(workspaceId)?.sessions || null
  }

  getSessionInfo(workspaceId: string, sessionId: string): SessionInfo | null {
    return this.readRecord(workspaceId)?.sessions.find((session) => session.id === sessionId) || null
  }

  getSessionView(workspaceId: string, sessionId: string): SessionView | null {
    if (this.mode !== 'full') return null
    return this.readRecord(workspaceId)?.views[sessionId] || null
  }

  getEventCursor(workspaceId: string, scope: string): number | null {
    return this.readRecord(workspaceId)?.eventCursors[scope] ?? null
  }

  setEventCursor(workspaceId: string, scope: string, sequence: number, now = new Date()): void {
    if (this.mode === 'disabled' || !scope || !Number.isFinite(sequence) || sequence < 0) return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    const current = existing.eventCursors[scope] || 0
    this.writeRecord(records, {
      ...existing,
      eventCursors: {
        ...existing.eventCursors,
        [scope]: Math.max(current, Math.floor(sequence)),
      },
      updatedAt: now.toISOString(),
    })
  }

  resetEventCursor(workspaceId: string, scope: string, sequence = 0, now = new Date()): void {
    if (this.mode === 'disabled' || !scope || !Number.isFinite(sequence) || sequence < 0) return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      eventCursors: {
        ...existing.eventCursors,
        [scope]: Math.floor(sequence),
      },
      updatedAt: now.toISOString(),
    })
  }

  getWorkflowList(workspaceId: string): WorkflowListPayload | null {
    return this.readRecord(workspaceId)?.workflows || null
  }

  upsertWorkflowList(workspaceId: string, workflows: WorkflowListPayload, now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    const normalized = normalizeWorkflowList(workflows)
    if (!id || !normalized) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      workflows: normalized,
      updatedAt: now.toISOString(),
    })
  }

  listSettings(workspaceId: string): CloudTransportSettingMetadata[] | null {
    return this.readRecord(workspaceId)?.settings || null
  }

  getSetting(workspaceId: string, key: string): CloudTransportSettingMetadata | null {
    return this.readRecord(workspaceId)?.settings.find((setting) => setting.key === key) || null
  }

  upsertSettings(workspaceId: string, settings: CloudTransportSettingMetadata[], now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    const normalized = normalizeSettings(settings)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      settings: normalized,
      updatedAt: now.toISOString(),
    })
  }

  upsertSetting(workspaceId: string, setting: CloudTransportSettingMetadata, now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    const normalized = normalizeSetting(setting)
    if (!id || !normalized) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      settings: [
        ...existing.settings.filter((entry) => entry.key !== normalized.key),
        normalized,
      ].sort((left, right) => left.key.localeCompare(right.key)),
      updatedAt: now.toISOString(),
    })
  }

  listArtifacts(workspaceId: string, sessionId: string): SessionArtifact[] | null {
    return this.readRecord(workspaceId)?.artifactsBySession[sessionId] || null
  }

  upsertArtifactList(workspaceId: string, sessionId: string, artifacts: SessionArtifact[], now = new Date()): void {
    if (this.mode === 'disabled' || !sessionId.trim()) return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      artifactsBySession: {
        ...existing.artifactsBySession,
        [sessionId]: artifacts.map(normalizeArtifact).filter((artifact): artifact is SessionArtifact => Boolean(artifact)),
      },
      updatedAt: now.toISOString(),
    })
  }

  upsertSessionList(workspaceId: string, sessions: SessionInfo[], now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || null
    const next: CloudWorkspaceCacheRecord = {
      workspaceId: id,
      sessions: sessions.map(normalizeSessionInfo).filter((session): session is SessionInfo => Boolean(session)),
      views: this.mode === 'full' ? existing?.views || {} : {},
      eventCursors: existing?.eventCursors || {},
      workflows: existing?.workflows || null,
      settings: existing?.settings || [],
      artifactsBySession: existing?.artifactsBySession || {},
      updatedAt: now.toISOString(),
    }
    this.writeRecord(records, next)
  }

  upsertSessionInfo(workspaceId: string, session: SessionInfo, now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      sessions: mergeSession(existing.sessions, session),
      updatedAt: now.toISOString(),
    })
  }

  upsertSessionView(workspaceId: string, sessionId: string, view: SessionView, now = new Date()): void {
    if (this.mode !== 'full') return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id || !sessionId.trim()) return
    const records = this.readRecords()
    const existing = records.find((record) => record.workspaceId === id) || this.emptyRecord(id, now)
    this.writeRecord(records, {
      ...existing,
      views: {
        ...existing.views,
        [sessionId]: view,
      },
      updatedAt: now.toISOString(),
    })
  }

  removeWorkspace(workspaceId: string): void {
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const records = this.readRecords()
    const next = records.filter((record) => record.workspaceId !== id)
    if (next.length === records.length) return
    this.writeRecords(next)
  }

  private emptyRecord(workspaceId: string, now = new Date()): CloudWorkspaceCacheRecord {
    return {
      workspaceId,
      sessions: [],
      views: {},
      eventCursors: {},
      workflows: null,
      settings: [],
      artifactsBySession: {},
      updatedAt: now.toISOString(),
    }
  }

  private readRecord(workspaceId: string) {
    const id = normalizeWorkspaceId(workspaceId)
    if (!id || this.mode === 'disabled') return null
    return this.readRecords().find((record) => record.workspaceId === id) || null
  }

  private storageMode() {
    return this.secretStorage?.mode || defaultSecretStorageMode()
  }

  private storage() {
    return this.secretStorage || requireSafeStorage()
  }

  private readRecords(): CloudWorkspaceCacheRecord[] {
    if (this.mode === 'disabled' || !existsSync(this.path)) return []
    const storageMode = this.storageMode()
    if (storageMode === 'unavailable' && this.mode === 'full') return []
    try {
      const raw = readFileSync(this.path)
      const json = this.mode === 'full' && storageMode === 'encrypted'
        ? this.storage().decryptString(raw)
        : raw.toString('utf-8')
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.map(normalizeRecord).filter((record): record is CloudWorkspaceCacheRecord => Boolean(record))
    } catch {
      if (this.mode === 'full' && storageMode === 'encrypted') {
        try { rmSync(this.path, { force: true }) } catch { /* ignore corrupted cache cleanup */ }
      }
      return []
    }
  }

  private writeRecord(records: CloudWorkspaceCacheRecord[], nextRecord: CloudWorkspaceCacheRecord) {
    this.writeRecords([
      ...records.filter((record) => record.workspaceId !== nextRecord.workspaceId),
      nextRecord,
    ])
  }

  private writeRecords(records: CloudWorkspaceCacheRecord[]) {
    if (this.mode === 'disabled') return
    const safeRecords = records
      .map((record) => normalizeRecord({
        ...record,
        views: this.mode === 'full' ? record.views : {},
      }))
      .filter((record): record is CloudWorkspaceCacheRecord => Boolean(record))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    const json = JSON.stringify(safeRecords, null, 2)
    const storageMode = this.storageMode()
    if (this.mode === 'full' && storageMode === 'encrypted') {
      writeFileAtomic(this.path, this.storage().encryptString(json), { mode: 0o600 })
      return
    }
    if (this.mode === 'full' && storageMode === 'unavailable') {
      throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist full cloud workspace cache in production without OS-backed secret storage.')
    }
    writeFileAtomic(this.path, json, { mode: 0o600 })
  }
}

export function createFileCloudWorkspaceCache(options?: {
  path?: string
  mode?: CloudWorkspaceCacheMode
  encryptionFallback?: CloudWorkspaceCacheEncryptionFallback
}) {
  return new FileCloudWorkspaceCache(options)
}
