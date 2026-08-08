import { createHash, randomUUID } from 'node:crypto'
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
import type {
  ArtifactUploadReservationRecord,
  CloudArtifactIndexRecord,
} from './control-plane-store.ts'
import type { CloudArtifactDirectUploadConfig } from './artifact-direct-upload-config.ts'
import { ArtifactUploadLifecycle } from './artifact-upload-lifecycle.ts'
import type {
  ObjectStoreAdapter,
  ObjectStorePresignedPostRequest,
  ObjectStorePresignedRequest,
  ObjectStorePresignedUploadCapability,
} from './object-store.ts'
import { artifactObjectKey } from './object-store.ts'
import { recordCloudMetric, type CloudObservabilityAdapter } from './observability.ts'
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
  artifactId: string
  filename: string
  contentType?: string | null
  checksumSha256: string
  expiresSeconds?: number
  expectedSize?: number
  kind?: ArtifactKind | null
  status?: ArtifactStatus | null
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
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
const MAX_ARTIFACT_INDEX_LIMIT = 500
const MAX_SESSION_ARTIFACT_INDEX_LIMIT = 500
const DIRECT_UPLOAD_CREDENTIAL_TTL_SECONDS = 15 * 60
const DIRECT_UPLOAD_RESERVATION_GRACE_MS = 30_000
const DIRECT_UPLOAD_CLAIM_TTL_MS = 30_000

export type CloudArtifactDirectUploadOptions = {
  config: CloudArtifactDirectUploadConfig
  lifecycle: ArtifactUploadLifecycle
  finalizationAvailable?: boolean
  browserOrigin: string | null
  claimOwner: string
  claimTtlMs?: number
  now?: () => Date
  observability?: CloudObservabilityAdapter | null
  cleanupOwnerReady?: () => boolean | Promise<boolean>
}

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
// reservation (SEC-1). Direct upload requires a positive exact size so quota cannot fall
// back to a token reservation smaller than the bytes accepted by object storage.
function boundedExpectedSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new CloudServiceError(400, 'Artifact expectedSize is invalid.')
  }
  if (value > MAX_ARTIFACT_BYTES) throw new CloudServiceError(413, 'Artifact is too large.')
  return value
}

function boundedChecksumSha256(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CloudServiceError(400, 'Artifact checksumSha256 is invalid.')
  }
  return value
}

function canonicalHttpOrigin(value: unknown) {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) return null
    return url.origin
  } catch {
    return null
  }
}

function directUploadOriginsCompatible(providerOrigin: string, browserOrigin: string) {
  const provider = canonicalHttpOrigin(providerOrigin)
  const browser = canonicalHttpOrigin(browserOrigin)
  return Boolean(provider && browser && (!browser.startsWith('https:') || provider.startsWith('https:')))
}

function validPresignedPostFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 64) return false
  let totalBytes = 0
  for (const [key, fieldValue] of entries) {
    if (!key || key.length > 256 || typeof fieldValue !== 'string' || fieldValue.length > 16_384) return false
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(fieldValue, 'utf8')
  }
  return totalBytes <= 64 * 1024
}

function sizeEnforcedPresignedUpload(
  objectStore: ObjectStoreAdapter,
): ObjectStorePresignedUploadCapability | null {
  const capability = objectStore.presignedUpload
  if (
    !capability
    || capability.enforcement !== 'exact-content-length'
    || !Number.isSafeInteger(capability.maxBytes)
    || capability.maxBytes <= 0
    || !canonicalHttpOrigin(capability.origin)
    || typeof capability.verifyCleanupSafety !== 'function'
    || typeof capability.verifyBrowserPostSafety !== 'function'
    || typeof capability.presignPost !== 'function'
    || typeof capability.inspect !== 'function'
    || typeof capability.promote !== 'function'
    || typeof capability.delete !== 'function'
  ) {
    return null
  }
  return capability
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    throw new CloudServiceError(400, 'Artifact id is invalid.')
  }
  return trimmed.toLowerCase()
}

function opaqueDirectUploadKey(input: {
  tenantId: string
  sessionId: string
  artifactId: string
  stage: 'staging' | 'final'
}) {
  const digest = createHash('sha256')
    .update('open-cowork-direct-upload-v1')
    .update('\0')
    .update(input.tenantId)
    .update('\0')
    .update(input.sessionId)
    .update('\0')
    .update(input.artifactId)
    .digest('hex')
  return `artifact-uploads/${input.stage}/${digest}`
}

