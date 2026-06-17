import type { IpcMainInvokeEvent } from 'electron'
import type {
  ThreadFacetSummary,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
} from '@open-cowork/shared'
import type { CloudWorkspaceSessionAdapter } from './cloud-workspace-adapter.ts'

type WorkspaceEventLike = Pick<IpcMainInvokeEvent, 'sender'> | null | undefined

export type ResolveCloudAdapter = (
  event: WorkspaceEventLike,
  workspaceIdInput?: string | null,
) => Promise<CloudWorkspaceSessionAdapter>

export function createCloudThreadGateway(resolveAdapter: ResolveCloudAdapter) {
  return {
    async search(
      event: WorkspaceEventLike,
      query?: ThreadSearchQuery,
      workspaceIdInput?: string | null,
    ): Promise<ThreadSearchResult> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.searchThreads) throw new Error('Cloud thread search is not supported by this workspace.')
      return adapter.searchThreads(query)
    },

    async facets(
      event: WorkspaceEventLike,
      query?: ThreadSearchQuery,
      workspaceIdInput?: string | null,
    ): Promise<ThreadFacetSummary> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.threadFacets) throw new Error('Cloud thread facets are not supported by this workspace.')
      return adapter.threadFacets(query)
    },

    async listTags(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadTag[]> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.listThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.listThreadTags()
    },

    async createTag(
      event: WorkspaceEventLike,
      input: ThreadTagInput,
      workspaceIdInput?: string | null,
    ): Promise<ThreadTag> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.createThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.createThreadTag(input)
    },

    async updateTag(
      event: WorkspaceEventLike,
      tagId: string,
      input: ThreadTagInput,
      workspaceIdInput?: string | null,
    ): Promise<ThreadTag | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.updateThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.updateThreadTag(tagId, input)
    },

    async deleteTag(
      event: WorkspaceEventLike,
      tagId: string,
      workspaceIdInput?: string | null,
    ): Promise<boolean> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.deleteThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.deleteThreadTag(tagId)
    },

    async applyTags(
      event: WorkspaceEventLike,
      sessionIds: string[],
      tagIds: string[],
      workspaceIdInput?: string | null,
    ): Promise<boolean> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.applyThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.applyThreadTags(sessionIds, tagIds)
    },

    async removeTags(
      event: WorkspaceEventLike,
      sessionIds: string[],
      tagIds: string[],
      workspaceIdInput?: string | null,
    ): Promise<boolean> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.removeThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
      return adapter.removeThreadTags(sessionIds, tagIds)
    },

    async listSmartFilters(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadSmartFilter[]> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.listThreadSmartFilters) throw new Error('Cloud smart filters are not supported by this workspace.')
      return adapter.listThreadSmartFilters()
    },

    async createSmartFilter(
      event: WorkspaceEventLike,
      input: ThreadSmartFilterInput,
      workspaceIdInput?: string | null,
    ): Promise<ThreadSmartFilter> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.createThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
      return adapter.createThreadSmartFilter(input)
    },

    async updateSmartFilter(
      event: WorkspaceEventLike,
      filterId: string,
      input: ThreadSmartFilterInput,
      workspaceIdInput?: string | null,
    ): Promise<ThreadSmartFilter | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.updateThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
      return adapter.updateThreadSmartFilter(filterId, input)
    },

    async deleteSmartFilter(
      event: WorkspaceEventLike,
      filterId: string,
      workspaceIdInput?: string | null,
    ): Promise<boolean> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.deleteThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
      return adapter.deleteThreadSmartFilter(filterId)
    },
  }
}
