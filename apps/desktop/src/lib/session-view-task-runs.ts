import type {
  CompactionNotice,
  ExecutionPlanItem,
  ReasoningSegment,
  SessionTokens,
  TaskRun,
  TaskTranscriptSegment,
  ToolCall,
} from '@open-cowork/shared'
import { cloneCompactionNotice } from './session-view-compaction.ts'
import {
  nextOrderFrom,
  nowIsoFromTiming,
  timestampIsoFromTiming,
  type SessionViewTiming,
} from './session-view-order.ts'
import { mergeStreamingText } from './session-view-text.ts'
import { cloneTokens, EMPTY_SESSION_TOKENS } from './session-view-tokens.ts'

function appendTaskTranscript(existing: string, incoming: string, options?: { boundary?: boolean }) {
  if (!incoming) return existing
  if (!existing) return incoming

  const boundary = options?.boundary
    || /^(#{1,6}\s|[-*]\s|\d+\.\s|>|\n)/.test(incoming)
  const separated = existing.endsWith('\n') || incoming.startsWith('\n')

  if (!boundary) {
    return mergeStreamingText(existing, incoming)
  }

  if (separated) {
    return `${existing}${incoming}`
  }

  return `${existing}\n\n${incoming}`
}

function sortTaskTranscript(transcript: TaskTranscriptSegment[]) {
  return transcript.slice().sort((a, b) => a.order - b.order)
}

export function renderTaskTranscript(transcript: TaskTranscriptSegment[]) {
  return sortTaskTranscript(transcript)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('\n\n')
}

function appendTaskTranscriptSegment(
  transcript: TaskTranscriptSegment[],
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean; replace?: boolean; order?: number },
) {
  if (!incoming) return transcript

  const existing = transcript.find((segment) => segment.id === segmentId)
  if (!existing) {
    return [...transcript, { id: segmentId, content: incoming, order: options?.order ?? nextOrderFrom(transcript) }]
  }

  return transcript.map((segment) => segment.id === segmentId
    ? {
        ...segment,
        content: options?.replace ? incoming : appendTaskTranscript(segment.content, incoming, options),
      }
    : segment)
}

export function withTaskTranscript(
  taskRun: TaskRun,
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean; replace?: boolean; order?: number },
) {
  const transcript = appendTaskTranscriptSegment(taskRun.transcript, segmentId, incoming, options)
  return {
    ...taskRun,
    transcript,
    content: renderTaskTranscript(transcript),
  }
}

export function withTaskReasoning(
  taskRun: TaskRun,
  segmentId: string,
  incoming: string,
  options?: { boundary?: boolean; replace?: boolean; order?: number },
) {
  const transcript = taskRun.transcript.filter((segment) => segment.id !== segmentId)
  const reasoning = appendTaskTranscriptSegment(taskRun.reasoning || [], segmentId, incoming, options) as ReasoningSegment[]
  return {
    ...taskRun,
    transcript,
    content: renderTaskTranscript(transcript),
    reasoning,
  }
}

export function createEmptyTaskRun(input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  parentSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  reasoning?: ReasoningSegment[]
  toolCalls?: ToolCall[]
  compactions?: CompactionNotice[]
  todos?: TaskRun['todos']
  error?: string | null
  sessionCost?: number
  sessionTokens?: SessionTokens
  order?: number
  startedAt?: string | null
  finishedAt?: string | null
}, timing?: SessionViewTiming): TaskRun {
  const transcript = input.transcript
    ? input.transcript
    : input.content
      ? [{ id: `${input.id}:initial`, content: input.content, order: 1 }]
      : []

  const status = input.status || 'queued'
  const nowIso = nowIsoFromTiming(timing)

  return {
    id: input.id,
    title: input.title || 'Sub-Agent',
    agent: input.agent || null,
    status,
    sourceSessionId: input.sourceSessionId || null,
    parentSessionId: input.parentSessionId ?? null,
    content: input.content || renderTaskTranscript(transcript),
    transcript,
    ...(input.reasoning && input.reasoning.length > 0 ? { reasoning: input.reasoning } : {}),
    toolCalls: input.toolCalls || [],
    compactions: (input.compactions || []).map(cloneCompactionNotice),
    todos: input.todos || [],
    error: input.error || null,
    sessionCost: input.sessionCost || 0,
    sessionTokens: cloneTokens(input.sessionTokens || EMPTY_SESSION_TOKENS),
    order: input.order ?? timing?.order ?? nextOrderFrom(transcript, input.reasoning, input.toolCalls, input.compactions),
    startedAt: input.startedAt ?? (status === 'running' ? nowIso : null),
    finishedAt: input.finishedAt ?? (status === 'complete' || status === 'error' ? nowIso : null),
  }
}

