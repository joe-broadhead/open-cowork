import type {
  Message,
  MessageAttachment,
  ReasoningSegment,
  MessageSegment,
} from '@open-cowork/shared'

import { nextOrderFrom, nowIsoFromTiming, orderAfterSplitBoundary, type SessionViewTiming } from './session-view-order.js'
import { mergeStreamingText, preferNewerStreamingText, splitReplacementTextByPreviousSegments } from './session-view-text.js'

const LIVE_ASSISTANT_MESSAGE_SUFFIX = ':assistant:live'
const LIVE_ASSISTANT_SEGMENT_SUFFIX = ':segment:live'
const LIVE_USER_MESSAGE_SUFFIX = ':user:live'
const LIVE_USER_SEGMENT_SUFFIX = ':user:segment:live'
// OpenCode V2 reuses part ids like `text-0` across different messages. Part
// storage is a flat map, so unscoped part ids collide and every bubble ends up
// showing the last reply. Scope every segment key by its owning message id.
const SEGMENT_SCOPE_SEPARATOR = '::'

/**
 * Namespace a provider part/segment id under its message so concurrent
 * assistant turns cannot clobber each other's text in messagePartsById.
 */
export function scopeMessageSegmentId(messageId: string, segmentId: string): string {
  if (!messageId || !segmentId) return segmentId
  const prefix = `${messageId}${SEGMENT_SCOPE_SEPARATOR}`
  if (segmentId.startsWith(prefix)) return segmentId
  return `${prefix}${segmentId}`
}

export function unscopeMessageSegmentId(messageId: string, segmentId: string): string {
  if (!messageId || !segmentId) return segmentId
  const prefix = `${messageId}${SEGMENT_SCOPE_SEPARATOR}`
  if (segmentId.startsWith(prefix)) return segmentId.slice(prefix.length)
  return segmentId
}

export interface MessageEntity {
  id: string
  role: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  timestamp?: string | null
  providerId?: string | null
  modelId?: string | null
  segmentIds: string[]
  reasoningIds: string[]
  order: number
}

export interface MessagePartEntity {
  id: string
  content: string
  order: number
}

export interface MessageStateShape {
  messageIds: string[]
  messageById: Record<string, MessageEntity>
  messagePartsById: Record<string, MessagePartEntity>
  messageReasoningById: Record<string, MessagePartEntity>
}

function splitSegmentIdAfterOrder(segmentId: string, order: number) {
  return `${segmentId}:after:${order}`
}

function splitSegmentPrefix(segmentId: string) {
  return `${segmentId}:after:`
}

function latestSplitSegmentId(
  messagePartsById: Record<string, MessagePartEntity>,
  segmentIds: string[],
  segmentId: string,
) {
  let latest: { id: string; order: number } | null = null
  const prefix = splitSegmentPrefix(segmentId)
  for (const candidateId of segmentIds) {
    if (!candidateId.startsWith(prefix)) continue
    const candidate = messagePartsById[candidateId]
    if (!candidate) continue
    if (!latest || candidate.order > latest.order) {
      latest = { id: candidateId, order: candidate.order }
    }
  }
  return latest?.id ?? null
}

function isStreamingResidualSegmentId(segmentId: string) {
  return segmentId.endsWith(LIVE_ASSISTANT_SEGMENT_SUFFIX)
    || segmentId.endsWith(LIVE_USER_SEGMENT_SUFFIX)
    || segmentId.includes(':segment:live')
    || segmentId.includes(':user:segment:live')
    || /:after:\d+$/.test(segmentId)
}

/**
 * When an authoritative replace lands (history snapshot or part.updated with the
 * full text), drop stream residuals that would otherwise join into a duplicated
 * bubble. Intentional multi-part messages (distinct part ids with different
 * content) are preserved: we only remove a sibling when its content is already
 * covered by the replacement text.
 */
