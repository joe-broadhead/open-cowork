import type { PendingApproval, PendingQuestion, TaskRun } from '@open-cowork/shared'
import { listArtifactsForTools } from './session-artifacts'

export const AGENT_RUN_FILTERS_FEATURE_GATE_KEY = 'open-cowork.feature.agentRunFilters'
export const AGENT_RUN_FILTER_STATE_KEY_PREFIX = 'open-cowork.agentRunFilters'

export type AgentRunStatusFilter = 'all' | 'running' | 'waiting' | 'blocked' | 'errored' | 'complete' | 'cancelled'
export type AgentRunActivityFilter = 'all' | 'needs_review' | 'approvals' | 'questions' | 'tools' | 'artifacts' | 'errors'

export interface AgentRunFilterState {
  statusFilter: AgentRunStatusFilter
  agentFilter: string
  activityFilter: AgentRunActivityFilter
}

export interface TaskReviewActivity {
  approvals: PendingApproval[]
  questions: PendingQuestion[]
}

export interface TaskRunMetrics {
  durationMs: number
  tokenTotal: number
  cost: number
  toolCount: number
  approvalCount: number
  questionCount: number
  artifactCount: number
  lastEventAt: string | null
  lastOrder: number
}

export interface AgentRunFilterSummary {
  total: number
  filtered: number
  statuses: Record<Exclude<AgentRunStatusFilter, 'all'>, number>
  agents: Array<{ id: string; label: string; count: number }>
  metrics: TaskRunMetrics
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined

export const DEFAULT_AGENT_RUN_FILTER_STATE: AgentRunFilterState = {
  statusFilter: 'all',
  agentFilter: 'all',
  activityFilter: 'all',
}

const statusFilters = new Set<AgentRunStatusFilter>(['all', 'running', 'waiting', 'blocked', 'errored', 'complete', 'cancelled'])
const activityFilters = new Set<AgentRunActivityFilter>(['all', 'needs_review', 'approvals', 'questions', 'tools', 'artifacts', 'errors'])

export function isAgentRunFiltersEnabled(storage: Pick<Storage, 'getItem'> | null | undefined = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return storage?.getItem(AGENT_RUN_FILTERS_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

export function agentRunFilterStorageKey(sessionId: string | null | undefined, groupKey: string) {
  return `${AGENT_RUN_FILTER_STATE_KEY_PREFIX}:${sessionId || 'detached'}:${groupKey || 'ungrouped'}`
}

export function readAgentRunFilterState(storage: StorageLike, key: string): AgentRunFilterState {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return DEFAULT_AGENT_RUN_FILTER_STATE
    const parsed = JSON.parse(raw) as Partial<AgentRunFilterState>
    return normalizeAgentRunFilterState(parsed)
  } catch {
    return DEFAULT_AGENT_RUN_FILTER_STATE
  }
}

export function writeAgentRunFilterState(storage: StorageLike, key: string, state: AgentRunFilterState) {
  try {
    storage?.setItem(key, JSON.stringify(normalizeAgentRunFilterState(state)))
  } catch {
    // Persisted filters are convenience state; ignore storage failures.
  }
}

function normalizeAgentRunFilterState(input: Partial<AgentRunFilterState> | null | undefined): AgentRunFilterState {
  return {
    statusFilter: input?.statusFilter && statusFilters.has(input.statusFilter) ? input.statusFilter : 'all',
    agentFilter: typeof input?.agentFilter === 'string' ? input.agentFilter : 'all',
    activityFilter: input?.activityFilter && activityFilters.has(input.activityFilter) ? input.activityFilter : 'all',
  }
}

export function buildTaskReviewIndex(
  taskRuns: readonly TaskRun[],
  approvals: readonly PendingApproval[] = [],
  questions: readonly PendingQuestion[] = [],
) {
  const index = new Map<string, TaskReviewActivity>()
  const bySession = new Map<string, TaskRun>()

  for (const task of taskRuns) {
    index.set(task.id, { approvals: [], questions: [] })
    if (task.sourceSessionId) bySession.set(task.sourceSessionId, task)
  }

  for (const approval of approvals) {
    const task = approval.taskRunId
      ? taskRuns.find((entry) => entry.id === approval.taskRunId)
      : bySession.get(approval.sessionId)
    if (!task) continue
    const activity = index.get(task.id) || { approvals: [], questions: [] }
    activity.approvals.push(approval)
    index.set(task.id, activity)
  }

  for (const question of questions) {
    const sourceSessionId = question.sourceSessionId || question.sessionId
    const task = sourceSessionId ? bySession.get(sourceSessionId) : null
    if (!task) continue
    const activity = index.get(task.id) || { approvals: [], questions: [] }
    activity.questions.push(question)
    index.set(task.id, activity)
  }

  return index
}

export function reviewActivityForTask(index: Map<string, TaskReviewActivity>, taskId: string): TaskReviewActivity {
  return index.get(taskId) || { approvals: [], questions: [] }
}

export function agentRunStatusForTask(taskRun: TaskRun, activity: TaskReviewActivity): Exclude<AgentRunStatusFilter, 'all'> {
  if (taskRun.status === 'error') {
    const errorText = `${taskRun.error || ''} ${taskRun.title}`.toLowerCase()
    if (/\b(aborted?|cancelled|canceled)\b/.test(errorText)) return 'cancelled'
    return 'errored'
  }
  if (activity.approvals.length > 0 || activity.questions.length > 0) return 'waiting'
  if (taskRun.status === 'queued') return 'blocked'
  if (taskRun.status === 'complete') return 'complete'
  return 'running'
}

function taskRunMatchesAgentRunFilters(
  taskRun: TaskRun,
  state: AgentRunFilterState,
  activity: TaskReviewActivity,
) {
  const status = agentRunStatusForTask(taskRun, activity)
  const artifacts = listArtifactsForTools(taskRun.toolCalls, taskRun)

  if (state.statusFilter !== 'all' && status !== state.statusFilter) return false
  if (state.agentFilter !== 'all' && (taskRun.agent || '') !== state.agentFilter) return false

  switch (state.activityFilter) {
    case 'all':
      return true
    case 'needs_review':
      return activity.approvals.length > 0 || activity.questions.length > 0
    case 'approvals':
      return activity.approvals.length > 0
    case 'questions':
      return activity.questions.length > 0
    case 'tools':
      return taskRun.toolCalls.length > 0
    case 'artifacts':
      return artifacts.length > 0
    case 'errors':
      return status === 'errored' || status === 'cancelled' || Boolean(taskRun.error)
  }
}

export function selectAgentRunVisibleTasks(
  taskRuns: readonly TaskRun[],
  state: AgentRunFilterState,
  reviewIndex: Map<string, TaskReviewActivity>,
) {
  if (
    state.statusFilter === 'all'
    && state.agentFilter === 'all'
    && state.activityFilter === 'all'
  ) {
    return taskRuns.slice()
  }

  const bySourceSession = new Map<string, TaskRun>()
  for (const task of taskRuns) {
    if (task.sourceSessionId) bySourceSession.set(task.sourceSessionId, task)
  }

  const visibleIds = new Set<string>()
  const includeWithAncestors = (task: TaskRun) => {
    let current: TaskRun | undefined = task
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      visibleIds.add(current.id)
      current = current.parentSessionId ? bySourceSession.get(current.parentSessionId) : undefined
    }
  }

  for (const task of taskRuns) {
    if (taskRunMatchesAgentRunFilters(task, state, reviewActivityForTask(reviewIndex, task.id))) {
      includeWithAncestors(task)
    }
  }

  return taskRuns.filter((task) => visibleIds.has(task.id))
}

function parseTimestamp(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function taskRunDurationMs(taskRun: TaskRun, now = Date.now()) {
  if (!taskRun.startedAt) return 0
  const startedAt = parseTimestamp(taskRun.startedAt, now)
  const finishedAt = taskRun.finishedAt ? parseTimestamp(taskRun.finishedAt, startedAt) : now
  return Math.max(0, finishedAt - startedAt)
}

function taskRunTokenTotal(taskRun: TaskRun) {
  return taskRun.sessionTokens.input
    + taskRun.sessionTokens.output
    + taskRun.sessionTokens.reasoning
    + taskRun.sessionTokens.cacheRead
    + taskRun.sessionTokens.cacheWrite
}

export function buildTaskRunMetrics(taskRun: TaskRun, activity: TaskReviewActivity, now = Date.now()): TaskRunMetrics {
  const lastOrder = [
    taskRun.order,
    ...taskRun.transcript.map((item) => item.order),
    ...taskRun.toolCalls.map((item) => item.order),
    ...taskRun.compactions.map((item) => item.order),
  ].reduce((max, order) => Math.max(max, order), 0)

  return {
    durationMs: taskRunDurationMs(taskRun, now),
    tokenTotal: taskRunTokenTotal(taskRun),
    cost: taskRun.sessionCost || 0,
    toolCount: taskRun.toolCalls.length,
    approvalCount: activity.approvals.length,
    questionCount: activity.questions.length,
    artifactCount: listArtifactsForTools(taskRun.toolCalls, taskRun).length,
    lastEventAt: taskRun.finishedAt || taskRun.startedAt || null,
    lastOrder,
  }
}

export function buildAgentRunFilterSummary(
  allTasks: readonly TaskRun[],
  visibleTasks: readonly TaskRun[],
  reviewIndex: Map<string, TaskReviewActivity>,
  now = Date.now(),
): AgentRunFilterSummary {
  const statuses: AgentRunFilterSummary['statuses'] = {
    running: 0,
    waiting: 0,
    blocked: 0,
    errored: 0,
    complete: 0,
    cancelled: 0,
  }
  const agentCounts = new Map<string, number>()

  for (const task of allTasks) {
    const activity = reviewActivityForTask(reviewIndex, task.id)
    statuses[agentRunStatusForTask(task, activity)] += 1
    const agentId = task.agent || ''
    agentCounts.set(agentId, (agentCounts.get(agentId) || 0) + 1)
  }

  const metrics = visibleTasks.reduce<TaskRunMetrics>((acc, task) => {
    const next = buildTaskRunMetrics(task, reviewActivityForTask(reviewIndex, task.id), now)
    return {
      durationMs: Math.max(acc.durationMs, next.durationMs),
      tokenTotal: acc.tokenTotal + next.tokenTotal,
      cost: acc.cost + next.cost,
      toolCount: acc.toolCount + next.toolCount,
      approvalCount: acc.approvalCount + next.approvalCount,
      questionCount: acc.questionCount + next.questionCount,
      artifactCount: acc.artifactCount + next.artifactCount,
      lastEventAt: latestIso(acc.lastEventAt, next.lastEventAt),
      lastOrder: Math.max(acc.lastOrder, next.lastOrder),
    }
  }, emptyTaskRunMetrics())

  return {
    total: allTasks.length,
    filtered: visibleTasks.length,
    statuses,
    agents: Array.from(agentCounts.entries())
      .map(([id, count]) => ({ id, label: id || 'Sub-agent', count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    metrics,
  }
}

function emptyTaskRunMetrics(): TaskRunMetrics {
  return {
    durationMs: 0,
    tokenTotal: 0,
    cost: 0,
    toolCount: 0,
    approvalCount: 0,
    questionCount: 0,
    artifactCount: 0,
    lastEventAt: null,
    lastOrder: 0,
  }
}

function latestIso(left: string | null, right: string | null) {
  if (!left) return right
  if (!right) return left
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right
}
