import type {
  DashboardSessionSummary,
  DashboardSummary,
  DashboardTimeRange,
  DashboardTimeRangeKey,
  SessionTokens,
  SessionUsageSummary,
  SessionView,
} from '@open-cowork/shared'
import type { SessionRecord } from './session-registry.ts'

const EMPTY_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

export const EMPTY_SESSION_USAGE_SUMMARY: SessionUsageSummary = {
  messages: 0,
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  taskRuns: 0,
  cost: 0,
  tokens: EMPTY_TOKENS,
}

function cloneTokens(tokens: SessionTokens): SessionTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  }
}

export function buildSessionUsageSummary(view: SessionView): SessionUsageSummary {
  const messages = view.messages.length
  const userMessages = view.messages.filter((message) => message.role === 'user').length
  const assistantMessages = view.messages.filter((message) => message.role === 'assistant').length
  const taskToolCalls = view.taskRuns.reduce((sum, taskRun) => sum + taskRun.toolCalls.length, 0)

  return {
    messages,
    userMessages,
    assistantMessages,
    toolCalls: view.toolCalls.length + taskToolCalls,
    taskRuns: view.taskRuns.length,
    cost: view.sessionCost,
    tokens: cloneTokens(view.sessionTokens),
  }
}

export function createDashboardTimeRange(key: DashboardTimeRangeKey, now = new Date()): DashboardTimeRange {
  const end = new Date(now)
  const nowMs = now.getTime()
  const dayMs = 24 * 60 * 60 * 1000

  switch (key) {
    case 'last30d':
      return {
        key,
        label: 'Last 30 days',
        startAt: new Date(nowMs - (30 * dayMs)).toISOString(),
        endAt: end.toISOString(),
      }
    case 'ytd':
      return {
        key,
        label: 'Year to date',
        startAt: new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0)).toISOString(),
        endAt: end.toISOString(),
      }
    case 'all':
      return {
        key,
        label: 'All time',
        startAt: null,
        endAt: end.toISOString(),
      }
    case 'last7d':
    default:
      return {
        key: 'last7d',
        label: 'Last 7 days',
        startAt: new Date(nowMs - (7 * dayMs)).toISOString(),
        endAt: end.toISOString(),
      }
  }
}

export function isRecordInDashboardRange(record: SessionRecord, range: DashboardTimeRange) {
  const updatedAt = new Date(record.updatedAt).getTime()
  if (!Number.isFinite(updatedAt)) return false
  const endAt = new Date(range.endAt).getTime()
  if (updatedAt > endAt) return false
  if (!range.startAt) return true
  return updatedAt >= new Date(range.startAt).getTime()
}

export function sumSessionUsageSummaries(items: SessionUsageSummary[]) {
  return items.reduce<SessionUsageSummary & { threads: number }>((acc, item) => ({
    threads: acc.threads + 1,
    messages: acc.messages + item.messages,
    userMessages: acc.userMessages + item.userMessages,
    assistantMessages: acc.assistantMessages + item.assistantMessages,
    toolCalls: acc.toolCalls + item.toolCalls,
    taskRuns: acc.taskRuns + item.taskRuns,
    cost: acc.cost + item.cost,
    tokens: {
      input: acc.tokens.input + item.tokens.input,
      output: acc.tokens.output + item.tokens.output,
      reasoning: acc.tokens.reasoning + item.tokens.reasoning,
      cacheRead: acc.tokens.cacheRead + item.tokens.cacheRead,
      cacheWrite: acc.tokens.cacheWrite + item.tokens.cacheWrite,
    },
  }), {
    threads: 0,
    ...EMPTY_SESSION_USAGE_SUMMARY,
    tokens: cloneTokens(EMPTY_TOKENS),
  })
}

export function toDashboardSessionSummary(
  record: SessionRecord,
  usage: SessionUsageSummary,
): DashboardSessionSummary {
  return {
    id: record.id,
    title: record.title,
    directory: record.directory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    providerId: record.providerId || null,
    modelId: record.modelId || null,
    usage,
  }
}

export function createEmptyDashboardSummary(range: DashboardTimeRange): DashboardSummary {
  return {
    range,
    totals: {
      threads: 0,
      ...EMPTY_SESSION_USAGE_SUMMARY,
      tokens: cloneTokens(EMPTY_TOKENS),
    },
    recentSessions: [],
    generatedAt: new Date().toISOString(),
    backfilledSessions: 0,
  }
}