function collapseSegmentsSupersededByReplace(
  messagePartsById: Record<string, MessagePartEntity>,
  segmentIds: string[],
  targetSegmentId: string,
  replacement: string,
  messageId: string,
) {
  if (!replacement) return segmentIds

  const keepRelated = (segmentId: string) => (
    segmentId === targetSegmentId
    || segmentId.startsWith(splitSegmentPrefix(targetSegmentId))
  )

  const nextIds: string[] = []
  for (const segmentId of segmentIds) {
    if (keepRelated(segmentId)) {
      nextIds.push(segmentId)
      continue
    }
    const segment = messagePartsById[segmentId]
    if (!segment) continue
    if (!segment.content) {
      delete messagePartsById[segmentId]
      continue
    }

    const coveredByReplacement = replacement === segment.content
      || replacement.startsWith(segment.content)
      || (
        segment.content.length >= 16
        && replacement.includes(segment.content)
      )
    // Stream deltas often land with segmentId === messageId when partId is
    // missing, then history/replace uses the real part id. That leaves two
    // segments with the same (or nested) answer text.
    const unscoped = unscopeMessageSegmentId(messageId, segmentId)
    const isMessageIdFallbackSegment = unscoped === messageId || segmentId === messageId
    const isResidual = isStreamingResidualSegmentId(unscoped)
      || isStreamingResidualSegmentId(segmentId)
      || isMessageIdFallbackSegment

    if (coveredByReplacement && (isResidual || replacement === segment.content)) {
      delete messagePartsById[segmentId]
      continue
    }

    nextIds.push(segmentId)
  }

  if (!nextIds.includes(targetSegmentId) && messagePartsById[targetSegmentId]) {
    nextIds.push(targetSegmentId)
  }
  return nextIds
}

export function hasMessageTextSegment(
  state: MessageStateShape,
  messageId: string,
  segmentId: string,
) {
  const scoped = scopeMessageSegmentId(messageId, segmentId)
  return Boolean(state.messageById[messageId]?.segmentIds.includes(scoped) && state.messagePartsById[scoped])
}

export function hasSplitMessageTextSegment(
  state: MessageStateShape,
  messageId: string,
  segmentId: string,
) {
  const message = state.messageById[messageId]
  const scoped = scopeMessageSegmentId(messageId, segmentId)
  return Boolean(message && latestSplitSegmentId(state.messagePartsById, message.segmentIds, scoped))
}

function livePlaceholderMessageSuffix(role: 'user' | 'assistant') {
  return role === 'assistant' ? LIVE_ASSISTANT_MESSAGE_SUFFIX : LIVE_USER_MESSAGE_SUFFIX
}

export function isLivePlaceholderMessageId(messageId: string, role: 'user' | 'assistant') {
  return messageId.endsWith(livePlaceholderMessageSuffix(role))
}

// Retained for the assistant-specific latest-message-id lookup below.
function isLiveAssistantMessageId(messageId: string) {
  return isLivePlaceholderMessageId(messageId, 'assistant')
}

function resolveIncomingLiveMessageId(
  state: MessageStateShape,
  input: { messageId: string; role: 'user' | 'assistant' },
) {
  // Only assistant-role placeholders get merged into the latest real assistant
  // message. User-role placeholders are always distinct per prompt and are
  // absorbed separately by moveLivePlaceholderStateToMessage below.
  if (input.role !== 'assistant' || !isLiveAssistantMessageId(input.messageId)) {
    return input.messageId
  }

  const latestMessageId = state.messageIds.at(-1)
  if (!latestMessageId) return input.messageId

  const latestMessage = state.messageById[latestMessageId]
  if (!latestMessage || latestMessage.role !== 'assistant') return input.messageId
  if (isLiveAssistantMessageId(latestMessage.id)) return input.messageId
  return latestMessage.id
}

