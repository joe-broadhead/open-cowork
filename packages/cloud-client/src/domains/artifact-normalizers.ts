import type {
  ArtifactIndexEntry,
  SessionArtifact,
  SessionArtifactAttachment,
} from '../contracts.js'
import {
  asRecord,
  readNullableString,
  readNumber,
  readString,
} from './shared.js'

function cloudArtifactFilePath(artifactId: string, filename: string) {
  return `cloud-artifact://${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}`
}

export function cloudArtifactIdFromFilePath(filePath: string) {
  const match = /^cloud-artifact:\/\/([^/]+)/.exec(filePath)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export function normalizeCloudArtifact(value: unknown, fallbackOrder = 0): SessionArtifact {
  const record = asRecord(value)
  const artifactId = readString(record.artifactId, readString(record.cloudArtifactId, readString(record.id)))
  const filename = readString(record.filename, 'artifact')
  return {
    id: artifactId,
    toolId: readString(record.toolId, 'cloud-artifact'),
    toolName: readString(record.toolName, 'cloud.artifact'),
    filePath: readString(record.filePath, cloudArtifactFilePath(artifactId, filename)),
    filename,
    order: readNumber(record.order, fallbackOrder),
    source: 'cloud',
    cloudArtifactId: artifactId,
    taskRunId: readNullableString(record.taskRunId),
    mime: readNullableString(record.mime) || readNullableString(record.contentType) || undefined,
    size: readNumber(record.size),
    createdAt: readNullableString(record.createdAt) || undefined,
    updatedAt: readNullableString(record.updatedAt) || undefined,
    kind: readNullableString(record.kind) as SessionArtifact['kind'] || undefined,
    status: readNullableString(record.status) as SessionArtifact['status'] || undefined,
    authorAgentId: readNullableString(record.authorAgentId),
    projectId: readNullableString(record.projectId),
    taskId: readNullableString(record.taskId),
    statusUpdatedBy: readNullableString(record.statusUpdatedBy),
    statusUpdatedAt: readNullableString(record.statusUpdatedAt),
  }
}

export function normalizeCloudArtifactIndexEntry(value: unknown, fallbackOrder = 0): ArtifactIndexEntry {
  const record = asRecord(value)
  return {
    ...normalizeCloudArtifact(record, fallbackOrder),
    sessionId: readString(record.sessionId),
    sessionTitle: readNullableString(record.sessionTitle),
    workspaceId: readNullableString(record.workspaceId),
  }
}

export function normalizeCloudArtifactAttachment(value: unknown): SessionArtifactAttachment {
  const record = asRecord(value)
  const artifact = asRecord(record.artifact || record)
  const mime = readNullableString(artifact.contentType) || readNullableString(artifact.mime) || 'application/octet-stream'
  const dataBase64 = readString(artifact.dataBase64)
  return {
    mime,
    url: `data:${mime};base64,${dataBase64}`,
    filename: readString(artifact.filename, 'artifact'),
  }
}
