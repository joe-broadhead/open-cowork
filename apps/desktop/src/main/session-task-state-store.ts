import {
  chooseTaskTitle,
  isPlaceholderTaskTitle,
} from './task-run-utils.ts'
import {
  applyTaskTimingTransition,
  isTerminalTaskStatus,
  normalizeTaskTiming,
  nowIso,
} from './event-task-timing.ts'
import {
  pushUniqueQueueValue,
  shiftQueueValue,
  spliceQueueValue,
} from './queue-map.ts'

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

type QueuedChildSessionMeta = {
  id: string
}

// Local cache fed by OpenCode session/task events. OpenCode remains the
// source of truth; this store only keeps enough indexed state for synchronous
// event projection without calling the SDK from every event handler.
export class SessionTaskStateStore {
  private readonly parentSessions = new Set<string>()
  private readonly sessionLineage = new Map<string, string>()
  private readonly taskRuns = new Map<string, TaskRunMeta>()
  private readonly childSessionToTaskRunId = new Map<string, string>()
  private readonly taskRunAliases = new Map<string, string>()
  private readonly pendingTaskRunsByParent = new Map<string, string[]>()
  private readonly queuedChildSessionsByParent = new Map<string, QueuedChildSessionMeta[]>()
  private readonly pendingSubmittedPromptBySession = new Map<string, string>()

  reset() {
    this.parentSessions.clear()
    this.sessionLineage.clear()
    this.taskRuns.clear()
    this.childSessionToTaskRunId.clear()
    this.taskRunAliases.clear()
    this.pendingTaskRunsByParent.clear()
    this.queuedChildSessionsByParent.clear()
    this.pendingSubmittedPromptBySession.clear()
  }

  trackParentSession(sessionId: string) {
    this.parentSessions.add(sessionId)
    this.sessionLineage.set(sessionId, sessionId)
  }

  isTrackedParentSession(sessionId: string) {
    return this.parentSessions.has(sessionId)
  }

  untrackParentSession(sessionId: string) {
    this.parentSessions.delete(sessionId)
  }

  registerSession(sessionId?: string | null, parentId?: string | null) {
    if (!sessionId) return
    if (!parentId) {
      if (!this.sessionLineage.has(sessionId)) {
        this.sessionLineage.set(sessionId, sessionId)
      }
      return
    }
    if (this.wouldCreateLineageCycle(sessionId, parentId)) {
      this.sessionLineage.set(sessionId, sessionId)
      return
    }
    this.sessionLineage.set(sessionId, parentId)
  }

  getImmediateParentSession(sessionId?: string | null): string | null {
    if (!sessionId) return null
    const parent = this.sessionLineage.get(sessionId)
    if (!parent || parent === sessionId) return null
    return parent
  }

  resolveRootSession(sessionId?: string | null) {
    if (!sessionId) return undefined

    let current = sessionId
    const seen = new Set<string>()

    while (true) {
      const next = this.sessionLineage.get(current)
      if (!next) return current
      if (next === current) return current
      if (seen.has(current)) return current
      seen.add(current)
      current = next
    }
  }

  findFallbackTaskRun(rootSessionId: string, parentSessionId: string) {
    const candidates = Array.from(this.taskRuns.values()).filter((taskRun) => {
      return taskRun.rootSessionId === rootSessionId
        && taskRun.parentSessionId === parentSessionId
        && taskRun.id.startsWith('child:')
        && (taskRun.status === 'queued' || taskRun.status === 'running')
    })

    return candidates.length === 1 ? candidates[0] : null
  }

  bindTaskRunToChild(taskRunId: string, childSessionId: string) {
    const resolvedTaskRunId = this.resolveTaskRunId(taskRunId) || taskRunId
    const existingTaskRunId = this.childSessionToTaskRunId.get(childSessionId)
    const childParentSessionId = this.getImmediateParentSession(childSessionId)
    if (existingTaskRunId && existingTaskRunId !== resolvedTaskRunId) {
      const existingTaskRun = this.taskRuns.get(existingTaskRunId)
      const incomingTaskRun = this.taskRuns.get(resolvedTaskRunId)

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
        const finishedAt = isTerminalTaskStatus(mergedStatus)
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

        this.taskRuns.set(existingTaskRunId, mergedTaskRun)
        this.taskRuns.delete(resolvedTaskRunId)
        this.childSessionToTaskRunId.set(childSessionId, existingTaskRunId)
        this.taskRunAliases.set(taskRunId, existingTaskRunId)
        if (resolvedTaskRunId !== taskRunId) this.taskRunAliases.set(resolvedTaskRunId, existingTaskRunId)
        this.removePendingTaskRun(resolvedTaskRunId)
        this.removeQueuedChildSession(childSessionId)
        return mergedTaskRun
      }
    }

