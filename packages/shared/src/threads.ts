import type { SessionChangeSummary, SessionUsageSummary } from './session.js'

export type ThreadStatus = 'idle' | 'running' | 'needs_user' | 'error' | 'reverted' | 'automation'
export type ThreadSort = 'updated_desc' | 'created_desc' | 'title_asc'
export type ThreadSuggestionStatus = 'suggested' | 'accepted' | 'dismissed'

export interface ThreadSearchQuery {
  text?: string
  cursor?: string | null
  limit?: number
  dateRange?: { from?: string; to?: string }
  projectLabels?: string[]
  directories?: string[]
  providerIds?: string[]
  modelIds?: string[]
  agents?: string[]
  tools?: string[]
  mcps?: string[]
  statuses?: ThreadStatus[]
  tagIds?: string[]
  smartFilterId?: string | null
  sort?: ThreadSort
}

export interface ThreadMetadataCount {
  name: string
  count: number
}

export interface ThreadToolCount {
  name: string
  mcpName?: string | null
  count: number
}

export interface ThreadTag {
  id: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export interface ThreadCategorySuggestion {
  id: string
  sessionId: string
  label: string
  reason: string
  evidence: Array<{ type: 'title' | 'project' | 'provider' | 'model' | 'agent' | 'tool'; value: string }>
  status: ThreadSuggestionStatus
  createdAt: string
  updatedAt: string
}

export interface ThreadUsageSummary {
  messages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionUsageSummary['tokens']
}

export interface ThreadListItem {
  sessionId: string
  title: string
  directory: string | null
  projectLabel: string | null
  providerId: string | null
  modelId: string | null
  status: ThreadStatus
  createdAt: string
  updatedAt: string
  parentSessionId: string | null
  automationId: string | null
  runId: string | null
  revertedMessageId: string | null
  tags: ThreadTag[]
  actualAgents: ThreadMetadataCount[]
  actualTools: ThreadToolCount[]
  suggestions: ThreadCategorySuggestion[]
  usage: ThreadUsageSummary
  changeSummary: SessionChangeSummary | null
}

export interface ThreadSearchResult {
  threads: ThreadListItem[]
  nextCursor: string | null
  totalEstimate: number
}

export interface ThreadFacetBucket {
  value: string
  label: string
  count: number
}

export interface ThreadFacetSummary {
  projects: ThreadFacetBucket[]
  providers: ThreadFacetBucket[]
  models: ThreadFacetBucket[]
  agents: ThreadFacetBucket[]
  tools: ThreadFacetBucket[]
  mcps: ThreadFacetBucket[]
  statuses: ThreadFacetBucket[]
  tags: Array<ThreadFacetBucket & { color?: string }>
}

export interface ThreadSmartFilter {
  id: string
  name: string
  query: ThreadSearchQuery
  createdAt: string
  updatedAt: string
}

export interface ThreadTagInput {
  name: string
  color?: string
}

export interface ThreadSmartFilterInput {
  name: string
  query: ThreadSearchQuery
}

export interface ThreadSuggestionInput {
  label: string
  reason: string
  evidence?: ThreadCategorySuggestion['evidence']
}

export interface ThreadIndexUpsertInput {
  sessionId: string
  title: string
  kind?: 'interactive' | 'automation'
  directory?: string | null
  projectLabel?: string | null
  providerId?: string | null
  modelId?: string | null
  status?: ThreadStatus
  createdAt: string
  updatedAt: string
  parentSessionId?: string | null
  automationId?: string | null
  runId?: string | null
  revertedMessageId?: string | null
  messageCount?: number
  toolCallCount?: number
  taskRunCount?: number
  cost?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  changeFiles?: number
  changeAdditions?: number
  changeDeletions?: number
  /**
   * Omit actual metadata arrays when an update is record-only and should
   * preserve the existing sidecar metadata. Pass an empty array only when the
   * caller has an authoritative fresh view with no entries.
   */
  actualAgents?: ThreadMetadataCount[]
  actualTools?: ThreadToolCount[]
  indexedAt?: string
  metadataVersion?: number
}

export const THREAD_SEARCH_DEFAULT_LIMIT = 50
export const THREAD_SEARCH_MAX_LIMIT = 100
export const THREAD_BULK_MAX_SESSION_IDS = 500
export const THREAD_FILTER_MAX_VALUES = 50
export const THREAD_QUERY_MAX_LENGTH = 256
export const THREAD_TAG_NAME_MAX_LENGTH = 48
export const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
export const THREAD_SUGGESTION_LABEL_MAX_LENGTH = 64
export const THREAD_SUGGESTION_REASON_MAX_LENGTH = 240