function directUploadLifecycleAvailable(
  objectStore: ObjectStoreAdapter,
  options: CloudArtifactDirectUploadOptions | null,
) {
  if (
    !options
    || options.finalizationAvailable === false
    || options.lifecycle.capability.persistence !== 'durable'
    || options.lifecycle.capability.reconciliation !== 'bounded-claims'
  ) return null
  return objectStore.directUploadLifecycle || objectStore.presignedUpload || null
}

function directUploadIssuanceAvailable(
  objectStore: ObjectStoreAdapter,
  options: CloudArtifactDirectUploadOptions | null,
) {
  const lifecycle = directUploadLifecycleAvailable(objectStore, options)
  const capability = sizeEnforcedPresignedUpload(objectStore)
  if (
    !lifecycle
    || !capability
    || !options
    || options.config.mode !== 'enabled'
    || options.config.configStatus !== 'valid'
    || !options.browserOrigin
    || !directUploadOriginsCompatible(capability.origin, options.browserOrigin)
  ) return null
  return capability
}

function directUploadCredentialSeconds(
  reservation: ArtifactUploadReservationRecord,
  now: Date,
) {
  const remainingMs = Date.parse(reservation.expiresAt) - now.getTime() - DIRECT_UPLOAD_RESERVATION_GRACE_MS
  if (!Number.isFinite(remainingMs) || remainingMs < 1_000) return 0
  return Math.min(DIRECT_UPLOAD_CREDENTIAL_TTL_SECONDS, Math.floor(remainingMs / 1_000))
}

