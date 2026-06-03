export type {
  CloudSessionCommandAckResponse,
  CloudSessionCommandMutationResponse,
  CloudClientCommandKind,
  CloudClientCommandStatus,
  CloudClientSessionStatus,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  CloudSessionView,
  ListSessionsInput,
  SessionListPage,
  SessionCommandRecord,
  SessionImportRequest,
  SessionProjectionRecord,
  SessionRecord,
} from '../contracts.js'

import type {
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  CloudSessionCommandAckResponse,
  CloudSessionCommandMutationResponse,
  CloudSessionView,
  ListSessionsInput,
  SessionImportRequest,
  SessionListPage,
  SessionRecord,
} from '../contracts.js'
import type { CloudDomainClientContext } from '../domains/shared.js'
import { encodePath, queryString } from '../domains/shared.js'

export type CloudSessionsClient = {
  listSessions(): Promise<SessionRecord[]>
  listSessionsPage(input?: ListSessionsInput): Promise<SessionListPage>
  createSession(input?: { profileName?: string | null; projectSource?: CloudProjectSourceInput | null }): Promise<CloudSessionView>
  validateProjectSource(input: CloudProjectSourceInput): Promise<CloudProjectSourcePolicyVerdict>
  uploadProjectSnapshot(input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult>
  importSession(input: SessionImportRequest): Promise<CloudSessionView>
  getSession(sessionId: string): Promise<CloudSessionView>
  promptSession(sessionId: string, input: { text: string, agent?: string | null }): Promise<CloudSessionCommandMutationResponse>
  abortSession(sessionId: string): Promise<CloudSessionCommandMutationResponse>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<CloudSessionCommandAckResponse>
  rejectQuestion(sessionId: string, input: { requestId: string }): Promise<CloudSessionCommandAckResponse>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<CloudSessionCommandAckResponse>
}

export function createCloudSessionsClient({ request }: CloudDomainClientContext): CloudSessionsClient {
  return {
    async listSessions() {
      return (await request<{ sessions: SessionRecord[] }>('/api/sessions')).sessions
    },
    listSessionsPage(input = {}) {
      return request<SessionListPage>(`/api/sessions${queryString({
        limit: input.limit,
        cursor: input.cursor,
        status: input.status,
        profileName: input.profileName,
        q: input.query,
      })}`)
    },
    createSession(input = {}) {
      return request<CloudSessionView>('/api/sessions', {
        method: 'POST',
        body: input,
      })
    },
    validateProjectSource(input) {
      return request<CloudProjectSourcePolicyVerdict>('/api/project-sources/validate', {
        method: 'POST',
        body: { projectSource: input },
      })
    },
    uploadProjectSnapshot(input) {
      return request<CloudProjectSnapshotUploadResult>('/api/project-sources/snapshots', {
        method: 'POST',
        body: input,
      })
    },
    importSession(input) {
      return request<CloudSessionView>('/api/import/sessions', {
        method: 'POST',
        body: input,
      })
    },
    getSession(sessionId) {
      return request<CloudSessionView>(`/api/sessions/${encodePath(sessionId)}`)
    },
    promptSession(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/prompt`, {
        method: 'POST',
        body: input,
      })
    },
    abortSession(sessionId) {
      return request(`/api/sessions/${encodePath(sessionId)}/abort`, {
        method: 'POST',
        body: {},
      })
    },
    replyToQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reply`, {
        method: 'POST',
        body: input,
      })
    },
    rejectQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reject`, {
        method: 'POST',
        body: input,
      })
    },
    respondToPermission(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/permission-respond`, {
        method: 'POST',
        body: input,
      })
    },
  }
}
