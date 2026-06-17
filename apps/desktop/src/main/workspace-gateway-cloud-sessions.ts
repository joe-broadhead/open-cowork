import type { IpcMainInvokeEvent } from 'electron'
import type {
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  SessionImportRequest,
  SessionImportResult,
  SessionInfo,
  SessionView,
} from '@open-cowork/shared'
import type { CloudPromptInput, CloudWorkspaceSessionAdapter } from './cloud-workspace-adapter.ts'

type WorkspaceEventLike = Pick<IpcMainInvokeEvent, 'sender'> | null | undefined

export type ResolveCloudAdapter = (
  event: WorkspaceEventLike,
  workspaceIdInput?: string | null,
) => Promise<CloudWorkspaceSessionAdapter>

export type ResolveCloudWorkspaceAndAdapter = (
  event: WorkspaceEventLike,
  workspaceIdInput?: string | null,
) => Promise<{ workspaceId: string; adapter: CloudWorkspaceSessionAdapter }>

export type CloudSessionGatewayContext = {
  resolveAdapter: ResolveCloudAdapter
  resolveWorkspaceAndAdapter: ResolveCloudWorkspaceAndAdapter
  onSessionImported: (workspaceId: string, syncedAt: string) => void
}

export function createCloudSessionGateway(context: CloudSessionGatewayContext) {
  const { resolveAdapter, resolveWorkspaceAndAdapter, onSessionImported } = context
  return {
    async listSessions(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<SessionInfo[]> {
      return (await resolveAdapter(event, workspaceIdInput)).listSessions()
    },

    async createSession(
      event: WorkspaceEventLike,
      workspaceIdInput?: string | null,
      input: { projectSource?: CloudProjectSourceInput | null } = {},
    ): Promise<SessionInfo> {
      return (await resolveAdapter(event, workspaceIdInput)).createSession(input)
    },

    async validateProjectSource(
      event: WorkspaceEventLike,
      workspaceIdInput: string | null | undefined,
      projectSource: CloudProjectSourceInput,
    ): Promise<CloudProjectSourcePolicyVerdict> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.validateProjectSource) {
        return { allowed: false, reason: 'Cloud workspace does not support project source validation.' }
      }
      return adapter.validateProjectSource(projectSource)
    },

    async uploadProjectSnapshot(
      event: WorkspaceEventLike,
      workspaceIdInput: string | null | undefined,
      input: CloudProjectSnapshotUploadInput,
    ): Promise<CloudProjectSnapshotUploadResult> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.uploadProjectSnapshot) {
        throw new Error('Cloud workspace does not support project snapshot uploads.')
      }
      return adapter.uploadProjectSnapshot(input)
    },

    async importSession(
      event: WorkspaceEventLike,
      input: SessionImportRequest,
      workspaceIdInput: string,
    ): Promise<SessionImportResult & { view: SessionView }> {
      const { workspaceId, adapter } = await resolveWorkspaceAndAdapter(event, workspaceIdInput)
      const imported = await adapter.importSession(input)
      const syncedAt = new Date().toISOString()
      onSessionImported(workspaceId, syncedAt)
      return {
        workspaceId,
        sessionId: imported.session.id,
        title: imported.session.title || input.title,
        importedAt: imported.session.createdAt,
        itemCounts: input.itemCounts,
        view: imported.view,
      }
    },

    async getSessionInfo(
      event: WorkspaceEventLike,
      sessionId: string,
      workspaceIdInput?: string | null,
    ): Promise<SessionInfo | null> {
      return (await resolveAdapter(event, workspaceIdInput)).getSessionInfo(sessionId)
    },

    async getSessionView(
      event: WorkspaceEventLike,
      sessionId: string,
      workspaceIdInput?: string | null,
    ): Promise<SessionView> {
      return (await resolveAdapter(event, workspaceIdInput)).getSessionView(sessionId)
    },

    async promptSession(
      event: WorkspaceEventLike,
      sessionId: string,
      input: CloudPromptInput,
      workspaceIdInput?: string | null,
    ): Promise<void> {
      await (await resolveAdapter(event, workspaceIdInput)).promptSession(sessionId, input)
    },

    async abortSession(
      event: WorkspaceEventLike,
      sessionId: string,
      workspaceIdInput?: string | null,
    ): Promise<void> {
      await (await resolveAdapter(event, workspaceIdInput)).abortSession(sessionId)
    },

    async replyToQuestion(
      event: WorkspaceEventLike,
      sessionId: string,
      requestId: string,
      answers: unknown[],
      workspaceIdInput?: string | null,
    ): Promise<void> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.replyToQuestion) throw new Error('Cloud question replies are not supported by this workspace.')
      await adapter.replyToQuestion(sessionId, requestId, answers)
    },

    async rejectQuestion(
      event: WorkspaceEventLike,
      sessionId: string,
      requestId: string,
      workspaceIdInput?: string | null,
    ): Promise<void> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.rejectQuestion) throw new Error('Cloud question rejection is not supported by this workspace.')
      await adapter.rejectQuestion(sessionId, requestId)
    },

    async respondToPermission(
      event: WorkspaceEventLike,
      sessionId: string,
      permissionId: string,
      allowed: boolean,
      workspaceIdInput?: string | null,
    ): Promise<void> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.respondToPermission) throw new Error('Cloud permission responses are not supported by this workspace.')
      await adapter.respondToPermission(sessionId, permissionId, allowed)
    },
  }
}
