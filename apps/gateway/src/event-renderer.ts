import { randomBytes } from 'node:crypto'

import type {
  ChannelButton,
  ChannelProviderId,
  ChannelProvider,
  ChannelTarget,
  SentMessage,
} from '@open-cowork/gateway-channel'
import { chunkText } from '@open-cowork/gateway-channel'
import type {
  ChannelSessionBindingRecord,
  CloudTransportSessionEvent,
} from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './render/operations.js'

export type RenderGatewaySessionEventInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  binding: ChannelSessionBindingRecord
  event: CloudTransportSessionEvent
}

export type RenderGatewaySessionEventResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export async function renderGatewaySessionEvent(
  input: RenderGatewaySessionEventInput,
): Promise<RenderGatewaySessionEventResult> {
  if (input.event.type === 'assistant.message') {
    return sendAssistantMessage(input.provider, targetForBinding(input.binding, input.provider.id), readAssistantText(input.event))
  }

  if (input.event.type === 'permission.requested') {
    return sendPermissionRequest(input)
  }

  if (input.event.type === 'question.asked') {
    return sendQuestion(input.provider, targetForBinding(input.binding, input.provider.id), readQuestionText(input.event))
  }

  return { handled: false }
}

async function sendAssistantMessage(
  provider: ChannelProvider,
  target: ChannelTarget,
  text: string,
): Promise<RenderGatewaySessionEventResult> {
  if (!text.trim()) return { handled: false }
  const sent = await sendTextChunks(provider, target, text)
  return { handled: true, lastChatMessageId: sent?.messageId ?? null }
}

async function sendPermissionRequest(input: RenderGatewaySessionEventInput): Promise<RenderGatewaySessionEventResult> {
  const permissionId = stringField(input.event.payload, 'permissionId')
    || stringField(input.event.payload, 'id')
  if (!permissionId) return { handled: false }

  const issued = await input.cloud.createChannelInteraction({
    interactionId: channelInteractionId(input.binding, input.event, permissionId),
    agentId: input.binding.agentId,
    sessionId: input.binding.sessionId,
    provider: input.binding.provider,
    kind: 'permission',
    targetId: permissionId,
  })
  const title = stringField(input.event.payload, 'title') || 'Permission requested'
  const description = stringField(input.event.payload, 'description')
    || stringField(input.event.payload, 'summary')
    || stringField(input.event.payload, 'tool')
  const text = description ? `${title}\n${description}` : title
  const target = targetForBinding(input.binding, input.provider.id)
  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  if (!capabilities.inlineButtons) {
    const sent = await sendTextChunks(input.provider, target, `${text}\n/approve ${issued.plaintextToken}`)
    return { handled: true, lastChatMessageId: sent?.messageId ?? null }
  }

  const buttons: ChannelButton[][] = [[{
    label: 'Approve',
    token: issued.plaintextToken,
    style: 'success',
  }]]
  const result = await executeRenderOperation(input.provider, {
    type: 'send_buttons',
    target,
    text,
    buttons,
  })
  return { handled: true, lastChatMessageId: result.sentMessage?.messageId ?? null }
}

async function sendQuestion(
  provider: ChannelProvider,
  target: ChannelTarget,
  text: string,
): Promise<RenderGatewaySessionEventResult> {
  if (!text.trim()) return { handled: false }
  const sent = await sendTextChunks(provider, target, text)
  return { handled: true, lastChatMessageId: sent?.messageId ?? null }
}

async function sendTextChunks(
  provider: ChannelProvider,
  target: ChannelTarget,
  text: string,
): Promise<SentMessage | null> {
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

function targetForBinding(binding: ChannelSessionBindingRecord, provider: ChannelProviderId): ChannelTarget {
  return {
    provider,
    chatId: binding.externalChatId,
    threadId: binding.externalThreadId,
    messageId: binding.lastChatMessageId,
  }
}

function readAssistantText(event: CloudTransportSessionEvent): string {
  return stringField(event.payload, 'content')
    || stringField(event.payload, 'text')
    || stringField(event.payload, 'message')
    || ''
}

function readQuestionText(event: CloudTransportSessionEvent): string {
  const title = stringField(event.payload, 'title') || 'Question requested'
  const question = stringField(event.payload, 'question')
    || stringField(event.payload, 'prompt')
    || readFirstQuestionText(event.payload)
  return question ? `${title}\n${question}` : title
}

function readFirstQuestionText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const questions = (payload as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return null
  const first = questions[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') {
    return stringField(first, 'label') || stringField(first, 'prompt') || stringField(first, 'text')
  }
  return null
}

function channelInteractionId(
  _binding: ChannelSessionBindingRecord,
  _event: CloudTransportSessionEvent,
  _targetId: string,
) {
  return `gw_${randomBytes(9).toString('base64url')}`
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
