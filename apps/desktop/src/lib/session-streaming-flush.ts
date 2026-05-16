import type { SessionPatch } from '@open-cowork/shared'
import type { SessionViewState } from './session-view-model.ts'

export type SessionStreamingFlushSnapshot = {
  currentSessionId: string | null
  sessionStateById: Record<string, SessionViewState>
}

export function shouldCommitStreamingTextImmediately(
  part: SessionPatch,
  snapshot: SessionStreamingFlushSnapshot,
) {
  if (snapshot.currentSessionId !== part.sessionId) return false

  const sessionState = snapshot.sessionStateById[part.sessionId]
  if (!sessionState) return true

  if (part.type === 'task_text' || part.type === 'task_reasoning') {
    const taskRun = sessionState.taskRuns.find((task) => task.id === part.taskRunId)
    if (!taskRun) return true
    const segments = part.type === 'task_reasoning' ? (taskRun.reasoning || []) : taskRun.transcript
    const segment = segments.find((entry) => entry.id === part.segmentId)
    return !segment || segment.content.length === 0
  }

  const message = sessionState.messageById[part.messageId]
  if (!message) return true
  const segment = part.type === 'message_reasoning'
    ? sessionState.messageReasoningById[part.segmentId]
    : sessionState.messagePartsById[part.segmentId]
  return !segment || segment.content.length === 0
}
