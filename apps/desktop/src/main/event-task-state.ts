import {
  chooseTaskTitle,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  normalizeTaskTitle,
} from './task-run-utils.ts'

export type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

export type TaskRunMeta = {
  id: string
  rootSessionId: string
  parentSessionId: string | null
  title: string
  agent: string | null
  childSessionId: string | null
  status: TaskStatus
  startedAt?: string | null
  finishedAt?: string | null
}

// parentSessions + sessionLineage are local caches fed from the SDK's own
// session.created / session.updated events. They exist so resolveRootSession()
// can traverse a session tree synchronously inside event handlers without
// calling client.session.get() per event. OpenCode remains the source of
// truth; these are memoized views of data the SDK already handed us.
type QueuedChildSessionMeta = {
  id: string
  title: string | null
  agent: string | null
}

class SessionHierarchyStore {
  readonly parentSessions = new Set<string>()
  readonly sessionLineage = new Map<string, string>()
  readonly taskRuns = new Map<string, TaskRunMeta>()
  readonly childSessionToTaskRunId = new Map<string, string>()
  readonly pendingTaskRunsByParent = new Map<string, string[]>()
  readonly queuedChildSessionsByParent = new Map<string, QueuedChildSessionMeta[]>()
  readonly pendingSubmittedPromptBySession = new Map<string, string>()

  reset() {
    this.parentSessions.clear()
    this.sessionLineage.clear()
    this.taskRuns.clear()
    this.childSessionToTaskRunId.clear()
    this.pendingTaskRunsByParent.clear()
    this.queuedChildSessionsByParent.clear()
    this.pendingSubmittedPromptBySession.clear()
  }
}

const hierarchyStore = new SessionHierarchyStore()
const {
  parentSessions,
  sessionLineage,
  taskRuns,
  childSessionToTaskRunId,
  pendingTaskRunsByParent,
  queuedChildSessionsByParent,
  pendingSubmittedPromptBySession,
} = hierarchyStore

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

function spliceQueueValue<T extends string | QueuedChildSessionMeta>(
  map: Map<string, T[]>,
  parentSessionId: string,
  matcher: (value: T) => boolean,
) {
  const current = map.get(parentSessionId) || []
  const index = current.findIndex(matcher)
  if (index < 0) return null
  const [value] = current.splice(index, 1)
  if (current.length > 0) map.set(parentSessionId, current)
  else map.delete(parentSessionId)
  return value ?? null
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
  if (wouldCreateLineageCycle(sessionId, parentId)) {
    sessionLineage.set(sessionId, sessionId)
    return
  }
  sessionLineage.set(sessionId, parentId)
}

function wouldCreateLineageCycle(sessionId: string, parentId: string) {
  let current: string | undefined = parentId
  const seen = new Set<string>()
  while (current) {
    if (current === sessionId) return true
    if (seen.has(current)) return true
    seen.add(current)
    const next = sessionLineage.get(current)
    if (!next || next === current) return false
    current = next
  }
  return false
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

type BindingHints = {
  title?: string | null
  agent?: string | null
}

function normalizeBindingHints(hints?: BindingHints | null) {
  return {
    title: normalizeTaskTitle(hints?.title) || null,
    agent: normalizeAgentName(hints?.agent) || null,
  }
}

function computeBindingScore(
  candidate: { title?: string | null; agent?: string | null },
  hints?: BindingHints | null,
) {
  const normalizedHints = normalizeBindingHints(hints)
  if (!normalizedHints.title && !normalizedHints.agent) return 0

  let score = 0
  const candidateAgent = normalizeAgentName(candidate.agent) || null
  const candidateTitle = normalizeTaskTitle(candidate.title) || null

  if (normalizedHints.agent && candidateAgent && normalizedHints.agent === candidateAgent) {
    score += 4
  }

  if (normalizedHints.title && candidateTitle) {
    if (normalizedHints.title === candidateTitle) {
      score += 3
    } else if (
      normalizedHints.title.includes(candidateTitle)
      || candidateTitle.includes(normalizedHints.title)
    ) {
      score += 2
    }
  }

  return score
}

function findBestIndexedMatch<T extends { title?: string | null; agent?: string | null }>(
  entries: T[],
  hints?: BindingHints | null,
) {
  if (entries.length <= 1) return entries.length === 1 ? 0 : -1

  let bestIndex = -1
  let bestScore = 0
  let ambiguous = false

  for (const [index, entry] of entries.entries()) {
    const score = computeBindingScore(entry, hints)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
      ambiguous = false
    } else if (score > 0 && score === bestScore) {
      ambiguous = true
    }
  }

  if (bestIndex >= 0 && !ambiguous) return bestIndex
  return -1
}

function takePendingTaskRunId(parentSessionId: string, hints?: BindingHints | null) {
  const current = mapTaskRunsForParent(parentSessionId)
  if (current.length === 0) return null
  if (current.length === 1) {
    return shiftQueue(pendingTaskRunsByParent, parentSessionId) || null
  }
  const matchIndex = findBestIndexedMatch(
    current
      .map((taskRunId) => taskRuns.get(taskRunId))
      .filter((taskRun): taskRun is TaskRunMeta => Boolean(taskRun)),
    hints,
  )
  if (matchIndex < 0) return null
  const matchId = current[matchIndex] || null
  if (!matchId) return null
  return spliceQueueValue(pendingTaskRunsByParent, parentSessionId, (value) => value === matchId)
}

