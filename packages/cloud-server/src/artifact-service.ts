import { randomUUID } from 'node:crypto'
import {
  canAdvanceArtifactStatus,
  cloudArtifactFilePath,
  defaultArtifactStatusForKind,
  inferArtifactKind,
  isArtifactKind,
  isArtifactStatus,
  type ArtifactIndexEntry,
  type ArtifactIndexPayload,
  type ArtifactIndexRequest,
  type ArtifactKind,
  type ArtifactStatus,
  type ArtifactStatusUpdateRequest,
} from '@open-cowork/shared'
import type { ObjectStoreAdapter, ObjectStorePresignedRequest } from './object-store.ts'
import { artifactObjectKey } from './object-store.ts'
import { CloudServiceError, type CloudPrincipal, type CloudSessionService } from './session-service.ts'

export type CloudArtifactRecord = {
  artifactId: string
  sessionId: string
  filename: string
  contentType: string | null
  size: number
  key: string
  createdAt: string
  updatedAt: string
  kind: ArtifactKind
  status: ArtifactStatus
  authorAgentId: string | null
  projectId: string | null
  taskId: string | null
  statusUpdatedBy: string | null
  statusUpdatedAt: string | null
}

type CloudArtifactUpdatePatch = {
  artifactId: string
  sessionId: string
  filename?: string
  contentType?: string | null
  size?: number
  createdAt?: string
  updatedAt?: string
  kind?: ArtifactKind
  status?: ArtifactStatus
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
}

export type CloudArtifactUploadInput = {
  filename: string
  contentType?: string | null
  dataBase64: string
  kind?: ArtifactKind | null
  status?: ArtifactStatus | null
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
}

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const ARTIFACT_INDEX_SESSION_PAGE_SIZE = 100
const MAX_ARTIFACT_INDEX_SESSION_SCAN = 5_000

function boundedFilename(value: unknown) {
  if (typeof value !== 'string') throw new CloudServiceError(400, 'Artifact filename is required.')
  const trimmed = value.trim()
  if (!trimmed) throw new CloudServiceError(400, 'Artifact filename is required.')
  if (trimmed.length > 256 || /[\\/\0]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new CloudServiceError(400, 'Artifact filename is invalid.')
  }
  return trimmed
}

function boundedContentType(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new CloudServiceError(400, 'Artifact contentType must be a string.')
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(trimmed)) {
    throw new CloudServiceError(400, 'Artifact contentType is invalid.')
  }
  return trimmed
}

