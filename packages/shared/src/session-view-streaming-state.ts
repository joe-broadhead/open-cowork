import { cloneCompactionNotice } from './session-view-compaction.js'
import {
  buildMessageSegments,
  importMessage,
  isLivePlaceholderMessageId,
  nextHasRealMessageOfRole,
  renderMessageSegments,
  type MessageStateShape,
} from './session-view-messages.js'
import { renderTaskTranscript } from './session-view-task-runs.js'
import { cloneTokens } from './session-view-tokens.js'
import { preferNewerStreamingText } from './session-view-text.js'
import type { SessionViewState } from './session-view-model.js'

export function mergeStreamingStateFromExisting(next: SessionViewState, existing: SessionViewState) {
  let messageState: MessageStateShape = {
    messageIds: next.messageIds,
    messageById: next.messageById,
    messagePartsById: next.messagePartsById,
    messageReasoningById: next.messageReasoningById,
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
      const reasoning = existingMessage.reasoningIds
        .map((segmentId) => existing.messageReasoningById[segmentId])
        .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
      if (segments.length === 0 && reasoning.length === 0) continue
      const existingContent = renderMessageSegments(segments)
      // History/view snapshots can land under a different message id than the
      // stream used. If a next message of the same role already carries this
      // answer (or a longer authoritative copy), skip the residual stream bubble.
      if (existingContent && existingMessage.role === 'assistant') {
        const alreadyCovered = messageState.messageIds.some((nextId) => {
          const candidate = messageState.messageById[nextId]
          if (!candidate || candidate.role !== 'assistant') return false
          if (isLivePlaceholderMessageId(candidate.id, 'assistant')) return false
          const nextSegments = buildMessageSegments(candidate, messageState.messagePartsById)
          const nextContent = renderMessageSegments(nextSegments)
          return nextContent === existingContent
            || nextContent.startsWith(existingContent)
            || (
              existingContent.length >= 16
              && nextContent.includes(existingContent)
            )
        })
        if (alreadyCovered) continue
      }
      messageState = importMessage(messageState, {
        id: existingMessage.id,
        role: existingMessage.role,
        attachments: existingMessage.attachments,
        segments,
        reasoning,
        content: existingContent,
        order: existingMessage.order,
      })
      continue
    }

    const messageById = { ...messageState.messageById }
    const messagePartsById = { ...messageState.messagePartsById }
    const messageReasoningById = { ...messageState.messageReasoningById }
    const segmentIds = nextMessage.segmentIds.slice()
    const reasoningIds = nextMessage.reasoningIds.slice()

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

    for (const reasoningId of existingMessage.reasoningIds) {
      const existingReasoning = existing.messageReasoningById[reasoningId]
      if (!existingReasoning) continue
      const nextReasoning = messageReasoningById[reasoningId]
      if (!nextReasoning) {
        reasoningIds.push(reasoningId)
        messageReasoningById[reasoningId] = { ...existingReasoning }
        continue
      }
      const content = preferNewerStreamingText(nextReasoning.content, existingReasoning.content)
      if (content !== nextReasoning.content) {
        messageReasoningById[reasoningId] = {
          ...nextReasoning,
          content,
        }
      }
    }

    messageById[messageId] = {
      ...nextMessage,
      attachments: nextMessage.attachments ?? existingMessage.attachments,
      segmentIds,
      reasoningIds,
    }
    messageState = {
      messageIds: messageState.messageIds,
      messageById,
      messagePartsById,
      messageReasoningById,
    }
  }

  next.messageIds = messageState.messageIds
  next.messageById = messageState.messageById
  next.messagePartsById = messageState.messagePartsById
  next.messageReasoningById = messageState.messageReasoningById

  const nextTaskRuns = next.taskRuns.map((taskRun) => ({
    ...taskRun,
    transcript: taskRun.transcript.map((segment) => ({ ...segment })),
    ...(taskRun.reasoning && taskRun.reasoning.length > 0
      ? { reasoning: taskRun.reasoning.map((segment) => ({ ...segment })) }
      : {}),
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
        ...(existingTaskRun.reasoning && existingTaskRun.reasoning.length > 0
          ? { reasoning: existingTaskRun.reasoning.map((segment) => ({ ...segment })) }
          : {}),
        todos: existingTaskRun.todos.map((todo) => ({ ...todo })),
        sessionTokens: cloneTokens(existingTaskRun.sessionTokens),
      })
      continue
    }

    const nextTaskRun = nextTaskRuns[nextIndex]!
    const transcript = nextTaskRun.transcript.slice()
    const reasoning = (nextTaskRun.reasoning || []).slice()
    for (const existingSegment of existingTaskRun.transcript) {
      const segmentIndex = transcript.findIndex((segment) => segment.id === existingSegment.id)
      if (segmentIndex === -1) {
        transcript.push({ ...existingSegment })
        continue
      }
      const currentSegment = transcript[segmentIndex]!
      const content = preferNewerStreamingText(currentSegment.content, existingSegment.content)
      if (content !== currentSegment.content) {
        transcript[segmentIndex] = {
          ...currentSegment,
          content,
        }
      }
    }
    for (const existingSegment of existingTaskRun.reasoning || []) {
      const segmentIndex = reasoning.findIndex((segment) => segment.id === existingSegment.id)
      if (segmentIndex === -1) {
        reasoning.push({ ...existingSegment })
        continue
      }
      const currentSegment = reasoning[segmentIndex]!
      const content = preferNewerStreamingText(currentSegment.content, existingSegment.content)
      if (content !== currentSegment.content) {
        reasoning[segmentIndex] = {
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
      ...(reasoning.length > 0 ? { reasoning } : {}),
      content: renderTaskTranscript(transcript),
      startedAt: nextTaskRun.startedAt ?? existingTaskRun.startedAt ?? null,
      finishedAt: nextTaskRun.finishedAt ?? existingTaskRun.finishedAt ?? null,
    }
  }

  next.taskRuns = nextTaskRuns
}
