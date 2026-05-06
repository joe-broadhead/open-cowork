import type {
  Message,
  MessageAttachment,
  MessageSegment,
} from '@open-cowork/shared'

import { nextSeq, observeSeq, nowTs } from './session-view-sequence.ts'
import { mergeStreamingText, preferNewerStreamingText } from './session-view-text.ts'

const LIVE_ASSISTANT_MESSAGE_SUFFIX = ':assistant:live'
const LIVE_ASSISTANT_SEGMENT_SUFFIX = ':segment:live'
const LIVE_USER_MESSAGE_SUFFIX = ':user:live'
const LIVE_USER_SEGMENT_SUFFIX = ':user:segment:live'

export const LIVE_USER_MESSAGE_SUFFIX_PUBLIC = LIVE_USER_MESSAGE_SUFFIX
export const LIVE_USER_SEGMENT_SUFFIX_PUBLIC = LIVE_USER_SEGMENT_SUFFIX

export interface MessageEntity {
  id: string
  role: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  timestamp?: string | null
  providerId?: string | null
  modelId?: string | null
  segmentIds: string[]
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
}

function livePlaceholderMessageSuffix(role: 'user' | 'assistant') {
  return role === 'assistant' ? LIVE_ASSISTANT_MESSAGE_SUFFIX : LIVE_USER_MESSAGE_SUFFIX
}

function livePlaceholderSegmentSuffix(role: 'user' | 'assistant') {
  return role === 'assistant' ? LIVE_ASSISTANT_SEGMENT_SUFFIX : LIVE_USER_SEGMENT_SUFFIX
}

export function isLivePlaceholderMessageId(messageId: string, role: 'user' | 'assistant') {
  return messageId.endsWith(livePlaceholderMessageSuffix(role))
}

