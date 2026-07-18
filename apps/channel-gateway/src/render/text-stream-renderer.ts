import type {
  ChannelProvider,
  ChannelTarget,
  SentMessage,
} from '@open-cowork/gateway-channel'
import { chunkText } from '@open-cowork/gateway-channel'

import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './operations.js'
import { setRenderStateEntry, type GatewaySessionRenderState } from './state.js'

export type RenderAssistantStreamInput = {
  provider: ChannelProvider
  target: ChannelTarget
  state: GatewaySessionRenderState
  sourceMessageId: string
  content: string
}

export type RenderAssistantStreamResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export async function renderAssistantStream(input: RenderAssistantStreamInput): Promise<RenderAssistantStreamResult> {
  const incoming = input.content.trimEnd()
  if (!incoming.trim()) return { handled: false }

  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  const existing = input.state.assistantStreams.get(input.sourceMessageId)
  const nextText = existing
    ? mergeStreamingText(existing.renderedText, incoming)
    : incoming

  if (existing && nextText === existing.renderedText) {
    return { handled: false, lastChatMessageId: existing.providerMessageId }
  }

  if (capabilities.messageEditing && existing?.providerMessageId && nextText.length <= capabilities.maxTextLength) {
    await executeRenderOperation(input.provider, {
      type: 'edit_text',
      target: input.target,
      messageId: existing.providerMessageId,
      text: nextText,
    })
    existing.renderedText = nextText
    return { handled: true, lastChatMessageId: existing.providerMessageId }
  }

  if (capabilities.messageEditing && !existing && nextText.length <= capabilities.maxTextLength) {
    const result = await executeRenderOperation(input.provider, {
      type: 'send_text',
      target: input.target,
      text: nextText,
    })
    const providerMessageId = result.sentMessage?.messageId ?? null
    setRenderStateEntry(input.state.assistantStreams, input.sourceMessageId, {
      sourceMessageId: input.sourceMessageId,
      providerMessageId,
      renderedText: nextText,
    })
    return { handled: true, lastChatMessageId: providerMessageId }
  }

  const textToSend = existing ? streamingSuffix(existing.renderedText, nextText) : nextText
  const sent = await sendTextChunks(input.provider, input.target, textToSend)
  setRenderStateEntry(input.state.assistantStreams, input.sourceMessageId, {
    sourceMessageId: input.sourceMessageId,
    providerMessageId: sent?.messageId ?? existing?.providerMessageId ?? null,
    renderedText: nextText,
  })
  return { handled: Boolean(sent), lastChatMessageId: sent?.messageId ?? existing?.providerMessageId ?? null }
}

export function mergeStreamingText(existing: string, incoming: string): string {
  if (!existing) return incoming
  if (!incoming || incoming === existing) return existing
  if (incoming.startsWith(existing)) return incoming
  if (existing.endsWith(incoming)) return existing

  const overlap = longestOverlap(existing, incoming)
  return `${existing}${incoming.slice(overlap)}`
}

function streamingSuffix(existing: string, nextText: string): string {
  if (!existing) return nextText
  if (nextText.startsWith(existing)) return nextText.slice(existing.length)
  return nextText
}

async function sendTextChunks(
  provider: ChannelProvider,
  target: ChannelTarget,
  text: string,
): Promise<SentMessage | null> {
  if (!text.trim()) return null
  let sent: SentMessage | null = null
  for (const chunk of chunkText(text, provider.capabilities.maxTextLength)) {
    const result = await executeRenderOperation(provider, {
      type: 'send_text',
      target,
      text: chunk,
    })
    sent = result.sentMessage ?? null
  }
  return sent
}

function longestOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  for (let length = max; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length
  }
  return 0
}
