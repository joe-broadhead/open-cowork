import { cloneCompactionNotice } from './session-view-compaction.ts'
import {
  buildMessageSegments,
  importMessage,
  isLivePlaceholderMessageId,
  nextHasRealMessageOfRole,
  renderMessageSegments,
  type MessageStateShape,
} from './session-view-messages.ts'
import { renderTaskTranscript } from './session-view-task-runs.ts'
import { cloneTokens } from './session-view-tokens.ts'
import { preferNewerStreamingText } from './session-view-text.ts'
import type { SessionViewState } from './session-view-model.ts'

export function mergeStreamingStateFromExisting(next: SessionViewState, existing: SessionViewState) {
  let messageState: MessageStateShape = {
    messageIds: next.messageIds,
    messageById: next.messageById,
    messagePartsById: next.messagePartsById,
  }

  for (const messageId of existing.messageIds) {
    const existingMessage = existing.messageById[messageId]
    if (!existingMessage) continue
    const nextMessage = messageState.messageById[messageId]
    if (!nextMessage) {
      // If the existing message is a live placeholder and `next` already has
      // a real message of the same role, the placeholder was absorbed during
      // history application. Re-importing it would create a duplicate bubble.
      if (
        isLivePlaceholderMessageId(existingMessage.id, existingMessage.role)
        && nextHasRealMessageOfRole(messageState, existingMessage.role)
      ) {
        continue
      }
      const segments = buildMessageSegments(existingMessage, existing.messagePartsById)
      if (segments.length === 0) continue
      messageState = importMessage(messageState, {
        id: existingMessage.id,
        role: existingMessage.role,
        attachments: existingMessage.attachments,
        segments,
        content: renderMessageSegments(segments),
        order: existingMessage.order,
      })
      continue
    }

    const messageById = { ...messageState.messageById }
    const messagePartsById = { ...messageState.messagePartsById }
    const segmentIds = nextMessage.segmentIds.slice()

    for (const segmentId of existingMessage.segmentIds) {
      const existingSegment = existing.messagePartsById[segmentId]
      if (!existingSegment) continue
      const nextSegment = messagePartsById[segmentId]
      if (!nextSegment) {
        segmentIds.push(segmentId)
        messagePartsById[segmentId] = { ...existingSegment }
        continue
      }
      const content = preferNewerStreamingText(nextSegment.content, existingSegment.content)
      if (content !== nextSegment.content) {
        messagePartsById[segmentId] = {
          ...nextSegment,
          content,
        }
      }
    }

    messageById[messageId] = {
      ...nextMessage,
      attachments: nextMessage.attachments ?? existingMessage.attachments,
      segmentIds,
    }
    messageState = {
      messageIds: messageState.messageIds,
      messageById,
      messagePartsById,
    }
  }

  next.messageIds = messageState.messageIds
  next.messageById = messageState.messageById
  next.messagePartsById = messageState.messagePartsById

  const nextTaskRuns = next.taskRuns.map((taskRun) => ({
    ...taskRun,
    transcript: taskRun.transcript.map((segment) => ({ ...segment })),
  }))

  for (const existingTaskRun of existing.taskRuns) {
    const nextIndex = nextTaskRuns.findIndex((taskRun) => taskRun.id === existingTaskRun.id)
    if (nextIndex === -1) {
      if (existingTaskRun.transcript.length === 0 && !existingTaskRun.content) continue
      nextTaskRuns.push({
        ...existingTaskRun,
        toolCalls: existingTaskRun.toolCalls.map((tool) => ({ ...tool })),
        compactions: existingTaskRun.compactions.map(cloneCompactionNotice),
        transcript: existingTaskRun.transcript.map((segment) => ({ ...segment })),
        todos: existingTaskRun.todos.map((todo) => ({ ...todo })),
        sessionTokens: cloneTokens(existingTaskRun.sessionTokens),
      })
      continue
    }

    const nextTaskRun = nextTaskRuns[nextIndex]
    const transcript = nextTaskRun.transcript.slice()
    for (const existingSegment of existingTaskRun.transcript) {
      const segmentIndex = transcript.findIndex((segment) => segment.id === existingSegment.id)
      if (segmentIndex === -1) {
        transcript.push({ ...existingSegment })
        continue
      }
      const currentSegment = transcript[segmentIndex]
      const content = preferNewerStreamingText(currentSegment.content, existingSegment.content)
      if (content !== currentSegment.content) {
        transcript[segmentIndex] = {
          ...currentSegment,
          content,
        }
      }
    }

    // Preserve live-streamed timing. If the existing task had a startedAt
    // but the hydrated next task lost it because history emitted task_run
    // events without timing metadata, carry the existing values forward.
    nextTaskRuns[nextIndex] = {
      ...nextTaskRun,
      transcript,
      content: renderTaskTranscript(transcript),
      startedAt: nextTaskRun.startedAt ?? existingTaskRun.startedAt ?? null,
      finishedAt: nextTaskRun.finishedAt ?? existingTaskRun.finishedAt ?? null,
    }
  }

  next.taskRuns = nextTaskRuns
}