function moveLivePlaceholderStateToMessage(
  state: MessageStateShape,
  input: {
    messageId: string
    segmentId: string
    role: 'user' | 'assistant'
    content: string
    attachments?: MessageAttachment[]
    timestamp?: string | null
    providerId?: string | null
    modelId?: string | null
  },
) {
  if (isLivePlaceholderMessageId(input.messageId, input.role)) {
    return state
  }

  const liveMessageIds = state.messageIds.filter((messageId) => {
    const message = state.messageById[messageId]
    return Boolean(
      message
      && message.role === input.role
      && isLivePlaceholderMessageId(message.id, input.role)
      && message.id !== input.messageId,
    )
  })
  const liveMessageId = input.role === 'user' && input.content.trim().length > 0
    ? liveMessageIds.find((messageId) => {
        const message = state.messageById[messageId]
        if (!message) return false
        return renderMessageSegments(buildMessageSegments(message, state.messagePartsById)) === input.content
      }) || liveMessageIds[0]
    : liveMessageIds[0]

  if (!liveMessageId) return state

  const liveMessage = state.messageById[liveMessageId]
  if (!liveMessage) return state

  const messageIds = state.messageIds
    .map((messageId) => (messageId === liveMessageId ? input.messageId : messageId))
    .filter((messageId, index, all) => all.indexOf(messageId) === index)
  const messageById = { ...state.messageById }
  const messagePartsById = { ...state.messagePartsById }
  const messageReasoningById = { ...state.messageReasoningById }
  let liveSegmentIds = liveMessage.segmentIds.slice()
  const liveReasoningIds = liveMessage.reasoningIds.slice()

  // Collapse multi-segment live stream text into the authoritative segment id
  // so tool-interrupted stream splits do not survive as a second bubble after
  // the real message id lands.
  if (liveSegmentIds.length > 0) {
    const liveSegments = liveSegmentIds
      .map((segmentId) => messagePartsById[segmentId])
      .filter((segment): segment is MessagePartEntity => Boolean(segment))
      .sort((left, right) => left.order - right.order)
    if (liveSegments.length > 0) {
      const joined = liveSegments.map((segment) => segment.content).join('')
      const earliestOrder = liveSegments[0]!.order
      const targetSegment = messagePartsById[input.segmentId]
      messagePartsById[input.segmentId] = targetSegment
        ? {
            ...targetSegment,
            order: Math.min(targetSegment.order, earliestOrder),
            content: preferNewerStreamingText(targetSegment.content, joined),
          }
        : {
            id: input.segmentId,
            content: joined,
            order: earliestOrder,
          }
      for (const segmentId of liveSegmentIds) {
        if (segmentId !== input.segmentId) delete messagePartsById[segmentId]
      }
      liveSegmentIds = [input.segmentId]
    }
  }

  const existingTarget = messageById[input.messageId]
  if (existingTarget) {
    const segmentIds = existingTarget.segmentIds.slice()
    const reasoningIds = existingTarget.reasoningIds.slice()
    for (const segmentId of liveSegmentIds) {
      const liveSegment = messagePartsById[segmentId]
      if (!liveSegment) continue
      const targetSegment = messagePartsById[segmentId]
      if (targetSegment && targetSegment !== liveSegment) {
        messagePartsById[segmentId] = {
          ...targetSegment,
          order: Math.min(targetSegment.order, liveSegment.order),
          content: preferNewerStreamingText(targetSegment.content, liveSegment.content),
        }
      } else if (!targetSegment) {
        messagePartsById[segmentId] = { ...liveSegment }
      }
      if (!segmentIds.includes(segmentId)) segmentIds.push(segmentId)
    }
    for (const reasoningId of liveReasoningIds) {
      const liveReasoning = messageReasoningById[reasoningId]
      if (!liveReasoning) continue
      if (!messageReasoningById[reasoningId]) {
        messageReasoningById[reasoningId] = { ...liveReasoning }
      }
      if (!reasoningIds.includes(reasoningId)) reasoningIds.push(reasoningId)
    }

    messageById[input.messageId] = {
      ...existingTarget,
      attachments: existingTarget.attachments ?? input.attachments ?? liveMessage.attachments,
      timestamp: existingTarget.timestamp ?? input.timestamp ?? liveMessage.timestamp ?? null,
      providerId: existingTarget.providerId ?? input.providerId ?? liveMessage.providerId ?? null,
      modelId: existingTarget.modelId ?? input.modelId ?? liveMessage.modelId ?? null,
      segmentIds,
      reasoningIds,
      order: Math.min(existingTarget.order, liveMessage.order),
    }
  } else {
    messageById[input.messageId] = {
      ...liveMessage,
      id: input.messageId,
      attachments: input.attachments ?? liveMessage.attachments,
      timestamp: input.timestamp ?? liveMessage.timestamp ?? null,
      providerId: input.providerId ?? liveMessage.providerId ?? null,
      modelId: input.modelId ?? liveMessage.modelId ?? null,
      segmentIds: liveSegmentIds,
      reasoningIds: liveReasoningIds,
    }
  }

  delete messageById[liveMessageId]

  return {
    messageIds,
    messageById,
    messagePartsById,
    messageReasoningById,
  }
}

function sortMessageSegments(segments: MessageSegment[]) {
  let alreadySorted = true
  for (let index = 1; index < segments.length; index += 1) {
    if ((segments[index - 1]?.order || 0) > (segments[index]?.order || 0)) {
      alreadySorted = false
      break
    }
  }
  if (alreadySorted) return segments
  return segments.slice().sort((a, b) => a.order - b.order)
}

