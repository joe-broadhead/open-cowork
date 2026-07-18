import type {
  ChannelProvider,
  ChannelTarget,
} from '@open-cowork/gateway-channel'

import type { CloudTransportSessionEvent } from '@open-cowork/cloud-client/domains/transport'

import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './operations.js'
import { sanitizeChannelText } from './sanitize.js'
import { setRenderStateEntry, type GatewaySessionRenderState } from './state.js'

export type RenderToolProgressInput = {
  provider: ChannelProvider
  target: ChannelTarget
  state: GatewaySessionRenderState
  event: CloudTransportSessionEvent
}

export type RenderToolProgressResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export async function renderToolProgress(input: RenderToolProgressInput): Promise<RenderToolProgressResult> {
  const toolCallId = stringField(input.event.payload, 'id')
    || stringField(input.event.payload, 'callId')
    || stringField(input.event.payload, 'toolCallId')
    || `${input.event.sessionId || 'session'}:tool:${input.event.sequence}`
  const status = normalizeStatus(stringField(input.event.payload, 'status'))
  const summary = buildToolSummary(input.event.payload, status)
  const existing = input.state.toolProgress.get(toolCallId)
  if (existing?.renderedSummary === summary && existing.status === status) {
    return { handled: false, lastChatMessageId: existing.providerMessageId }
  }

  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  if (existing?.providerMessageId && capabilities.messageEditing && summary.length <= capabilities.maxTextLength) {
    await executeRenderOperation(input.provider, {
      type: 'edit_text',
      target: input.target,
      messageId: existing.providerMessageId,
      text: summary,
    })
    existing.renderedSummary = summary
    existing.status = status
    return { handled: true, lastChatMessageId: existing.providerMessageId }
  }

  const sent = await executeRenderOperation(input.provider, {
    type: 'send_text',
    target: input.target,
    text: summary.length <= capabilities.maxTextLength
      ? summary
      : `${summary.slice(0, Math.max(0, capabilities.maxTextLength - 15)).trimEnd()}\n...[truncated]`,
  })
  const providerMessageId = sent.sentMessage?.messageId ?? existing?.providerMessageId ?? null
  setRenderStateEntry(input.state.toolProgress, toolCallId, {
    toolCallId,
    providerMessageId,
    renderedSummary: summary,
    status,
  })
  return { handled: true, lastChatMessageId: providerMessageId }
}

function buildToolSummary(payload: Record<string, unknown>, status: string): string {
  const name = sanitizeChannelText(
    stringField(payload, 'name')
      || stringField(payload, 'tool')
      || 'tool',
    120,
  )
  const prefix = status === 'error'
    ? 'Tool failed'
    : status === 'complete'
      ? 'Tool complete'
      : 'Tool running'
  const detail = status === 'error'
    ? stringField(payload, 'error') || stringField(payload, 'message') || stringField(payload, 'summary')
    : null
  return detail
    ? `${prefix}: ${name}\n${sanitizeChannelText(detail, 320)}`
    : `${prefix}: ${name}`
}

function normalizeStatus(value: string | null) {
  return value === 'complete' || value === 'completed' || value === 'success'
    ? 'complete'
    : value === 'error' || value === 'failed' || value === 'failure'
      ? 'error'
      : 'running'
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
