/**
 * JOE-994 Phase 3: select WhatsApp protocol implementation.
 * Env: OPEN_COWORK_WHATSAPP_PROTOCOL_STACK=durable|monorepo
 */
import type { ChannelAdapter } from './provider.js'
import { whatsappChannel } from './whatsapp.js'
import { createWhatsAppMonorepoChannelAdapter, type WhatsAppBridgeChannel } from './whatsapp-monorepo-adapter.js'
import { getConfig } from '../config.js'
import { resolveChannelProtocolStack, type ChannelProtocolStack } from './bridge-protocol-stack.js'

export type WhatsAppProtocolStack = ChannelProtocolStack
export type WhatsAppChannelSurface = typeof whatsappChannel | WhatsAppBridgeChannel

let cachedAdapter: WhatsAppChannelSurface | null = null
let cachedStack: WhatsAppProtocolStack | null = null

export function resolveWhatsAppProtocolStack(
  env: NodeJS.ProcessEnv = process.env,
  configStack?: string | undefined,
): WhatsAppProtocolStack {
  return resolveChannelProtocolStack(
    env,
    ['OPEN_COWORK_WHATSAPP_PROTOCOL_STACK', 'WHATSAPP_PROTOCOL_STACK'],
    configStack,
  )
}

export function getWhatsAppChannel(): WhatsAppChannelSurface {
  const stack = resolveWhatsAppProtocolStack(process.env, getConfig().channels.whatsapp.protocolStack)
  if (cachedAdapter && cachedStack === stack) return cachedAdapter
  cachedStack = stack
  cachedAdapter = stack === 'monorepo' ? createWhatsAppMonorepoChannelAdapter() : whatsappChannel
  return cachedAdapter
}

export function peekWhatsAppProtocolStack(): WhatsAppProtocolStack {
  return resolveWhatsAppProtocolStack(process.env, getConfig().channels.whatsapp.protocolStack)
}

export function resetWhatsAppChannelForTest(): void {
  cachedAdapter = null
  cachedStack = null
}

export function isWhatsAppMonorepoBridge(channel: ChannelAdapter): channel is WhatsAppBridgeChannel {
  return typeof (channel as WhatsAppBridgeChannel).isMonorepoBridge === 'function'
    && (channel as WhatsAppBridgeChannel).isMonorepoBridge()
}
