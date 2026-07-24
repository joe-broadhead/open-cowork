/**
 * JOE-994 Phase 2: select Telegram protocol implementation.
 *
 * - `durable` (default): legacy products/gateway long-poll adapter
 * - `monorepo`: thin façade over @open-cowork/gateway-provider-telegram
 *
 * Env overrides config for emergency rollback:
 *   OPEN_COWORK_TELEGRAM_PROTOCOL_STACK=durable|monorepo
 */
import type { ChannelAdapter } from './provider.js'
import { telegramChannel } from './telegram.js'
import { createTelegramMonorepoChannelAdapter } from './telegram-monorepo-adapter.js'
import { getConfig } from '../config.js'

export type TelegramProtocolStack = 'durable' | 'monorepo'

let cachedAdapter: ChannelAdapter | null = null
let cachedStack: TelegramProtocolStack | null = null

export function resolveTelegramProtocolStack(
  env: NodeJS.ProcessEnv = process.env,
  configStack?: string | undefined,
): TelegramProtocolStack {
  const rawEnv = (env['OPEN_COWORK_TELEGRAM_PROTOCOL_STACK'] || env['TELEGRAM_PROTOCOL_STACK'] || '').trim().toLowerCase()
  if (rawEnv === 'monorepo' || rawEnv === 'shared' || rawEnv === 'gateway-provider' || rawEnv === 'provider') {
    return 'monorepo'
  }
  if (rawEnv === 'durable' || rawEnv === 'legacy' || rawEnv === 'classic') {
    return 'durable'
  }
  const fromConfig = (configStack || '').trim().toLowerCase()
  if (fromConfig === 'monorepo') return 'monorepo'
  return 'durable'
}

/**
 * Resolve the Telegram ChannelAdapter for daemon wiring.
 * Cached for process lifetime; call resetTelegramChannelForTest in tests.
 */
export function getTelegramChannel(): ChannelAdapter {
  const stack = resolveTelegramProtocolStack(process.env, getConfig().channels.telegram.protocolStack)
  if (cachedAdapter && cachedStack === stack) return cachedAdapter
  cachedStack = stack
  cachedAdapter = stack === 'monorepo' ? createTelegramMonorepoChannelAdapter() : telegramChannel
  return cachedAdapter
}

export function peekTelegramProtocolStack(): TelegramProtocolStack {
  return resolveTelegramProtocolStack(process.env, getConfig().channels.telegram.protocolStack)
}

export function resetTelegramChannelForTest(): void {
  cachedAdapter = null
  cachedStack = null
}
