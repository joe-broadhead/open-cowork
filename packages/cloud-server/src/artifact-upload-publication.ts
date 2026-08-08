import { isArtifactKind, isArtifactStatus } from '@open-cowork/shared'
import type { ArtifactUploadPublicationMetadata } from './control-plane-usage-records.ts'

const EMPTY_PUBLICATION: ArtifactUploadPublicationMetadata = Object.freeze({
  kind: 'draft',
  artifactStatus: 'draft',
  authorAgentId: null,
  projectId: null,
  taskId: null,
  statusUpdatedBy: null,
  statusUpdatedAt: null,
})

export function normalizeArtifactUploadPublicationMetadata(
  value: ArtifactUploadPublicationMetadata | null | undefined,
): ArtifactUploadPublicationMetadata {
  if (!value || Object.keys(value).length === 0) return { ...EMPTY_PUBLICATION }
  if (!isArtifactKind(value.kind) || !isArtifactStatus(value.artifactStatus)) {
    throw new Error('Artifact upload publication metadata is invalid.')
  }
  return {
    kind: value.kind,
    artifactStatus: value.artifactStatus,
    authorAgentId: boundedNullableString(value.authorAgentId),
    projectId: boundedNullableString(value.projectId),
    taskId: boundedNullableString(value.taskId),
    statusUpdatedBy: boundedNullableString(value.statusUpdatedBy),
    statusUpdatedAt: boundedNullableDate(value.statusUpdatedAt),
  }
}

export function artifactUploadPublicationMetadataEqual(
  left: ArtifactUploadPublicationMetadata,
  right: ArtifactUploadPublicationMetadata,
) {
  return left.kind === right.kind
    && left.artifactStatus === right.artifactStatus
    && left.authorAgentId === right.authorAgentId
    && left.projectId === right.projectId
    && left.taskId === right.taskId
    && left.statusUpdatedBy === right.statusUpdatedBy
    && left.statusUpdatedAt === right.statusUpdatedAt
}

function boundedNullableString(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Artifact upload publication metadata is invalid.')
  const normalized = value.trim()
  if (!normalized) return null
  if (Buffer.byteLength(normalized, 'utf8') > 512) {
    throw new Error('Artifact upload publication metadata is invalid.')
  }
  return normalized
}

function boundedNullableDate(value: unknown) {
  const normalized = boundedNullableString(value)
  if (!normalized) return null
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
  if (!isoLike.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error('Artifact upload publication metadata is invalid.')
  }
  return normalized
}