function isLivePlaceholderSegmentId(segmentId: string, role: 'user' | 'assistant') {
  return segmentId.endsWith(livePlaceholderSegmentSuffix(role))
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
    attachments?: MessageAttachment[]
    timestamp?: string | null
    providerId?: string | null
    modelId?: string | null
  },
) {
  if (isLivePlaceholderMessageId(input.messageId, input.role)) {
    return state
  }

  const liveMessageId = state.messageIds.find((messageId) => {
    const message = state.messageById[messageId]
    return Boolean(
      message
      && message.role === input.role
      && isLivePlaceholderMessageId(message.id, input.role)
      && message.id !== input.messageId,
    )
  })

  if (!liveMessageId) return state

  const liveMessage = state.messageById[liveMessageId]
  if (!liveMessage) return state

  const messageIds = state.messageIds
    .map((messageId) => (messageId === liveMessageId ? input.messageId : messageId))
    .filter((messageId, index, all) => all.indexOf(messageId) === index)
  const messageById = { ...state.messageById }
  const messagePartsById = { ...state.messagePartsById }
  const liveSegmentIds = liveMessage.segmentIds.slice()

  if (liveSegmentIds.length === 1 && isLivePlaceholderSegmentId(liveSegmentIds[0], input.role) && liveSegmentIds[0] !== input.segmentId) {
    const liveSegment = messagePartsById[liveSegmentIds[0]]
    if (liveSegment) {
      const targetSegment = messagePartsById[input.segmentId]
      messagePartsById[input.segmentId] = targetSegment
        ? {
            ...targetSegment,
            order: Math.min(targetSegment.order, liveSegment.order),
            content: preferNewerStreamingText(targetSegment.content, liveSegment.content),
          }
        : {
            ...liveSegment,
            id: input.segmentId,
          }
      delete messagePartsById[liveSegmentIds[0]]
      liveSegmentIds[0] = input.segmentId
    }
  }

  const existingTarget = messageById[input.messageId]
  if (existingTarget) {
    const segmentIds = existingTarget.segmentIds.slice()
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

    messageById[input.messageId] = {
      ...existingTarget,
      attachments: existingTarget.attachments ?? input.attachments ?? liveMessage.attachments,
      timestamp: existingTarget.timestamp ?? input.timestamp ?? liveMessage.timestamp ?? null,
      providerId: existingTarget.providerId ?? input.providerId ?? liveMessage.providerId ?? null,
      modelId: existingTarget.modelId ?? input.modelId ?? liveMessage.modelId ?? null,
      segmentIds,
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
    }
  }

  delete messageById[liveMessageId]

  return {
    messageIds,
    messageById,
    messagePartsById,
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

export function buildMessages(
  messageIds: string[],
  messageById: Record<string, MessageEntity>,
  messagePartsById: Record<string, MessagePartEntity>,
): Message[] {
  const messages: Message[] = []
  for (const messageId of messageIds) {
    const message = messageById[messageId]
    if (!message) continue
    const segments = buildMessageSegments(message, messagePartsById)
    messages.push({
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      segments,
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
  }
}

export function importMessage(
  state: MessageStateShape,
  message: Message,
) {
  observeSeq(message.order)
  const messageIds = state.messageIds.includes(message.id)
    ? state.messageIds.slice()
    : [...state.messageIds, message.id]
  const messageById = {
    ...state.messageById,
    [message.id]: {
      id: message.id,
      role: message.role,
      attachments: message.attachments,
      timestamp: message.timestamp || null,
      providerId: message.providerId || null,
      modelId: message.modelId || null,
      segmentIds: (message.segments && message.segments.length > 0)
        ? message.segments.map((segment) => segment.id)
        : (message.content ? [`${message.id}:initial`] : []),
      order: message.order,
    },
  }
  const messagePartsById = { ...state.messagePartsById }
  const sourceSegments = message.segments && message.segments.length > 0
    ? message.segments
    : (message.content
      ? [{ id: `${message.id}:initial`, content: message.content, order: message.order }]
      : [])

  for (const segment of sourceSegments) {
    observeSeq(segment.order)
    messagePartsById[segment.id] = {
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
  },
) {
  const resolvedMessageId = resolveIncomingLiveMessageId(state, input)
  const normalizedInput = {
    ...input,
    messageId: resolvedMessageId,
  }
  const reconciledState = moveLivePlaceholderStateToMessage(state, normalizedInput)

  const messageIds = reconciledState.messageIds.slice()
  const messageById = { ...reconciledState.messageById }
  const messagePartsById = { ...reconciledState.messagePartsById }

  const existingMessage = messageById[normalizedInput.messageId]
  if (!existingMessage) {
    messageById[normalizedInput.messageId] = {
      id: normalizedInput.messageId,
      role: normalizedInput.role,
      attachments: normalizedInput.attachments,
      timestamp: normalizedInput.timestamp || new Date(nowTs()).toISOString(),
      providerId: normalizedInput.providerId || null,
      modelId: normalizedInput.modelId || null,
      segmentIds: normalizedInput.content ? [normalizedInput.segmentId] : [],
      order: nextSeq(),
    }
    messageIds.push(normalizedInput.messageId)
    if (normalizedInput.content) {
      messagePartsById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: nextSeq(),
      }
    }
    return {
      messageIds,
      messageById,
      messagePartsById,
    }
  }

  const segmentIds = existingMessage.segmentIds.slice()
  const existingSegment = messagePartsById[normalizedInput.segmentId]
  if (!existingSegment) {
    if (normalizedInput.content) {
      segmentIds.push(normalizedInput.segmentId)
      messagePartsById[normalizedInput.segmentId] = {
        id: normalizedInput.segmentId,
        content: normalizedInput.content,
        order: nextSeq(),
      }
    }
  } else {
    messagePartsById[normalizedInput.segmentId] = {
      ...existingSegment,
      content: normalizedInput.replace
        ? normalizedInput.content
        : mergeStreamingText(existingSegment.content, normalizedInput.content),
    }
  }

  messageById[normalizedInput.messageId] = {
    ...existingMessage,
    role: normalizedInput.role,
    attachments: normalizedInput.attachments ?? existingMessage.attachments,
    timestamp: normalizedInput.timestamp ?? existingMessage.timestamp ?? null,
    providerId: normalizedInput.providerId ?? existingMessage.providerId ?? null,
    modelId: normalizedInput.modelId ?? existingMessage.modelId ?? null,
    segmentIds,
  }

  return {
    messageIds,
    messageById,
    messagePartsById,
  }
}

export function mergeMissingUserMessages(next: MessageStateShape, existing: MessageStateShape) {
  const nextMessages = buildMessages(next.messageIds, next.messageById, next.messagePartsById)
  const existingMessages = buildMessages(existing.messageIds, existing.messageById, existing.messagePartsById)
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
