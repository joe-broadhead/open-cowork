import { chooseTaskTitle, isPlaceholderTaskTitle } from './task-run-utils.ts'

export type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

export type TaskRunMeta = {
  id: string
  rootSessionId: string
  parentSessionId: string | null
  title: string
  agent: string | null
  childSessionId: string | null
  status: TaskStatus
}

// parentSessions + sessionLineage are local caches fed from the SDK's own
// session.created / session.updated events. They exist so resolveRootSession()
// can traverse a session tree synchronously inside event handlers without
// calling client.session.get() per event. OpenCode remains the source of
// truth; these are memoized views of data the SDK already handed us.
const parentSessions = new Set<string>()
const sessionLineage = new Map<string, string>()
const taskRuns = new Map<string, TaskRunMeta>()
const childSessionToTaskRunId = new Map<string, string>()
const pendingTaskRunsByParent = new Map<string, string[]>()
const queuedChildSessionsByParent = new Map<string, string[]>()
const pendingSubmittedPromptBySession = new Map<string, string>()

function pushQueue(map: Map<string, string[]>, parentSessionId: string, value: string) {
  const current = map.get(parentSessionId) || []
  if (!current.includes(value)) {
    current.push(value)
    map.set(parentSessionId, current)
  }
}

function shiftQueue(map: Map<string, string[]>, parentSessionId: string) {
  const current = map.get(parentSessionId) || []
  const value = current.shift()
  if (current.length > 0) map.set(parentSessionId, current)
  else map.delete(parentSessionId)
  return value
}

function isKnownSession(sessionId: string) {
  return parentSessions.has(sessionId) || sessionLineage.has(sessionId)
}

export function trackParentSession(sessionId: string) {
  parentSessions.add(sessionId)
  sessionLineage.set(sessionId, sessionId)
}

export function isTrackedParentSession(sessionId: string) {
  return parentSessions.has(sessionId)
}

export function untrackParentSession(sessionId: string) {
  parentSessions.delete(sessionId)
}

export function registerSession(sessionId?: string | null, parentId?: string | null) {
  if (!sessionId) return
  if (!parentId) {
    if (!sessionLineage.has(sessionId)) {
      sessionLineage.set(sessionId, sessionId)
    }
    return
  }
  sessionLineage.set(sessionId, parentId)
}

// Returns the immediate parent session id for a child session, or null if
// the session has no recorded parent (i.e. it's a root session). Used by
// the orchestration UI to render two-level nesting — a task's parent
// session tells us which other task (if any) spawned it.
export function getImmediateParentSession(sessionId?: string | null): string | null {
  if (!sessionId) return null
  const parent = sessionLineage.get(sessionId)
  if (!parent || parent === sessionId) return null
  return parent
}

export function resolveRootSession(sessionId?: string | null) {
  if (!sessionId) return sessionId ?? undefined

  let current = sessionId
  const seen = new Set<string>()

  while (true) {
    const next = sessionLineage.get(current)
    if (!next) return current
    if (next === current) return current
    if (seen.has(current)) return current
    seen.add(current)
    current = next
  }
}

export function findFallbackTaskRun(rootSessionId: string, parentSessionId: string, agent?: string | null) {
  const candidates = Array.from(taskRuns.values()).filter((taskRun) => {
    return taskRun.rootSessionId === rootSessionId
      && taskRun.parentSessionId === parentSessionId
      && taskRun.id.startsWith('child:')
      && (taskRun.status === 'queued' || taskRun.status === 'running')
      && (!agent || taskRun.agent === agent || !taskRun.agent)
  })

  return candidates.length === 1 ? candidates[0] : null
}

