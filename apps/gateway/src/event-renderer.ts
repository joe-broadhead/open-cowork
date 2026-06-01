import type {
  ChannelProvider,
  ChannelTarget,
} from '@open-cowork/gateway-channel'
import type {
  ChannelSessionBindingRecord,
  CloudTransportSessionEvent,
} from '@open-cowork/cloud-client'
import type { CloudSessionEventType } from '@open-cowork/shared'

import type { CloudGateway } from './cloud-gateway.js'
import { renderArtifactCreated } from './render/artifact-renderer.js'
import { renderApprovalRequest } from './render/approval-renderer.js'
import { renderQuestionRequest } from './render/question-renderer.js'
import type { GatewaySessionRenderState } from './render/state.js'
import { renderAssistantStream } from './render/text-stream-renderer.js'
import { renderToolProgress } from './render/tool-progress-renderer.js'

export type RenderGatewaySessionEventInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  binding: ChannelSessionBindingRecord
  event: CloudTransportSessionEvent
  state: GatewaySessionRenderState
}

export type RenderGatewaySessionEventResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export const GATEWAY_RENDERED_SESSION_EVENT_TYPES = [
  'assistant.message',
  'tool.call',
  'permission.requested',
  'question.asked',
  'artifact.created',
] as const satisfies readonly CloudSessionEventType[]

export async function renderGatewaySessionEvent(
  input: RenderGatewaySessionEventInput,
): Promise<RenderGatewaySessionEventResult> {
  const target = targetForBinding(input.binding, input.provider)
  if (input.event.type === 'assistant.message') {
    return renderAssistantStream({
      provider: input.provider,
      target,
      state: input.state,
      sourceMessageId: readAssistantSourceMessageId(input.event),
      content: readAssistantText(input.event),
    })
  }

  if (input.event.type === 'tool.call') {
    return renderToolProgress({
      provider: input.provider,
      target,
      state: input.state,
      event: input.event,
    })
  }

  if (input.event.type === 'permission.requested') {
    return renderApprovalRequest({ ...input, target })
  }

  if (input.event.type === 'question.asked') {
    return renderQuestionRequest({ ...input, target })
  }

  if (input.event.type === 'artifact.created') {
    return renderArtifactCreated({ ...input, target })
  }

  return { handled: false }
}

function targetForBinding(binding: ChannelSessionBindingRecord, provider: Pick<ChannelProvider, 'id' | 'kind'>): ChannelTarget {
  return {
    provider: provider.id,
    providerKind: provider.kind,
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

function readAssistantSourceMessageId(event: CloudTransportSessionEvent): string {
  return stringField(event.payload, 'messageId')
    || stringField(event.payload, 'id')
    || event.entityId
    || `${event.sessionId || 'session'}:assistant:${event.sequence}`
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
