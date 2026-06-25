import { shortSessionId } from '@open-cowork/shared'
import type {
  SessionChangeSummary,
  SessionTokens,
  SessionView,
  ThreadIndexUpsertInput,
  ThreadMetadataCount,
  ThreadSearchQuery,
  ThreadSmartFilterInput,
  ThreadStatus,
  ThreadSuggestionInput,
  ThreadTagInput,
  ThreadToolCount,
} from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import { getSessionRecord, listSessionRecords, type SessionRecord } from '../session-registry.js'
import { sessionEngine } from '../session-engine.js'
import {
  getThreadIndexStore,
  normalizeThreadSearchQuery,
  type ThreadIndexStore,
} from './thread-index-store.js'

const REFRESH_DEBOUNCE_MS = 750
const MAX_DETERMINISTIC_SUGGESTIONS = 5
// Bounds the per-session "last indexed projection" signature map. Sessions far above this are rare;
// evicting the oldest just costs one redundant (idempotent) reindex the next time it streams.
const THREAD_INDEX_SIGNATURE_CACHE_MAX = 4_096

// A stable fingerprint of everything the thread-index projection persists for a session. When a
// debounced refresh produces the same fingerprint as the last applied one, the write (and its cache
// invalidation + chmod) is skipped entirely. The input carries no wall-clock fields (indexedAt is
// assigned by the store), so identical session state yields an identical signature.
function threadIndexSignature(input: ThreadIndexUpsertInput, suggestions: ThreadSuggestionInput[]) {
  return JSON.stringify([input, suggestions])
}

function emptyTokens(): SessionTokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

function addTokens(target: SessionTokens, source?: Partial<SessionTokens> | null) {
  if (!source) return
  target.input += source.input || 0
  target.output += source.output || 0
  target.reasoning += source.reasoning || 0
  target.cacheRead += source.cacheRead || 0
  target.cacheWrite += source.cacheWrite || 0
}

function hasUsableThreadView(view?: SessionView | null) {
  return Boolean(view && (
    view.messages.length
    || view.toolCalls.length
    || view.taskRuns.length
    || view.sessionCost
  ))
}

function hasAuthoritativeThreadView(view?: SessionView | null): view is SessionView {
  if (!view) return false
  return Boolean(
    hasUsableThreadView(view)
    || view.revision > 0
    || view.lastEventAt > 0
    || view.pendingApprovals.length
    || view.pendingQuestions.length
    || view.errors.length
    || view.todos.length
    || view.executionPlan.length
    || view.compactions.length
    || view.isGenerating
    || view.isAwaitingPermission
    || view.isAwaitingQuestion
    || view.contextState !== 'idle'
    || view.compactionCount > 0
    || Boolean(view.lastCompactedAt)
  )
}

function usageFromRecordAndView(record: SessionRecord, view?: SessionView | null): {
  messages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
} {
  if (view && hasUsableThreadView(view)) {
    const tokens = emptyTokens()
    addTokens(tokens, view.sessionTokens)
    for (const taskRun of view.taskRuns) {
      addTokens(tokens, taskRun.sessionTokens)
    }
    return {
      messages: view.messages.length,
      toolCalls: view.toolCalls.length + view.taskRuns.reduce((count, task) => count + task.toolCalls.length, 0),
      taskRuns: view.taskRuns.length,
      cost: view.sessionCost + view.taskRuns.reduce((cost, task) => cost + (task.sessionCost || 0), 0),
      tokens,
    }
  }
  const summary = record.summary
  return {
    messages: summary?.messages || 0,
    toolCalls: summary?.toolCalls || 0,
    taskRuns: summary?.taskRuns || 0,
    cost: summary?.cost || 0,
    tokens: summary?.tokens || emptyTokens(),
  }
}