export function bindTaskRunToChild(taskRunId: string, childSessionId: string) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  const childParentSessionId = getImmediateParentSession(childSessionId)
  if (existingTaskRunId && existingTaskRunId !== taskRunId) {
    const existingTaskRun = taskRuns.get(existingTaskRunId)
    const incomingTaskRun = taskRuns.get(taskRunId)

    if (existingTaskRun && incomingTaskRun) {
      const mergedAgent = incomingTaskRun.agent || existingTaskRun.agent
      const mergedTaskRun: TaskRunMeta = {
        ...existingTaskRun,
        rootSessionId: incomingTaskRun.rootSessionId || existingTaskRun.rootSessionId,
        parentSessionId: childParentSessionId
          || incomingTaskRun.parentSessionId
          || existingTaskRun.parentSessionId
          || existingTaskRun.rootSessionId,
        title: chooseTaskTitle(
          mergedAgent,
          !isPlaceholderTaskTitle(existingTaskRun.title, existingTaskRun.agent) ? existingTaskRun.title : null,
          incomingTaskRun.title,
        ),
        agent: mergedAgent,
        childSessionId,
        status: incomingTaskRun.status === 'error'
          ? 'error'
          : incomingTaskRun.status === 'complete'
            ? 'complete'
            : incomingTaskRun.status === 'running'
              ? 'running'
              : existingTaskRun.status,
      }

      taskRuns.set(existingTaskRunId, mergedTaskRun)
      taskRuns.delete(taskRunId)
      childSessionToTaskRunId.set(childSessionId, existingTaskRunId)
      return mergedTaskRun
    }
  }

  const taskRun = taskRuns.get(taskRunId)
  if (!taskRun) return null
  taskRun.childSessionId = childSessionId
  taskRun.parentSessionId = childParentSessionId || taskRun.parentSessionId || taskRun.rootSessionId
  childSessionToTaskRunId.set(childSessionId, taskRunId)
  return taskRun
}

export function registerTaskRun(taskRun: TaskRunMeta) {
  const normalizedTaskRun: TaskRunMeta = {
    ...taskRun,
    parentSessionId: taskRun.parentSessionId || taskRun.rootSessionId,
  }
  taskRuns.set(normalizedTaskRun.id, normalizedTaskRun)
  const parentQueueKey = normalizedTaskRun.parentSessionId || normalizedTaskRun.rootSessionId

  const queuedChild = shiftQueue(queuedChildSessionsByParent, parentQueueKey)
  if (queuedChild) {
    const bound = bindTaskRunToChild(normalizedTaskRun.id, queuedChild)
    return bound || taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
  }

  if (!normalizedTaskRun.childSessionId) {
    pushQueue(pendingTaskRunsByParent, parentQueueKey, normalizedTaskRun.id)
  }

  return taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
}

export function queueOrBindChildSession(parentSessionId: string | null | undefined, childSessionId: string) {
  if (!parentSessionId) return null
  const pendingTaskRunId = shiftQueue(pendingTaskRunsByParent, parentSessionId)
  if (pendingTaskRunId) {
    return bindTaskRunToChild(pendingTaskRunId, childSessionId)
  }

  pushQueue(queuedChildSessionsByParent, parentSessionId, childSessionId)
  return null
}

export function ensureTaskRunForChild(
  rootSessionId: string,
  childSessionId: string,
  agent?: string | null,
  parentSessionId?: string | null,
) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  if (existingTaskRunId) return taskRuns.get(existingTaskRunId) || null

  const immediateParentSessionId = parentSessionId || getImmediateParentSession(childSessionId) || rootSessionId
  const fallback: TaskRunMeta = {
    id: `child:${childSessionId}`,
    rootSessionId,
    parentSessionId: immediateParentSessionId,
    title: chooseTaskTitle(agent),
    agent: agent || null,
    childSessionId,
    status: 'queued',
  }
  taskRuns.set(fallback.id, fallback)
  childSessionToTaskRunId.set(childSessionId, fallback.id)
  return fallback
}

export function updateTaskRun(taskRunId: string, patch: Partial<TaskRunMeta>) {
  const existing = taskRuns.get(taskRunId)
  if (!existing) return null
  const next = { ...existing, ...patch }
  taskRuns.set(taskRunId, next)
  if (next.childSessionId) {
    childSessionToTaskRunId.set(next.childSessionId, next.id)
  }
  return next
}

export function getTaskRun(taskRunId: string | null | undefined) {
  if (!taskRunId) return null
  return taskRuns.get(taskRunId) || null
}

export function getTaskRunIdForChild(sessionId: string | null | undefined) {
  if (!sessionId) return null
  return childSessionToTaskRunId.get(sessionId) || null
}

export function removeTaskSession(sessionId: string) {
  const taskRunId = childSessionToTaskRunId.get(sessionId)
  if (taskRunId) {
    childSessionToTaskRunId.delete(sessionId)
    const taskRun = taskRuns.get(taskRunId)
    if (taskRun) {
      taskRuns.set(taskRunId, { ...taskRun, childSessionId: null })
    }
  }
}

export function rememberSubmittedPrompt(sessionId: string, text: string) {
  if (!sessionId || !text) return
  pendingSubmittedPromptBySession.set(sessionId, text)
}

export function forgetSubmittedPrompt(sessionId: string) {
  pendingSubmittedPromptBySession.delete(sessionId)
}

