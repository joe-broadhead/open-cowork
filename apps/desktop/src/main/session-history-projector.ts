import { resolveDisplayCostForModel } from './pricing-core.ts'
import { isInternalCoworkMessage } from './internal-message-utils.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.ts'

type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

type TaskRunSnapshot = {
  title: string
  agent: string | null
  status: TaskStatus
  sourceSessionId: string | null
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
  todos?: any[]
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

type ChildSessionRecord = {
  id: string
  title?: string
  time?: {
    created?: number
    updated?: number
  }
}

type ProjectSessionHistoryInput = {
  sessionId: string
  cachedModelId: string
  rootMessages: any[]
  rootTodos: any[]
  children: ChildSessionRecord[]
  statuses: Record<string, any>
  loadChildSnapshot: (childId: string) => Promise<{ messages: any[]; todos: any[] }>
}

export async function projectSessionHistory(input: ProjectSessionHistoryInput): Promise<ProjectedHistoryItem[]> {
  const { sessionId, cachedModelId, rootMessages, rootTodos, statuses, loadChildSnapshot } = input
  type InternalProjectedHistoryItem = ProjectedHistoryItem & { sortTime: number }
  const toSortTime = (value?: number) => {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    return raw < 1_000_000_000_000 ? raw * 1000 : raw
  }
  const children = (input.children || [])
    .slice()
    .sort((a, b) => (a?.time?.created || 0) - (b?.time?.created || 0))
  const rootStatus = statuses[sessionId]?.type || null
  const childCompletesById = new Map<string, boolean>()

  let sequence = 0
  const nextOrder = () => ++sequence
  const out: InternalProjectedHistoryItem[] = []
  const taskRunItems = new Map<string, InternalProjectedHistoryItem>()
  const childByTaskId = new Map<string, ChildSessionRecord>()
  let childIndex = 0

  const pushItem = (item: ProjectedHistoryItem, sortTime: number) => {
    out.push({
      ...item,
      sortTime,
    })
  }

  const collectTextParts = (parts: any[]) => {
    const textParts: any[] = []
    let fullText = ''

    for (const part of parts) {
      if (part.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) continue
      textParts.push(part)
      fullText += part.text
    }

    return { textParts, fullText }
  }

  const createCostPayload = (part: any) => {
    const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const cost = resolveDisplayCostForModel(cachedModelId, part.cost, tokens)
    return {
      cost,
      tokens: {
        input: tokens.input || 0,
        output: tokens.output || 0,
        reasoning: tokens.reasoning || 0,
        cache: { read: tokens.cache?.read || 0, write: tokens.cache?.write || 0 },
      },
    }
  }

  const getModelMeta = (info: any) => ({
    providerId: info?.model?.providerID || info?.model?.providerId || null,
    modelId: info?.model?.modelID || info?.model?.modelId || null,
  })

  const getTaskStatus = (childId?: string | null): TaskStatus => {
    if (!childId) return 'queued'
    const status = statuses[childId]?.type
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

  for (const msg of rootMessages) {
    const info = (msg as any).info || msg
    const parts = (msg as any).parts || []
    const tsMs = toSortTime(info.time?.created || msg.time?.created || Date.now())
    const ts = toIsoTimestamp(tsMs)
    const msgId = info.id || msg.id || crypto.randomUUID()
    const role = info.role || msg.role || 'assistant'
    const modelMeta = getModelMeta(info)
    const { textParts, fullText } = collectTextParts(parts)

    if (fullText && !isInternalCoworkMessage(fullText)) {
      textParts.forEach((part: any, index: number) => {
        const partId = part.id || `${msgId}:part:${index}`
        pushItem({
          type: 'message',
          id: `${msgId}:${partId}:text`,
          messageId: msgId,
          partId,
          role,
          content: part.text,
          timestamp: ts,
          sequence: nextOrder(),
          providerId: modelMeta.providerId,
          modelId: modelMeta.modelId,
        }, tsMs)
      })
    }

    for (const part of parts) {
      if (part.type === 'subtask') {
        const child = children[childIndex++] || null
        const taskId = child?.id
          ? `child:${child.id}`
          : `pending:${part.id || crypto.randomUUID()}`
        const taskItem = addTaskRun({
          id: taskId,
          title: chooseTaskTitle(
            normalizeAgentName(part.agent) || extractAgentName(part.description, (part as any).title, (part as any).prompt, (part as any).raw, child?.title) || null,
            part.description,
            (part as any).title,
            (part as any).prompt,
            (part as any).raw,
            child?.title,
          ),
          agent: normalizeAgentName(part.agent) || extractAgentName(part.description, (part as any).title, (part as any).prompt, (part as any).raw, child?.title) || null,
          status: getTaskStatus(child?.id || null),
          sourceSessionId: child?.id || null,
        }, ts, tsMs)
        if (child) childByTaskId.set(taskId, child)
        if (!taskItem) continue
        continue
      }

      if (part.type === 'compaction') {
        pushItem({
          type: 'compaction',
          id: part.id || crypto.randomUUID(),
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
        const state = part.state || {}
        pushItem({
          type: 'tool',
          id: part.callID || part.id || crypto.randomUUID(),
          timestamp: ts,
          sequence: nextOrder(),
          tool: {
            name: part.tool === 'task' && part.title ? part.title : part.tool,
            input: state.input || {},
            status: state.output ? 'complete' : state.error ? 'error' : 'complete',
            output: state.output,
            agent: state.metadata?.agent || part.metadata?.agent || null,
          },
        }, tsMs)
        continue
      }

      if (part.type === 'step-finish' && (part.cost || part.tokens)) {
        pushItem({
          type: 'cost',
          id: part.id || crypto.randomUUID(),
          timestamp: ts,
          sequence: nextOrder(),
          cost: createCostPayload(part),
        }, tsMs)
      }
    }
  }

  if (rootTodos.length > 0) {
    const todosTs = Date.now()
    pushItem({
      type: 'todos',
      id: `todos:${sessionId}`,
      timestamp: toIsoTimestamp(todosTs),
      sequence: nextOrder(),
      todos: rootTodos,
    }, todosTs)
  }

  for (const child of children.slice(childIndex)) {
    const taskId = `child:${child.id}`
    const agent = extractAgentName(child.title)
    const sortTime = toSortTime(child.time?.created || Date.now())
    addTaskRun({
      id: taskId,
      title: chooseTaskTitle(agent, child.title),
      agent,
      status: getTaskStatus(child.id),
      sourceSessionId: child.id,
    }, toIsoTimestamp(sortTime), sortTime)
    childByTaskId.set(taskId, child)
  }

  for (const [taskId, child] of childByTaskId.entries()) {
    const { messages: childMessages, todos: childTodos } = await loadChildSnapshot(child.id)
    const taskRunItem = taskRunItems.get(taskId)
    let childHasTerminalStop = false

    for (const msg of childMessages) {
      const info = (msg as any).info || msg
      const parts = (msg as any).parts || []
      const tsMs = toSortTime(info.time?.created || msg.time?.created || Date.now())
      const ts = toIsoTimestamp(tsMs)
      const role = info.role || msg.role || 'assistant'
      const modelMeta = getModelMeta(info)
      const { textParts, fullText } = collectTextParts(parts)

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
        if (part.type === 'tool' && part.tool === 'task' && taskRunItem?.taskRun) {
          taskRunItem.taskRun.agent = normalizeAgentName(part.state?.metadata?.agent || part.metadata?.agent || null)
            || extractAgentName(part.title, part.state?.title, typeof part.state?.raw === 'string' ? part.state.raw : null)
            || taskRunItem.taskRun.agent
          taskRunItem.taskRun.title = chooseTaskTitle(
            taskRunItem.taskRun.agent,
            !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
            part.title,
            part.state?.title,
            typeof part.state?.raw === 'string' ? part.state.raw : null,
            typeof part.state?.input?.prompt === 'string' ? part.state.input.prompt : null,
          )
        }
        if (part.type === 'step-finish' && part.reason === 'stop') {
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

      if (fullText && !isInternalCoworkMessage(fullText)) {
        textParts.forEach((part: any, index: number) => {
          const messageId = info.id || crypto.randomUUID()
          const partId = part.id || `${messageId}:part:${index}`
          pushItem({
            type: 'task_text',
            id: `${taskId}:${messageId}:${partId}:text`,
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            messageId,
            partId,
            content: part.text,
            providerId: modelMeta.providerId,
            modelId: modelMeta.modelId,
          }, tsMs)
        })
      }

      for (const part of parts) {
        if (part.type === 'compaction') {
          pushItem({
            type: 'task_compaction',
            id: `${taskId}:${part.id || crypto.randomUUID()}:compaction`,
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

        if (part.type === 'tool' && part.tool) {
          const state = part.state || {}
          const title = part.title || ''
          const toolOutput = state.output
          pushItem({
            type: 'task_tool',
            id: part.callID || part.id || crypto.randomUUID(),
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            tool: {
              name: part.tool === 'task' && title ? title : part.tool,
              input: state.input || {},
              status: toolOutput ? 'complete' : state.error ? 'error' : 'complete',
              output: toolOutput,
              attachments: state.attachments || [],
              agent: normalizeAgentName(state.metadata?.agent || part.metadata?.agent || null)
                || extractAgentName(title, state.title, typeof state.raw === 'string' ? state.raw : null)
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
            id: `${taskId}:${part.id || crypto.randomUUID()}:cost`,
            timestamp: ts,
            sequence: nextOrder(),
            taskRunId: taskId,
            cost: createCostPayload(part),
          }, tsMs)
        }
      }
    }

    childCompletesById.set(child.id, childHasTerminalStop)
    if (taskRunItem?.taskRun) {
      taskRunItem.taskRun.status = getTaskStatus(child.id)
    }

    if (childTodos.length > 0) {
      const todoSortTime = toSortTime(child.time?.updated || child.time?.created || Date.now())
      pushItem({
        type: 'task_todos',
        id: `${taskId}:todos`,
        timestamp: toIsoTimestamp(todoSortTime),
        sequence: nextOrder(),
        taskRunId: taskId,
        todos: childTodos,
      }, todoSortTime)
    }
  }

  return out
    .sort((a, b) => {
      const timeDiff = a.sortTime - b.sortTime
      return timeDiff !== 0 ? timeDiff : a.sequence - b.sequence
    })
    .map(({ sortTime: _sortTime, ...item }) => item)
}
