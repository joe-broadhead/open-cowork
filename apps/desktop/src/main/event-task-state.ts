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

const parentSessions = new Set<string>()
const sessionLineage = new Map<string, string>()
const sessionAliases = new Map<string, string>()
const taskRuns = new Map<string, TaskRunMeta>()
const childSessionToTaskRunId = new Map<string, string>()
const pendingTaskRunsByRoot = new Map<string, string[]>()
const queuedChildSessionsByRoot = new Map<string, string[]>()
const pendingSubmittedPromptBySession = new Map<string, string>()

function rememberSessionAlias(actualId: string, canonicalId: string) {
  if (!actualId || !canonicalId || actualId === canonicalId) return
  sessionAliases.set(actualId, canonicalId)
}

function canonicalizeSessionId(sessionId?: string | null) {
  if (!sessionId) return sessionId ?? undefined

  const aliased = sessionAliases.get(sessionId)
  if (aliased) return aliased
  if (sessionLineage.has(sessionId) || parentSessions.has(sessionId)) return sessionId
  if (!sessionId.startsWith('ses_')) return sessionId

  const candidates = new Set<string>([
    ...parentSessions,
    ...sessionLineage.keys(),
    ...sessionLineage.values(),
  ])

  let bestMatch: string | null = null
  for (const candidate of candidates) {
    if (!candidate || candidate === sessionId) continue
    if (!sessionId.endsWith(candidate)) continue
    if (!bestMatch || candidate.length > bestMatch.length) {
      bestMatch = candidate
    }
  }

  if (bestMatch) {
    rememberSessionAlias(sessionId, bestMatch)
    return bestMatch
  }

  return sessionId
}

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
  const canonicalSessionId = canonicalizeSessionId(sessionId) || sessionId
  rememberSessionAlias(sessionId, canonicalSessionId)
  parentSessions.add(canonicalSessionId)
  sessionLineage.set(canonicalSessionId, canonicalSessionId)
}

export function isTrackedParentSession(sessionId: string) {
  return parentSessions.has(canonicalizeSessionId(sessionId) || sessionId)
}

export function untrackParentSession(sessionId: string) {
  parentSessions.delete(canonicalizeSessionId(sessionId) || sessionId)
}

export function registerSession(sessionId?: string | null, parentId?: string | null) {
  if (!sessionId) return
  const canonicalSessionId = canonicalizeSessionId(sessionId) || sessionId
  rememberSessionAlias(sessionId, canonicalSessionId)
  if (!parentId) {
    if (!sessionLineage.has(canonicalSessionId)) {
      sessionLineage.set(canonicalSessionId, canonicalSessionId)
    }
    return
  }
  const canonicalParentId = canonicalizeSessionId(parentId) || parentId
  rememberSessionAlias(parentId, canonicalParentId)
  sessionLineage.set(canonicalSessionId, canonicalParentId)
}

export function resolveRootSession(sessionId?: string | null) {
  if (!sessionId) return sessionId ?? undefined

  let current = canonicalizeSessionId(sessionId) || sessionId
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
  pendingSubmittedPromptBySession.set(canonicalizeSessionId(sessionId) || sessionId, text)
}

export function forgetSubmittedPrompt(sessionId: string) {
  pendingSubmittedPromptBySession.delete(canonicalizeSessionId(sessionId) || sessionId)
}

export function consumePendingPromptEcho(sessionId: string, content: string) {
  const canonicalSessionId = canonicalizeSessionId(sessionId) || sessionId
  const pending = pendingSubmittedPromptBySession.get(canonicalSessionId)
  if (!pending || !content) return content
  if (content === pending) {
    pendingSubmittedPromptBySession.delete(canonicalSessionId)
    return ''
  }
  if (pending.startsWith(content)) {
    pendingSubmittedPromptBySession.set(canonicalSessionId, pending.slice(content.length))
    return ''
  }
  if (content.startsWith(pending)) {
    pendingSubmittedPromptBySession.delete(canonicalSessionId)
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

export function removeParentSessionState(sessionId: string) {
  const canonicalSessionId = canonicalizeSessionId(sessionId) || sessionId
  parentSessions.delete(canonicalSessionId)
  sessionLineage.delete(canonicalSessionId)
  pendingTaskRunsByRoot.delete(canonicalSessionId)
  queuedChildSessionsByRoot.delete(canonicalSessionId)
  pendingSubmittedPromptBySession.delete(canonicalSessionId)
  for (const [taskRunId, taskRun] of taskRuns.entries()) {
    if (taskRun.rootSessionId === canonicalSessionId) {
      taskRuns.delete(taskRunId)
      if (taskRun.childSessionId) {
        childSessionToTaskRunId.delete(taskRun.childSessionId)
      }
    }
  }
  for (const [actualId, alias] of sessionAliases.entries()) {
    if (actualId === canonicalSessionId || alias === canonicalSessionId) {
      sessionAliases.delete(actualId)
    }
  }
}

export function removeSessionState(sessionId: string, parentId?: string | null) {
  const canonicalSessionId = canonicalizeSessionId(sessionId) || sessionId
  removeTaskSession(canonicalSessionId)
  sessionLineage.delete(canonicalSessionId)
  pendingSubmittedPromptBySession.delete(canonicalSessionId)
  if (!parentId) {
    parentSessions.delete(canonicalSessionId)
    pendingTaskRunsByRoot.delete(canonicalSessionId)
    queuedChildSessionsByRoot.delete(canonicalSessionId)
  }
  for (const [actualId, alias] of sessionAliases.entries()) {
    if (actualId === canonicalSessionId || alias === canonicalSessionId) {
      sessionAliases.delete(actualId)
    }
  }
}

export function resetEventTaskState() {
  parentSessions.clear()
  sessionLineage.clear()
  sessionAliases.clear()
  taskRuns.clear()
  childSessionToTaskRunId.clear()
  pendingTaskRunsByRoot.clear()
  queuedChildSessionsByRoot.clear()
  pendingSubmittedPromptBySession.clear()
}
