import { readSafeStorageBackendForPolicy, resolveSecretStorageMode, type SecretStorageMode } from '@open-cowork/runtime-host/secure-storage-policy'
import { getAppPathHost, getSafeStorageHost, quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  CloudProjectSourceSummary,
  SessionArtifact,
  SessionInfo,
  SessionView,
  WorkflowListPayload,
} from '@open-cowork/shared'
import { isArtifactKind, isArtifactStatus } from '@open-cowork/shared'
import type { CloudTransportSettingMetadata } from '@open-cowork/cloud-server/transport-adapter'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
import {
  decodeCacheDocument,
  decodeCacheFile,
  decodeLegacyPlaintextCache,
  encodeCacheFile,
} from './workspace/cloud-workspace-cache-format.ts'
import { containsSensitiveCacheContent } from './workspace/cloud-workspace-cache-migration.ts'
import {
  createCloudWorkspaceCacheReporter,
  type CloudWorkspaceCacheReporter,
} from './workspace/cloud-workspace-cache-telemetry.ts'
import { redactWorkflowListForCache } from './workspace/cloud-workspace-cache-workflows.ts'
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
  // Coalesce a sync pass's per-session upserts into one durable read + write (P1-E).
  beginCacheBatch(): void
  endCacheBatch(): void
}

function defaultCachePath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'cloud-workspace-cache.json')
}

function defaultSecretStorageMode() {
  return resolveSecretStorageMode({
    isPackaged: Boolean(getAppPathHost()?.isPackaged),
    encryptionAvailable: Boolean(getSafeStorageHost()?.isEncryptionAvailable()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      getSafeStorageHost()?.getSelectedStorageBackend,
    ),
  })
}

function requireSafeStorage() {
  const safeStorage = getSafeStorageHost()
  if (!safeStorage) throw new Error('Electron safeStorage is unavailable')
  return safeStorage
}

function normalizeWorkspaceId(value: unknown) {
  return typeof value === 'string' && value.trim() && Buffer.byteLength(value.trim(), 'utf8') <= 512
    ? value.trim()
    : null
}

function readCacheString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readCacheRepositoryUrl(value: unknown) {
  const raw = readCacheString(value)
  if (!raw) return null
  const stripped = raw.split(/[?#]/, 1)[0]?.trim() || raw
  return stripped.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+@)/i, '$1')
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
    projectSource: normalizeProjectSourceSummary(record.projectSource),
  }
}

function normalizeProjectSourceSummary(value: unknown): CloudProjectSourceSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudProjectSourceSummary>
  if (record.kind === 'git') {
    const repositoryUrl = readCacheRepositoryUrl(record.repositoryUrl)
    if (!repositoryUrl) return null
    return {
      kind: 'git',
      repositoryUrl,
      ref: readCacheString(record.ref),
      subdirectory: readCacheString(record.subdirectory),
    }
  }
  if (record.kind === 'snapshot') {
    const snapshotId = readCacheString(record.snapshotId)
    if (!snapshotId) return null
    return {
      kind: 'snapshot',
      snapshotId,
      title: readCacheString(record.title),
    }
  }
  return null
}

function normalizeSetting(value: unknown): CloudTransportSettingMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudTransportSettingMetadata>
  if (typeof record.key !== 'string' || !record.key.trim()) return null
  if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) return null
  if (containsSensitiveCacheContent({ [record.key]: record.value })) return null
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

function normalizeArtifact(value: unknown, includeChart: boolean): SessionArtifact | null {
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
    chart: includeChart && !containsSensitiveCacheContent(record.chart)
      ? record.chart ?? undefined
      : undefined,
  }
}

function normalizeArtifactsBySession(
  value: unknown,
  includeChart: boolean,
): Record<string, SessionArtifact[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const artifactsBySession: Record<string, SessionArtifact[]> = {}
  for (const [sessionId, artifacts] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || Buffer.byteLength(sessionId, 'utf8') > 512 || !Array.isArray(artifacts)) continue
    artifactsBySession[sessionId] = artifacts
      .map((artifact) => normalizeArtifact(artifact, includeChart))
      .filter((artifact): artifact is SessionArtifact => Boolean(artifact))
  }
  return artifactsBySession
}

