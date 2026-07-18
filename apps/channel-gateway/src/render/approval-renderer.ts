import { randomBytes } from 'node:crypto'

import type {
  ChannelButton,
  ChannelProvider,
  ChannelTarget,
} from '@open-cowork/gateway-channel'
import { chunkText } from '@open-cowork/gateway-channel'

import type {
  ChannelSessionBindingRecord,
} from '@open-cowork/cloud-client/domains/channels'
import type {
  CloudTransportSessionEvent,
} from '@open-cowork/cloud-client/domains/transport'

import type { CloudGateway } from '../cloud-gateway.js'
import {
  approvalToken,
  denialToken,
} from './interaction-tokens.js'
import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './operations.js'
import { sanitizeChannelText } from './sanitize.js'

export type RenderApprovalRequestInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  target: ChannelTarget
  binding: ChannelSessionBindingRecord
  event: CloudTransportSessionEvent
}

export type RenderApprovalRequestResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export async function renderApprovalRequest(input: RenderApprovalRequestInput): Promise<RenderApprovalRequestResult> {
  const permissionId = stringField(input.event.payload, 'permissionId')
    || stringField(input.event.payload, 'id')
  if (!permissionId) return { handled: false }

  const issued = await input.cloud.createChannelInteraction({
    interactionId: channelInteractionId(input.event, permissionId, 'permission'),
    agentId: input.binding.agentId,
    sessionId: input.binding.sessionId,
    provider: input.binding.provider,
    kind: 'permission',
    targetId: permissionId,
  })
  const text = approvalText(input.event.payload)
  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  const buttons: ChannelButton[][] = [[{
    label: 'Approve',
    token: approvalToken(issued.plaintextToken),
    style: 'success',
  }, {
    label: 'Deny',
    token: denialToken(issued.plaintextToken),
    style: 'danger',
  }]]

  if (
    capabilities.inlineButtons
    && text.length <= capabilities.maxTextLength
    && buttonsFit(buttons, capabilities.maxButtonsPerMessage, capabilities.maxButtonRowsPerMessage, capabilities.maxButtonTokenBytes)
  ) {
    const result = await executeRenderOperation(input.provider, {
      type: 'send_buttons',
      target: input.target,
      text,
      buttons,
    })
    return { handled: true, lastChatMessageId: result.sentMessage?.messageId ?? null }
  }

  const fallback = `${text}\n/approve ${issued.plaintextToken}\n/deny ${issued.plaintextToken}`
  let lastChatMessageId: string | null = null
  for (const chunk of chunkText(fallback, capabilities.maxTextLength)) {
    const result = await executeRenderOperation(input.provider, {
      type: 'send_text',
      target: input.target,
      text: chunk,
    })
    lastChatMessageId = result.sentMessage?.messageId ?? lastChatMessageId
  }
  return { handled: true, lastChatMessageId }
}

function approvalText(payload: Record<string, unknown>): string {
  const title = sanitizeChannelText(stringField(payload, 'title') || 'Permission requested', 160)
  const description = sanitizeChannelText(
    stringField(payload, 'description')
      || stringField(payload, 'summary')
      || stringField(payload, 'tool')
      || '',
    320,
  )
  return description ? `${title}\n${description}` : title
}

function buttonsFit(
  buttons: ChannelButton[][],
  maxButtons: number,
  maxRows: number,
  maxTokenBytes: number,
) {
  return buttons.length <= maxRows
    && buttons.flat().length <= maxButtons
    && buttons.flat().every((button) => Buffer.byteLength(button.token, 'utf8') <= maxTokenBytes)
}

function channelInteractionId(
  _event: CloudTransportSessionEvent,
  _targetId: string,
  kind: string,
) {
  return `gw_${kind}_${randomBytes(9).toString('base64url')}`
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
