import {
  SessionTaskStateStore,
  type TaskRunMeta,
  type TaskStatus,
} from './session-task-state-store.ts'

export type { TaskRunMeta, TaskStatus }

const hierarchyStore = new SessionTaskStateStore()

export function trackParentSession(sessionId: string) {
  hierarchyStore.trackParentSession(sessionId)
}

export function isTrackedParentSession(sessionId: string) {
  return hierarchyStore.isTrackedParentSession(sessionId)
}

export function untrackParentSession(sessionId: string) {
  hierarchyStore.untrackParentSession(sessionId)
}

export function registerSession(sessionId?: string | null, parentId?: string | null) {
  hierarchyStore.registerSession(sessionId, parentId)
}

// Returns the immediate parent session id for a child session, or null if
// the session has no recorded parent (i.e. it's a root session). Used by
// the orchestration UI to render two-level nesting — a task's parent
// session tells us which other task (if any) spawned it.
export function getImmediateParentSession(sessionId?: string | null): string | null {
  return hierarchyStore.getImmediateParentSession(sessionId)
}

export function resolveRootSession(sessionId?: string | null) {
  return hierarchyStore.resolveRootSession(sessionId)
}

export function findFallbackTaskRun(rootSessionId: string, parentSessionId: string) {
  return hierarchyStore.findFallbackTaskRun(rootSessionId, parentSessionId)
}

export function bindTaskRunToChild(taskRunId: string, childSessionId: string) {
  return hierarchyStore.bindTaskRunToChild(taskRunId, childSessionId)
}

export function registerTaskRun(taskRun: TaskRunMeta) {
  return hierarchyStore.registerTaskRun(taskRun)
}

export function queueOrBindChildSession(
  parentSessionId: string | null | undefined,
  childSessionId: string,
) {
  return hierarchyStore.queueOrBindChildSession(parentSessionId, childSessionId)
}

export function ensureTaskRunForChild(
  rootSessionId: string,
  childSessionId: string,
  agent?: string | null,
  parentSessionId?: string | null,
) {
  return hierarchyStore.ensureTaskRunForChild(rootSessionId, childSessionId, agent, parentSessionId)
}

export function updateTaskRun(taskRunId: string, patch: Partial<TaskRunMeta>) {
  return hierarchyStore.updateTaskRun(taskRunId, patch)
}

export function getTaskRun(taskRunId: string | null | undefined) {
  return hierarchyStore.getTaskRun(taskRunId)
}

export function getTaskRunIdForChild(sessionId: string | null | undefined) {
  return hierarchyStore.getTaskRunIdForChild(sessionId)
}

export function rememberSubmittedPrompt(sessionId: string, text: string) {
  hierarchyStore.rememberSubmittedPrompt(sessionId, text)
}

export function forgetSubmittedPrompt(sessionId: string) {
  hierarchyStore.forgetSubmittedPrompt(sessionId)
}

export function consumePendingPromptEcho(sessionId: string, content: string) {
  return hierarchyStore.consumePendingPromptEcho(sessionId, content)
}

export function sweepStaleTaskState(messageRoles: Map<string, 'user' | 'assistant'>) {
  hierarchyStore.sweepStaleTaskState(messageRoles)
}

export function removeParentSessionState(sessionId: string) {
  hierarchyStore.removeParentSessionState(sessionId)
}

export function removeSessionState(sessionId: string, parentId?: string | null) {
  hierarchyStore.removeSessionState(sessionId, parentId)
}

export function resetEventTaskState() {
  hierarchyStore.reset()
}
