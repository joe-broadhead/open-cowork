import type { ChannelProvider, IncomingChannelMessage } from '@open-cowork/gateway-channel'
import type { CloudChannelProviderId } from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import type { GatewayProviderConfig } from './config.js'
import { ensureGatewayProviderMetrics, type GatewayMetrics } from './metrics.js'
import { parseGatewayInteractionToken } from './render/interaction-tokens.js'

export type RouteGatewayInteractionInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  providerConfig: GatewayProviderConfig
  message: IncomingChannelMessage
  metrics: GatewayMetrics
}

export async function routeGatewayInteraction(input: RouteGatewayInteractionInput): Promise<boolean> {
  const interaction = readInteractionIntent(input.message)
  if (!interaction) return false

  const cloudProvider = input.message.provider as CloudChannelProviderId
  await input.cloud.resolveChannelInteraction({
    provider: cloudProvider,
    externalWorkspaceId: input.providerConfig.externalWorkspaceId ?? null,
    externalUserId: input.message.sender.providerUserId,
    token: interaction.token,
    externalInteractionId: interaction.externalInteractionId,
    ...interaction.resolution,
  })
  input.metrics.interactionsResolved += 1
  ensureGatewayProviderMetrics(input.metrics, input.providerConfig).interactionsResolved += 1

  if (input.provider.answerInteraction) {
    try {
      await input.provider.answerInteraction(interaction.externalInteractionId, interaction.acknowledgement)
    } catch {
      input.metrics.errors += 1
    }
  }
  return true
}

type InteractionIntent = {
  token: string
  externalInteractionId: string
  acknowledgement: string
  resolution: {
    response?: unknown
    answers?: unknown[]
    reject?: boolean
  }
}

function readInteractionIntent(message: IncomingChannelMessage): InteractionIntent | null {
  if (message.interaction?.token) {
    const parsed = parseGatewayInteractionToken(message.interaction.token)
    return {
      token: parsed.token,
      externalInteractionId: message.interaction.id,
      acknowledgement: acknowledgementFor(parsed.action),
      resolution: resolutionForParsedToken(parsed),
    }
  }

  const command = parseFallbackCommand(message.rawText || message.text)
  if (!command) return null
  return {
    token: command.token,
    externalInteractionId: message.id,
    acknowledgement: acknowledgementFor(command.action),
    resolution: command.action === 'approve'
      ? { response: { allowed: true } }
      : command.action === 'deny'
        ? { response: { allowed: false } }
        : command.action === 'reject'
          ? { reject: true }
          : { answers: [command.answer] },
  }
}

function resolutionForParsedToken(parsed: ReturnType<typeof parseGatewayInteractionToken>): InteractionIntent['resolution'] {
  switch (parsed.action) {
    case 'approve':
      return { response: { allowed: true } }
    case 'deny':
      return { response: { allowed: false } }
    case 'answer':
      return { answers: [parsed.answer] }
    case 'reject':
      return { reject: true }
    case 'default':
      return { response: { allowed: true } }
  }
}

function acknowledgementFor(action: ReturnType<typeof parseGatewayInteractionToken>['action'] | FallbackCommand['action']) {
  return action === 'deny'
    ? 'Denied'
    : action === 'reject'
      ? 'Rejected'
      : action === 'answer'
        ? 'Answered'
        : 'Approved'
}

type FallbackCommand =
  | { action: 'approve', token: string }
  | { action: 'deny', token: string }
  | { action: 'reject', token: string }
  | { action: 'answer', token: string, answer: string }

function parseFallbackCommand(text: string): FallbackCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const commandEnd = firstWhitespaceIndex(trimmed)
  if (commandEnd < 0) return null

  const verb = trimmed.slice(1, commandEnd).toLowerCase()
  const rest = trimmed.slice(commandEnd).trimStart()
  if (!rest) return null

  const tokenEnd = firstWhitespaceIndex(rest)
  const token = tokenEnd < 0 ? rest : rest.slice(0, tokenEnd)
  const answer = tokenEnd < 0 ? '' : rest.slice(tokenEnd).trim()

  if (!token) return null
  if (verb === 'approve' || verb === 'allow') return { action: 'approve', token }
  if (verb === 'deny') return { action: 'deny', token }
  if (verb === 'reject') return { action: 'reject', token }
  if (verb === 'answer' && answer) return { action: 'answer', token, answer }
  return null
}

function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index]?.trim() === '') return index
  }
  return -1
}
