import type { ChannelTelemetryStack } from '@open-cowork/gateway-channel'
import type { ChannelAdapter } from './provider.js'
import { getDiscordChannel } from './discord-protocol-stack.js'
import { withChannelEgressTelemetry } from './egress-telemetry.js'
import { getTelegramChannel } from './telegram-protocol-stack.js'
import { getWhatsAppChannel } from './whatsapp-protocol-stack.js'
import {
  channelTelemetryBindingConfigured,
  channelTelemetryStack,
} from '../channel-telemetry.js'
import { setChannelBindingTelemetry } from '../runtime-metrics.js'

export interface DaemonChannelComposition {
  channels: Map<string, ChannelAdapter>
  telegramChannel: ReturnType<typeof getTelegramChannel>
  whatsappChannel: ReturnType<typeof getWhatsAppChannel>
  discordChannel: ReturnType<typeof getDiscordChannel>
}

const composedChannelStacks = new WeakMap<object, ChannelTelemetryStack>()

/**
 * Resolve the configured protocol implementations once, then instrument the
 * exact adapters the daemon starts and exposes to routes.
 */
export function createDaemonChannelComposition(): DaemonChannelComposition {
  const telegramChannel = instrumentChannel(getTelegramChannel())
  const whatsappChannel = instrumentChannel(getWhatsAppChannel())
  const discordChannel = instrumentChannel(getDiscordChannel())
  return {
    channels: new Map<string, ChannelAdapter>([
      [telegramChannel.name, telegramChannel],
      [whatsappChannel.name, whatsappChannel],
      [discordChannel.name, discordChannel],
    ]),
    telegramChannel,
    whatsappChannel,
    discordChannel,
  }
}

/**
 * Refresh low-cardinality binding gauges from the live adapters. This is
 * intentionally safe to call on every scrape so degraded providers do not
 * remain reported as active until another lifecycle transition occurs.
 */
export function syncChannelBindingTelemetry(
  channels: ReadonlyMap<string, Pick<ChannelAdapter, 'isActive'>>,
): void {
  for (const [provider, channel] of channels) {
    const stack = composedChannelTelemetryStack(provider, channel)
    let active = false
    try {
      active = channel.isActive?.() === true
    } catch {
      active = false
    }
    setChannelBindingTelemetry(
      provider,
      stack,
      'configured',
      channelTelemetryBindingConfigured(provider, stack) ? 1 : 0,
    )
    setChannelBindingTelemetry(provider, stack, 'active', active ? 1 : 0)
  }
}

export function composedChannelTelemetryStack(
  provider: string,
  channel?: object,
): ChannelTelemetryStack {
  return (channel && composedChannelStacks.get(channel)) || channelTelemetryStack(provider)
}

function instrumentChannel<T extends ChannelAdapter>(channel: T): T {
  const stack = channelTelemetryStack(channel.name)
  const instrumented = withChannelEgressTelemetry(channel, {
    stack,
  })
  composedChannelStacks.set(instrumented, stack)
  return instrumented
}
