export type {
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
} from '../contracts.js'

import type {
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
} from '../contracts.js'
import type { CloudDomainClientContext } from '../domains/shared.js'
import {
  asRecord,
  encodePath,
  queryString,
  readNullableString,
  readNumber,
  readString,
} from '../domains/shared.js'

export type CloudThreadsClient = {
  searchThreads(query?: ThreadSearchQuery): Promise<ThreadSearchResult>
  threadFacets(query?: ThreadSearchQuery): Promise<ThreadFacetSummary>
  listThreadTags(): Promise<ThreadTag[]>
  createThreadTag(input: ThreadTagInput): Promise<ThreadTag>
  updateThreadTag(tagId: string, input: ThreadTagInput): Promise<ThreadTag | null>
  deleteThreadTag(tagId: string): Promise<boolean>
  applyThreadTags(sessionIds: string[], tagIds: string[]): Promise<boolean>
  removeThreadTags(sessionIds: string[], tagIds: string[]): Promise<boolean>
  listThreadSmartFilters(): Promise<ThreadSmartFilter[]>
  createThreadSmartFilter(input: ThreadSmartFilterInput): Promise<ThreadSmartFilter>
  updateThreadSmartFilter(filterId: string, input: ThreadSmartFilterInput): Promise<ThreadSmartFilter | null>
  deleteThreadSmartFilter(filterId: string): Promise<boolean>
}

function normalizeThreadTag(value: unknown): ThreadTag {
  const record = asRecord(value)
  const id = readString(record.id, readString(record.tagId))
  return {
    id,
    name: readString(record.name, 'Tag'),
    color: readString(record.color, '#64748b'),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadSmartFilter(value: unknown): ThreadSmartFilter {
  const record = asRecord(value)
  return {
    id: readString(record.id, readString(record.filterId)),
    name: readString(record.name, 'Smart filter'),
    query: asRecord(record.query) as ThreadSearchQuery,
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadStatus(value: unknown): ThreadListItem['status'] {
  if (value === 'running') return 'running'
  if (value === 'errored' || value === 'error') return 'error'
  return 'idle'
}

function normalizeThreadListItem(value: unknown): ThreadListItem {
  const record = asRecord(value)
  const tags = Array.isArray(record.tags) ? record.tags.map(normalizeThreadTag) : []
  return {
    sessionId: readString(record.sessionId),
    title: readString(record.title, 'New session'),
    directory: null,
    projectLabel: null,
    providerId: null,
    modelId: null,
    status: normalizeThreadStatus(record.status),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
    parentSessionId: null,
    workflowId: null,
    runId: null,
    revertedMessageId: null,
    tags,
    actualAgents: readNullableString(record.profileName) ? [{ name: readString(record.profileName), count: 1 }] : [],
    actualTools: [],
    suggestions: [],
    usage: {
      messages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    changeSummary: null,
  }
}

function normalizeThreadSearchResult(value: unknown): ThreadSearchResult {
  const record = asRecord(value)
  const threads = Array.isArray(record.threads) ? record.threads.map(normalizeThreadListItem) : []
  return {
    threads,
    nextCursor: readNullableString(record.nextCursor),
    totalEstimate: readNumber(record.totalEstimate, threads.length),
  }
}

export function createCloudThreadsClient({ request }: CloudDomainClientContext): CloudThreadsClient {
  return {
    async searchThreads(query = {}) {
      const result = await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`)
      return normalizeThreadSearchResult(result)
    },
    async threadFacets(query = {}) {
      const result = normalizeThreadSearchResult(await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`))
      const tags = (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
      const tagCounts = new Map<string, { label: string, color?: string, count: number }>()
      for (const thread of result.threads) {
        for (const tag of thread.tags || []) {
          const existing = tagCounts.get(tag.id) || { label: tag.name, color: tag.color, count: 0 }
          existing.count += 1
          tagCounts.set(tag.id, existing)
        }
      }
      return {
        projects: [],
        providers: [],
        models: [],
        agents: [],
        tools: [],
        mcps: [],
        statuses: [],
        tags: tags.map((tag) => ({
          value: tag.id,
          label: tag.name,
          color: tag.color,
          count: tagCounts.get(tag.id)?.count || 0,
        })),
      }
    },
    async listThreadTags() {
      return (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
    },
    async createThreadTag(input) {
      return normalizeThreadTag((await request<{ tag: unknown }>('/api/threads/tags', {
        method: 'POST',
        body: input,
      })).tag)
    },
    async updateThreadTag(tagId, input) {
      const tag = (await request<{ tag: unknown | null }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'PATCH',
        body: input,
      })).tag
      return tag ? normalizeThreadTag(tag) : null
    },
    async deleteThreadTag(tagId) {
      return (await request<{ deleted: boolean }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'DELETE',
      })).deleted
    },
    async applyThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/apply`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async removeThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/remove`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async listThreadSmartFilters() {
      return (await request<{ filters: unknown[] }>('/api/threads/smart-filters')).filters.map(normalizeThreadSmartFilter)
    },
    async createThreadSmartFilter(input) {
      return normalizeThreadSmartFilter((await request<{ filter: unknown }>('/api/threads/smart-filters', {
        method: 'POST',
        body: input,
      })).filter)
    },
    async updateThreadSmartFilter(filterId, input) {
      const filter = (await request<{ filter: unknown | null }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'PATCH',
        body: input,
      })).filter
      return filter ? normalizeThreadSmartFilter(filter) : null
    },
    async deleteThreadSmartFilter(filterId) {
      return (await request<{ deleted: boolean }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'DELETE',
      })).deleted
    },
  }
}
