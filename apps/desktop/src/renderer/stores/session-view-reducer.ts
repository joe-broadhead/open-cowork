import type { SessionPatch, TaskRun } from '@open-cowork/shared'
import {
  deriveVisibleSessionPatch,
  getOrCreateSessionState,
  hasMessageTextSegment,
  hasSplitMessageTextSegment,
  pruneSessionDetailCache,
  withMessageReasoning,
  withMessageText,
  withTaskReasoning,
  withTaskRun,
  withTaskTranscript,
  type SessionViewState,
} from '../../lib/session-view-model.ts'
import type { SessionStore } from './session.ts'
import { activeSessionWorkspaceKey } from './session-workspace-keys.ts'

export function sumSessionCosts(sessionStateById: Record<string, SessionViewState>) {
  return Object.values(sessionStateById)
    .reduce((sum, sessionState) => sum + (sessionState.sessionCost || 0), 0)
}

export function sessionViewTiming() {
  return {
    nowMs: Date.now(),
    nowIso: new Date().toISOString(),
    formatTimestamp: (timestamp: number) => new Date(timestamp).toISOString(),
  }
}

function latestOrder(...groups: readonly (readonly { order?: number | null }[] | null | undefined)[]) {
  let max: number | null = null
  for (const group of groups) {
    if (!group) continue
    for (const entry of group) {
      const order = typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : null
      if (order !== null && (max === null || order > max)) max = order
    }
  }
  return max ?? undefined
}

function latestTaskInterruptionOrder(taskRun: TaskRun) {
  return latestOrder(taskRun.toolCalls, taskRun.compactions)
}

function latestSessionInterruptionOrder(current: SessionViewState) {
  return latestOrder(
    current.toolCalls,
    current.taskRuns,
    current.compactions,
    current.pendingApprovals,
    current.errors,
  )
}

function shouldComputeMessageSplitOrder(
  current: SessionViewState,
  messageId: string,
  segmentId: string,
) {
  return hasMessageTextSegment(current, messageId, segmentId)
    && (current.lastItemWasTool || !hasSplitMessageTextSegment(current, messageId, segmentId))
}

export function updateSessionState(
  state: SessionStore,
  sessionId: string,
  updater: (current: SessionViewState) => SessionViewState,
  options?: { eventAt?: number },
) {
  const sessionStateById = { ...state.sessionStateById }
  const timing = sessionViewTiming()
  const sessionKey = activeSessionWorkspaceKey(state, sessionId)
  const currentSessionKey = state.currentSessionId ? activeSessionWorkspaceKey(state, state.currentSessionId) : null
  const current = getOrCreateSessionState(sessionStateById, sessionKey, timing)
  const updated = updater(current)
  const next = {
    ...updated,
    revision: current.revision + 1,
    lastEventAt: options?.eventAt ?? timing.nowMs,
  }
  sessionStateById[sessionKey] = next
  const prunedSessionStateById = pruneSessionDetailCache(sessionStateById, currentSessionKey, state.busySessions)

  const patch: Partial<SessionStore> = {
    sessionStateById: prunedSessionStateById,
    totalCost: sumSessionCosts(prunedSessionStateById),
  }
  if (state.currentSessionId === sessionId) {
    const visibleState = prunedSessionStateById[sessionKey] || next
    patch.currentView = deriveVisibleSessionPatch(
      visibleState,
      sessionKey,
      state.busySessions,
      state.awaitingPermissionSessions,
      timing,
    )
  }
  return patch
}

export function applySessionPatchToState(state: SessionStore, patch: SessionPatch) {
  if (patch.type === 'task_text') {
    return updateSessionState(
      state,
      patch.sessionId,
      (current) => ({
        ...current,
        taskRuns: withTaskRun(current.taskRuns, patch.taskRunId, (taskRun) => ({
          ...withTaskTranscript(taskRun, patch.segmentId, patch.content, {
            replace: patch.mode === 'replace',
            splitAfterOrder: patch.mode === 'replace' ? undefined : latestTaskInterruptionOrder(taskRun),
          }),
        })),
        lastItemWasTool: true,
      }),
      { eventAt: patch.eventAt },
    )
  }

  if (patch.type === 'task_reasoning') {
    return updateSessionState(
      state,
      patch.sessionId,
      (current) => ({
        ...current,
        taskRuns: withTaskRun(current.taskRuns, patch.taskRunId, (taskRun) => ({
          ...withTaskReasoning(taskRun, patch.segmentId, patch.content, {
            replace: patch.mode === 'replace',
          }),
        })),
        lastItemWasTool: true,
      }),
      { eventAt: patch.eventAt },
    )
  }

  if (patch.type === 'message_reasoning') {
    return updateSessionState(
      state,
      patch.sessionId,
      (current) => ({
        ...current,
        ...withMessageReasoning(current, {
          messageId: patch.messageId,
          content: patch.content,
          segmentId: patch.segmentId,
          replace: patch.mode === 'replace',
        }, sessionViewTiming()),
        lastItemWasTool: false,
      }),
      { eventAt: patch.eventAt },
    )
  }

  return updateSessionState(
    state,
    patch.sessionId,
    (current) => {
      const splitAfterOrder = patch.mode === 'replace'
        ? undefined
        : shouldComputeMessageSplitOrder(current, patch.messageId, patch.segmentId)
          ? latestSessionInterruptionOrder(current)
          : undefined
      return {
        ...current,
        ...withMessageText(current, {
          messageId: patch.messageId,
          role: patch.role || 'assistant',
          content: patch.content,
          segmentId: patch.segmentId,
          attachments: patch.attachments,
          replace: patch.mode === 'replace',
          splitAfterOrder,
        }, sessionViewTiming()),
        lastItemWasTool: false,
      }
    },
    { eventAt: patch.eventAt },
  )
}

export function orderSessionPatches(patches: SessionPatch[]) {
  return patches
    .map((patch, index) => ({ patch, index }))
    .sort((left, right) => {
      if (left.patch.eventAt !== right.patch.eventAt) return left.patch.eventAt - right.patch.eventAt
      return left.index - right.index
    })
    .map(({ patch }) => patch)
}
