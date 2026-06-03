export type {
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
} from '../contracts.js'

import type {
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import {
  asRecord,
  encodePath,
  readNullableString,
  readNumber,
  readString,
} from './shared.js'

export type CloudArtifactsClient = {
  listArtifacts(sessionId: string): Promise<SessionArtifact[]>
  uploadArtifact(sessionId: string, input: Omit<SessionArtifactUploadRequest, 'sessionId' | 'workspaceId'>): Promise<SessionArtifact>
  readArtifactAttachment(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
}

function cloudArtifactFilePath(artifactId: string, filename: string) {
  return `cloud-artifact://${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}`
}

function cloudArtifactIdFromFilePath(filePath: string) {
  const match = /^cloud-artifact:\/\/([^/]+)/.exec(filePath)
  return match ? decodeURIComponent(match[1]) : null
}

function normalizeCloudArtifact(value: unknown, fallbackOrder = 0): SessionArtifact {
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
  }
}

function normalizeCloudArtifactAttachment(value: unknown): SessionArtifactAttachment {
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

export function createCloudArtifactsClient({ request }: CloudDomainClientContext): CloudArtifactsClient {
  return {
    async listArtifacts(sessionId) {
      return (await request<{ artifacts: unknown[] }>(`/api/sessions/${encodePath(sessionId)}/artifacts`))
        .artifacts
        .map((artifact, index) => normalizeCloudArtifact(artifact, index))
    },
    async uploadArtifact(sessionId, input) {
      return normalizeCloudArtifact((await request<{ artifact: unknown }>(`/api/sessions/${encodePath(sessionId)}/artifacts`, {
        method: 'POST',
        body: {
          filename: input.filename,
          contentType: input.contentType || null,
          dataBase64: input.dataBase64,
        },
      })).artifact)
    },
    async readArtifactAttachment(sessionId, filePathOrArtifactId) {
      const artifactId = cloudArtifactIdFromFilePath(filePathOrArtifactId) || filePathOrArtifactId.trim()
      if (!artifactId) throw new Error('Cloud artifact id is required.')
      return normalizeCloudArtifactAttachment(await request<{ artifact: unknown }>(
        `/api/sessions/${encodePath(sessionId)}/artifacts/${encodePath(artifactId)}`,
      ))
    },
  }
}