export function renderMessageSegments(segments: MessageSegment[]) {
  return sortMessageSegments(segments)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('')
}

export function buildMessageSegments(
  message: MessageEntity,
  messagePartsById: Record<string, MessagePartEntity>,
): MessageSegment[] {
  return message.segmentIds
    .map((segmentId) => messagePartsById[segmentId])
    .filter((segment): segment is MessagePartEntity => Boolean(segment))
    .sort((a, b) => a.order - b.order)
    .map((segment) => ({
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }))
}

function buildReasoningSegments(
  message: MessageEntity,
  messageReasoningById: Record<string, MessagePartEntity>,
): ReasoningSegment[] {
  return message.reasoningIds
    .map((segmentId) => messageReasoningById[segmentId])
    .filter((segment): segment is MessagePartEntity => Boolean(segment))
    .sort((a, b) => a.order - b.order)
    .map((segment) => ({
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }))
}

export function buildMessages(
  messageIds: string[],
  messageById: Record<string, MessageEntity>,
  messagePartsById: Record<string, MessagePartEntity>,
  messageReasoningById: Record<string, MessagePartEntity> = {},
): Message[] {
  const messages: Message[] = []
  for (const messageId of messageIds) {
    const message = messageById[messageId]
    if (!message) continue
    const segments = buildMessageSegments(message, messagePartsById)
    const reasoning = buildReasoningSegments(message, messageReasoningById)
    messages.push({
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      segments,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      content: renderMessageSegments(segments),
      timestamp: message.timestamp || null,
      providerId: message.providerId || null,
      modelId: message.modelId || null,
      order: message.order,
    })
  }
  return messages
}

export function createEmptyMessageState(): MessageStateShape {
  return {
    messageIds: [],
    messageById: {},
    messagePartsById: {},
    messageReasoningById: {},
  }
}

function nextMessageStateOrder(state: MessageStateShape) {
  return nextOrderFrom(
    Object.values(state.messageById),
    Object.values(state.messagePartsById),
    Object.values(state.messageReasoningById),
  )
}

export function importMessage(
  state: MessageStateShape,
  message: Message,
) {
  const messageIds = state.messageIds.includes(message.id)
    ? state.messageIds.slice()
    : [...state.messageIds, message.id]
  const sourceSegments = message.segments && message.segments.length > 0
    ? message.segments.map((segment) => ({
        ...segment,
        id: scopeMessageSegmentId(message.id, segment.id),
      }))
    : (message.content
      ? [{ id: scopeMessageSegmentId(message.id, 'initial'), content: message.content, order: message.order }]
      : [])
  const sourceReasoning = (message.reasoning || []).map((segment) => ({
    ...segment,
    id: scopeMessageSegmentId(message.id, segment.id),
  }))
  const messageById = {
    ...state.messageById,
    [message.id]: {
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      timestamp: message.timestamp || null,
      providerId: message.providerId || null,
      modelId: message.modelId || null,
      segmentIds: sourceSegments.map((segment) => segment.id),
      reasoningIds: sourceReasoning.map((segment) => segment.id),
      order: message.order,
    },
  }
  const messagePartsById = { ...state.messagePartsById }
  const messageReasoningById = { ...state.messageReasoningById }

  for (const segment of sourceSegments) {
    messagePartsById[segment.id] = {
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }
  }
  for (const segment of sourceReasoning) {
    messageReasoningById[segment.id] = {
      id: segment.id,
      content: segment.content,
      order: segment.order,
    }
  }

  messageIds.sort((left, right) => (messageById[left]?.order || 0) - (messageById[right]?.order || 0))

  return {
    messageIds,
    messageById,
    messagePartsById,
    messageReasoningById,
  }
}