function agentsFromRecordAndView(record: SessionRecord, view?: SessionView | null): ThreadMetadataCount[] {
  const counts = new Map<string, number>()
  const add = (name?: string | null, count = 1) => {
    const normalized = name?.trim()
    if (!normalized) return
    counts.set(normalized, (counts.get(normalized) || 0) + count)
  }
  if (view) {
    for (const taskRun of view.taskRuns) add(taskRun.agent)
  } else {
    for (const entry of record.summary?.agentBreakdown || []) add(entry.agent, entry.taskRuns || 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function mcpNameForTool(toolName: string) {
  const trimmed = toolName.trim()
  if (!trimmed) return null
  const dotIndex = trimmed.indexOf('.')
  if (dotIndex > 0) return trimmed.slice(0, dotIndex)
  const slashIndex = trimmed.indexOf('/')
  if (slashIndex > 0) return trimmed.slice(0, slashIndex)
  return null
}

function toolsFromView(view?: SessionView | null): ThreadToolCount[] {
  const counts = new Map<string, ThreadToolCount>()
  const add = (name?: string | null) => {
    const normalized = name?.trim()
    if (!normalized) return
    const existing = counts.get(normalized)
    if (existing) {
      existing.count += 1
      return
    }
    counts.set(normalized, { name: normalized, mcpName: mcpNameForTool(normalized), count: 1 })
  }
  for (const tool of view?.toolCalls || []) add(tool.name)
  for (const taskRun of view?.taskRuns || []) {
    for (const tool of taskRun.toolCalls) add(tool.name)
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function statusFromRecordAndView(record: SessionRecord, view?: SessionView | null): ThreadStatus {
  if (record.kind === 'workflow_draft' || record.kind === 'workflow_run' || record.workflowId) return 'workflow'
  if (record.revertedMessageId) return 'reverted'
  if (!view) return 'idle'
  if (view.isAwaitingPermission || view.isAwaitingQuestion) return 'needs_user'
  if (view.isGenerating || view.taskRuns.some((task) => task.status === 'running' || task.status === 'queued')) return 'running'
  if (view.errors.length || view.taskRuns.some((task) => task.status === 'error')) return 'error'
  return 'idle'
}

function changeCounts(changeSummary?: SessionChangeSummary | null) {
  return {
    changeFiles: changeSummary?.files || 0,
    changeAdditions: changeSummary?.additions || 0,
    changeDeletions: changeSummary?.deletions || 0,
    changeSource: changeSummary?.source === 'synthetic' || changeSummary?.source === 'mixed'
      ? changeSummary.source
      : null,
  }
}

function projectLabel(directory?: string | null) {
  if (!directory) return null
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/') || directory
}

function threadInputFromRecord(record: SessionRecord, view?: SessionView | null): ThreadIndexUpsertInput {
  const statusView = hasAuthoritativeThreadView(view) ? view : null
  const metadataView = view && hasUsableThreadView(view) ? view : null
  const usage = usageFromRecordAndView(record, metadataView)
  const actualAgents = metadataView || record.summary?.agentBreakdown !== undefined
    ? agentsFromRecordAndView(record, metadataView)
    : undefined
  const actualTools = metadataView ? toolsFromView(metadataView) : undefined
  return {
    sessionId: record.id,
    title: record.title || 'New session',
    kind: record.kind,
    directory: record.directory,
    projectLabel: projectLabel(record.directory),
    providerId: record.providerId,
    modelId: record.modelId,
    status: statusFromRecordAndView(record, statusView),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parentSessionId: record.parentSessionId,
    workflowId: record.workflowId,
    runId: record.runId,
    revertedMessageId: record.revertedMessageId,
    messageCount: usage.messages,
    toolCallCount: usage.toolCalls,
    taskRunCount: usage.taskRuns,
    cost: usage.cost,
    inputTokens: usage.tokens.input,
    outputTokens: usage.tokens.output,
    reasoningTokens: usage.tokens.reasoning,
    cacheReadTokens: usage.tokens.cacheRead,
    cacheWriteTokens: usage.tokens.cacheWrite,
    ...(actualAgents !== undefined ? { actualAgents } : {}),
    ...(actualTools !== undefined ? { actualTools } : {}),
    ...changeCounts(record.changeSummary),
  }
}

function addSuggestion(
  suggestions: ThreadSuggestionInput[],
  label: string,
  reason: string,
  evidence: NonNullable<ThreadSuggestionInput['evidence']>,
) {
  if (suggestions.some((item) => item.label.toLowerCase() === label.toLowerCase())) return
  suggestions.push({ label, reason, evidence })
}

function deterministicSuggestions(record: SessionRecord, agents: ThreadMetadataCount[], tools: ThreadToolCount[]) {
  const suggestions: ThreadSuggestionInput[] = []
  const title = (record.title || '').toLowerCase()
  const project = projectLabel(record.directory)
  if (record.kind === 'workflow_draft' || record.kind === 'workflow_run' || record.workflowId) {
    addSuggestion(suggestions, 'workflow', 'This thread is linked to a saved workflow.', [{ type: 'title', value: record.title || record.id }])
  }
  if (project) {
    addSuggestion(suggestions, project, 'Project label from the thread directory.', [{ type: 'project', value: project }])
  }
  const hasChartTool = tools.some((tool) => /chart|vega|mermaid/i.test(tool.name))
  if (hasChartTool || /chart|visual|dashboard|report/.test(title)) {
    addSuggestion(suggestions, 'reporting', 'Title or actual tool usage suggests reporting or visualization work.', [
      ...(hasChartTool ? [{ type: 'tool' as const, value: tools.find((tool) => /chart|vega|mermaid/i.test(tool.name))?.name || 'chart' }] : []),
      ...(record.title ? [{ type: 'title' as const, value: record.title }] : []),
    ])
  }
  const topAgent = agents[0]
  if (topAgent) {
    addSuggestion(suggestions, topAgent.name, 'Most-used delegated agent in this thread.', [{ type: 'agent', value: topAgent.name }])
  }
  if (record.providerId) {
    addSuggestion(suggestions, record.providerId, 'Provider metadata recorded for this thread.', [{ type: 'provider', value: record.providerId }])
  }
  return suggestions.slice(0, MAX_DETERMINISTIC_SUGGESTIONS)
}

export class ThreadIndexService {
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>()
  private readonly lastIndexSignatures = new Map<string, string>()
  private readonly store: ThreadIndexStore

  constructor(store: ThreadIndexStore = getThreadIndexStore()) {
    this.store = store
  }

  reconcileThreadIndexFromRegistry() {
    try {
      const records = listSessionRecords()
      for (const record of records) {
        this.upsertThreadFromSessionRecord(record)
      }
      const keptIds = records.map((record) => record.id)
      this.store.deleteThreadsNotIn(keptIds)
      this.pruneSignaturesNotIn(keptIds)
    } catch (err) {
      log('thread-index', `Registry reconciliation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  upsertThreadFromSessionRecord(record: SessionRecord, view?: SessionView | null) {
    try {
      const input = threadInputFromRecord(record, view)
      const existing = input.actualAgents === undefined || input.actualTools === undefined
        ? this.store.getThread(record.id)
        : null
      const actualAgents = input.actualAgents ?? existing?.actualAgents ?? []
      const actualTools = input.actualTools ?? existing?.actualTools ?? []
      const suggestions = deterministicSuggestions(record, actualAgents, actualTools)
      // Streamed-event refreshes are debounced but still fire for events that change nothing in the
      // projection (permission prompts, question/answer turns, partial text within one message).
      // Skip the upsert when the derived projection is byte-identical to the last applied one.
      const signature = threadIndexSignature(input, suggestions)
      if (this.lastIndexSignatures.get(record.id) === signature) return
      this.store.upsertThreadWithSuggestions(input, suggestions)
      this.rememberIndexSignature(record.id, signature)
    } catch (err) {
      log('thread-index', `Upsert failed session=${shortSessionId(record.id)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private rememberIndexSignature(sessionId: string, signature: string) {
    this.lastIndexSignatures.delete(sessionId)
    this.lastIndexSignatures.set(sessionId, signature)
    while (this.lastIndexSignatures.size > THREAD_INDEX_SIGNATURE_CACHE_MAX) {
      const oldest = this.lastIndexSignatures.keys().next().value
      if (typeof oldest !== 'string') break
      this.lastIndexSignatures.delete(oldest)
    }
  }

  // Drop signature-cache entries for sessions removed by a bulk deleteThreadsNotIn (P3): unlike
  // removeThread, those paths left stale entries that the 4096-cap only bounded, not cleared.
  private pruneSignaturesNotIn(keptIds: string[]) {
    const kept = new Set(keptIds)
    for (const key of this.lastIndexSignatures.keys()) {
      if (!kept.has(key)) this.lastIndexSignatures.delete(key)
    }
  }

  removeThread(sessionId: string) {
    try {
      this.store.deleteThread(sessionId)
      this.lastIndexSignatures.delete(sessionId)
    } catch (err) {
      log('thread-index', `Remove failed session=${shortSessionId(sessionId)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  refreshThreadMetadata(sessionId: string, view?: SessionView | null) {
    const record = getSessionRecord(sessionId)
    if (!record) return
    this.upsertThreadFromSessionRecord(record, view || sessionEngine.getSessionView(sessionId))
  }

  scheduleThreadMetadataRefresh(sessionId: string) {
    const existing = this.refreshTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.refreshTimers.delete(sessionId)
      this.refreshThreadMetadata(sessionId)
    }, REFRESH_DEBOUNCE_MS)
    this.refreshTimers.set(sessionId, timer)
  }

  search(query?: ThreadSearchQuery) {
    return this.store.searchThreads(normalizeThreadSearchQuery(query))
  }

  facets(query?: ThreadSearchQuery) {
    return this.store.listFacets(normalizeThreadSearchQuery(query))
  }

  listTags() {
    return this.store.listTags()
  }

  createTag(input: ThreadTagInput) {
    return this.store.createTag(input)
  }

  updateTag(tagId: string, input: ThreadTagInput) {
    return this.store.updateTag(tagId, input)
  }

  deleteTag(tagId: string) {
    return this.store.deleteTag(tagId)
  }

  applyTags(sessionIds: string[], tagIds: string[]) {
    return this.store.applyTags(sessionIds, tagIds)
  }

  removeTags(sessionIds: string[], tagIds: string[]) {
    return this.store.removeTags(sessionIds, tagIds)
  }

  listSmartFilters() {
    return this.store.listSmartFilters()
  }

  createSmartFilter(input: ThreadSmartFilterInput) {
    return this.store.createSmartFilter(input)
  }

  updateSmartFilter(filterId: string, input: ThreadSmartFilterInput) {
    return this.store.updateSmartFilter(filterId, input)
  }

  deleteSmartFilter(filterId: string) {
    return this.store.deleteSmartFilter(filterId)
  }

  acceptSuggestion(suggestionId: string) {
    return this.store.acceptSuggestion(suggestionId)
  }

  editSuggestion(suggestionId: string, label: string) {
    return this.store.editSuggestion(suggestionId, label)
  }

  dismissSuggestion(suggestionId: string) {
    return this.store.dismissSuggestion(suggestionId)
  }

  reindex(sessionIds?: string[]) {
    const wanted = new Set(sessionIds || [])
    const records = listSessionRecords().filter((record) => !sessionIds || wanted.has(record.id))
    for (const record of records) {
      this.refreshThreadMetadata(record.id)
    }
    if (!sessionIds) {
      const keptIds = records.map((record) => record.id)
      this.store.deleteThreadsNotIn(keptIds)
      this.pruneSignaturesNotIn(keptIds)
    }
    return true
  }

  dispose() {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
  }
}

let threadIndexService: ThreadIndexService | null = null

export function getThreadIndexService() {
  if (!threadIndexService) threadIndexService = new ThreadIndexService()
  return threadIndexService
}

export function clearThreadIndexServiceCache() {
  threadIndexService?.dispose()
  threadIndexService = null
}
