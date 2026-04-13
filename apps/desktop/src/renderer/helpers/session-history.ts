type MessageLike = { id: string; role: 'user' | 'assistant'; content: string }
type SessionStateLike = {
  messages?: MessageLike[]
  messageIds?: string[]
  messageById?: Record<string, { id: string; role: 'user' | 'assistant' }>
  toolCalls: Array<unknown>
  taskRuns: Array<unknown>
  pendingApprovals: Array<unknown>
  errors: Array<unknown>
  todos?: Array<unknown>
  compactions?: Array<unknown>
}

function currentMessageCount(state: SessionStateLike) {
  if (Array.isArray(state.messages) && state.messages.length > 0) return state.messages.length
  if (Array.isArray(state.messageIds)) return state.messageIds.length
  if (state.messageById && typeof state.messageById === 'object') return Object.keys(state.messageById).length
  return 0
}

function hasVisibleCurrentRootMessages(state: SessionStateLike) {
  if (Array.isArray(state.messages) && state.messages.length > 0) {
    return state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
  }

  if (state.messageIds && state.messageById) {
    return state.messageIds.some((messageId) => {
      const message = state.messageById?.[messageId]
      return message?.role === 'user' || message?.role === 'assistant'
    })
  }

  return false
}

type HistoryItemLike = {
  type?: string
  id?: string
  messageId?: string
  role?: string
}

function historyMessageCount(items: HistoryItemLike[]) {
  const ids = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (item.type !== 'message' && !item.role) continue
    ids.add(item.messageId || item.id || `message:${index}`)
  }
  return ids.size
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

function historyTodoCount(items: HistoryItemLike[]) {
  return items.filter((item) => item.type === 'todos' || item.type === 'task_todos').length
}

export function hasRenderableHistoryState(state?: SessionStateLike | null) {
  if (!state) return false
  return currentMessageCount(state) > 0
    || state.toolCalls.length > 0
    || state.taskRuns.length > 0
    || state.pendingApprovals.length > 0
    || state.errors.length > 0
    || (state.todos?.length || 0) > 0
    || (state.compactions?.length || 0) > 0
}

export function hasVisibleRootMessages(state?: SessionStateLike | null) {
  if (!state) return false
  return hasVisibleCurrentRootMessages(state)
}

export function historyLooksRicher(
  current: SessionStateLike | null | undefined,
  items: HistoryItemLike[],
) {
  if (!current) return items.length > 0

  const incomingMessageCount = historyMessageCount(items)
  if (incomingMessageCount > currentMessageCount(current)) return true
  if (!hasVisibleCurrentRootMessages(current) && incomingMessageCount > 0) return true

  if (historyTaskRunCount(items) > current.taskRuns.length) return true
  if (historyToolCount(items) > current.toolCalls.length) return true
  if (historyTodoCount(items) > (current.todos?.length || 0)) return true
  if (historyCompactionCount(items) > (current.compactions?.length || 0)) return true

  return false
}