function takeQueuedChildSession(
  parentSessionId: string,
  hints?: BindingHints | null,
) {
  const current = queuedChildSessionsByParent.get(parentSessionId) || []
  if (current.length === 0) return null
  if (current.length === 1) {
    return spliceQueueValue(queuedChildSessionsByParent, parentSessionId, () => true)
  }
  const matchIndex = findBestIndexedMatch(current, hints)
  if (matchIndex < 0) return null
  const matchId = current[matchIndex]?.id
  if (!matchId) return null
  return spliceQueueValue(queuedChildSessionsByParent, parentSessionId, (value) => value.id === matchId)
}

function mapTaskRunsForParent(parentSessionId: string) {
  return pendingTaskRunsByParent.get(parentSessionId) || []
}

function nowIso() {
  return new Date().toISOString()
}

function isTerminalStatus(status: TaskStatus) {
  return status === 'complete' || status === 'error'
}

function normalizeTaskTiming(taskRun: TaskRunMeta): TaskRunMeta {
  const startedAt = taskRun.startedAt ?? nowIso()
  const finishedAt = taskRun.finishedAt ?? (isTerminalStatus(taskRun.status) ? nowIso() : null)
  return { ...taskRun, startedAt, finishedAt }
}

function applyTaskTimingTransition(existing: TaskRunMeta, patch: Partial<TaskRunMeta>): TaskRunMeta {
  const nextStatus = patch.status ?? existing.status
  const timestamp = nowIso()
  const startedAt = patch.startedAt
    ?? existing.startedAt
    ?? timestamp
  const finishedAt = patch.finishedAt !== undefined
    ? patch.finishedAt
    : isTerminalStatus(nextStatus)
      ? (existing.finishedAt ?? timestamp)
      : null

  return {
    ...existing,
    ...patch,
    startedAt,
    finishedAt,
  }
}

export function resolveRootSession(sessionId?: string | null) {
  if (!sessionId) return undefined

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
      const mergedStatus = incomingTaskRun.status === 'error'
        ? 'error'
        : incomingTaskRun.status === 'complete'
          ? 'complete'
          : incomingTaskRun.status === 'running'
            ? 'running'
            : existingTaskRun.status
      const timestamp = nowIso()
      const finishedAt = isTerminalStatus(mergedStatus)
        ? (existingTaskRun.finishedAt || incomingTaskRun.finishedAt || timestamp)
        : null
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
        status: mergedStatus,
        startedAt: existingTaskRun.startedAt || incomingTaskRun.startedAt || timestamp,
        finishedAt,
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
  const normalizedTaskRun: TaskRunMeta = normalizeTaskTiming({
    ...taskRun,
    parentSessionId: taskRun.parentSessionId || taskRun.rootSessionId,
  })
  taskRuns.set(normalizedTaskRun.id, normalizedTaskRun)
  const parentQueueKey = normalizedTaskRun.parentSessionId || normalizedTaskRun.rootSessionId

  const queuedChild = takeQueuedChildSession(parentQueueKey, {
    agent: normalizedTaskRun.agent,
    title: normalizedTaskRun.title,
  })
  if (queuedChild) {
    const bound = bindTaskRunToChild(normalizedTaskRun.id, queuedChild.id)
    return bound || taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
  }

  if (!normalizedTaskRun.childSessionId) {
    pushQueue(pendingTaskRunsByParent, parentQueueKey, normalizedTaskRun.id)
  }

  return taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
}

export function queueOrBindChildSession(
  parentSessionId: string | null | undefined,
  childSessionId: string,
  hints?: BindingHints | null,
) {
  if (!parentSessionId) return null
  const pendingTaskRunId = takePendingTaskRunId(parentSessionId, hints)
  if (pendingTaskRunId) {
    return bindTaskRunToChild(pendingTaskRunId, childSessionId)
  }

  const queuedChild: QueuedChildSessionMeta = {
    id: childSessionId,
    title: normalizeTaskTitle(hints?.title) || null,
    agent: normalizeAgentName(hints?.agent) || null,
  }
  const current = queuedChildSessionsByParent.get(parentSessionId) || []
  if (!current.some((entry) => entry.id === childSessionId)) {
    queuedChildSessionsByParent.set(parentSessionId, [...current, queuedChild])
  }
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
    startedAt: nowIso(),
    finishedAt: null,
  }
  taskRuns.set(fallback.id, fallback)
  childSessionToTaskRunId.set(childSessionId, fallback.id)
  return fallback
}

export function updateTaskRun(taskRunId: string, patch: Partial<TaskRunMeta>) {
  const existing = taskRuns.get(taskRunId)
  if (!existing) return null
  const next = applyTaskTimingTransition(existing, patch)
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
  hierarchyStore.reset()
}
