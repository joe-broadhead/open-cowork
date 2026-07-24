/**
 * JOE-994 Phase 3: select Discord protocol implementation.
 * Env: OPEN_COWORK_DISCORD_PROTOCOL_STACK=durable|monorepo
 */
import type { ChannelAdapter } from './provider.js'
import { discordChannel } from './discord.js'
import { createDiscordMonorepoChannelAdapter, type DiscordBridgeChannel } from './discord-monorepo-adapter.js'
import { getConfig } from '../config.js'
import { resolveChannelProtocolStack, type ChannelProtocolStack } from './bridge-protocol-stack.js'

export type DiscordProtocolStack = ChannelProtocolStack
export type DiscordChannelSurface = typeof discordChannel | DiscordBridgeChannel

let cachedAdapter: DiscordChannelSurface | null = null
let cachedStack: DiscordProtocolStack | null = null

export function resolveDiscordProtocolStack(
  env: NodeJS.ProcessEnv = process.env,
  configStack?: string | undefined,
): DiscordProtocolStack {
  return resolveChannelProtocolStack(
    env,
    ['OPEN_COWORK_DISCORD_PROTOCOL_STACK', 'DISCORD_PROTOCOL_STACK'],
    configStack,
  )
}

export function getDiscordChannel(): DiscordChannelSurface {
  const stack = resolveDiscordProtocolStack(process.env, getConfig().channels.discord.protocolStack)
  if (cachedAdapter && cachedStack === stack) return cachedAdapter
  cachedStack = stack
  cachedAdapter = stack === 'monorepo' ? createDiscordMonorepoChannelAdapter() : discordChannel
  return cachedAdapter
}

export function peekDiscordProtocolStack(): DiscordProtocolStack {
  return resolveDiscordProtocolStack(process.env, getConfig().channels.discord.protocolStack)
}

export function resetDiscordChannelForTest(): void {
  cachedAdapter = null
  cachedStack = null
}

export function isDiscordMonorepoBridge(channel: ChannelAdapter): channel is DiscordBridgeChannel {
  return typeof (channel as DiscordBridgeChannel).isMonorepoBridge === 'function'
    && (channel as DiscordBridgeChannel).isMonorepoBridge()
}
