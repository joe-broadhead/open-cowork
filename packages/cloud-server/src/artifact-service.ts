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

// Metadata fields shared by the buffered upload and the presigned-upload finalize. The
// presigned flow never carries the bytes themselves (those go straight to object storage),
// so finalize describes the artifact with everything except the body.
type CloudArtifactMetadataInput = {
  filename: unknown
  contentType?: unknown
  kind?: unknown
  status?: unknown
  authorAgentId?: unknown
  projectId?: unknown
  taskId?: unknown
  statusUpdatedBy?: unknown
  statusUpdatedAt?: unknown
}

export type CloudArtifactPresignUploadInput = {
  filename: string
  contentType?: string | null
  expiresSeconds?: number
  // Client-declared expected upload size, in bytes. Used only to size the speculative
  // billing/quota reservation at BEGIN (SEC-1); finalize settles the actual stored size.
  // Absent ⇒ a minimal speculative reservation that still runs the billing/over-quota gate.
  expectedSize?: number
}

export type CloudArtifactFinalizeUploadInput = {
  artifactId: string
  filename: string
  contentType?: string | null
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

// Bound the client-declared expected upload size used to size the presign BEGIN
// reservation (SEC-1). A declared size over the hard cap is rejected up front (mirrors
// the buffered path's 413). An absent size reserves a minimal speculative byte so the
// billing + over-quota gate still runs without materially double-counting against the
// actual-size charge that finalize records.
function boundedExpectedSize(value: unknown): number {
  if (value === null || value === undefined) return 1
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new CloudServiceError(400, 'Artifact expectedSize is invalid.')
  }
  if (value > MAX_ARTIFACT_BYTES) throw new CloudServiceError(413, 'Artifact is too large.')
  return Math.max(1, value)
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

// The presigned-upload finalize echoes back the artifact id the begin endpoint issued. It is
// interpolated into the object key, so it must be a tight, traversal-free token (server-issued
// UUIDs satisfy this) — never trust a client-supplied id that could reshape the key path.
function boundedArtifactId(value: unknown) {
  if (typeof value !== 'string') throw new CloudServiceError(400, 'Artifact id is required.')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new CloudServiceError(400, 'Artifact id is invalid.')
  }
  return trimmed
}