function boundedNullableString(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new CloudServiceError(400, `${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > 512) throw new CloudServiceError(400, `${label} is too large.`)
  return trimmed
}

function boundedNullableIsoDate(value: unknown, label: string) {
  const trimmed = boundedNullableString(value, label)
  if (!trimmed) return null
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
  if (!isoLike.test(trimmed) || !Number.isFinite(Date.parse(trimmed))) {
    throw new CloudServiceError(400, `${label} is invalid.`)
  }
  return trimmed
}

function boundedKind(value: unknown, fallback: ArtifactKind) {
  if (value === null || value === undefined || value === '') return fallback
  if (!isArtifactKind(value)) throw new CloudServiceError(400, 'Artifact kind is invalid.')
  return value
}

function boundedStatus(value: unknown, fallback: ArtifactStatus) {
  if (value === null || value === undefined || value === '') return fallback
  if (!isArtifactStatus(value)) throw new CloudServiceError(400, 'Artifact status is invalid.')
  return value
}

function decodeBase64(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new CloudServiceError(400, 'Artifact dataBase64 is required.')
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(value)) throw new CloudServiceError(400, 'Artifact dataBase64 is invalid.')
  const buffer = Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64')
  if (buffer.byteLength === 0) throw new CloudServiceError(400, 'Artifact dataBase64 is empty.')
  if (buffer.byteLength > MAX_ARTIFACT_BYTES) throw new CloudServiceError(413, 'Artifact is too large.')
  return buffer
}

function asArtifactRecord(value: unknown): CloudArtifactRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudArtifactRecord>
  if (
    typeof record.artifactId !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.filename !== 'string'
    || typeof record.key !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.size !== 'number'
  ) {
    return null
  }
  const contentType = typeof record.contentType === 'string' ? record.contentType : null
  const kind = isArtifactKind(record.kind)
    ? record.kind
    : inferArtifactKind({
      filename: record.filename,
      mime: contentType,
      kind: record.kind,
    })
  const createdAt = record.createdAt
  const status = isArtifactStatus(record.status) ? record.status : defaultArtifactStatusForKind(kind)
  return {
    artifactId: record.artifactId,
    sessionId: record.sessionId,
    filename: record.filename,
    contentType,
    size: record.size,
    key: record.key,
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : createdAt,
    kind,
    status,
    authorAgentId: typeof record.authorAgentId === 'string' ? record.authorAgentId : null,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    taskId: typeof record.taskId === 'string' ? record.taskId : null,
    statusUpdatedBy: typeof record.statusUpdatedBy === 'string' ? record.statusUpdatedBy : null,
    statusUpdatedAt: typeof record.statusUpdatedAt === 'string' ? record.statusUpdatedAt : null,
  }
}

function asArtifactUpdatePatch(value: unknown): CloudArtifactUpdatePatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudArtifactRecord>
  if (typeof record.artifactId !== 'string' || typeof record.sessionId !== 'string') return null
  const patch: CloudArtifactUpdatePatch = {
    artifactId: record.artifactId,
    sessionId: record.sessionId,
  }
  if (typeof record.filename === 'string') patch.filename = record.filename
  if (typeof record.contentType === 'string' || record.contentType === null) patch.contentType = record.contentType
  if (typeof record.size === 'number') patch.size = record.size
  if (typeof record.createdAt === 'string') patch.createdAt = record.createdAt
  if (typeof record.updatedAt === 'string') patch.updatedAt = record.updatedAt
  if (isArtifactKind(record.kind)) patch.kind = record.kind
  if (isArtifactStatus(record.status)) patch.status = record.status
  if (typeof record.authorAgentId === 'string' || record.authorAgentId === null) patch.authorAgentId = record.authorAgentId
  if (typeof record.projectId === 'string' || record.projectId === null) patch.projectId = record.projectId
  if (typeof record.taskId === 'string' || record.taskId === null) patch.taskId = record.taskId
  if (typeof record.statusUpdatedBy === 'string' || record.statusUpdatedBy === null) patch.statusUpdatedBy = record.statusUpdatedBy
  if (typeof record.statusUpdatedAt === 'string' || record.statusUpdatedAt === null) patch.statusUpdatedAt = record.statusUpdatedAt
  return patch
}

function mergeArtifactUpdate(existing: CloudArtifactRecord, patch: CloudArtifactUpdatePatch): CloudArtifactRecord {
  return {
    ...existing,
    filename: patch.filename ?? existing.filename,
    contentType: patch.contentType === undefined ? existing.contentType : patch.contentType,
    size: patch.size ?? existing.size,
    createdAt: patch.createdAt ?? existing.createdAt,
    updatedAt: patch.updatedAt ?? existing.updatedAt,
    kind: patch.kind ?? existing.kind,
    status: patch.status ?? existing.status,
    authorAgentId: patch.authorAgentId === undefined ? existing.authorAgentId : patch.authorAgentId,
    projectId: patch.projectId === undefined ? existing.projectId : patch.projectId,
    taskId: patch.taskId === undefined ? existing.taskId : patch.taskId,
    statusUpdatedBy: patch.statusUpdatedBy === undefined ? existing.statusUpdatedBy : patch.statusUpdatedBy,
    statusUpdatedAt: patch.statusUpdatedAt === undefined ? existing.statusUpdatedAt : patch.statusUpdatedAt,
  }
}

function publicArtifactRecord(record: CloudArtifactRecord, options: {
  order?: number
  sessionTitle?: string | null
  workspaceId?: string | null
} = {}): ArtifactIndexEntry & { artifactId: string; contentType: string | null } {
  return {
    artifactId: record.artifactId,
    id: record.artifactId,
    toolId: 'cloud-artifact',
    toolName: 'cloud.artifact',
    filePath: cloudArtifactFilePath(record.artifactId, record.filename),
    filename: record.filename,
    order: options.order || 0,
    source: 'cloud',
    cloudArtifactId: record.artifactId,
    sessionId: record.sessionId,
    sessionTitle: options.sessionTitle || null,
    workspaceId: options.workspaceId || null,
    mime: record.contentType || undefined,
    contentType: record.contentType,
    size: record.size,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: record.kind,
    status: record.status,
    authorAgentId: record.authorAgentId,
    projectId: record.projectId,
    taskId: record.taskId,
    statusUpdatedBy: record.statusUpdatedBy,
    statusUpdatedAt: record.statusUpdatedAt,
  }
}

function artifactUpdatedMs(artifact: Pick<ArtifactIndexEntry, 'updatedAt' | 'createdAt'>) {
  const value = artifact.updatedAt || artifact.createdAt
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : 0
}

function artifactMatchesIndexRequest(entry: ArtifactIndexEntry, request: ArtifactIndexRequest) {
  const taskIds = new Set((request.taskIds || []).filter(Boolean))
  if (request.projectId && entry.projectId !== request.projectId && (!entry.taskId || !taskIds.has(entry.taskId))) return false
  if (request.taskId && entry.taskId !== request.taskId) return false
  if (!request.projectId && taskIds.size > 0 && (!entry.taskId || !taskIds.has(entry.taskId))) return false
  if (request.status && entry.status !== request.status) return false
  if (request.kind && entry.kind !== request.kind) return false
  return true
}

export class CloudArtifactService {
  private readonly sessionService: CloudSessionService
  private readonly objectStore: ObjectStoreAdapter
  private readonly ids: { randomUUID: () => string }

  constructor(
    sessionService: CloudSessionService,
    objectStore: ObjectStoreAdapter,
    ids: { randomUUID: () => string } = { randomUUID },
  ) {
    this.sessionService = sessionService
    this.objectStore = objectStore
    this.ids = ids
  }

  async uploadSessionArtifact(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactUploadInput,
  ): Promise<CloudArtifactRecord> {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = this.ids.randomUUID()
    const filename = boundedFilename(input.filename)
    const contentType = boundedContentType(input.contentType)
    const body = decodeBase64(input.dataBase64)
    const kind = boundedKind(input.kind, inferArtifactKind({ filename, mime: contentType }))
    const status = boundedStatus(input.status, defaultArtifactStatusForKind(kind))
    const authorAgentId = boundedNullableString(input.authorAgentId, 'Author agent id')
    const projectId = boundedNullableString(input.projectId, 'Project id')
    const taskId = boundedNullableString(input.taskId, 'Task id')
    const statusUpdatedBy = boundedNullableString(input.statusUpdatedBy, 'Status updated by')
    const explicitStatusUpdatedAt = boundedNullableIsoDate(input.statusUpdatedAt, 'Status updated at')
    const createdAt = new Date().toISOString()
    await this.sessionService.assertArtifactUploadAllowed(principal, body.byteLength)
    const key = artifactObjectKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      filename,
    })
    const stored = await this.objectStore.putObject({
      key,
      body,
      contentType,
      metadata: {
        tenant: principal.tenantId,
        session: sessionId,
        artifact: artifactId,
      },
    })
    const record: CloudArtifactRecord = {
      artifactId,
      sessionId,
      filename,
      contentType,
      size: stored.size,
      key,
      createdAt,
      updatedAt: createdAt,
      kind,
      status,
      authorAgentId,
      projectId,
      taskId,
      statusUpdatedBy,
      statusUpdatedAt: explicitStatusUpdatedAt ?? (input.status || input.statusUpdatedBy ? createdAt : null),
    }
    await this.sessionService.appendProductEvent(principal, sessionId, {
      type: 'artifact.created',
      payload: record,
    })
    await this.sessionService.recordArtifactUploaded(principal, sessionId, artifactId, stored.size)
    return record
  }

  async listSessionArtifacts(principal: CloudPrincipal, sessionId: string): Promise<CloudArtifactRecord[]> {
    await this.sessionService.getSessionView(principal, sessionId)
    const events = await this.sessionService.listEvents(principal, sessionId)
    const artifacts = new Map<string, CloudArtifactRecord>()
    for (const event of events) {
      if (event.type !== 'artifact.created' && event.type !== 'artifact.updated') continue
      const record = asArtifactRecord(event.payload)
      if (record) {
        if (record.sessionId !== sessionId) continue
        artifacts.set(record.artifactId, record)
        continue
      }
      const patch = asArtifactUpdatePatch(event.payload)
      if (!patch || patch.sessionId !== sessionId) continue
      const existing = artifacts.get(patch.artifactId)
      if (!existing) continue
      artifacts.set(patch.artifactId, mergeArtifactUpdate(existing, patch))
    }
    return Array.from(artifacts.values())
  }

  async listPublicSessionArtifacts(principal: CloudPrincipal, sessionId: string): Promise<Array<ReturnType<typeof publicArtifactRecord>>> {
    const artifacts = await this.listSessionArtifacts(principal, sessionId)
    return artifacts.map((artifact, index) => publicArtifactRecord(artifact, {
      order: index,
      workspaceId: `cloud:${principal.tenantId}`,
    }))
  }

  async listArtifactIndex(principal: CloudPrincipal, request: ArtifactIndexRequest = {}): Promise<ArtifactIndexPayload> {
    const limit = Math.min(Math.max(Math.floor(Number(request.limit) || 100), 1), 500)
    const artifacts: ArtifactIndexEntry[] = []

    if (request.sessionId) {
      const sessionView = await this.sessionService.getSessionView(principal, request.sessionId)
      const truncated = await this.collectIndexArtifactsForSession(principal, sessionView, request, artifacts, limit)
      return { artifacts, total: artifacts.length, scannedSessions: 1, truncated }
    }

    let cursor: string | null = null
    let scannedSessions = 0
    let truncated = false
    do {
      const remainingScanBudget = MAX_ARTIFACT_INDEX_SESSION_SCAN - scannedSessions
      if (remainingScanBudget <= 0) {
        truncated = Boolean(cursor)
        break
      }
      const page = await this.sessionService.listSessionsPage(principal, {
        cursor: cursor || undefined,
        limit: Math.min(ARTIFACT_INDEX_SESSION_PAGE_SIZE, remainingScanBudget),
      })
      if (page.items.length === 0) {
        truncated = Boolean(page.nextCursor)
        break
      }
      scannedSessions += page.items.length
      for (const session of page.items) {
        const stoppedAtLimit = await this.collectIndexArtifactsForSession(principal, { session, projection: null }, request, artifacts, limit)
        if (stoppedAtLimit) {
          return { artifacts, total: artifacts.length, scannedSessions, truncated: true }
        }
      }
      cursor = page.nextCursor
    } while (cursor)
    return { artifacts, total: artifacts.length, scannedSessions, truncated }
  }

  private async collectIndexArtifactsForSession(
    principal: CloudPrincipal,
    sessionView: Awaited<ReturnType<CloudSessionService['getSessionView']>>,
    request: ArtifactIndexRequest,
    artifacts: ArtifactIndexEntry[],
    limit: number,
  ): Promise<boolean> {
    const records = await this.listSessionArtifacts(principal, sessionView.session.sessionId)
    const sessionArtifacts: ArtifactIndexEntry[] = []
    for (const [index, record] of records.entries()) {
      const entry = publicArtifactRecord(record, {
        order: index,
        sessionTitle: sessionView.session.title,
        workspaceId: `cloud:${principal.tenantId}`,
      })
      if (!artifactMatchesIndexRequest(entry, request)) continue
      sessionArtifacts.push(entry)
    }
    sessionArtifacts.sort((left, right) => artifactUpdatedMs(right) - artifactUpdatedMs(left))
    for (const entry of sessionArtifacts) {
      if (artifacts.length >= limit) return true
      artifacts.push(entry)
    }
    return artifacts.length >= limit && sessionArtifacts.length > 0
  }

  async updateSessionArtifactStatus(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
    input: Pick<ArtifactStatusUpdateRequest, 'status' | 'updatedBy' | 'authorAgentId' | 'projectId' | 'taskId' | 'kind'>,
  ): Promise<CloudArtifactRecord> {
    const existing = (await this.listSessionArtifacts(principal, sessionId))
      .find((entry) => entry.artifactId === artifactId)
    if (!existing) throw new CloudServiceError(404, 'Cloud artifact was not found.')
    const status = boundedStatus(input.status, existing.status)
    if (!canAdvanceArtifactStatus(existing.status, status)) {
      throw new CloudServiceError(409, 'Artifact status cannot move backwards.')
    }
    const now = new Date().toISOString()
    const statusUpdatedBy = boundedNullableString(input.updatedBy, 'Updated by')
    const next: CloudArtifactRecord = {
      ...existing,
      kind: boundedKind(input.kind, existing.kind),
      status,
      authorAgentId: boundedNullableString(input.authorAgentId, 'Author agent id') ?? existing.authorAgentId,
      projectId: boundedNullableString(input.projectId, 'Project id') ?? existing.projectId,
      taskId: boundedNullableString(input.taskId, 'Task id') ?? existing.taskId,
      statusUpdatedBy,
      statusUpdatedAt: now,
      updatedAt: now,
    }
    await this.sessionService.appendProductEvent(principal, sessionId, {
      type: 'artifact.updated',
      payload: { ...publicArtifactRecord(next) },
    })
    return next
  }

  async readSessionArtifact(principal: CloudPrincipal, sessionId: string, artifactId: string) {
    const artifact = (await this.listSessionArtifacts(principal, sessionId))
      .find((entry) => entry.artifactId === artifactId)
    if (!artifact) throw new CloudServiceError(404, 'Cloud artifact was not found.')
    const object = await this.objectStore.getObject(artifact.key)
    if (!object) throw new CloudServiceError(404, 'Cloud artifact object was not found.')
    await this.sessionService.recordArtifactDownloaded(principal, sessionId, artifactId, object.body.byteLength)
    return {
      ...artifact,
      contentType: object.contentType || artifact.contentType,
      dataBase64: object.body.toString('base64'),
    }
  }

  // Guarded direct-to-store download. When the configured object store can presign (S3 with
  // static credentials), authorize the principal/artifact and return a time-limited URL the
  // client fetches directly — keeping the artifact bytes off the pod heap. Returns null when
  // presigning is unavailable (absent capability or no static credentials) so the caller falls
  // back to the buffered readSessionArtifact path. A missing artifact still throws 404, matching
  // the buffered path's behaviour. Usage is attributed at presign time using the recorded size.
  async presignSessionArtifactDownload(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
    options?: { expiresSeconds?: number },
  ): Promise<{ artifact: CloudArtifactRecord, presigned: ObjectStorePresignedRequest } | null> {
    if (!this.objectStore.presignGet) return null
    const artifact = (await this.listSessionArtifacts(principal, sessionId))
      .find((entry) => entry.artifactId === artifactId)
    if (!artifact) throw new CloudServiceError(404, 'Cloud artifact was not found.')
    const presigned = await this.objectStore.presignGet(artifact.key, options)
    if (!presigned) return null
    await this.sessionService.recordArtifactDownloaded(principal, sessionId, artifactId, artifact.size)
    return { artifact, presigned }
  }

  publicArtifact(record: CloudArtifactRecord, order = 0) {
    return publicArtifactRecord(record, {
      order,
    })
  }
}
