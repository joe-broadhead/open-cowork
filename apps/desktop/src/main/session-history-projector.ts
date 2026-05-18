import { isInternalCoworkMessage } from './internal-message-utils.ts'
import {
  normalizeTodoItems,
  normalizeSessionMessages,
  normalizeSessionStatuses,
  type NormalizedMessagePart,
} from './opencode-adapter.ts'
import type { TodoItem } from '@open-cowork/shared'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.ts'
import {
  collectHistoryTextParts,
  createHistoryCostPayload,
  getHistoryModelMeta,
  toHistorySortTime,
} from './session-history-projection-utils.ts'
import {
  timingFromChild,
  type ChildSessionRecord,
  type TaskStatus,
} from './session-history-task-binding.ts'

type TaskRunSnapshot = {
  title: string
  agent: string | null
  status: TaskStatus
  sourceSessionId: string | null
  parentSessionId?: string | null
  // Carry the child session's created/updated timestamps so the
  // renderer's ElapsedClock has real anchors to compute duration
  // against on history replay. Without these, rehydrated subagent
  // lanes render "ran 0s" because both timestamps default to null
  // and the defensive backfill can't recover them.
  startedAt?: string | null
  finishedAt?: string | null
}

export type ProjectedHistoryItem = {
  type?: string
  id: string
  role?: string
  content?: string
  messageId?: string
  partId?: string
  timestamp: string
  sequence: number
  providerId?: string | null
  modelId?: string | null
  taskRunId?: string
  taskRun?: TaskRunSnapshot
  todos?: TodoItem[]
  tool?: {
    name: string
    input: Record<string, unknown>
    status: string
    output?: unknown
    attachments?: Array<{ mime: string; url: string; filename?: string }>
    agent?: string | null
    sourceSessionId?: string | null
  }
  cost?: {
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }
  compaction?: {
    status: 'compacting' | 'compacted'
    auto: boolean
    overflow: boolean
    sourceSessionId?: string | null
  }
}

type ProjectSessionHistoryInput = {
  sessionId: string
  cachedModelId: string
  rootMessages: unknown[]
  rootTodos: unknown[]
  children: ChildSessionRecord[]
  statuses: Record<string, { type: string | null }>
  loadChildSnapshot: (childId: string) => Promise<{ messages: unknown[]; todos: unknown[] }>
  generateId?: () => string
}

