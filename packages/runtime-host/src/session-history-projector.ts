import { normalizeTodoItems, normalizeSessionMessages, normalizeSessionStatuses, type NormalizedMessagePart } from './opencode-adapter.js'
import { isInternalCoworkMessage } from './internal-message-utils.js'
import type { TodoItem } from '@open-cowork/shared'
import { deriveToolStatus } from '@open-cowork/shared'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.js'
import {
  collectHistoryTextParts,
  createHistoryCostPayload,
  getHistoryModelMeta,
  toHistorySortTime,
} from './session-history-projection-utils.js'
import {
  timingFromChild,
  type ChildSessionRecord,
  type TaskStatus,
} from './session-history-task-binding.js'

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
  fallbackTimestampMs?: number
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
    || stringField(part.state.input, 'subagent_type')
    || stringField(part.state.input, 'subagentType')
  const argsAgent = stringField(part.state.args, 'agent')
    || stringField(part.state.args, 'subagent_type')
    || stringField(part.state.args, 'subagentType')
  const metadataAgent = stringField(part.state.metadata, 'agent') || stringField(part.metadata, 'agent')
  const inputDescription = stringField(part.state.input, 'description')
  const argsDescription = stringField(part.state.args, 'description')
  const inputTitle = stringField(part.state.input, 'title')
  const argsTitle = stringField(part.state.args, 'title')
  const inputPrompt = stringField(part.state.input, 'prompt')
  const argsPrompt = stringField(part.state.args, 'prompt')
  // Agent IDENTITY is an execution fact OpenCode owns: derive it only from structured
  // fields and OpenCode's own task description/title labels — never from user-supplied
  // prompt/raw content, where a stray "@name" mention would be mis-attributed as the
  // executing agent. Prompt/raw text remains fair game for the human-readable TITLE.
  const agentCandidates = [
    part.description,
    inputDescription,
    argsDescription,
    part.title,
    part.state.title,
    inputTitle,
    argsTitle,
    child?.title,
  ]
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
    || extractAgentName(...agentCandidates)
    || null

  return { agent, titleCandidates }
}

function fallbackTaskToolStatus(part: NormalizedMessagePart): TaskStatus {
  const status = part.state.status || ''
  if (status === 'error' || part.state.error !== undefined) return 'error'
  if (status === 'completed' || status === 'complete' || part.state.output !== undefined) return 'complete'
  return 'queued'
}

function taskToolChildSessionId(part: NormalizedMessagePart) {
  return stringField(part.state.metadata, 'sessionId')
    || stringField(part.state.metadata, 'sessionID')
    || stringField(part.state.metadata, 'session_id')
    || stringField(part.metadata, 'sessionId')
    || stringField(part.metadata, 'sessionID')
    || stringField(part.metadata, 'session_id')
}

function isDelegationPart(part: NormalizedMessagePart) {
  return part.type === 'subtask' || (part.type === 'tool' && part.tool === 'task')
}

function messageCreatedSortTime(msg: NonNullable<ReturnType<typeof normalizeSessionMessages>[number]>) {
  const created = msg.info.time.created || msg.time.created
  return created ? toHistorySortTime(created, 0) : null
}

function childCreatedSortTime(child: ChildSessionRecord) {
  const created = child.time?.created
  return created === null || created === undefined ? null : toHistorySortTime(created, 0)
}

type IndexedChildSession = {
  child: ChildSessionRecord
  sortTime: number
}

function lowerBoundChildSortTime(entries: IndexedChildSession[], target: number) {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const entry = entries[mid]
    if (entry && entry.sortTime < target) low = mid + 1
    else high = mid
  }
  return low
}