function normalizeRecord(
  value: unknown,
  includeArtifactCharts = false,
): CloudWorkspaceCacheRecord | null {
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
    workflows: redactWorkflowListForCache(raw.workflows),
    settings: normalizeSettings(raw.settings),
    artifactsBySession: normalizeArtifactsBySession(
      raw.artifactsBySession,
      includeArtifactCharts,
    ),
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
  private readonly reportCacheEvent: CloudWorkspaceCacheReporter
  // Event cursors live in a tiny, plain (sequence numbers aren't secret) sibling file,
  // written debounced — decoupled from the big encrypted views blob. setEventCursor is
  // called per streamed cloud event; persisting it previously re-read, re-decrypted,
  // re-serialized, re-encrypted and fsync'd EVERY transcript on each call, blocking the
  // Electron main loop. Cursors are advisory (re-reading events is idempotent), so a
  // debounced write — and losing the last few hundred ms on an abrupt quit — is safe.
  private readonly cursorsPath: string
  private cursorState: Map<string, Map<string, number>> | null = null
  // A failed encrypted read is not an empty cache. Keep that state distinct so
  // a later mutation cannot replace recoverable ciphertext with a new document.
  private secureReadUnavailable = false
  // Non-null while a sync batch is open: upserts mutate this buffer instead of re-reading +
  // re-writing the whole cache per call (P1-E). Persisted once on endCacheBatch.
  private batchBuffer: CloudWorkspaceCacheRecord[] | null = null
  private cursorFlushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: {
    path?: string
    mode?: CloudWorkspaceCacheMode
    encryptionFallback?: CloudWorkspaceCacheEncryptionFallback
    secretStorage?: SecretStorageAdapter | null
    reporter?: CloudWorkspaceCacheReporter
  } = {}) {
    this.path = options.path || defaultCachePath()
    this.cursorsPath = `${this.path}.cursors.json`
    this.reportCacheEvent = createCloudWorkspaceCacheReporter(options.reporter)
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
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return null
    return this.loadCursorState().get(id)?.get(scope) ?? null
  }

  setEventCursor(workspaceId: string, scope: string, sequence: number, _now = new Date()): void {
    if (this.mode === 'disabled' || !scope || !Number.isFinite(sequence) || sequence < 0) return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const state = this.loadCursorState()
    const scopes = state.get(id) || new Map<string, number>()
    const current = scopes.get(scope) || 0
    scopes.set(scope, Math.max(current, Math.floor(sequence)))
    state.set(id, scopes)
    this.scheduleCursorFlush()
  }

  resetEventCursor(workspaceId: string, scope: string, sequence = 0, _now = new Date()): void {
    if (this.mode === 'disabled' || !scope || !Number.isFinite(sequence) || sequence < 0) return
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return
    const state = this.loadCursorState()
    const scopes = state.get(id) || new Map<string, number>()
    scopes.set(scope, Math.floor(sequence))
    state.set(id, scopes)
    this.scheduleCursorFlush()
  }

  // Lazily load cursors from the dedicated file.
  private loadCursorState(): Map<string, Map<string, number>> {
    if (this.cursorState) return this.cursorState
    const state = new Map<string, Map<string, number>>()
    if (this.mode === 'disabled') { this.cursorState = state; return state }
    if (existsSync(this.cursorsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.cursorsPath, 'utf-8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [ws, scopes] of Object.entries(parsed as Record<string, unknown>)) {
            if (!scopes || typeof scopes !== 'object') continue
            const scopeMap = new Map<string, number>()
            for (const [scope, seq] of Object.entries(scopes as Record<string, unknown>)) {
              if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) scopeMap.set(scope, Math.floor(seq))
            }
            if (scopeMap.size > 0) state.set(ws, scopeMap)
          }
        }
      } catch { /* corrupt cursor file → start empty; cursors are advisory */ }
    }
    this.cursorState = state
    return state
  }

  private scheduleCursorFlush(): void {
    if (this.cursorFlushTimer) return
    this.cursorFlushTimer = setTimeout(() => {
      this.cursorFlushTimer = null
      this.flushCursorState()
    }, 250)
    this.cursorFlushTimer.unref?.()
  }

  private flushCursorState(): void {
    if (this.mode === 'disabled' || !this.cursorState) return
    const serialized: Record<string, Record<string, number>> = {}
    for (const [ws, scopes] of this.cursorState) {
      serialized[ws] = Object.fromEntries(scopes)
    }
    try {
      writeFileAtomic(this.cursorsPath, JSON.stringify(serialized), { mode: 0o600 })
    } catch { /* best-effort; cursors are advisory and re-derive from replay */ }
  }

  getWorkflowList(workspaceId: string): WorkflowListPayload | null {
    return this.readRecord(workspaceId)?.workflows || null
  }

  upsertWorkflowList(workspaceId: string, workflows: WorkflowListPayload, now = new Date()): void {
    if (this.mode === 'disabled') return
    const id = normalizeWorkspaceId(workspaceId)
    const normalized = redactWorkflowListForCache(workflows)
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
        [sessionId]: artifacts
          .map((artifact) => normalizeArtifact(artifact, this.mode === 'full'))
          .filter((artifact): artifact is SessionArtifact => Boolean(artifact)),
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
    if (this.loadCursorState().delete(id)) this.scheduleCursorFlush()
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
    if (this.batchBuffer !== null) return this.batchBuffer
    if (this.mode === 'disabled' || !existsSync(this.path)) {
      this.secureReadUnavailable = false
      return []
    }
    const storageMode = this.storageMode()
    const normalizeForMode = (value: unknown) => normalizeRecord(
      value,
      this.mode === 'full',
    )
    if (storageMode === 'unavailable' && this.mode === 'full') {
      this.secureReadUnavailable = true
      this.reportCacheEvent({
        operation: 'read',
        outcome: 'blocked',
        reason: 'secure_storage_unavailable',
        encoding: 'unknown',
      })
      return []
    }
    let raw: Buffer
    try {
      raw = readFileSync(this.path)
    } catch {
      this.secureReadUnavailable = true
      this.reportCacheEvent({
        operation: 'read',
        outcome: 'failed',
        reason: 'io_error',
        encoding: 'unknown',
      })
      return []
    }
    const file = decodeCacheFile(raw)
    let decoded: ReturnType<typeof decodeCacheDocument<CloudWorkspaceCacheRecord>>
    let sourceEncoding: 'encrypted' | 'plaintext'
    if (file.encoding === 'plaintext') {
      sourceEncoding = 'plaintext'
      decoded = decodeCacheDocument(file.payload.toString('utf-8'), normalizeForMode)
    } else if (file.encoding === 'encrypted') {
      sourceEncoding = 'encrypted'
      if (storageMode !== 'encrypted') {
        this.secureReadUnavailable = true
        this.reportCacheEvent({
          operation: 'decrypt',
          outcome: 'blocked',
          reason: 'secure_storage_unavailable',
          encoding: 'encrypted',
        })
        return []
      }
      try {
        decoded = decodeCacheDocument(this.storage().decryptString(file.payload), normalizeForMode)
      } catch {
        // Transient decrypt failure (keychain locked): the encrypted transcript cache is intact
        // (audit P2-12) — do NOT delete, just skip it for this read so it isn't lost on a hiccup.
        this.secureReadUnavailable = true
        this.reportCacheEvent({
          operation: 'decrypt',
          outcome: 'failed',
          reason: 'decrypt_error',
          encoding: 'encrypted',
        })
        return []
      }
    } else {
      // An unversioned file is ambiguous: some safeStorage backends can emit
      // bytes that also happen to parse as JSON (including `[]`). When secure
      // storage is unavailable there is no safe discriminator, so preserve the
      // original bytes and block writes until the backend recovers.
      if (storageMode === 'unavailable') {
        this.secureReadUnavailable = true
        this.reportCacheEvent({
          operation: 'decrypt',
          outcome: 'blocked',
          reason: 'ambiguous_legacy_format',
          encoding: 'legacy',
        })
        return []
      }
      if (storageMode === 'encrypted') {
        try {
          decoded = decodeCacheDocument(this.storage().decryptString(file.payload), normalizeForMode)
          sourceEncoding = 'encrypted'
        } catch {
          const plaintext = decodeLegacyPlaintextCache(file.payload, normalizeForMode)
          if (!plaintext) {
            this.secureReadUnavailable = true
            this.reportCacheEvent({
              operation: 'decrypt',
              outcome: 'failed',
              reason: 'decrypt_error',
              encoding: 'legacy',
            })
            return []
          }
          sourceEncoding = 'plaintext'
          decoded = plaintext
        }
      } else {
        sourceEncoding = 'plaintext'
        decoded = decodeLegacyPlaintextCache(file.payload, normalizeForMode)
      }
    }
    if (!decoded) {
      // A successfully decoded file envelope with an invalid document is
      // genuinely corrupt. Quarantine for diagnosis, never silently overwrite.
      const quarantined = quarantineCorruptFile(this.path)
      this.secureReadUnavailable = !quarantined
      this.reportCacheEvent({
        operation: 'quarantine',
        outcome: quarantined ? 'completed' : 'failed',
        reason: quarantined ? 'invalid_document' : 'quarantine_failed',
        encoding: file.encoding,
      })
      return []
    }
    this.secureReadUnavailable = false
    const targetEncoding = this.mode === 'full' && storageMode === 'encrypted'
      ? 'encrypted'
      : 'plaintext'
    if (
      decoded.migratedLegacySensitivePartitions
      || file.encoding === 'legacy'
      || sourceEncoding !== targetEncoding
    ) {
      try {
        this.writeRecords(decoded.records)
        if (decoded.migratedLegacySensitivePartitions) {
          this.reportCacheEvent({
            operation: 'migrate_v1',
            outcome: 'completed',
            reason: decoded.removedSensitiveViews
              ? 'sensitive_views_removed'
              : 'workflow_partitions_removed',
            encoding: sourceEncoding,
          })
        }
      } catch (error) {
        if (decoded.migratedLegacySensitivePartitions) {
          this.reportCacheEvent({
            operation: 'migrate_v1',
            outcome: 'failed',
            reason: 'write_error',
            encoding: sourceEncoding,
          })
        }
        throw error
      }
    }
    return decoded.records
  }

  private writeRecord(records: CloudWorkspaceCacheRecord[], nextRecord: CloudWorkspaceCacheRecord) {
    this.writeRecords([
      ...records.filter((record) => record.workspaceId !== nextRecord.workspaceId),
      nextRecord,
    ])
  }

  private writeRecords(records: CloudWorkspaceCacheRecord[]) {
    if (this.mode === 'disabled' || this.secureReadUnavailable) return
    const safeRecords = records
      .map((record) => normalizeRecord({
        ...record,
        views: this.mode === 'full' ? record.views : {},
      }, this.mode === 'full'))
      .filter((record): record is CloudWorkspaceCacheRecord => Boolean(record))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    // During a sync batch, accumulate in memory and persist once at endCacheBatch (P1-E). The
    // n per-session upserts a sync performs would otherwise each re-serialize + encrypt + fsync
    // the entire cache — O(n^2) bytes on the Electron main thread.
    if (this.batchBuffer !== null) {
      this.batchBuffer = safeRecords
      return
    }
    this.persistRecords(safeRecords)
  }

  private persistRecords(safeRecords: CloudWorkspaceCacheRecord[]) {
    const storageMode = this.storageMode()
    const encoding = this.mode === 'full' && storageMode === 'encrypted'
      ? 'encrypted'
      : 'plaintext'
    try {
      if (this.mode === 'full' && storageMode === 'encrypted') {
        writeFileAtomic(
          this.path,
          encodeCacheFile(safeRecords, 'encrypted', (plaintext) => this.storage().encryptString(plaintext)),
          { mode: 0o600 },
        )
        return
      }
      if (this.mode === 'full' && storageMode === 'unavailable') {
        throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist full cloud workspace cache in production without OS-backed secret storage.')
      }
      writeFileAtomic(
        this.path,
        encodeCacheFile(safeRecords, 'plaintext'),
        { mode: 0o600 },
      )
    } catch (error) {
      const storageBlocked = this.mode === 'full' && storageMode === 'unavailable'
      this.reportCacheEvent({
        operation: 'write',
        outcome: storageBlocked ? 'blocked' : 'failed',
        reason: storageBlocked ? 'secure_storage_unavailable' : 'write_error',
        encoding,
      })
      throw error
    }
  }

  // Coalesce the durable writes of a sync pass: read the cache once, let every upsert mutate the
  // in-memory buffer, then write once. Idempotent + always paired with endCacheBatch in a finally.
  beginCacheBatch(): void {
    if (this.mode === 'disabled' || this.batchBuffer !== null) return
    this.batchBuffer = this.readRecords()
  }

  endCacheBatch(): void {
    const buffered = this.batchBuffer
    this.batchBuffer = null
    if (buffered && !this.secureReadUnavailable) this.persistRecords(buffered)
  }
}

export function createFileCloudWorkspaceCache(options?: {
  path?: string
  mode?: CloudWorkspaceCacheMode
  encryptionFallback?: CloudWorkspaceCacheEncryptionFallback
}) {
  return new FileCloudWorkspaceCache(options)
}