// Validate + normalize the artifact metadata both upload paths persist, so the buffered upload
// and the presigned finalize agree on bounds and on the derived defaults (kind/status/statusUpdatedAt).
function resolveArtifactMetadataFields(input: CloudArtifactMetadataInput, createdAt: string) {
  const filename = boundedFilename(input.filename)
  const contentType = boundedContentType(input.contentType)
  const kind = boundedKind(input.kind, inferArtifactKind({ filename, mime: contentType }))
  const status = boundedStatus(input.status, defaultArtifactStatusForKind(kind))
  const authorAgentId = boundedNullableString(input.authorAgentId, 'Author agent id')
  const projectId = boundedNullableString(input.projectId, 'Project id')
  const taskId = boundedNullableString(input.taskId, 'Task id')
  const statusUpdatedBy = boundedNullableString(input.statusUpdatedBy, 'Status updated by')
  const explicitStatusUpdatedAt = boundedNullableIsoDate(input.statusUpdatedAt, 'Status updated at')
  const statusUpdatedAt = explicitStatusUpdatedAt ?? ((input.status || input.statusUpdatedBy) ? createdAt : null)
  return { filename, contentType, kind, status, authorAgentId, projectId, taskId, statusUpdatedBy, statusUpdatedAt }
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
  // Cached serialized origin of the object store's presigned URLs (or null when the store
  // cannot presign). The store config is fixed for the server's lifetime, so this is
  // computed once. See presignedUploadOrigin (SEC-2).
  private cachedPresignedUploadOrigin: string | null | undefined

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
    const createdAt = new Date().toISOString()
    const meta = resolveArtifactMetadataFields(input, createdAt)
    const body = decodeBase64(input.dataBase64)
    await this.sessionService.assertArtifactUploadAllowed(principal, body.byteLength)
    const key = artifactObjectKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      filename: meta.filename,
    })
    const stored = await this.objectStore.putObject({
      key,
      body,
      contentType: meta.contentType,
      metadata: {
        tenant: principal.tenantId,
        session: sessionId,
        artifact: artifactId,
      },
    })
    return this.persistUploadedArtifact(principal, sessionId, {
      ...meta,
      artifactId,
      size: stored.size,
      key,
      createdAt,
    })
  }

  // Begin a direct-to-store upload. When the configured object store can presign (S3 with static
  // credentials), authorize the principal/session, mint the artifact id + object key, and return a
  // time-limited PUT URL the client uploads bytes straight to — keeping them off the pod heap. The
  // client then calls finalizeSessionArtifactUpload to record the metadata row. Returns null when
  // presigning is unavailable (absent capability or no static credentials) so the route signals
  // "unsupported" and the client falls back to the buffered uploadSessionArtifact path.
  async presignSessionArtifactUpload(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactPresignUploadInput,
  ): Promise<{ artifactId: string, key: string, presigned: ObjectStorePresignedRequest } | null> {
    if (!this.objectStore.presignPut) return null
    await this.sessionService.getSessionView(principal, sessionId)
    const filename = boundedFilename(input.filename)
    const contentType = boundedContentType(input.contentType)
    // SEC-1: the minted PUT URL writes bytes STRAIGHT to the object store, bypassing the
    // pod, so this mint is the only enforcement point for the direct-transfer path. Run
    // the SAME assertBillingAllowed + daily-artifact-bytes quota check the buffered upload
    // runs (assertArtifactUploadAllowed) BEFORE handing out the URL — reserved speculatively
    // against the client-declared expected size; finalizeSessionArtifactUpload settles the
    // actual stored size, so steady-state accounting matches the buffered path. Without this
    // a canceled/over-quota tenant could mint URLs and upload directly, bypassing billing.
    await this.sessionService.assertArtifactUploadAllowed(principal, boundedExpectedSize(input.expectedSize))
    const artifactId = this.ids.randomUUID()
    const key = artifactObjectKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      filename,
    })
    const presigned = await this.objectStore.presignPut({ key, contentType, expiresSeconds: input.expiresSeconds })
    if (!presigned) return null
    return { artifactId, key, presigned }
  }

  // Record the artifact row after a presigned direct PUT has landed the bytes in object storage.
  // The object key is re-derived server-side from the (validated) artifact id + filename — the
  // client's reported key is never trusted. headObject confirms the PUT actually happened and
  // yields the authoritative stored size/content-type, which drives quota + usage attribution
  // exactly like the buffered path. A missing object throws 409 so the client can retry/fall back.
  async finalizeSessionArtifactUpload(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactFinalizeUploadInput,
  ): Promise<CloudArtifactRecord> {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = boundedArtifactId(input.artifactId)
    const createdAt = new Date().toISOString()
    const meta = resolveArtifactMetadataFields(input, createdAt)
    const key = artifactObjectKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      filename: meta.filename,
    })
    const head = await this.objectStore.headObject(key)
    if (!head) throw new CloudServiceError(409, 'Cloud artifact upload was not found in object storage.')
    if (head.size > MAX_ARTIFACT_BYTES) {
      await this.objectStore.deleteObject(key)
      throw new CloudServiceError(413, 'Artifact is too large.')
    }
    await this.sessionService.assertArtifactUploadAllowed(principal, head.size)
    return this.persistUploadedArtifact(principal, sessionId, {
      ...meta,
      contentType: meta.contentType ?? head.contentType ?? null,
      artifactId,
      size: head.size,
      key,
      createdAt,
    })
  }

  // Shared tail of both upload paths: build the canonical record, append the artifact.created
  // product event (the source of the session's artifact index), and attribute the uploaded bytes.
  private async persistUploadedArtifact(
    principal: CloudPrincipal,
    sessionId: string,
    fields: {
      artifactId: string
      filename: string
      contentType: string | null
      size: number
      key: string
      createdAt: string
      kind: ArtifactKind
      status: ArtifactStatus
      authorAgentId: string | null
      projectId: string | null
      taskId: string | null
      statusUpdatedBy: string | null
      statusUpdatedAt: string | null
    },
  ): Promise<CloudArtifactRecord> {
    const record: CloudArtifactRecord = {
      artifactId: fields.artifactId,
      sessionId,
      filename: fields.filename,
      contentType: fields.contentType,
      size: fields.size,
      key: fields.key,
      createdAt: fields.createdAt,
      updatedAt: fields.createdAt,
      kind: fields.kind,
      status: fields.status,
      authorAgentId: fields.authorAgentId,
      projectId: fields.projectId,
      taskId: fields.taskId,
      statusUpdatedBy: fields.statusUpdatedBy,
      statusUpdatedAt: fields.statusUpdatedAt,
    }
    await this.sessionService.appendProductEvent(principal, sessionId, {
      type: 'artifact.created',
      payload: record,
    })
    await this.sessionService.recordArtifactUploaded(principal, sessionId, fields.artifactId, fields.size)
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

  // SEC-2: the serialized origin (scheme://host[:port]) the object store's presigned PUT/GET
  // URLs target, so the served renderer's CSP connect-src can allow the browser shim's direct
  // F4 transfer to that cross-origin store. Derived by signing a throwaway probe key and
  // reading its URL origin (presigning is a local, side-effect-free computation; the probe
  // URL is never used). Returns null when the store cannot presign (buffered-only / no static
  // credentials) — the caller then leaves connect-src 'self'. Cached: the store config is fixed.
  async presignedUploadOrigin(): Promise<string | null> {
    if (this.cachedPresignedUploadOrigin !== undefined) return this.cachedPresignedUploadOrigin
    let origin: string | null = null
    if (this.objectStore.presignPut) {
      try {
        const probe = await this.objectStore.presignPut({ key: 'csp-origin-probe', contentType: null })
        origin = probe ? new URL(probe.url).origin : null
      } catch {
        origin = null
      }
    }
    this.cachedPresignedUploadOrigin = origin
    return origin
  }
}
