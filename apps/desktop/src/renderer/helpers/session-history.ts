type MessageLike = { id: string; role: 'user' | 'assistant'; content: string }
type SessionStateLike = {
  messages: MessageLike[]
  toolCalls: Array<unknown>
  taskRuns: Array<unknown>
  pendingApprovals: Array<unknown>
  errors: Array<unknown>
  compactions?: Array<unknown>
}

type HistoryItemLike = {
  type?: string
  role?: string
}

function historyMessageCount(items: HistoryItemLike[]) {
  return items.filter((item) => item.type === 'message' || (!item.type && item.role)).length
}

function historyTaskRunCount(items: HistoryItemLike[]) {
  return items.filter((item) => item.type === 'task_run').length
}

function historyToolCount(items: HistoryItemLike[]) {
  return items.filter((item) => item.type === 'tool' || item.type === 'task_tool').length
}

function historyCompactionCount(items: HistoryItemLike[]) {
  return items.filter((item) => item.type === 'compaction' || item.type === 'task_compaction').length
}

export function hasRenderableHistoryState(state?: SessionStateLike | null) {
  if (!state) return false
  return state.messages.length > 0
    || state.toolCalls.length > 0
    || state.taskRuns.length > 0
    || state.pendingApprovals.length > 0
    || state.errors.length > 0
    || (state.compactions?.length || 0) > 0
}

export function hasVisibleRootMessages(state?: SessionStateLike | null) {
  if (!state) return false
  return state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
}

export function historyLooksRicher(
  current: SessionStateLike | null | undefined,
  items: HistoryItemLike[],
) {
  if (!current) return items.length > 0

  const incomingMessageCount = historyMessageCount(items)
  if (incomingMessageCount > current.messages.length) return true
  if (!hasVisibleRootMessages(current) && incomingMessageCount > 0) return true

  if (historyTaskRunCount(items) > current.taskRuns.length) return true
  if (historyToolCount(items) > current.toolCalls.length) return true
  if (historyCompactionCount(items) > (current.compactions?.length || 0)) return true

  return false
}