export function upsertTaskRunList(taskRuns: TaskRun[], input: {
  id: string
  title?: string
  agent?: string | null
  status?: TaskRun['status']
  sourceSessionId?: string | null
  parentSessionId?: string | null
  content?: string
  transcript?: TaskTranscriptSegment[]
  reasoning?: ReasoningSegment[]
  toolCalls?: ToolCall[]
  compactions?: CompactionNotice[]
  todos?: TaskRun['todos']
  error?: string | null
  sessionCost?: number
  sessionTokens?: SessionTokens
  order?: number
  // Optional explicit anchors. Provided by the history replay path so
  // rehydrated terminal tasks don't lose their duration.
  startedAt?: string | null
  finishedAt?: string | null
}, timing?: SessionViewTiming) {
  const existing = taskRuns.find((taskRun) => taskRun.id === input.id)
  if (!existing) {
    return [...taskRuns, createEmptyTaskRun(input, timing)]
  }

  return taskRuns.map((taskRun) => {
    if (taskRun.id !== input.id) return taskRun
    const incoming = input as TaskRun & { startedAt?: string | null; finishedAt?: string | null }
    const nextStatus = input.status !== undefined ? input.status : taskRun.status
    const nowIso = nowIsoFromTiming(timing)
    // Precedence: explicit caller-provided timestamp, existing task
    // timestamp, then derived from status transition. This keeps clocks
    // stable across snapshots while allowing better caller knowledge.
    const startedAt = incoming.startedAt
      ?? taskRun.startedAt
      ?? (nextStatus === 'running' ? nowIso : null)
    const finishedAt = incoming.finishedAt
      ?? taskRun.finishedAt
      ?? ((nextStatus === 'complete' || nextStatus === 'error') ? nowIso : null)
    return {
      ...taskRun,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.transcript !== undefined
        ? {
            transcript: input.transcript,
            content: input.content !== undefined ? input.content : renderTaskTranscript(input.transcript),
          }
        : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.compactions !== undefined ? { compactions: input.compactions.map(cloneCompactionNotice) } : {}),
      ...(input.todos !== undefined ? { todos: input.todos } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.sessionCost !== undefined ? { sessionCost: input.sessionCost } : {}),
      ...(input.sessionTokens !== undefined ? { sessionTokens: cloneTokens(input.sessionTokens) } : {}),
      startedAt,
      finishedAt,
    }
  })
}

export function withTaskRun(
  taskRuns: TaskRun[],
  taskRunId: string,
  updater: (taskRun: TaskRun) => TaskRun,
  timing?: SessionViewTiming,
) {
  const existing = taskRuns.find((taskRun) => taskRun.id === taskRunId) || createEmptyTaskRun({ id: taskRunId }, timing)
  const next = updater(existing)
  return upsertTaskRunList(taskRuns, next, timing)
}

export function deriveExecutionPlan(taskRuns: TaskRun[], busy: boolean): ExecutionPlanItem[] {
  if (taskRuns.length === 0) return []

  const orderedTaskRuns = taskRuns.slice().sort((a, b) => a.order - b.order)
  const anyError = orderedTaskRuns.some((taskRun) => taskRun.status === 'error')
  const allComplete = orderedTaskRuns.every((taskRun) => taskRun.status === 'complete')

  const synthStatus = anyError
    ? 'blocked'
    : allComplete
      ? (busy ? 'in_progress' : 'completed')
      : 'pending'

  return [
    {
      id: 'execution:launch',
      content: `Launch ${orderedTaskRuns.length} sub-agent branch${orderedTaskRuns.length === 1 ? '' : 'es'}`,
      status: 'completed',
      priority: 'high',
    },
    ...orderedTaskRuns.map((taskRun) => ({
      id: `execution:${taskRun.id}`,
      content: taskRun.title,
      status: taskRun.status === 'complete'
        ? 'completed'
        : taskRun.status === 'error'
          ? 'blocked'
          : taskRun.status === 'queued'
            ? 'pending'
            : 'in_progress',
      priority: 'medium',
    })),
    {
      id: 'execution:synthesize',
      content: 'Synthesize the final answer',
      status: synthStatus,
      priority: 'high',
    },
  ]
}

export function ensureTaskRunTimingsForView(taskRuns: TaskRun[], lastEventAt: number, timing?: SessionViewTiming): TaskRun[] {
  // Defensive backfill: keep terminal task clocks bounded when older
  // persisted/hydrated task records are missing timing anchors.
  let patched = false
  const sessionAnchor = lastEventAt > 0 ? timestampIsoFromTiming(lastEventAt, timing) : nowIsoFromTiming(timing)
  const next = taskRuns.map((taskRun) => {
    if (taskRun.status === 'running') {
      if (taskRun.startedAt) return taskRun
      patched = true
      return { ...taskRun, startedAt: sessionAnchor }
    }

    if (taskRun.status === 'complete' || taskRun.status === 'error') {
      const startedAt = taskRun.startedAt ?? taskRun.finishedAt ?? sessionAnchor
      const finishedAt = taskRun.finishedAt ?? startedAt
      if (startedAt !== taskRun.startedAt || finishedAt !== taskRun.finishedAt) {
        patched = true
        return { ...taskRun, startedAt, finishedAt }
      }
    }

    return taskRun
  })
  return patched ? next : taskRuns
}
