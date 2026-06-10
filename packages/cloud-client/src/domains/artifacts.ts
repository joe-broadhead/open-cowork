export type {
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
} from '../contracts.js'

import type {
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
} from '../contracts.js'
import {
  cloudArtifactIdFromFilePath,
  normalizeCloudArtifact,
  normalizeCloudArtifactAttachment,
  normalizeCloudArtifactIndexEntry,
} from './artifact-normalizers.js'
import type { CloudDomainClientContext } from './shared.js'
import {
  encodePath,
  queryString,
  readNumber,
} from './shared.js'

export type CloudArtifactsClient = {
  listArtifacts(sessionId: string): Promise<SessionArtifact[]>
  indexArtifacts(query?: ArtifactIndexRequest): Promise<ArtifactIndexPayload>
  updateArtifactStatus(input: ArtifactStatusUpdateRequest): Promise<SessionArtifact>
  uploadArtifact(sessionId: string, input: Omit<SessionArtifactUploadRequest, 'sessionId' | 'workspaceId'>): Promise<SessionArtifact>
  readArtifactAttachment(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
}

export function createCloudArtifactsClient({ request }: CloudDomainClientContext): CloudArtifactsClient {
  return {
    async listArtifacts(sessionId) {
      return (await request<{ artifacts: unknown[] }>(`/api/sessions/${encodePath(sessionId)}/artifacts`))
        .artifacts
        .map((artifact, index) => normalizeCloudArtifact(artifact, index))
    },
    async indexArtifacts(query = {}) {
      const payload = await request<{ artifacts: unknown[], total?: number, scannedSessions?: number, truncated?: boolean }>(`/api/artifacts${queryString({
        sessionId: query.sessionId || undefined,
        projectId: query.projectId || undefined,
        taskId: query.taskId || undefined,
        taskIds: query.taskIds || undefined,
        kind: query.kind || undefined,
        status: query.status || undefined,
        limit: query.limit || undefined,
      })}`)
      const artifacts = (payload.artifacts || []).map((artifact, index) => normalizeCloudArtifactIndexEntry(artifact, index))
      return {
        artifacts,
        total: readNumber(payload.total, artifacts.length),
        scannedSessions: readNumber(payload.scannedSessions, 0) || undefined,
        truncated: payload.truncated === true,
      }
    },
    async updateArtifactStatus(input) {
      return normalizeCloudArtifact((await request<{ artifact: unknown }>(
        `/api/sessions/${encodePath(input.sessionId)}/artifacts/${encodePath(input.artifactId)}/status`,
        {
          method: 'POST',
          body: {
            status: input.status,
            updatedBy: input.updatedBy || null,
            authorAgentId: input.authorAgentId || null,
            projectId: input.projectId || null,
            taskId: input.taskId || null,
            kind: input.kind || null,
          },
        },
      )).artifact)
    },
    async uploadArtifact(sessionId, input) {
      return normalizeCloudArtifact((await request<{ artifact: unknown }>(`/api/sessions/${encodePath(sessionId)}/artifacts`, {
        method: 'POST',
        body: {
          filename: input.filename,
          contentType: input.contentType || null,
          dataBase64: input.dataBase64,
          kind: input.kind || null,
          status: input.status || null,
          authorAgentId: input.authorAgentId || null,
          projectId: input.projectId || null,
          taskId: input.taskId || null,
          statusUpdatedBy: input.statusUpdatedBy || null,
          statusUpdatedAt: input.statusUpdatedAt || null,
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
