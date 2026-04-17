import { chooseTaskTitle, isPlaceholderTaskTitle } from './task-run-utils.ts'

export type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

export type TaskRunMeta = {
  id: string
  rootSessionId: string
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
const pendingTaskRunsByRoot = new Map<string, string[]>()
const queuedChildSessionsByRoot = new Map<string, string[]>()
const pendingSubmittedPromptBySession = new Map<string, string>()

function pushQueue(map: Map<string, string[]>, rootSessionId: string, value: string) {
  const current = map.get(rootSessionId) || []
  if (!current.includes(value)) {
    current.push(value)
    map.set(rootSessionId, current)
  }
}

function shiftQueue(map: Map<string, string[]>, rootSessionId: string) {
  const current = map.get(rootSessionId) || []
  const value = current.shift()
  if (current.length > 0) map.set(rootSessionId, current)
  else map.delete(rootSessionId)
  return value
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

export function findFallbackTaskRun(rootSessionId: string, agent?: string | null) {
  const candidates = Array.from(taskRuns.values()).filter((taskRun) => {
    return taskRun.rootSessionId === rootSessionId
      && taskRun.id.startsWith('child:')
      && (taskRun.status === 'queued' || taskRun.status === 'running')
      && (!agent || taskRun.agent === agent || !taskRun.agent)
  })

  return candidates.length === 1 ? candidates[0] : null
}

export function bindTaskRunToChild(taskRunId: string, childSessionId: string) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  if (existingTaskRunId && existingTaskRunId !== taskRunId) {
    const existingTaskRun = taskRuns.get(existingTaskRunId)
    const incomingTaskRun = taskRuns.get(taskRunId)

    if (existingTaskRun && incomingTaskRun) {
      const mergedAgent = incomingTaskRun.agent || existingTaskRun.agent
      const mergedTaskRun: TaskRunMeta = {
        ...existingTaskRun,
        rootSessionId: incomingTaskRun.rootSessionId || existingTaskRun.rootSessionId,
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
  childSessionToTaskRunId.set(childSessionId, taskRunId)
  return taskRun
}

export function registerTaskRun(taskRun: TaskRunMeta) {
  taskRuns.set(taskRun.id, taskRun)

  const queuedChild = shiftQueue(queuedChildSessionsByRoot, taskRun.rootSessionId)
  if (queuedChild) {
    bindTaskRunToChild(taskRun.id, queuedChild)
    return taskRuns.get(taskRun.id) || taskRun
  }

  if (!taskRun.childSessionId) {
    pushQueue(pendingTaskRunsByRoot, taskRun.rootSessionId, taskRun.id)
  }

  return taskRuns.get(taskRun.id) || taskRun
}

export function queueOrBindChildSession(rootSessionId: string, childSessionId: string) {
  const pendingTaskRunId = shiftQueue(pendingTaskRunsByRoot, rootSessionId)
  if (pendingTaskRunId) {
    return bindTaskRunToChild(pendingTaskRunId, childSessionId)
  }

  pushQueue(queuedChildSessionsByRoot, rootSessionId, childSessionId)
  return null
}

export function ensureTaskRunForChild(rootSessionId: string, childSessionId: string, agent?: string | null) {
  const existingTaskRunId = childSessionToTaskRunId.get(childSessionId)
  if (existingTaskRunId) return taskRuns.get(existingTaskRunId) || null

  const fallback: TaskRunMeta = {
    id: `child:${childSessionId}`,
    rootSessionId,
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

  for (const [rootSessionId] of pendingTaskRunsByRoot.entries()) {
    if (!parentSessions.has(rootSessionId)) {
      pendingTaskRunsByRoot.delete(rootSessionId)
    }
  }

  for (const [rootSessionId] of queuedChildSessionsByRoot.entries()) {
    if (!parentSessions.has(rootSessionId)) {
      queuedChildSessionsByRoot.delete(rootSessionId)
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
function removeDescendantLineage(sessionId: string) {
  for (const [childId, parentId] of sessionLineage.entries()) {
    if (parentId === sessionId && childId !== sessionId) {
      sessionLineage.delete(childId)
    }
  }
}

export function removeParentSessionState(sessionId: string) {
  parentSessions.delete(sessionId)
  sessionLineage.delete(sessionId)
  pendingTaskRunsByRoot.delete(sessionId)
  queuedChildSessionsByRoot.delete(sessionId)
  pendingSubmittedPromptBySession.delete(sessionId)
  for (const [taskRunId, taskRun] of taskRuns.entries()) {
    if (taskRun.rootSessionId === sessionId) {
      taskRuns.delete(taskRunId)
      if (taskRun.childSessionId) {
        childSessionToTaskRunId.delete(taskRun.childSessionId)
      }
    }
  }
  removeDescendantLineage(sessionId)
}

export function removeSessionState(sessionId: string, parentId?: string | null) {
  removeTaskSession(sessionId)
  sessionLineage.delete(sessionId)
  pendingSubmittedPromptBySession.delete(sessionId)
  if (!parentId) {
    parentSessions.delete(sessionId)
    pendingTaskRunsByRoot.delete(sessionId)
    queuedChildSessionsByRoot.delete(sessionId)
    removeDescendantLineage(sessionId)
  }
}

export function resetEventTaskState() {
  parentSessions.clear()
  sessionLineage.clear()
  taskRuns.clear()
  childSessionToTaskRunId.clear()
  pendingTaskRunsByRoot.clear()
  queuedChildSessionsByRoot.clear()
  pendingSubmittedPromptBySession.clear()
}