function isTerminalStepFinishReason(reason: string | null | undefined) {
  if (!reason) return false
  const normalized = reason.toLowerCase()
  return normalized !== 'tool-calls' && normalized !== 'tool_calls'
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function taskToolDescriptor(part: NormalizedMessagePart, child?: ChildSessionRecord | null) {
  const inputAgent = stringField(part.state.input, 'agent')
  const argsAgent = stringField(part.state.args, 'agent')
  const metadataAgent = stringField(part.state.metadata, 'agent') || stringField(part.metadata, 'agent')
  const inputDescription = stringField(part.state.input, 'description')
  const argsDescription = stringField(part.state.args, 'description')
  const inputTitle = stringField(part.state.input, 'title')
  const argsTitle = stringField(part.state.args, 'title')
  const inputPrompt = stringField(part.state.input, 'prompt')
  const argsPrompt = stringField(part.state.args, 'prompt')
  const titleCandidates = [
    part.description,
    inputDescription,
    argsDescription,
    part.title,
    part.state.title,
    inputTitle,
    argsTitle,
    inputPrompt,
    argsPrompt,
    part.prompt,
    part.state.raw,
    part.raw,
    child?.title,
  ]
  const agent = normalizeAgentName(part.agent)
    || normalizeAgentName(inputAgent)
    || normalizeAgentName(argsAgent)
    || normalizeAgentName(metadataAgent)
    || extractAgentName(...titleCandidates)
    || null

  return { agent, titleCandidates }
}

function fallbackTaskToolStatus(part: NormalizedMessagePart): TaskStatus {
  const status = part.state.status || ''
  if (status === 'error' || part.state.error !== undefined) return 'error'
  if (status === 'completed' || status === 'complete' || part.state.output !== undefined) return 'complete'
  return 'queued'
}

function normalizeMatchText(value: string | null | undefined) {
  return (value || '')
    .toLowerCase()
    .replace(/@\w[\w-]*/g, ' ')
    .replace(/\bsubagent\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function childLooksLikeTaskTool(part: NormalizedMessagePart, child: ChildSessionRecord) {
  const childTitle = normalizeMatchText(child.title)
  if (!childTitle) return false

  const descriptor = taskToolDescriptor(part)
  const titleCandidates = descriptor.titleCandidates
    .map(normalizeMatchText)
    .filter((candidate) => candidate.length >= 8)
  if (titleCandidates.length > 0) {
    return titleCandidates.some((candidate) => childTitle.includes(candidate) || candidate.includes(childTitle))
  }

  const agent = normalizeMatchText(descriptor.agent)
  return agent.length > 0 && childTitle.includes(agent)
}

export async function projectSessionHistory(input: ProjectSessionHistoryInput): Promise<ProjectedHistoryItem[]> {
  const { sessionId, cachedModelId, rootMessages, rootTodos, statuses, loadChildSnapshot } = input
  const generateId = input.generateId || crypto.randomUUID
  const normalizedRootMessages = rootMessages
    .map((rawMsg) => normalizeSessionMessages([rawMsg])[0])
    .filter((msg): msg is NonNullable<ReturnType<typeof normalizeSessionMessages>[number]> => Boolean(msg))
  type InternalProjectedHistoryItem = ProjectedHistoryItem & { sortTime: number }
  const normalizedStatuses = normalizeSessionStatuses(statuses)
  const statusFor = (id: string) => normalizedStatuses[id] || { type: null }
  const children = (input.children || [])
    .slice()
    .sort((a, b) => (a?.time?.created || 0) - (b?.time?.created || 0))
  const directChildren = children.filter((child) => (child.parentSessionId || sessionId) === sessionId)
  const rootStatus = statusFor(sessionId).type || null
  const childCompletesById = new Map<string, boolean>()

  let sequence = 0
  const nextOrder = () => ++sequence
  const out: InternalProjectedHistoryItem[] = []
  const taskRunItems = new Map<string, InternalProjectedHistoryItem>()
  const childByTaskId = new Map<string, ChildSessionRecord>()
  const childTaskQueue: Array<[string, ChildSessionRecord]> = []
  const matchedChildIds = new Set<string>()

  const pushItem = (item: ProjectedHistoryItem, sortTime: number) => {
    out.push({
      ...item,
      sortTime,
    })
  }

  const getTaskStatus = (childId?: string | null): TaskStatus => {
    if (!childId) return 'queued'
    const status = statusFor(childId).type
    const isTerminal = childCompletesById.get(childId)
    if (status === 'busy') return 'running'
    if (status === 'idle') return isTerminal ? 'complete' : (rootStatus === 'busy' ? 'running' : 'queued')
    if (isTerminal) return 'complete'
    if (rootStatus === 'busy') return 'running'
    if (rootStatus === 'idle') return 'complete'
    return 'queued'
  }

  const addTaskRun = (taskRun: {
    id: string
    title: string
    agent: string | null
    status: TaskStatus
    sourceSessionId: string | null
    parentSessionId?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }, timestamp: string, sortTime: number) => {
    const item: InternalProjectedHistoryItem = {
      type: 'task_run',
      id: taskRun.id,
      timestamp,
      sequence: nextOrder(),
      taskRun,
      sortTime,
    }
    out.push(item)
    taskRunItems.set(taskRun.id, item)
    return item
  }

  const enqueueChildTask = (taskId: string, child: ChildSessionRecord) => {
    if (childByTaskId.has(taskId)) {
      childByTaskId.set(taskId, child)
      return
    }
    childByTaskId.set(taskId, child)
    childTaskQueue.push([taskId, child])
  }

  const childBelongsToParent = (child: ChildSessionRecord, parentSessionId: string) => {
    return (child.parentSessionId || sessionId) === parentSessionId
  }

  const takeChildForTaskTool = (
    parentSessionId: string,
    part: NormalizedMessagePart,
    requireTaskMatch: boolean,
  ) => {
    for (const child of children) {
      if (matchedChildIds.has(child.id) || !childBelongsToParent(child, parentSessionId)) continue
      if (requireTaskMatch && !childLooksLikeTaskTool(part, child)) continue
      matchedChildIds.add(child.id)
      return child
    }
    return null
  }

  const enqueueUnmatchedChildren = (parentSessionId?: string) => {
    for (const child of children) {
      if (matchedChildIds.has(child.id)) continue
      if (parentSessionId && !childBelongsToParent(child, parentSessionId)) continue
      const taskId = `child:${child.id}`
      const agent = extractAgentName(child.title)
      const sortTime = toHistorySortTime(child.time?.created || Date.now())
      const childStatus = getTaskStatus(child.id)
      const timing = timingFromChild(child, childStatus)
      addTaskRun({
        id: taskId,
        title: chooseTaskTitle(agent, child.title),
        agent,
        status: childStatus,
        sourceSessionId: child.id,
        parentSessionId: child.parentSessionId || sessionId,
        startedAt: timing.startedAt,
        finishedAt: timing.finishedAt,
      }, toIsoTimestamp(sortTime), sortTime)
      matchedChildIds.add(child.id)
      enqueueChildTask(taskId, child)
    }
  }

  let nextDirectChildIndex = 0
  const nextAvailableDirectChild = () => {
    while (nextDirectChildIndex < directChildren.length) {
      const child = directChildren[nextDirectChildIndex]
      if (child && !matchedChildIds.has(child.id)) return child
      nextDirectChildIndex += 1
    }
    return null
  }
  const takeDirectChildForSubtask = (accept?: (child: ChildSessionRecord) => boolean) => {
    if (!accept) {
      const child = nextAvailableDirectChild()
      if (!child) return null
      nextDirectChildIndex += 1
      return child
    }

    while (nextDirectChildIndex < directChildren.length) {
      const current = directChildren[nextDirectChildIndex]
      if (current && !matchedChildIds.has(current.id)) break
      nextDirectChildIndex += 1
    }

    for (let index = nextDirectChildIndex; index < directChildren.length; index += 1) {
      const child = directChildren[index]
      if (!child || matchedChildIds.has(child.id) || !accept(child)) continue
      if (index === nextDirectChildIndex) nextDirectChildIndex += 1
      return child
    }
    return null
  }

  for (const msg of normalizedRootMessages) {
    const info = msg.info
    const parts = msg.parts
    const tsMs = toHistorySortTime(info.time.created || msg.time.created || Date.now())
    const ts = toIsoTimestamp(tsMs)
    const msgId = info.id || msg.id || generateId()
    const role = info.role || msg.role || 'assistant'
    const modelMeta = getHistoryModelMeta(msg)
    const { fullText } = collectHistoryTextParts(parts)

    let textIndex = 0
    let reasoningIndex = 0
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        const partId = part.id || `${msgId}:part:${textIndex++}`
        if (fullText && !isInternalCoworkMessage(fullText)) {
          pushItem({
            type: 'message',
            id: `${msgId}:${partId}:text`,
            messageId: msgId,
            partId,
            role,
            content: part.text || '',
            timestamp: ts,
            sequence: nextOrder(),
            providerId: modelMeta.providerId,
            modelId: modelMeta.modelId,
          }, tsMs)
        }
        continue
      }

      if (part.type === 'reasoning' && role === 'assistant' && typeof part.text === 'string' && part.text.length > 0) {
        const partId = part.id || `${msgId}:reasoning:${reasoningIndex++}`
        pushItem({
          type: 'message_reasoning',
          id: `${msgId}:${partId}:reasoning`,
          messageId: msgId,
          partId,
          role,
          content: part.text || '',
          timestamp: ts,
          sequence: nextOrder(),
          providerId: modelMeta.providerId,
          modelId: modelMeta.modelId,
        }, tsMs)
        continue
      }

      if (part.type === 'subtask') {
        const child = takeDirectChildForSubtask()
        const taskId = child?.id
          ? `child:${child.id}`
          : `pending:${part.id || generateId()}`
        const childStatus = getTaskStatus(child?.id || null)
        const timing = timingFromChild(child, childStatus)
        const taskItem = addTaskRun({
          id: taskId,
          title: chooseTaskTitle(
            normalizeAgentName(part.agent) || extractAgentName(part.description, part.title, part.prompt, part.raw, child?.title) || null,
            part.description,
            part.title,
            part.prompt,
            part.raw,
            child?.title,
          ),
          agent: normalizeAgentName(part.agent) || extractAgentName(part.description, part.title, part.prompt, part.raw, child?.title) || null,
          status: childStatus,
          sourceSessionId: child?.id || null,
          // Subtasks attached to root messages are always direct children
          // of the root session — the orchestration tree renders them as
          // lanes at the top level.
          parentSessionId: child?.parentSessionId || sessionId,
          startedAt: timing.startedAt,
          finishedAt: timing.finishedAt,
        }, ts, tsMs)
        if (child) {
          matchedChildIds.add(child.id)
          enqueueChildTask(taskId, child)
        }
        if (!taskItem) continue
        continue
      }

      if (part.type === 'tool' && part.tool === 'task') {
        const fallbackStatus = fallbackTaskToolStatus(part)
        const requireTaskMatch = fallbackStatus === 'complete' || fallbackStatus === 'error'
        const child = takeDirectChildForSubtask((candidate) => {
          return !requireTaskMatch || childLooksLikeTaskTool(part, candidate)
        })
        const taskId = child?.id
          ? `child:${child.id}`
          : `pending:${part.callId || part.id || generateId()}`
        const childStatus = child ? getTaskStatus(child.id) : fallbackStatus
        const timing = timingFromChild(child, childStatus)
        const descriptor = taskToolDescriptor(part, child)
        const taskItem = addTaskRun({
          id: taskId,
          title: chooseTaskTitle(descriptor.agent, ...descriptor.titleCandidates),
          agent: descriptor.agent,
          status: childStatus,
          sourceSessionId: child?.id || null,
          parentSessionId: child?.parentSessionId || sessionId,
          startedAt: timing.startedAt,
          finishedAt: timing.finishedAt,
        }, ts, tsMs)
        if (child) {
          matchedChildIds.add(child.id)
          enqueueChildTask(taskId, child)
        }
        if (!taskItem) continue
        continue
      }

      if (part.type === 'compaction') {
        pushItem({
          type: 'compaction',
          id: part.id || generateId(),
          timestamp: ts,
          sequence: nextOrder(),
          compaction: {
            status: 'compacted',
            auto: !!part.auto,
            overflow: !!part.overflow,
            sourceSessionId: sessionId,
          },
        }, tsMs)
        continue
      }

      if (part.type === 'tool' && part.tool && part.tool !== 'task' && part.tool !== 'question') {
        const state = part.state
        pushItem({
          type: 'tool',
          id: part.callId || part.id || generateId(),
          timestamp: ts,
          sequence: nextOrder(),
          tool: {
            name: part.tool === 'task' && part.title ? part.title : part.tool,
            input: state.input,
            status: state.output ? 'complete' : state.error ? 'error' : 'complete',
            output: state.output,
            agent: typeof state.metadata.agent === 'string'
              ? state.metadata.agent
              : typeof part.metadata.agent === 'string'
                ? part.metadata.agent
                : null,
          },
        }, tsMs)
        continue
      }

      if (part.type === 'step-finish' && (part.cost || part.tokens)) {
        pushItem({
          type: 'cost',
          id: part.id || generateId(),
          timestamp: ts,
          sequence: nextOrder(),
          cost: createHistoryCostPayload(cachedModelId, part),
        }, tsMs)
      }
    }
  }

  if (rootTodos.length > 0) {
    const todos = normalizeTodoItems(rootTodos)
    if (todos.length > 0) {
      const todosTs = Date.now()
      pushItem({
        type: 'todos',
        id: `todos:${sessionId}`,
        timestamp: toIsoTimestamp(todosTs),
        sequence: nextOrder(),
        todos,
      }, todosTs)
    }
  }

  // Queue direct orphan children before replaying child transcripts, but hold
  // nested orphans until each parent transcript has a chance to bind task tools.
  enqueueUnmatchedChildren(sessionId)

  let taskQueueIndex = 0
  let fallbackChildrenQueued = false
  while (taskQueueIndex < childTaskQueue.length || !fallbackChildrenQueued) {
    if (taskQueueIndex >= childTaskQueue.length) {
      fallbackChildrenQueued = true
      enqueueUnmatchedChildren()
      continue
    }
    const [taskId, child] = childTaskQueue[taskQueueIndex]
    taskQueueIndex += 1
    const { messages: childMessages, todos: childTodos } = await loadChildSnapshot(child.id)
    const normalizedChildTodos = normalizeTodoItems(childTodos)
    const taskRunItem = taskRunItems.get(taskId)
    let childHasTerminalStop = false

    for (const rawMsg of childMessages) {
      const msg = normalizeSessionMessages([rawMsg])[0]
      if (!msg) continue
      const info = msg.info
      const parts = msg.parts
      const tsMs = toHistorySortTime(info.time.created || msg.time.created || Date.now())
      const ts = toIsoTimestamp(tsMs)
      const role = info.role || msg.role || 'assistant'
      const modelMeta = getHistoryModelMeta(msg)
      const { fullText } = collectHistoryTextParts(parts)

      for (const part of parts) {
        if (part.type === 'agent' && taskRunItem?.taskRun) {
          taskRunItem.taskRun.agent = normalizeAgentName(part.name || null)
            || extractAgentName(fullText, part.name)
            || taskRunItem.taskRun.agent
          taskRunItem.taskRun.title = chooseTaskTitle(
            taskRunItem.taskRun.agent,
            !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
          )
        }
        if (part.type === 'step-finish' && isTerminalStepFinishReason(part.reason)) {
          childHasTerminalStop = true
        }
      }

      if (role === 'user' && taskRunItem?.taskRun) {
        taskRunItem.taskRun.title = chooseTaskTitle(
          taskRunItem.taskRun.agent,
          !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
          fullText,
        )
      }

      let textIndex = 0
      let reasoningIndex = 0
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          const messageId = info.id || generateId()
          const partId = part.id || `${messageId}:part:${textIndex++}`
          if (fullText && !isInternalCoworkMessage(fullText)) {
            pushItem({
              type: 'task_text',
              id: `${taskId}:${messageId}:${partId}:text`,
              timestamp: ts,
              sequence: nextOrder(),
              taskRunId: taskId,
              messageId,
              partId,
              content: part.text || '',
              providerId: modelMeta.providerId,
              modelId: modelMeta.modelId,
            }, tsMs)
          }
          continue
        }

        if (part.type === 'reasoning' && role === 'assistant' && typeof part.text === 'string' && part.text.length > 0) {
          const messageId = info.id || generateId()
          const partId = part.id || `${messageId}:reasoning:${reasoningIndex++}`
          pushItem({
            type: 'task_reasoning',
            id: `${taskId}:${messageId}:${partId}:reasoning`,
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            messageId,
            partId,
            content: part.text || '',
            providerId: modelMeta.providerId,
            modelId: modelMeta.modelId,
          }, tsMs)
          continue
        }

        if (part.type === 'compaction') {
          pushItem({
            type: 'task_compaction',
            id: `${taskId}:${part.id || generateId()}:compaction`,
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            compaction: {
              status: 'compacted',
              auto: !!part.auto,
              overflow: !!part.overflow,
              sourceSessionId: child.id,
            },
          }, tsMs)
          continue
        }

        if (part.type === 'tool' && part.tool === 'task') {
          const fallbackStatus = fallbackTaskToolStatus(part)
          const requireTaskMatch = fallbackStatus === 'complete' || fallbackStatus === 'error'
          const nestedChild = takeChildForTaskTool(child.id, part, requireTaskMatch)
          const nestedTaskId = nestedChild?.id
            ? `child:${nestedChild.id}`
            : `pending:${part.callId || part.id || generateId()}`
          const nestedStatus = nestedChild ? getTaskStatus(nestedChild.id) : fallbackStatus
          const timing = timingFromChild(nestedChild, nestedStatus)
          const descriptor = taskToolDescriptor(part, nestedChild)
          addTaskRun({
            id: nestedTaskId,
            title: chooseTaskTitle(descriptor.agent, ...descriptor.titleCandidates),
            agent: descriptor.agent,
            status: nestedStatus,
            sourceSessionId: nestedChild?.id || null,
            parentSessionId: nestedChild?.parentSessionId || child.id,
            startedAt: timing.startedAt,
            finishedAt: timing.finishedAt,
          }, ts, tsMs)
          if (nestedChild) enqueueChildTask(nestedTaskId, nestedChild)
          continue
        }

        if (part.type === 'tool' && part.tool) {
          const state = part.state
          const title = part.title || ''
          const toolOutput = state.output
          pushItem({
            type: 'task_tool',
            id: part.callId || part.id || generateId(),
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            tool: {
              name: part.tool === 'task' && title ? title : part.tool,
              input: state.input,
              status: toolOutput ? 'complete' : state.error ? 'error' : 'complete',
              output: toolOutput,
              attachments: state.attachments,
              agent: normalizeAgentName(
                (typeof state.metadata.agent === 'string' ? state.metadata.agent : null)
                || (typeof part.metadata.agent === 'string' ? part.metadata.agent : null),
              )
                || extractAgentName(title, state.title, state.raw)
                || taskRunItem?.taskRun?.agent
                || null,
              sourceSessionId: child.id,
            },
          }, tsMs)
          continue
        }

        if (part.type === 'step-finish' && (part.cost || part.tokens)) {
          pushItem({
            type: 'task_cost',
            id: `${taskId}:${part.id || generateId()}:cost`,
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            cost: createHistoryCostPayload(cachedModelId, part),
          }, tsMs)
        }
      }
    }

    childCompletesById.set(child.id, childHasTerminalStop)
    if (taskRunItem?.taskRun) {
      const nextStatus = getTaskStatus(child.id)
      const timing = timingFromChild(child, nextStatus)
      taskRunItem.taskRun.status = nextStatus
      taskRunItem.taskRun.startedAt = timing.startedAt
      taskRunItem.taskRun.finishedAt = timing.finishedAt
    }

    if (normalizedChildTodos.length > 0) {
      const todoSortTime = toHistorySortTime(child.time?.updated || child.time?.created || Date.now())
      pushItem({
        type: 'task_todos',
        id: `${taskId}:todos`,
        timestamp: toIsoTimestamp(todoSortTime),
        sequence: nextOrder(),
        taskRunId: taskId,
        todos: normalizedChildTodos,
      }, todoSortTime)
    }
  }

  return out
    .sort((a, b) => {
      const timeDiff = a.sortTime - b.sortTime
      return timeDiff !== 0 ? timeDiff : a.sequence - b.sequence
    })
    .map(({ sortTime: _sortTime, ...item }, index) => ({
      ...item,
      sequence: index + 1,
    }))
}
