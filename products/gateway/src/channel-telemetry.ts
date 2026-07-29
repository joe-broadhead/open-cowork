import {
  classifyChannelTelemetryError,
  type ChannelTelemetryFailureOutcome,
  type ChannelTelemetryStack,
} from '@open-cowork/gateway-channel'
import { getConfig } from './config.js'
import { peekDiscordProtocolStack } from './channels/discord-protocol-stack.js'
import { peekTelegramProtocolStack } from './channels/telegram-protocol-stack.js'
import { peekWhatsAppProtocolStack } from './channels/whatsapp-protocol-stack.js'

export function channelTelemetryStack(provider: string): ChannelTelemetryStack {
  const protocolStack = provider === 'telegram'
    ? peekTelegramProtocolStack()
    : provider === 'discord'
      ? peekDiscordProtocolStack()
      : provider === 'whatsapp'
        ? peekWhatsAppProtocolStack()
        : 'durable'
  return protocolStack === 'monorepo' ? 'monorepo-provider' : 'durable-native'
}

export function channelTelemetryFailureOutcome(error: unknown): ChannelTelemetryFailureOutcome {
  return classifyChannelTelemetryError(error)
}

export function channelTelemetryBindingConfigured(
  provider: string,
  stack: ChannelTelemetryStack,
): boolean {
  const config = getConfig()
  if (provider === 'telegram') {
    return Boolean(process.env['TELEGRAM_BOT_TOKEN'] || config.channels.telegram.botToken)
  }
  if (provider === 'whatsapp') {
    if (stack === 'monorepo-provider') {
      return Boolean(
        (process.env['OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL'] || config.channels.whatsapp.bridgeDeliveryUrl)?.trim()
        && (process.env['OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET'] || config.channels.whatsapp.bridgeSharedSecret)?.trim(),
      )
    }
    return Boolean(
      (process.env['WHATSAPP_ACCESS_TOKEN'] || config.channels.whatsapp.accessToken)
      && (process.env['WHATSAPP_PHONE_NUMBER_ID'] || config.channels.whatsapp.phoneNumberId)
      && (process.env['WHATSAPP_VERIFY_TOKEN'] || config.channels.whatsapp.verifyToken)
      && (process.env['WHATSAPP_APP_SECRET'] || config.channels.whatsapp.appSecret),
    )
  }
  if (provider === 'discord') {
    const enabled = process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true'
      || config.channels.discord.enabled === true
    if (!enabled) return false
    if (stack === 'monorepo-provider') {
      return Boolean(
        (process.env['OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL'] || config.channels.discord.bridgeDeliveryUrl)?.trim()
        && (process.env['OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET'] || config.channels.discord.bridgeSharedSecret)?.trim(),
      )
    }
    return Boolean(
      (process.env['DISCORD_BOT_TOKEN'] || config.channels.discord.botToken)
      && (process.env['DISCORD_PUBLIC_KEY'] || config.channels.discord.publicKey),
    )
  }
  return false
}