export function consumePendingPromptEcho(sessionId: string, content: string) {
  const pending = pendingSubmittedPromptBySession.get(sessionId)
  if (!pending || !content) return content
  if (content === pending) {
    pendingSubmittedPromptBySession.delete(sessionId)
    return ''
  }
  if (pending.startsWith(content)) {
    pendingSubmittedPromptBySession.set(sessionId, pending.slice(content.length))
    return ''
  }
  if (content.startsWith(pending)) {
    pendingSubmittedPromptBySession.delete(sessionId)
    return content.slice(pending.length)
  }
  return content
}

export function sweepStaleTaskState(messageRoles: Map<string, 'user' | 'assistant'>) {
  for (const [childSessionId, taskRunId] of childSessionToTaskRunId.entries()) {
    const taskRun = taskRuns.get(taskRunId)
    if (!taskRun || taskRun.childSessionId !== childSessionId) {
      childSessionToTaskRunId.delete(childSessionId)
    }
  }

  for (const [parentSessionId] of pendingTaskRunsByParent.entries()) {
    if (!isKnownSession(parentSessionId)) {
      pendingTaskRunsByParent.delete(parentSessionId)
    }
  }

  for (const [parentSessionId] of queuedChildSessionsByParent.entries()) {
    if (!isKnownSession(parentSessionId)) {
      queuedChildSessionsByParent.delete(parentSessionId)
    }
  }

  while (messageRoles.size > 2000) {
    const oldest = messageRoles.keys().next().value
    if (!oldest) break
    messageRoles.delete(oldest)
  }
}

// Drop any lineage rows that pointed at `sessionId` as their parent.
// Without this pass, deleting a root session leaves orphaned child rows
// in `sessionLineage` whose resolveRootSession walks would still end at
// the deleted id — making the cache disagree with OpenCode's own view
// until a full runtime reboot.
function collectDescendantSessions(sessionId: string) {
  const descendants: string[] = []
  const queue = [sessionId]
  while (queue.length > 0) {
    const currentParentId = queue.shift()
    if (!currentParentId) continue
    for (const [childId, parentId] of sessionLineage.entries()) {
      if (parentId !== currentParentId || childId === currentParentId) continue
      descendants.push(childId)
      queue.push(childId)
    }
  }
  return descendants
}

function deleteTaskRunsForSessions(sessionIds: string[]) {
  const targetIds = new Set(sessionIds)
  for (const sessionId of targetIds) {
    childSessionToTaskRunId.delete(sessionId)
  }
  for (const [taskRunId, taskRun] of taskRuns.entries()) {
    const childSessionId = taskRun.childSessionId
    if (
      (childSessionId && targetIds.has(childSessionId))
      || (taskRunId.startsWith('child:') && targetIds.has(taskRunId.slice('child:'.length)))
    ) {
      taskRuns.delete(taskRunId)
    }
  }
}

function removeDescendantLineage(sessionId: string) {
  const descendants = collectDescendantSessions(sessionId)
  deleteTaskRunsForSessions(descendants)
  for (const childId of descendants) {
    sessionLineage.delete(childId)
    pendingTaskRunsByParent.delete(childId)
    queuedChildSessionsByParent.delete(childId)
    pendingSubmittedPromptBySession.delete(childId)
  }
}

export function removeParentSessionState(sessionId: string) {
  parentSessions.delete(sessionId)
  sessionLineage.delete(sessionId)
  pendingTaskRunsByParent.delete(sessionId)
  queuedChildSessionsByParent.delete(sessionId)
  pendingSubmittedPromptBySession.delete(sessionId)
  deleteTaskRunsForSessions([sessionId])
  for (const [taskRunId, taskRun] of taskRuns.entries()) {
    if (taskRun.rootSessionId === sessionId) taskRuns.delete(taskRunId)
  }
  removeDescendantLineage(sessionId)
}

export function removeSessionState(sessionId: string, parentId?: string | null) {
  deleteTaskRunsForSessions([sessionId])
  sessionLineage.delete(sessionId)
  pendingTaskRunsByParent.delete(sessionId)
  queuedChildSessionsByParent.delete(sessionId)
  pendingSubmittedPromptBySession.delete(sessionId)
  removeDescendantLineage(sessionId)
  if (!parentId) {
    parentSessions.delete(sessionId)
  }
}

export function resetEventTaskState() {
  parentSessions.clear()
  sessionLineage.clear()
  taskRuns.clear()
  childSessionToTaskRunId.clear()
  pendingTaskRunsByParent.clear()
  queuedChildSessionsByParent.clear()
  pendingSubmittedPromptBySession.clear()
}
