import { scopeMessageSegmentId, type SessionViewState } from '@open-cowork/shared'
import type { SessionPatch } from '@open-cowork/shared'
type SessionStreamingFlushSnapshot = {
  currentSessionId: string | null
  currentSessionKey?: string | null
  sessionStateById: Record<string, SessionViewState>
}

export function shouldCommitStreamingTextImmediately(
  part: SessionPatch,
  snapshot: SessionStreamingFlushSnapshot,
) {
  if (snapshot.currentSessionId !== part.sessionId) return false

  const sessionState = snapshot.sessionStateById[snapshot.currentSessionKey || part.sessionId]
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
  // Message part maps are keyed by message-scoped segment ids (OpenCode V2 reuses
  // bare part ids like text-0 across turns). Look up with the same scope used by
  // withMessageText / withMessageReasoning so appends buffer instead of
  // immediately re-merging into an existing segment.
  const scopedSegmentId = scopeMessageSegmentId(part.messageId, part.segmentId)
  const segment = part.type === 'message_reasoning'
    ? sessionState.messageReasoningById[scopedSegmentId]
    : sessionState.messagePartsById[scopedSegmentId]
  return !segment || segment.content.length === 0
}