export function withMessageText(
  state: MessageStateShape,
  input: {
    messageId: string
    role: 'user' | 'assistant'
    content: string
    segmentId: string
    attachments?: MessageAttachment[]
    timestamp?: string | null
    providerId?: string | null
    modelId?: string | null
    replace?: boolean
    splitAfterOrder?: number
  },
  timing?: SessionViewTiming,
) {
  const resolvedMessageId = resolveIncomingLiveMessageId(state, input)
  // Scope before absorb so live collapse and later storage share one key space.
  const scopedSegmentId = scopeMessageSegmentId(resolvedMessageId, input.segmentId)
  const normalizedInput = {
    ...input,
    messageId: resolvedMessageId,
    segmentId: scopedSegmentId,
  }
  const reconciledState = moveLivePlaceholderStateToMessage(state, normalizedInput)

  const messageIds = reconciledState.messageIds.slice()
  const messageById = { ...reconciledState.messageById }
  const messagePartsById = { ...reconciledState.messagePartsById }

  const existingMessage = messageById[normalizedInput.messageId]
  if (!existingMessage) {
    const messageOrder = timing?.order ?? nextMessageStateOrder(reconciledState)
    const segmentOrder = timing?.segmentOrder ?? (messageOrder + 1)
    messageById[normalizedInput.messageId] = {
      id: normalizedInput.messageId,
      role: normalizedInput.role,
      attachments: normalizedInput.attachments,
      timestamp: normalizedInput.timestamp || nowIsoFromTiming(timing),
      providerId: normalizedInput.providerId || null,
      modelId: normalizedInput.modelId || null,
      segmentIds: normalizedInput.content ? [normalizedInput.segmentId] : [],
      reasoningIds: [],
      order: messageOrder,
    }
    messageIds.push(normalizedInput.messageId)
    if (normalizedInput.content) {
      messagePartsById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: segmentOrder,
      }
    }
    return {
      messageIds,
      messageById,
      messagePartsById,
    }
  }

  const segmentIds = existingMessage.segmentIds.slice()
  let handledSplitReplace = false
  if (normalizedInput.replace) {
    const relatedSegmentIds = segmentIds
      .filter((segmentId) => segmentId === normalizedInput.segmentId || segmentId.startsWith(splitSegmentPrefix(normalizedInput.segmentId)))
      .filter((segmentId) => messagePartsById[segmentId])
      .sort((left, right) => messagePartsById[left]!.order - messagePartsById[right]!.order)

    if (relatedSegmentIds.length > 1) {
      const relatedSegments = relatedSegmentIds.map((segmentId) => messagePartsById[segmentId]!)
      const replacementSegments = splitReplacementTextByPreviousSegments(relatedSegments, normalizedInput.content)
      relatedSegments.forEach((segment, index) => {
        messagePartsById[segment.id] = {
          ...segment,
          content: replacementSegments[index] ?? '',
        }
      })
      handledSplitReplace = true
    }
  }

  const originalSegment = messagePartsById[normalizedInput.segmentId]
  const shouldSplitSegment = Boolean(
    originalSegment
    && !normalizedInput.replace
    && normalizedInput.splitAfterOrder !== undefined
    && originalSegment.order <= normalizedInput.splitAfterOrder,
  )
  const targetSegmentId = shouldSplitSegment
    ? splitSegmentIdAfterOrder(normalizedInput.segmentId, normalizedInput.splitAfterOrder!)
    : (!normalizedInput.replace
        ? latestSplitSegmentId(messagePartsById, segmentIds, normalizedInput.segmentId) || normalizedInput.segmentId
        : normalizedInput.segmentId)
  if (!handledSplitReplace) {
    const existingSegment = messagePartsById[targetSegmentId]
    if (!existingSegment) {
      if (normalizedInput.content) {
        if (!segmentIds.includes(targetSegmentId)) segmentIds.push(targetSegmentId)
        const fallbackOrder = timing?.segmentOrder ?? nextMessageStateOrder(reconciledState)
        messagePartsById[targetSegmentId] = {
          id: targetSegmentId,
          content: normalizedInput.content,
          order: orderAfterSplitBoundary(
            fallbackOrder,
            shouldSplitSegment ? normalizedInput.splitAfterOrder : undefined,
          ),
        }
      }
    } else {
      messagePartsById[targetSegmentId] = {
        ...existingSegment,
        content: normalizedInput.replace
          ? normalizedInput.content
          : mergeStreamingText(existingSegment.content, normalizedInput.content),
      }
    }
  }

  let nextSegmentIds = segmentIds
  if (normalizedInput.replace && normalizedInput.content) {
    // Authoritative full-text replace must not leave stream residuals that
    // render as a second copy of the same answer in the transcript.
    nextSegmentIds = collapseSegmentsSupersededByReplace(
      messagePartsById,
      segmentIds,
      targetSegmentId,
      normalizedInput.content,
      normalizedInput.messageId,
    )
  }

  messageById[normalizedInput.messageId] = {
    ...existingMessage,
    role: normalizedInput.role,
    attachments: normalizedInput.attachments ?? existingMessage.attachments,
    timestamp: normalizedInput.timestamp ?? existingMessage.timestamp ?? null,
    providerId: normalizedInput.providerId ?? existingMessage.providerId ?? null,
    modelId: normalizedInput.modelId ?? existingMessage.modelId ?? null,
    segmentIds: nextSegmentIds,
  }

  return {
    messageIds,
    messageById,
    messagePartsById,
    messageReasoningById: reconciledState.messageReasoningById,
  }
}