// Validate + normalize the artifact metadata both upload paths persist, so the buffered upload
// and the presigned finalize agree on bounds and on the derived defaults (kind/status/statusUpdatedAt).
function resolveArtifactMetadataFields(
  input: CloudArtifactMetadataInput,
  createdAt: string,
  options: { deriveStatusTimestamp?: boolean } = {},
) {
  const filename = boundedFilename(input.filename)
  const contentType = boundedContentType(input.contentType)
  const kind = boundedKind(input.kind, inferArtifactKind({ filename, mime: contentType }))
  const status = boundedStatus(input.status, defaultArtifactStatusForKind(kind))
  const authorAgentId = boundedNullableString(input.authorAgentId, 'Author agent id')
  const projectId = boundedNullableString(input.projectId, 'Project id')
  const taskId = boundedNullableString(input.taskId, 'Task id')
  const statusUpdatedBy = boundedNullableString(input.statusUpdatedBy, 'Status updated by')
  const explicitStatusUpdatedAt = boundedNullableIsoDate(input.statusUpdatedAt, 'Status updated at')
  const statusUpdatedAt = explicitStatusUpdatedAt
    ?? (options.deriveStatusTimestamp === false
      ? null
      : (input.status || input.statusUpdatedBy) ? createdAt : null)
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

export function validateCloudArtifactUploadInput(input: unknown, createdAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CloudServiceError(400, 'Artifact upload must be an object.')
  }
  const upload = input as CloudArtifactUploadInput
  return {
    meta: resolveArtifactMetadataFields(upload, createdAt),
    body: decodeBase64(upload.dataBase64),
  }
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

function artifactRecordFromIndex(record: CloudArtifactIndexRecord): CloudArtifactRecord {
  return {
    artifactId: record.artifactId,
    sessionId: record.sessionId,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    key: record.key,
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
  private readonly directUpload: CloudArtifactDirectUploadOptions | null

  constructor(
    sessionService: CloudSessionService,
    objectStore: ObjectStoreAdapter,
    ids: { randomUUID: () => string } = { randomUUID },
    options: { directUpload?: CloudArtifactDirectUploadOptions | null } = {},
  ) {
    this.sessionService = sessionService
    this.objectStore = objectStore
    this.ids = ids
    this.directUpload = options.directUpload || null
  }

  async uploadSessionArtifact(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactUploadInput,
  ): Promise<CloudArtifactRecord> {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = this.ids.randomUUID()
    const createdAt = new Date().toISOString()
    const { meta, body } = validateCloudArtifactUploadInput(input, createdAt)
    await this.sessionService.domains.usage.assertArtifactUploadAllowed(principal, body.byteLength)
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

  // Authenticate first, then bind one client idempotency key to durable quota, metadata,
  // opaque staging/final keys, checksum, and expiry before any credentials can escape.
  async presignSessionArtifactUpload(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactPresignUploadInput,
  ): Promise<{ artifactId: string, presigned: ObjectStorePresignedPostRequest } | null> {
    await this.sessionService.getSessionView(principal, sessionId)
    const uploadCapability = directUploadIssuanceAvailable(this.objectStore, this.directUpload)
    if (!uploadCapability || !this.directUpload) return null
    if (this.directUpload.cleanupOwnerReady && !await this.directUpload.cleanupOwnerReady()) return null
    const now = this.directUpload.now?.() || new Date()
    const artifactId = boundedArtifactId(input.artifactId)
    // Reservation rows are eventually pruned, but a published artifact identity remains
    // durable. Never let a later begin reuse its deterministic keys, event id, or usage id.
    if (await this.findSessionArtifact(principal, sessionId, artifactId)) {
      throw new CloudServiceError(409, 'Cloud artifact identity is already published.')
    }
    const checksumSha256 = boundedChecksumSha256(input.checksumSha256)
    const replay = await this.sessionService.domains.usage.getArtifactUploadReservation(principal, {
      sessionId,
      artifactId,
    })
    const meta = resolveArtifactMetadataFields(input, replay?.createdAt || now.toISOString())
    const expectedBytes = boundedExpectedSize(input.expectedSize)
    if (expectedBytes > uploadCapability.maxBytes) throw new CloudServiceError(413, 'Artifact is too large.')
    const stagingObjectKey = opaqueDirectUploadKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      stage: 'staging',
    })
    const finalObjectKey = opaqueDirectUploadKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      stage: 'final',
    })
    const requestedCredentialSeconds = Math.min(
      DIRECT_UPLOAD_CREDENTIAL_TTL_SECONDS,
      Math.max(1, Math.floor(input.expiresSeconds || DIRECT_UPLOAD_CREDENTIAL_TTL_SECONDS)),
    )
    const reservation = await this.sessionService.domains.usage.reserveArtifactUploadQuota(principal, {
      sessionId,
      artifactId,
      objectKey: finalObjectKey,
      stagingObjectKey,
      finalObjectKey,
      filename: meta.filename,
      contentType: meta.contentType,
      checksumSha256,
      expectedBytes,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + requestedCredentialSeconds * 1_000 + DIRECT_UPLOAD_RESERVATION_GRACE_MS,
      ).toISOString(),
      publication: {
        kind: meta.kind,
        artifactStatus: meta.status,
        authorAgentId: meta.authorAgentId,
        projectId: meta.projectId,
        taskId: meta.taskId,
        statusUpdatedBy: meta.statusUpdatedBy,
        statusUpdatedAt: meta.statusUpdatedAt,
      },
    })
    if (reservation.status !== 'reserved') {
      throw new CloudServiceError(409, `Cloud artifact upload reservation is ${reservation.status}.`)
    }
    const credentialSeconds = directUploadCredentialSeconds(reservation, this.directUpload.now?.() || new Date())
    if (credentialSeconds <= 0) {
      await this.abortDirectUpload(principal, sessionId, artifactId)
      await this.recordDirectUploadOutcome('expired')
      throw new CloudServiceError(409, 'Cloud artifact upload reservation expired.')
    }
    try {
      const presigned = await uploadCapability.presignPost({
        key: reservation.stagingObjectKey,
        contentType: reservation.contentType,
        expectedSize: reservation.reservedBytes,
        checksumSha256: reservation.checksumSha256 || '',
        browserOrigin: this.directUpload.browserOrigin!,
        expiresSeconds: credentialSeconds,
      })
      if (
        !presigned
        || presigned.method !== 'POST'
        || !validPresignedPostFields(presigned.fields)
      ) {
        throw new Error('Direct-upload provider returned an invalid credential contract.')
      }
      const credentialExpiresAtMs = Date.parse(presigned.expiresAt)
      const reservationCredentialLimitMs = Date.parse(reservation.expiresAt) - DIRECT_UPLOAD_RESERVATION_GRACE_MS
      const presignedUrl = new URL(presigned.url)
      if (
        !Number.isFinite(credentialExpiresAtMs)
        || credentialExpiresAtMs <= (this.directUpload.now?.() || new Date()).getTime()
        || credentialExpiresAtMs > reservationCredentialLimitMs
        || presignedUrl.username
        || presignedUrl.password
        || presignedUrl.origin !== canonicalHttpOrigin(uploadCapability.origin)
      ) {
        throw new Error('Direct-upload provider returned an invalid credential contract.')
      }
      await this.recordDirectUploadOutcome('reserved')
      return { artifactId, presigned }
    } catch {
      await this.abortDirectUpload(principal, sessionId, artifactId)
      await this.recordDirectUploadOutcome('rejected')
      throw new CloudServiceError(503, 'Cloud artifact direct upload is temporarily unavailable.')
    }
  }

  async finalizeSessionArtifactUpload(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactFinalizeUploadInput,
  ): Promise<CloudArtifactRecord> {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = boundedArtifactId(input.artifactId)
    const uploadCapability = directUploadLifecycleAvailable(this.objectStore, this.directUpload)
    if (!uploadCapability || !this.directUpload) {
      throw new CloudServiceError(409, 'Cloud artifact direct upload is not enabled.')
    }
    const issuanceAvailable = sizeEnforcedPresignedUpload(this.objectStore) !== null
    const cleanupSafe = issuanceAvailable
      && this.directUpload.config.mode === 'enabled'
      && this.directUpload.cleanupOwnerReady
      ? await this.directUpload.cleanupOwnerReady()
      : await uploadCapability.verifyCleanupSafety()
    if (!cleanupSafe) {
      throw new CloudServiceError(503, 'Cloud artifact upload cleanup safety is not attested.')
    }
    const reservation = await this.sessionService.domains.usage.getArtifactUploadReservation(principal, { sessionId, artifactId })
    if (!reservation) throw new CloudServiceError(409, 'Cloud artifact upload reservation was not found.')
    const requested = resolveArtifactMetadataFields(input, reservation.createdAt)
    if (!this.directUploadMetadataMatches(requested, reservation)) {
      await this.abortDirectUpload(principal, sessionId, artifactId)
      await this.recordDirectUploadOutcome('rejected')
      throw new CloudServiceError(409, 'Cloud artifact upload metadata does not match its reservation.')
    }
    let result: Awaited<ReturnType<ArtifactUploadLifecycle['finalize']>>
    try {
      result = await this.directUpload.lifecycle.finalize({
        orgId: reservation.orgId,
        tenantId: reservation.tenantId,
        sessionId,
        artifactId,
        claimOwner: this.directUpload.claimOwner,
        claimTtlMs: this.directUpload.claimTtlMs || DIRECT_UPLOAD_CLAIM_TTL_MS,
      })
    } catch {
      await this.recordDirectUploadOutcome('cleanup_failed')
      throw new CloudServiceError(503, 'Cloud artifact upload finalization is temporarily unavailable.')
    }
    if (result.outcome !== 'finalized' && result.outcome !== 'already_finalized') {
      await this.recordDirectUploadOutcome(result.outcome === 'rejected' ? 'rejected' : 'cleanup_failed')
      throw new CloudServiceError(409, 'Cloud artifact upload is not ready to finalize.')
    }
    const finalized = result.reservation || reservation
    const published = await this.findSessionArtifact(principal, sessionId, artifactId)
      || await this.sessionService.publishFinalizedArtifactUpload(finalized)
    await this.recordDirectUploadOutcome('finalized')
    this.sessionService.auditPrincipalAction(principal, {
      eventType: 'artifact.uploaded',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { sessionId, size: finalized.reservedBytes, mode: 'direct' },
    })
    return published
  }

  async abortSessionArtifactUpload(
    principal: CloudPrincipal,
    sessionId: string,
    artifactIdInput: string,
  ) {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = boundedArtifactId(artifactIdInput)
    const result = await this.abortDirectUpload(principal, sessionId, artifactId)
    if (result) {
      await this.recordDirectUploadOutcome(
        result.outcome === 'cleaned' || result.outcome === 'cleanup_pending' ? 'aborted' : 'cleanup_failed',
      )
    }
    return result
  }

  private async abortDirectUpload(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
  ) {
    if (!this.directUpload) return null
    const reservation = await this.sessionService.domains.usage.getArtifactUploadReservation(principal, {
      sessionId,
      artifactId,
    })
    if (!reservation) return null
    return this.directUpload.lifecycle.abort({
      orgId: reservation.orgId,
      tenantId: reservation.tenantId,
      sessionId,
      artifactId,
      claimOwner: this.directUpload.claimOwner,
      claimTtlMs: this.directUpload.claimTtlMs || DIRECT_UPLOAD_CLAIM_TTL_MS,
    })
  }

  private directUploadMetadataMatches(
    requested: ReturnType<typeof resolveArtifactMetadataFields>,
    reservation: ArtifactUploadReservationRecord,
  ) {
    return requested.filename === reservation.filename
      && requested.contentType === reservation.contentType
      && requested.kind === reservation.publication.kind
      && requested.status === reservation.publication.artifactStatus
      && requested.authorAgentId === reservation.publication.authorAgentId
      && requested.projectId === reservation.publication.projectId
      && requested.taskId === reservation.publication.taskId
      && requested.statusUpdatedBy === reservation.publication.statusUpdatedBy
      && requested.statusUpdatedAt === reservation.publication.statusUpdatedAt
  }

  private recordDirectUploadOutcome(
    outcome: 'reserved' | 'finalized' | 'aborted' | 'expired' | 'rejected' | 'cleanup_failed',
  ) {
    return recordCloudMetric(this.directUpload?.observability, {
      name: 'open_cowork_cloud_artifact_direct_upload_outcomes_total',
      value: 1,
      unit: '1',
      attributes: { upload_outcome: outcome },
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
    await this.sessionService.domains.usage.appendProductEvent(principal, sessionId, {
      eventId: `${sessionId}:artifact.created:${fields.artifactId}`,
      type: 'artifact.created',
      payload: record,
    })
    await this.sessionService.upsertCloudArtifactIndex(principal, record)
    await this.sessionService.domains.usage.recordArtifactUploaded(principal, sessionId, fields.artifactId, fields.size)
    this.sessionService.auditPrincipalAction(principal, {
      eventType: 'artifact.uploaded',
      targetType: 'artifact',
      targetId: fields.artifactId,
      metadata: { sessionId, size: fields.size, contentType: fields.contentType, kind: fields.kind },
    })
    return record
  }

  async listSessionArtifacts(principal: CloudPrincipal, sessionId: string): Promise<CloudArtifactRecord[]> {
    const indexed = await this.sessionService.listCloudArtifactIndex(principal, {
      sessionId,
      limit: MAX_SESSION_ARTIFACT_INDEX_LIMIT,
    })
    if (indexed.items.length > 0 || indexed.truncated) {
      return indexed.items.map(artifactRecordFromIndex)
    }
    return this.rebuildSessionArtifactIndex(principal, sessionId)
  }

  private async rebuildSessionArtifactIndex(principal: CloudPrincipal, sessionId: string): Promise<CloudArtifactRecord[]> {
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
    const records = Array.from(artifacts.values())
    for (const record of records) {
      await this.sessionService.upsertCloudArtifactIndex(principal, record)
    }
    return records
  }

  async listPublicSessionArtifacts(principal: CloudPrincipal, sessionId: string): Promise<Array<ReturnType<typeof publicArtifactRecord>>> {
    const artifacts = await this.listSessionArtifacts(principal, sessionId)
    return artifacts.map((artifact, index) => publicArtifactRecord(artifact, {
      order: index,
      workspaceId: `cloud:${principal.tenantId}`,
    }))
  }

  async listArtifactIndex(principal: CloudPrincipal, request: ArtifactIndexRequest = {}): Promise<ArtifactIndexPayload> {
    const limit = Math.min(Math.max(Math.floor(Number(request.limit) || 100), 1), MAX_ARTIFACT_INDEX_LIMIT)
    if (request.sessionId) {
      const records = await this.listSessionArtifacts(principal, request.sessionId)
      const artifacts = records
        .map((record, index) => publicArtifactRecord(record, {
          order: index,
          workspaceId: `cloud:${principal.tenantId}`,
        }))
        .filter((entry) => artifactMatchesIndexRequest(entry, request))
        .sort((left, right) => artifactUpdatedMs(right) - artifactUpdatedMs(left))
        .slice(0, limit)
      return { artifacts, total: artifacts.length, scannedSessions: 1, truncated: records.length > artifacts.length }
    }

    const page = await this.sessionService.listCloudArtifactIndex(principal, {
      sessionId: request.sessionId,
      projectId: request.projectId,
      taskId: request.taskId,
      taskIds: request.taskIds,
      status: request.status,
      kind: request.kind,
      limit,
    })
    const artifacts = page.items.map((record, index) => publicArtifactRecord(artifactRecordFromIndex(record), {
      order: index,
      sessionTitle: record.sessionTitle,
      workspaceId: `cloud:${principal.tenantId}`,
    }))
    return {
      artifacts,
      total: page.totalEstimate,
      scannedSessions: 0,
      truncated: page.truncated,
    }
  }

  private async findSessionArtifact(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
  ): Promise<CloudArtifactRecord | null> {
    const indexed = await this.sessionService.getCloudArtifactIndexRecord(principal, sessionId, artifactId)
    if (indexed) return artifactRecordFromIndex(indexed)
    return (await this.rebuildSessionArtifactIndex(principal, sessionId))
      .find((entry) => entry.artifactId === artifactId) || null
  }

  async updateSessionArtifactStatus(
    principal: CloudPrincipal,
    sessionId: string,
    artifactId: string,
    input: Pick<ArtifactStatusUpdateRequest, 'status' | 'updatedBy' | 'authorAgentId' | 'projectId' | 'taskId' | 'kind'>,
  ): Promise<CloudArtifactRecord> {
    const existing = await this.findSessionArtifact(principal, sessionId, artifactId)
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
    await this.sessionService.domains.usage.appendProductEvent(principal, sessionId, {
      type: 'artifact.updated',
      payload: { ...publicArtifactRecord(next) },
    })
    await this.sessionService.upsertCloudArtifactIndex(principal, next)
    return next
  }

  async readSessionArtifact(principal: CloudPrincipal, sessionId: string, artifactId: string) {
    const artifact = await this.findSessionArtifact(principal, sessionId, artifactId)
    if (!artifact) throw new CloudServiceError(404, 'Cloud artifact was not found.')
    const object = await this.objectStore.getObject(artifact.key)
    if (!object) throw new CloudServiceError(404, 'Cloud artifact object was not found.')
    await this.sessionService.domains.usage.recordArtifactDownloaded(principal, sessionId, artifactId, object.body.byteLength)
    this.sessionService.auditPrincipalAction(principal, {
      eventType: 'artifact.downloaded',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { sessionId, size: object.body.byteLength, mode: 'buffered' },
    })
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
    const artifact = await this.findSessionArtifact(principal, sessionId, artifactId)
    if (!artifact) throw new CloudServiceError(404, 'Cloud artifact was not found.')
    const presigned = await this.objectStore.presignGet(artifact.key, options)
    if (!presigned) return null
    await this.sessionService.domains.usage.recordArtifactDownloaded(principal, sessionId, artifactId, artifact.size)
    this.sessionService.auditPrincipalAction(principal, {
      eventType: 'artifact.downloaded',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { sessionId, size: artifact.size, mode: 'presigned' },
    })
    return { artifact, presigned }
  }

  publicArtifact(record: CloudArtifactRecord, order = 0) {
    return publicArtifactRecord(record, {
      order,
    })
  }

  // Read the provider's fixed origin without minting a throwaway credential. The origin is
  // advertised only when the complete durable direct-upload contract is enabled and its
  // cleanup owner is currently ready. Readiness is intentionally re-evaluated: caching a
  // transient false result would permanently disable the browser path after startup.
  async presignedUploadOrigin(): Promise<string | null> {
    let origin: string | null = null
    const uploadCapability = directUploadIssuanceAvailable(this.objectStore, this.directUpload)
    if (uploadCapability && this.directUpload?.browserOrigin) {
      try {
        const cleanupReady = !this.directUpload?.cleanupOwnerReady
          || await this.directUpload.cleanupOwnerReady()
        origin = cleanupReady ? new URL(uploadCapability.origin).origin : null
      } catch {
        origin = null
      }
    }
    return origin
  }
}
