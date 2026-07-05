import type {
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
} from '@open-cowork/shared'
import type { CloudWorkspaceSessionAdapter } from './cloud-workspace-adapter.ts'

type WorkspaceEventLike = { sender?: { id?: number } } | null | undefined

export type ResolveCloudAdapter = (
  event: WorkspaceEventLike,
  workspaceIdInput?: string | null,
) => Promise<CloudWorkspaceSessionAdapter>

export function createCloudArtifactGateway(resolveAdapter: ResolveCloudAdapter) {
  return {
    async list(
      event: WorkspaceEventLike,
      sessionId: string,
      workspaceIdInput?: string | null,
    ): Promise<SessionArtifact[]> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.listArtifacts) throw new Error('Cloud artifacts are not supported by this workspace.')
      return adapter.listArtifacts(sessionId)
    },

    async index(
      event: WorkspaceEventLike,
      request: ArtifactIndexRequest,
      workspaceIdInput?: string | null,
    ): Promise<ArtifactIndexPayload> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.indexArtifacts) throw new Error('Cloud artifact index is not supported by this workspace.')
      return adapter.indexArtifacts(request)
    },

    async launchpadFeed(
      event: WorkspaceEventLike,
      request: LaunchpadFeedRequest,
      workspaceIdInput?: string | null,
    ): Promise<LaunchpadFeedPayload> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.launchpadFeed) throw new Error('Cloud launchpad feed is not supported by this workspace.')
      return adapter.launchpadFeed(request)
    },

    async updateStatus(
      event: WorkspaceEventLike,
      request: ArtifactStatusUpdateRequest,
      workspaceIdInput?: string | null,
    ): Promise<SessionArtifact> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.updateArtifactStatus) throw new Error('Cloud artifact status updates are not supported by this workspace.')
      return adapter.updateArtifactStatus(request)
    },

    async upload(
      event: WorkspaceEventLike,
      input: SessionArtifactUploadRequest,
      workspaceIdInput?: string | null,
    ): Promise<SessionArtifact> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.uploadArtifact) throw new Error('Cloud artifact uploads are not supported by this workspace.')
      return adapter.uploadArtifact(input)
    },

    async readAttachment(
      event: WorkspaceEventLike,
      sessionId: string,
      filePathOrArtifactId: string,
      workspaceIdInput?: string | null,
    ): Promise<SessionArtifactAttachment> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.readArtifactAttachment) throw new Error('Cloud artifact downloads are not supported by this workspace.')
      return adapter.readArtifactAttachment(sessionId, filePathOrArtifactId)
    },
  }
}