export function withMessageReasoning(
  state: MessageStateShape,
  input: {
    messageId: string
    content: string
      segmentId: string
      timestamp?: string | null
      replace?: boolean
  },
  timing?: SessionViewTiming,
) {
  const resolvedMessageId = resolveIncomingLiveMessageId(state, {
    messageId: input.messageId,
    role: 'assistant',
  })
  const normalizedInput = {
    ...input,
    messageId: resolvedMessageId,
    segmentId: scopeMessageSegmentId(resolvedMessageId, input.segmentId),
  }
  const messageIds = state.messageIds.slice()
  const messageById = { ...state.messageById }
  const messagePartsById = { ...state.messagePartsById }
  const messageReasoningById = { ...state.messageReasoningById }

  const existingMessage = messageById[normalizedInput.messageId]
  if (!existingMessage) {
    const messageOrder = timing?.order ?? nextMessageStateOrder(state)
    const segmentOrder = timing?.segmentOrder ?? (messageOrder + 1)
    messageById[normalizedInput.messageId] = {
      id: normalizedInput.messageId,
      role: 'assistant',
      timestamp: normalizedInput.timestamp || nowIsoFromTiming(timing),
      providerId: null,
      modelId: null,
      segmentIds: [],
      reasoningIds: normalizedInput.content ? [normalizedInput.segmentId] : [],
      order: messageOrder,
    }
    messageIds.push(normalizedInput.messageId)
    if (normalizedInput.content) {
      messageReasoningById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: segmentOrder,
      }
    }
    return {
      messageIds,
      messageById,
      messagePartsById,
      messageReasoningById,
    }
  }

  const segmentIds = existingMessage.segmentIds.filter((segmentId) => segmentId !== normalizedInput.segmentId)
  delete messagePartsById[normalizedInput.segmentId]

  const reasoningIds = existingMessage.reasoningIds.slice()
  const existingReasoning = messageReasoningById[normalizedInput.segmentId]
  if (!existingReasoning) {
    if (normalizedInput.content) {
      if (!reasoningIds.includes(normalizedInput.segmentId)) reasoningIds.push(normalizedInput.segmentId)
      messageReasoningById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: timing?.segmentOrder ?? nextMessageStateOrder(state),
      }
    }
  } else {
    messageReasoningById[normalizedInput.segmentId] = {
      ...existingReasoning,
      content: normalizedInput.replace
        ? normalizedInput.content
        : mergeStreamingText(existingReasoning.content, normalizedInput.content),
    }
  }

  messageById[normalizedInput.messageId] = {
    ...existingMessage,
    timestamp: normalizedInput.timestamp ?? existingMessage.timestamp ?? null,
    segmentIds,
    reasoningIds,
  }

  return {
    messageIds,
    messageById,
    messagePartsById,
    messageReasoningById,
  }
}

export function mergeMissingUserMessages(next: MessageStateShape, existing: MessageStateShape) {
  const nextMessages = buildMessages(next.messageIds, next.messageById, next.messagePartsById, next.messageReasoningById)
  const existingMessages = buildMessages(existing.messageIds, existing.messageById, existing.messagePartsById, existing.messageReasoningById)
  const nextHasUser = nextMessages.some((message) => message.role === 'user')
  if (nextHasUser) return next

  const existingUsers = existingMessages
    .filter((message) => message.role === 'user' && message.content.trim().length > 0)
    .filter((message) => !nextMessages.some((nextMessage) => nextMessage.id === message.id))

  if (existingUsers.length === 0) return next

  let merged = next
  for (const message of existingUsers) {
    merged = importMessage(merged, message)
  }
  return merged
}

export function nextHasRealMessageOfRole(next: MessageStateShape, role: 'user' | 'assistant') {
  for (const id of next.messageIds) {
    const message = next.messageById[id]
    if (!message) continue
    if (message.role !== role) continue
    if (!isLivePlaceholderMessageId(id, role)) return true
  }
  return false
}