export async function projectSessionHistory(input: ProjectSessionHistoryInput): Promise<ProjectedHistoryItem[]> {
  const { sessionId, cachedModelId, rootMessages, rootTodos, statuses, loadChildSnapshot } = input
  const generateId = input.generateId || crypto.randomUUID
  const fallbackSortTime = toHistorySortTime(input.fallbackTimestampMs, 0)
  const normalizedRootMessages = rootMessages
    .map((rawMsg) => normalizeSessionMessages([rawMsg])[0])
    .filter((msg): msg is NonNullable<ReturnType<typeof normalizeSessionMessages>[number]> => Boolean(msg))
  type RootDelegationBoundary = {
    sortTime: number | null
    slotCount: number
  }
  const nextRootDelegationBoundaryByMessageIndex: Array<RootDelegationBoundary | null> = []
  let nextRootDelegationBoundary: RootDelegationBoundary | null = null
  for (let index = normalizedRootMessages.length - 1; index >= 0; index -= 1) {
    const msg = normalizedRootMessages[index]
    nextRootDelegationBoundaryByMessageIndex[index] = nextRootDelegationBoundary
    const slotCount = msg?.parts.filter(isDelegationPart).length || 0
    if (msg && slotCount > 0) {
      nextRootDelegationBoundary = {
        sortTime: messageCreatedSortTime(msg),
        slotCount,
      }
    }
  }
  type InternalProjectedHistoryItem = ProjectedHistoryItem & { sortTime: number }
  const normalizedStatuses = normalizeSessionStatuses(statuses)
  const statusFor = (id: string) => normalizedStatuses[id] || { type: null }
  const children = (input.children || [])
    .slice()
    .sort((a, b) => (a?.time?.created || 0) - (b?.time?.created || 0))
  const childrenById = new Map(children.map((child) => [child.id, child]))
  const childSortTimesById = new Map<string, number | null>()
  const childrenByParentId = new Map<string, ChildSessionRecord[]>()
  const timedChildrenByParentId = new Map<string, IndexedChildSession[]>()
  const parentIdForChild = (child: ChildSessionRecord) => child.parentSessionId || sessionId
  for (const child of children) {
    const parentSessionId = parentIdForChild(child)
    const parentChildren = childrenByParentId.get(parentSessionId)
    if (parentChildren) parentChildren.push(child)
    else childrenByParentId.set(parentSessionId, [child])

    const sortTime = childCreatedSortTime(child)
    childSortTimesById.set(child.id, sortTime)
    if (sortTime !== null) {
      const timedChildren = timedChildrenByParentId.get(parentSessionId)
      const entry = { child, sortTime }
      if (timedChildren) timedChildren.push(entry)
      else timedChildrenByParentId.set(parentSessionId, [entry])
    }
  }
  const childrenForParent = (parentSessionId: string) => childrenByParentId.get(parentSessionId) || []
  const timedChildrenForParent = (parentSessionId: string) => timedChildrenByParentId.get(parentSessionId) || []
  const directChildren = childrenForParent(sessionId)
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

  type TaskToolBindingWindow = {
    after?: number
    before?: number
    excludeUntimed?: boolean
  }

  const taskToolBindingWindow = (messageIndex: number, after: number | null): TaskToolBindingWindow | null => {
    const nextBoundary = nextRootDelegationBoundaryByMessageIndex[messageIndex]
    if (!nextBoundary) return { after: after ?? undefined }
    if (nextBoundary.sortTime === null) {
      // An untimed later delegation is still a real ordering boundary. Without
      // an upper timestamp, implicit binding would be allowed to consume that
      // later child session and leave the actual delegation pending on replay.
      if (after === null) return null
      const availableDirectChildCount = countCandidateChildrenForTaskTool(sessionId, { after })
      return availableDirectChildCount > nextBoundary.slotCount
        ? { after, excludeUntimed: true }
        : null
    }
    return {
      after: after ?? undefined,
      before: nextBoundary.sortTime,
    }
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
    return parentIdForChild(child) === parentSessionId
  }

  const takeExplicitChildForTaskTool = (parentSessionId: string, part: NormalizedMessagePart) => {
    const childSessionId = taskToolChildSessionId(part)
    if (!childSessionId) return { child: null, hasExplicitChild: false }
    const child = childrenById.get(childSessionId)
    if (!child || matchedChildIds.has(child.id) || !childBelongsToParent(child, parentSessionId)) {
      return { child: null, hasExplicitChild: true }
    }
    matchedChildIds.add(child.id)
    return { child, hasExplicitChild: true }
  }

  const candidateChildrenForTaskTool = (
    parentSessionId: string,
    options: TaskToolBindingWindow = {},
    excludedChildIds = new Set<string>(),
  ) => {
    const candidates: ChildSessionRecord[] = []
    for (const child of candidatePoolForTaskTool(parentSessionId, options)) {
      if (isCandidateChildForTaskTool(child, options, excludedChildIds)) candidates.push(child)
    }
    return candidates
  }

  const takeOnlyChildForTaskTool = (
    parentSessionId: string,
    options: TaskToolBindingWindow = {},
    excludedChildIds = new Set<string>(),
  ) => {
    let onlyCandidate: ChildSessionRecord | null = null
    for (const child of candidatePoolForTaskTool(parentSessionId, options)) {
      if (!isCandidateChildForTaskTool(child, options, excludedChildIds)) continue
      if (onlyCandidate) return null
      onlyCandidate = child
    }
    if (onlyCandidate) {
      matchedChildIds.add(onlyCandidate.id)
      return onlyCandidate
    }
    return null
  }

  function candidatePoolForTaskTool(
    parentSessionId: string,
    options: TaskToolBindingWindow,
  ): ChildSessionRecord[] {
    if (options.before === undefined && !options.excludeUntimed) {
      return childrenForParent(parentSessionId)
    }

    const timedChildren = timedChildrenForParent(parentSessionId)
    const start = options.after === undefined
      ? 0
      : lowerBoundChildSortTime(timedChildren, options.after)
    const end = options.before === undefined
      ? timedChildren.length
      : lowerBoundChildSortTime(timedChildren, options.before)
    const candidates: ChildSessionRecord[] = []
    for (let index = start; index < end; index += 1) {
      const entry = timedChildren[index]
      if (entry) candidates.push(entry.child)
    }
    return candidates
  }

  function isCandidateChildForTaskTool(
    child: ChildSessionRecord,
    options: TaskToolBindingWindow,
    excludedChildIds = new Set<string>(),
  ) {
    if (matchedChildIds.has(child.id) || excludedChildIds.has(child.id)) return false
    const created = childSortTimesById.get(child.id) ?? null
    if (created === null && (options.before !== undefined || options.excludeUntimed)) return false
    if (created !== null && options.after !== undefined && created < options.after) return false
    if (created !== null && options.before !== undefined && created >= options.before) return false
    return true
  }

  function countCandidateChildrenForTaskTool(
    parentSessionId: string,
    options: TaskToolBindingWindow = {},
    excludedChildIds = new Set<string>(),
  ) {
    let count = 0
    for (const child of candidatePoolForTaskTool(parentSessionId, options)) {
      if (isCandidateChildForTaskTool(child, options, excludedChildIds)) count += 1
    }
    return count
  }

  const explicitChildIdsForTaskTools = (parts: NormalizedMessagePart[]) => {
    return new Set(
      parts
        .filter((part) => part.type === 'tool' && part.tool === 'task')
        .map(taskToolChildSessionId)
        .filter((id): id is string => Boolean(id)),
    )
  }

  const createOrderedTaskToolChildBinder = (
    parentSessionId: string,
    remainingParts: NormalizedMessagePart[],
    options: TaskToolBindingWindow = {},
  ) => {
    const orderedImplicitBindingParts = remainingParts.filter((part) => (
      part.type === 'subtask'
      || (
        part.type === 'tool'
        && part.tool === 'task'
        && !taskToolChildSessionId(part)
      )
    ))
    const hasOrderedImplicitBindings = orderedImplicitBindingParts.length > 1
    if (!hasOrderedImplicitBindings) {
      return {
        usesOrderedImplicitBindings: false,
        explicitChildIds: explicitChildIdsForTaskTools(remainingParts),
        takeSubtask: () => null as ChildSessionRecord | null,
        take: () => null as ChildSessionRecord | null,
      }
    }

    const explicitChildIds = explicitChildIdsForTaskTools(remainingParts)
    let slotIndex = 0
    let candidateIndex = 0
    const candidates = candidateChildrenForTaskTool(parentSessionId, options, explicitChildIds)
    const remainingTaskToolSlotsFromIndex = new Array<number>(orderedImplicitBindingParts.length + 1).fill(0)
    for (let index = orderedImplicitBindingParts.length - 1; index >= 0; index -= 1) {
      const part = orderedImplicitBindingParts[index]
      remainingTaskToolSlotsFromIndex[index] = remainingTaskToolSlotsFromIndex[index + 1]!
        + (part?.type === 'tool' && part.tool === 'task' && !taskToolChildSessionId(part) ? 1 : 0)
    }
    let remainingCandidateCount = candidates.length
    const skipMatchedCandidates = () => {
      while (candidateIndex < candidates.length) {
        const child = candidates[candidateIndex]
        if (child && !matchedChildIds.has(child.id)) return
        candidateIndex += 1
        remainingCandidateCount -= 1
      }
    }
    const consumeNextCandidate = () => {
      skipMatchedCandidates()
      if (candidateIndex >= candidates.length) return null
      const child = candidates[candidateIndex]
      candidateIndex += 1
      remainingCandidateCount -= 1
      return child && !matchedChildIds.has(child.id) ? child : null
    }
    return {
      usesOrderedImplicitBindings: true,
      explicitChildIds,
      takeSubtask: () => {
        while (slotIndex < orderedImplicitBindingParts.length) {
          const part = orderedImplicitBindingParts[slotIndex]
          if (part?.type !== 'subtask') return null
          slotIndex += 1
          skipMatchedCandidates()
          if (remainingCandidateCount <= remainingTaskToolSlotsFromIndex[slotIndex]!) return null
          return consumeNextCandidate()
        }
        return null
      },
      take: () => {
        while (slotIndex < orderedImplicitBindingParts.length) {
          const part = orderedImplicitBindingParts[slotIndex]
          slotIndex += 1
          if (part?.type !== 'tool' || part.tool !== 'task' || taskToolChildSessionId(part)) continue
          const child = consumeNextCandidate()
          if (!child) return null
          matchedChildIds.add(child.id)
          return child
        }
        return null
      },
    }
  }

  const enqueueUnmatchedChildren = (parentSessionId?: string) => {
    const candidateChildren = parentSessionId ? childrenForParent(parentSessionId) : children
    for (const child of candidateChildren) {
      if (matchedChildIds.has(child.id)) continue
      const taskId = `child:${child.id}`
      const agent = extractAgentName(child.title)
      const sortTime = toHistorySortTime(child.time?.created, fallbackSortTime)
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

  for (let msgIndex = 0; msgIndex < normalizedRootMessages.length; msgIndex += 1) {
    const msg = normalizedRootMessages[msgIndex]
    if (!msg) continue
    const info = msg.info
    const parts = msg.parts
    const childBindingAfter = messageCreatedSortTime(msg)
    const tsMs = childBindingAfter ?? fallbackSortTime
    const ts = toIsoTimestamp(tsMs)
    const msgId = info.id || msg.id || generateId()
    const role = info.role || msg.role || 'assistant'
    const modelMeta = getHistoryModelMeta(msg)
    const { fullText } = collectHistoryTextParts(parts)

    let textIndex = 0
    let reasoningIndex = 0
    let taskToolChildBinder: ReturnType<typeof createOrderedTaskToolChildBinder> | null = null
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]
      if (!part) continue
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
        const child = taskToolChildBinder?.usesOrderedImplicitBindings
          ? taskToolChildBinder.takeSubtask()
          : takeDirectChildForSubtask()
        const taskId = child?.id
          ? `child:${child.id}`
          : `pending:${part.id || generateId()}`
        const childStatus = getTaskStatus(child?.id || null)
        const timing = timingFromChild(child, childStatus)
        const taskItem = addTaskRun({
          id: taskId,
          title: chooseTaskTitle(
            normalizeAgentName(part.agent) || extractAgentName(part.description, part.title, child?.title) || null,
            part.description,
            part.title,
            part.prompt,
            part.raw,
            child?.title,
          ),
          // Agent identity from structured/labeled fields only, not user prompt/raw content.
          agent: normalizeAgentName(part.agent) || extractAgentName(part.description, part.title, child?.title) || null,
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
        const explicit = takeExplicitChildForTaskTool(sessionId, part)
        const bindingWindow = taskToolBindingWindow(msgIndex, childBindingAfter)
        if (!explicit.hasExplicitChild && !taskToolChildBinder) {
          taskToolChildBinder = bindingWindow
            ? createOrderedTaskToolChildBinder(sessionId, parts.slice(partIndex), bindingWindow)
            : null
        }
        const child = explicit.child || (explicit.hasExplicitChild
            ? null
          : taskToolChildBinder?.take()
            || (taskToolChildBinder?.usesOrderedImplicitBindings
              ? null
              : bindingWindow
                ? takeOnlyChildForTaskTool(sessionId, bindingWindow, taskToolChildBinder?.explicitChildIds)
                : null))
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
            status: deriveToolStatus({ hasOutput: state.output !== undefined, hasError: state.error !== undefined }),
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
      const todosTs = fallbackSortTime
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
    const [taskId, child] = childTaskQueue[taskQueueIndex]!
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
      const tsMs = toHistorySortTime(info.time.created || msg.time.created, fallbackSortTime)
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
      let taskToolChildBinder: ReturnType<typeof createOrderedTaskToolChildBinder> | null = null
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex]
        if (!part) continue
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
          const explicit = takeExplicitChildForTaskTool(child.id, part)
          if (!explicit.hasExplicitChild && !taskToolChildBinder) {
            taskToolChildBinder = createOrderedTaskToolChildBinder(child.id, parts.slice(partIndex))
          }
          const nestedChild = explicit.child || (explicit.hasExplicitChild
            ? null
          : taskToolChildBinder?.take()
              || (taskToolChildBinder?.usesOrderedImplicitBindings
                ? null
                : takeOnlyChildForTaskTool(child.id, {}, taskToolChildBinder?.explicitChildIds)))
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
          if (nestedChild) {
            matchedChildIds.add(nestedChild.id)
            enqueueChildTask(nestedTaskId, nestedChild)
          }
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
              status: deriveToolStatus({ hasOutput: toolOutput !== undefined, hasError: state.error !== undefined }),
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
      const todoSortTime = toHistorySortTime(child.time?.updated || child.time?.created, fallbackSortTime)
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
