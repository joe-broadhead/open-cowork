import type {
  Message,
  MessageSegment,
  ToolCall,
  PendingApproval,
  SessionError,
  TaskRun,
  CompactionNotice,
} from '../../stores/session'

export type TimelineItem =
  | { kind: 'message'; data: Message; key: string; actionsEnabled: boolean }
  | { kind: 'tools'; data: ToolCall[] }
  | { kind: 'task'; data: TaskRun }
  | { kind: 'task_group'; data: TaskRun[] }
  | { kind: 'compaction'; data: CompactionNotice }
  | { kind: 'approval'; data: PendingApproval }
  | { kind: 'error'; data: SessionError }

type OrderedTimelineItem =
  | { kind: 'message'; data: Message; order: number }
  | {
      kind: 'message_segment'
      data: Message
      segment: MessageSegment
      segmentIndex: number
      segmentCount: number
      order: number
    }
  | { kind: 'tool'; data: ToolCall; order: number }
  | { kind: 'task'; data: TaskRun; order: number }
  | { kind: 'compaction'; data: CompactionNotice; order: number }
  | { kind: 'approval'; data: PendingApproval; order: number }
  | { kind: 'error'; data: SessionError; order: number }

type MessageSegmentTimelineItem = Extract<OrderedTimelineItem, { kind: 'message_segment' }>

function messageTimelineItems(message: Message): OrderedTimelineItem[] {
  const segments = message.segments && message.segments.length > 0
    ? message.segments
    : message.content
      ? [{ id: `${message.id}:content`, content: message.content, order: message.order }]
      : []

  const visibleSegments = segments
    .filter((segment) => segment.content.length > 0)
    .slice()
    .sort((left, right) => left.order - right.order)

  if (visibleSegments.length === 0) {
    return [{ kind: 'message', data: message, order: message.order }]
  }

  return visibleSegments.map((segment, segmentIndex) => ({
    kind: 'message_segment' as const,
    data: message,
    segment,
    segmentIndex,
    segmentCount: visibleSegments.length,
    order: segment.order,
  }))
}

function buildGroupedMessage(
  items: MessageSegmentTimelineItem[],
): { message: Message; key: string; actionsEnabled: boolean } | null {
  const first = items[0]
  if (!first) return null
  const segments = items.map((item) => item.segment)
  const includesFirstSegment = items.some((item) => item.segmentIndex === 0)
  const includesWholeMessage = items.length === first.segmentCount && first.segmentIndex === 0

  return {
    message: {
      ...first.data,
      id: first.data.id,
      content: segments.map((segment) => segment.content).join(''),
      segments,
      attachments: includesFirstSegment ? first.data.attachments : undefined,
      reasoning: includesFirstSegment ? first.data.reasoning : undefined,
      order: segments[0]?.order ?? first.data.order,
    },
    key: includesWholeMessage
      ? `msg:${first.data.id}`
      : `msg:${first.data.id}:timeline:${segments[0]?.id || 'segment'}`,
    actionsEnabled: includesWholeMessage,
  }
}

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
    ...messages.flatMap(messageTimelineItems),
    ...toolCalls.map((tc) => ({ kind: 'tool' as const, data: tc, order: tc.order })),
    ...taskRuns.map((tr) => ({ kind: 'task' as const, data: tr, order: tr.order })),
    ...compactions.map((c) => ({ kind: 'compaction' as const, data: c, order: c.order })),
    ...approvals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
    ...errors.map((e) => ({ kind: 'error' as const, data: e, order: e.order })),
  ].sort((a, b) => a.order - b.order)

  const result: TimelineItem[] = []
  let toolGroup: ToolCall[] = []
  let taskGroup: TaskRun[] = []
  let messageGroup: MessageSegmentTimelineItem[] = []

  const flushToolGroup = () => {
    if (toolGroup.length === 0) return
    result.push({ kind: 'tools', data: [...toolGroup] })
    toolGroup = []
  }

  const flushMessageGroup = () => {
    const grouped = buildGroupedMessage(messageGroup)
    if (grouped) {
      result.push({
        kind: 'message',
        data: grouped.message,
        key: grouped.key,
        actionsEnabled: grouped.actionsEnabled,
      })
    }
    messageGroup = []
  }

  const flushTaskGroup = () => {
    if (taskGroup.length === 0) return
    if (taskGroup.length === 1) {
      result.push({ kind: 'task', data: taskGroup[0]! })
    } else {
      result.push({ kind: 'task_group', data: [...taskGroup] })
    }
    taskGroup = []
  }

  for (const item of rawItems) {
    if (item.kind === 'message_segment') {
      flushToolGroup()
      flushTaskGroup()
      const currentMessage = messageGroup[0]?.data
      if (currentMessage && (currentMessage.id !== item.data.id || currentMessage.role !== item.data.role)) {
        flushMessageGroup()
      }
      messageGroup.push(item)
      continue
    }

    if (item.kind === 'tool') {
      flushMessageGroup()
      flushTaskGroup()
      toolGroup.push(item.data)
      continue
    }

    if (item.kind === 'task') {
      flushMessageGroup()
      flushToolGroup()
      taskGroup.push(item.data)
      continue
    }

    flushMessageGroup()
    flushToolGroup()
    flushTaskGroup()
    if (item.kind === 'message') {
      result.push({ kind: 'message', data: item.data, key: `msg:${item.data.id}`, actionsEnabled: true })
    } else if (item.kind === 'compaction') {
      result.push({ kind: 'compaction', data: item.data })
    } else if (item.kind === 'approval') {
      result.push({ kind: 'approval', data: item.data })
    } else if (item.kind === 'error') {
      result.push({ kind: 'error', data: item.data })
    }
  }

  flushMessageGroup()
  flushToolGroup()
  flushTaskGroup()
  return result
}