    const taskRun = this.taskRuns.get(resolvedTaskRunId)
    if (!taskRun) return null
    taskRun.childSessionId = childSessionId
    taskRun.parentSessionId = childParentSessionId || taskRun.parentSessionId || taskRun.rootSessionId
    this.childSessionToTaskRunId.set(childSessionId, resolvedTaskRunId)
    if (resolvedTaskRunId !== taskRunId) this.taskRunAliases.set(taskRunId, resolvedTaskRunId)
    this.removePendingTaskRun(resolvedTaskRunId)
    this.removeQueuedChildSession(childSessionId)
    return taskRun
  }

  registerTaskRun(taskRun: TaskRunMeta) {
    const normalizedTaskRun: TaskRunMeta = normalizeTaskTiming({
      ...taskRun,
      parentSessionId: taskRun.parentSessionId || taskRun.rootSessionId,
    })
    this.taskRunAliases.delete(normalizedTaskRun.id)
    this.taskRuns.set(normalizedTaskRun.id, normalizedTaskRun)
    const parentQueueKey = normalizedTaskRun.parentSessionId || normalizedTaskRun.rootSessionId

    if (normalizedTaskRun.childSessionId) {
      this.childSessionToTaskRunId.set(normalizedTaskRun.childSessionId, normalizedTaskRun.id)
      this.removePendingTaskRun(normalizedTaskRun.id)
      this.removeQueuedChildSession(normalizedTaskRun.childSessionId)
      return normalizedTaskRun
    }

    const queuedChild = this.takeQueuedChildSession(parentQueueKey)
    if (queuedChild) {
      const bound = this.bindTaskRunToChild(normalizedTaskRun.id, queuedChild.id)
      return bound || this.taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
    }

    if (!normalizedTaskRun.childSessionId && !isTerminalTaskStatus(normalizedTaskRun.status)) {
      pushUniqueQueueValue(this.pendingTaskRunsByParent, parentQueueKey, normalizedTaskRun.id)
    }

    return this.taskRuns.get(normalizedTaskRun.id) || normalizedTaskRun
  }

  queueOrBindChildSession(
    parentSessionId: string | null | undefined,
    childSessionId: string,
  ) {
    if (!parentSessionId) return null
    const existingTaskRunId = this.childSessionToTaskRunId.get(childSessionId)
    if (existingTaskRunId) {
      const existing = this.taskRuns.get(existingTaskRunId)
      if (existing) {
        this.removeQueuedChildSession(childSessionId)
        return existing
      }
      this.childSessionToTaskRunId.delete(childSessionId)
    }

    const pendingTaskRunId = this.takePendingTaskRunId(parentSessionId)
    if (pendingTaskRunId) {
      return this.bindTaskRunToChild(pendingTaskRunId, childSessionId)
    }

    const queuedChild: QueuedChildSessionMeta = {
      id: childSessionId,
    }
    const current = this.queuedChildSessionsByParent.get(parentSessionId) || []
    if (!current.some((entry) => entry.id === childSessionId)) {
      this.queuedChildSessionsByParent.set(parentSessionId, [...current, queuedChild])
    }
    return null
  }

  ensureTaskRunForChild(
    rootSessionId: string,
    childSessionId: string,
    agent?: string | null,
    parentSessionId?: string | null,
  ) {
    const existingTaskRunId = this.childSessionToTaskRunId.get(childSessionId)
    if (existingTaskRunId) return this.taskRuns.get(existingTaskRunId) || null

    const immediateParentSessionId = parentSessionId || this.getImmediateParentSession(childSessionId) || rootSessionId
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
    this.taskRuns.set(fallback.id, fallback)
    this.childSessionToTaskRunId.set(childSessionId, fallback.id)
    return fallback
  }

  updateTaskRun(taskRunId: string, patch: Partial<TaskRunMeta>) {
    const resolvedTaskRunId = this.resolveTaskRunId(taskRunId) || taskRunId
    const existing = this.taskRuns.get(resolvedTaskRunId)
    if (!existing) return null
    const next = applyTaskTimingTransition(existing, patch)
    this.taskRuns.set(resolvedTaskRunId, next)
    if (next.childSessionId) {
      this.childSessionToTaskRunId.set(next.childSessionId, resolvedTaskRunId)
    } else if (isTerminalTaskStatus(next.status)) {
      this.removePendingTaskRun(next.id)
    }
    return next
  }

  getTaskRun(taskRunId: string | null | undefined) {
    if (!taskRunId) return null
    return this.taskRuns.get(taskRunId) || null
  }

  getTaskRunIdForChild(sessionId: string | null | undefined) {
    if (!sessionId) return null
    return this.childSessionToTaskRunId.get(sessionId) || null
  }

  aliasTaskRunId(aliasTaskRunId: string | null | undefined, targetTaskRunId: string | null | undefined) {
    if (!aliasTaskRunId || !targetTaskRunId || aliasTaskRunId === targetTaskRunId) return
    const resolvedTargetTaskRunId = this.resolveTaskRunId(targetTaskRunId) || targetTaskRunId
    if (!this.taskRuns.has(resolvedTargetTaskRunId)) return
    this.taskRunAliases.set(aliasTaskRunId, resolvedTargetTaskRunId)
  }

  resolveTaskRunId(taskRunId: string | null | undefined) {
    if (!taskRunId) return null
    if (this.taskRuns.has(taskRunId)) return taskRunId
    const aliasedTaskRunId = this.taskRunAliases.get(taskRunId)
    if (!aliasedTaskRunId) return null
    if (this.taskRuns.has(aliasedTaskRunId)) return aliasedTaskRunId
    this.taskRunAliases.delete(taskRunId)
    return null
  }

  rememberSubmittedPrompt(sessionId: string, text: string) {
    if (!sessionId || !text) return
    this.pendingSubmittedPromptBySession.set(sessionId, text)
  }

  forgetSubmittedPrompt(sessionId: string) {
    this.pendingSubmittedPromptBySession.delete(sessionId)
  }

  consumePendingPromptEcho(sessionId: string, content: string) {
    const pending = this.pendingSubmittedPromptBySession.get(sessionId)
    if (!pending || !content) return content
    if (content === pending) {
      this.pendingSubmittedPromptBySession.delete(sessionId)
      return ''
    }
    if (pending.startsWith(content)) {
      this.pendingSubmittedPromptBySession.set(sessionId, pending.slice(content.length))
      return ''
    }
    if (content.startsWith(pending)) {
      this.pendingSubmittedPromptBySession.delete(sessionId)
      return content.slice(pending.length)
    }
    return content
  }

  sweepStaleTaskState(messageRoles?: Map<string, 'user' | 'assistant'>) {
    for (const [childSessionId, taskRunId] of this.childSessionToTaskRunId.entries()) {
      const taskRun = this.taskRuns.get(taskRunId)
      if (!taskRun || taskRun.childSessionId !== childSessionId) {
        this.childSessionToTaskRunId.delete(childSessionId)
      }
    }

    for (const [aliasTaskRunId, taskRunId] of this.taskRunAliases.entries()) {
      if (!this.taskRuns.has(taskRunId) || aliasTaskRunId === taskRunId) {
        this.taskRunAliases.delete(aliasTaskRunId)
      }
    }

    for (const [parentSessionId] of this.pendingTaskRunsByParent.entries()) {
      if (!this.isKnownSession(parentSessionId)) {
        this.pendingTaskRunsByParent.delete(parentSessionId)
      }
    }

    for (const [parentSessionId] of this.queuedChildSessionsByParent.entries()) {
      if (!this.isKnownSession(parentSessionId)) {
        this.queuedChildSessionsByParent.delete(parentSessionId)
      }
    }

    if (!messageRoles) return

    while (messageRoles.size > 2000) {
      const oldest = messageRoles.keys().next().value
      if (!oldest) break
      messageRoles.delete(oldest)
    }
  }

  removeParentSessionState(sessionId: string) {
    this.parentSessions.delete(sessionId)
    this.sessionLineage.delete(sessionId)
    this.pendingTaskRunsByParent.delete(sessionId)
    this.queuedChildSessionsByParent.delete(sessionId)
    this.pendingSubmittedPromptBySession.delete(sessionId)
    this.deleteTaskRunsForSessions([sessionId])
    const deletedTaskRunIds = new Set<string>()
    for (const [taskRunId, taskRun] of this.taskRuns.entries()) {
      if (taskRun.rootSessionId === sessionId) {
        deletedTaskRunIds.add(taskRunId)
        this.taskRuns.delete(taskRunId)
      }
    }
    this.removeTaskRunAliasesForTaskIds(deletedTaskRunIds)
    this.removeDescendantLineage(sessionId)
  }

  removeSessionState(sessionId: string, parentId?: string | null) {
    this.deleteTaskRunsForSessions([sessionId])
    this.sessionLineage.delete(sessionId)
    this.pendingTaskRunsByParent.delete(sessionId)
    this.queuedChildSessionsByParent.delete(sessionId)
    this.pendingSubmittedPromptBySession.delete(sessionId)
    this.removeDescendantLineage(sessionId)
    if (!parentId) {
      this.parentSessions.delete(sessionId)
    }
  }

  private isKnownSession(sessionId: string) {
    return this.parentSessions.has(sessionId) || this.sessionLineage.has(sessionId)
  }

  private wouldCreateLineageCycle(sessionId: string, parentId: string) {
    let current: string | undefined = parentId
    const seen = new Set<string>()
    while (current) {
      if (current === sessionId) return true
      if (seen.has(current)) return true
      seen.add(current)
      const next = this.sessionLineage.get(current)
      if (!next || next === current) return false
      current = next
    }
    return false
  }

  private takePendingTaskRunId(parentSessionId: string) {
    // OpenCode provides the parent lineage. Within one parent, event order is
    // the only deterministic binding signal Cowork may use; task titles and
    // agent labels are display metadata and must not drive assignment.
    let taskRunId = shiftQueueValue(this.pendingTaskRunsByParent, parentSessionId) || null
    while (taskRunId) {
      const taskRun = this.taskRuns.get(taskRunId)
      if (taskRun && !taskRun.childSessionId) return taskRunId
      taskRunId = shiftQueueValue(this.pendingTaskRunsByParent, parentSessionId) || null
    }
    return null
  }

  private takeQueuedChildSession(
    parentSessionId: string,
  ) {
    let queuedChild = shiftQueueValue(this.queuedChildSessionsByParent, parentSessionId) || null
    while (queuedChild) {
      if (!this.childSessionToTaskRunId.has(queuedChild.id)) return queuedChild
      queuedChild = shiftQueueValue(this.queuedChildSessionsByParent, parentSessionId) || null
    }
    return null
  }

  private removePendingTaskRun(taskRunId: string) {
    for (const parentSessionId of Array.from(this.pendingTaskRunsByParent.keys())) {
      spliceQueueValue(this.pendingTaskRunsByParent, parentSessionId, (entry) => entry === taskRunId)
    }
  }

  private removeQueuedChildSession(childSessionId: string) {
    for (const parentSessionId of Array.from(this.queuedChildSessionsByParent.keys())) {
      spliceQueueValue(this.queuedChildSessionsByParent, parentSessionId, (entry) => entry.id === childSessionId)
    }
  }

  private collectDescendantSessions(sessionId: string) {
    const descendants: string[] = []
    const queue = [sessionId]
    while (queue.length > 0) {
      const currentParentId = queue.shift()
      if (!currentParentId) continue
      for (const [childId, parentId] of this.sessionLineage.entries()) {
        if (parentId !== currentParentId || childId === currentParentId) continue
        descendants.push(childId)
        queue.push(childId)
      }
    }
    return descendants
  }

  private deleteTaskRunsForSessions(sessionIds: string[]) {
    const targetIds = new Set(sessionIds)
    const deletedTaskRunIds = new Set<string>()
    for (const sessionId of targetIds) {
      this.childSessionToTaskRunId.delete(sessionId)
    }
    for (const [taskRunId, taskRun] of this.taskRuns.entries()) {
      const childSessionId = taskRun.childSessionId
      if (
        (childSessionId && targetIds.has(childSessionId))
        || (taskRunId.startsWith('child:') && targetIds.has(taskRunId.slice('child:'.length)))
      ) {
        deletedTaskRunIds.add(taskRunId)
        this.taskRuns.delete(taskRunId)
      }
    }
    this.removeTaskRunAliasesForTaskIds(deletedTaskRunIds)
  }

  private removeTaskRunAliasesForTaskIds(taskRunIds: Set<string>) {
    if (taskRunIds.size === 0) return
    for (const [aliasTaskRunId, targetTaskRunId] of this.taskRunAliases.entries()) {
      if (taskRunIds.has(aliasTaskRunId) || taskRunIds.has(targetTaskRunId)) {
        this.taskRunAliases.delete(aliasTaskRunId)
      }
    }
  }

  private removeDescendantLineage(sessionId: string) {
    const descendants = this.collectDescendantSessions(sessionId)
    this.deleteTaskRunsForSessions(descendants)
    for (const childId of descendants) {
      this.sessionLineage.delete(childId)
      this.pendingTaskRunsByParent.delete(childId)
      this.queuedChildSessionsByParent.delete(childId)
      this.pendingSubmittedPromptBySession.delete(childId)
    }
  }
}
