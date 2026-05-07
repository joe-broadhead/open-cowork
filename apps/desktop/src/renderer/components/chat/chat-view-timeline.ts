import type { Message, ToolCall, PendingApproval, SessionError, TaskRun, CompactionNotice } from '../../stores/session'

export type TimelineItem =
  | { kind: 'message'; data: Message }
  | { kind: 'tools'; data: ToolCall[] }
  | { kind: 'task'; data: TaskRun }
  | { kind: 'task_group'; data: TaskRun[] }
  | { kind: 'compaction'; data: CompactionNotice }
  | { kind: 'approval'; data: PendingApproval }
  | { kind: 'error'; data: SessionError }

type OrderedTimelineItem =
  | { kind: 'message'; data: Message; order: number }
  | { kind: 'tool'; data: ToolCall; order: number }
  | { kind: 'task'; data: TaskRun; order: number }
  | { kind: 'compaction'; data: CompactionNotice; order: number }
  | { kind: 'approval'; data: PendingApproval; order: number }
  | { kind: 'error'; data: SessionError; order: number }

export function buildChatTimeline({
  messages,
  toolCalls,
  taskRuns,
  compactions,
  approvals,
  errors,
}: {
  messages: readonly Message[]
  toolCalls: readonly ToolCall[]
  taskRuns: readonly TaskRun[]
  compactions: readonly CompactionNotice[]
  approvals: readonly PendingApproval[]
  errors: readonly SessionError[]
}): TimelineItem[] {
  const rawItems: OrderedTimelineItem[] = [
    ...messages.map((m) => ({ kind: 'message' as const, data: m, order: m.order })),
    ...toolCalls.map((tc) => ({ kind: 'tool' as const, data: tc, order: tc.order })),
    ...taskRuns.map((tr) => ({ kind: 'task' as const, data: tr, order: tr.order })),
    ...compactions.map((c) => ({ kind: 'compaction' as const, data: c, order: c.order })),
    ...approvals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
    ...errors.map((e) => ({ kind: 'error' as const, data: e, order: e.order })),
  ].sort((a, b) => a.order - b.order)

  const result: TimelineItem[] = []
  let toolGroup: ToolCall[] = []
  let taskGroup: TaskRun[] = []

  const flushToolGroup = () => {
    if (toolGroup.length === 0) return
    result.push({ kind: 'tools', data: [...toolGroup] })
    toolGroup = []
  }

  const flushTaskGroup = () => {
    if (taskGroup.length === 0) return
    if (taskGroup.length === 1) {
      result.push({ kind: 'task', data: taskGroup[0] })
    } else {
      result.push({ kind: 'task_group', data: [...taskGroup] })
    }
    taskGroup = []
  }

  for (const item of rawItems) {
    if (item.kind === 'tool') {
      flushTaskGroup()
      toolGroup.push(item.data)
      continue
    }

    if (item.kind === 'task') {
      flushToolGroup()
      taskGroup.push(item.data)
      continue
    }

    flushToolGroup()
    flushTaskGroup()
    if (item.kind === 'message') {
      result.push({ kind: 'message', data: item.data })
    } else if (item.kind === 'compaction') {
      result.push({ kind: 'compaction', data: item.data })
    } else if (item.kind === 'approval') {
      result.push({ kind: 'approval', data: item.data })
    } else if (item.kind === 'error') {
      result.push({ kind: 'error', data: item.data })
    }
  }

  flushToolGroup()
  flushTaskGroup()
  return result
}
