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
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { getSessionRecord, listSessionRecords, type SessionRecord } from './session-registry.ts'
import { sessionEngine } from './session-engine.ts'
import {
  getThreadIndexStore,
  normalizeThreadSearchQuery,
  type ThreadIndexStore,
} from './thread-index-store.ts'

const REFRESH_DEBOUNCE_MS = 750
const MAX_DETERMINISTIC_SUGGESTIONS = 5

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

function usageFromRecordAndView(record: SessionRecord, view?: SessionView | null): {
  messages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
} {
  if (view && (view.messages.length || view.toolCalls.length || view.taskRuns.length || view.sessionCost)) {
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
  for (const taskRun of view?.taskRuns || []) add(taskRun.agent)
  for (const entry of record.summary?.agentBreakdown || []) add(entry.agent, entry.taskRuns || 1)
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
  if (record.kind === 'automation' || record.automationId) return 'automation'
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
  }
}

function projectLabel(directory?: string | null) {
  if (!directory) return null
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/') || directory
}

function threadInputFromRecord(record: SessionRecord, view?: SessionView | null): ThreadIndexUpsertInput {
  const usage = usageFromRecordAndView(record, view)
  const actualAgents = view || record.summary?.agentBreakdown !== undefined
    ? agentsFromRecordAndView(record, view)
    : undefined
  const actualTools = view ? toolsFromView(view) : undefined
  return {
    sessionId: record.id,
    title: record.title || 'New session',
    kind: record.kind,
    directory: record.directory,
    projectLabel: projectLabel(record.directory),
    providerId: record.providerId,
    modelId: record.modelId,
    status: statusFromRecordAndView(record, view),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parentSessionId: record.parentSessionId,
    automationId: record.automationId,
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
  if (record.kind === 'automation' || record.automationId) {
    addSuggestion(suggestions, 'automation', 'This thread is linked to an automation run.', [{ type: 'title', value: record.title || record.id }])
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
      this.store.deleteThreadsNotIn(records.map((record) => record.id))
    } catch (err) {
      log('thread-index', `Registry reconciliation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  upsertThreadFromSessionRecord(record: SessionRecord, view?: SessionView | null) {
    try {
      const existing = view ? null : this.store.getThread(record.id)
      const input = threadInputFromRecord(record, view)
      this.store.upsertThread(input)
      const actualAgents = input.actualAgents ?? existing?.actualAgents ?? []
      const actualTools = input.actualTools ?? existing?.actualTools ?? []
      this.store.replaceSuggestedSuggestions(
        record.id,
        deterministicSuggestions(record, actualAgents, actualTools),
      )
    } catch (err) {
      log('thread-index', `Upsert failed session=${shortSessionId(record.id)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  removeThread(sessionId: string) {
    try {
      this.store.deleteThread(sessionId)
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
    if (!sessionIds) this.store.deleteThreadsNotIn(records.map((record) => record.id))
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
