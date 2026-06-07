import type { IncomingHttpHeaders } from 'node:http'

import type {
  ChannelInteraction,
  ChannelProvider,
  ChannelProviderId,
  ChannelProviderKind,
  ChannelTarget,
  IncomingChannelMessage,
} from '@open-cowork/gateway-channel'
import { CliProvider } from '@open-cowork/gateway-provider-cli'
import { DiscordProvider } from '@open-cowork/gateway-provider-discord'
import { EmailProvider } from '@open-cowork/gateway-provider-email'
import { SignalProvider } from '@open-cowork/gateway-provider-signal'
import { SlackProvider } from '@open-cowork/gateway-provider-slack'
import { TelegramProvider } from '@open-cowork/gateway-provider-telegram'
import { WebhookProvider } from '@open-cowork/gateway-provider-webhook'
import { WhatsAppProvider } from '@open-cowork/gateway-provider-whatsapp'
import { FakeChannelProvider } from '@open-cowork/gateway-testing'

import type { GatewayConfig, GatewayProviderConfig } from './config.js'

export type ProviderRegistration = {
  config: GatewayProviderConfig
  provider: ChannelProvider
  started: boolean
  healthy: boolean
  lastError: string | null
}

export type GatewayWebhookResponse = {
  challenge?: string
}

export type GatewayProviderRegistry = {
  readonly registrations: ProviderRegistration[]
  start(handler: (config: GatewayProviderConfig, message: IncomingChannelMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
  get(id: string): ProviderRegistration | null
  handleWebhook(id: string, payload: unknown, headers: IncomingHttpHeaders, rawBody?: string): Promise<GatewayWebhookResponse | void>
  emitFake(id: string, input: {
    text: string
    chatId?: string
    threadId?: string | null
    userId?: string
    interaction?: {
      id: string
      token: string
      kind?: 'button' | 'command'
    }
  }): Promise<void>
}

export function createGatewayProviderRegistry(config: GatewayConfig): GatewayProviderRegistry {
  const registrations = config.providers
    .filter((provider) => provider.enabled)
    .map((provider): ProviderRegistration => ({
      config: provider,
      provider: createProvider(provider, config),
      started: false,
      healthy: false,
      lastError: null,
    }))

  return {
    registrations,
    async start(handler) {
      for (const registration of registrations) {
        await registration.provider.start((message) => handler(registration.config, message))
        registration.started = true
        registration.healthy = providerHealthy(registration.provider)
        registration.lastError = providerHealthError(registration.provider)
        if (registration.config.kind === 'telegram') {
          const provider = registration.provider as TelegramProvider
          await provider.configureWebhook()
          registration.healthy = providerHealthy(registration.provider)
          registration.lastError = providerHealthError(registration.provider)
        }
      }
    },
    async stop() {
      for (const registration of [...registrations].reverse()) {
        if (!registration.started) continue
        await registration.provider.stop()
        registration.started = false
        registration.healthy = false
        registration.lastError = null
      }
    },
    get(id) {
      return registrations.find((entry) => entry.config.id === id) || null
    },
    async handleWebhook(id, payload, headers, rawBody) {
      const registration = this.get(id)
      if (!registration) throw new Error(`Unknown gateway provider ${id}.`)
      if (registration.config.kind === 'telegram') {
        await (registration.provider as TelegramProvider).handleWebhookUpdate(payload, {
          headers,
          secretToken: registration.config.credentials.webhookSecret || null,
        })
        return
      }
      if (registration.config.kind === 'slack') {
        return (registration.provider as SlackProvider).handleWebhookPayload(payload, {
          headers,
          rawBody,
          signingSecret: registration.config.credentials.signingSecret || null,
        })
      }
      if (registration.config.kind === 'email') {
        await (registration.provider as EmailProvider).handleWebhookPayload(payload, {
          headers,
          sharedSecret: registration.config.credentials.inboundSecret || null,
        })
        return
      }
      if (registration.config.kind === 'webhook') {
        await (registration.provider as WebhookProvider).handleWebhookPayload(payload, {
          headers,
          rawBody,
        })
        return
      }
      if (isBridgeWebhookProviderKind(registration.config.kind)) {
        await (registration.provider as WebhookProvider).handleWebhookPayload(payload, {
          headers,
          rawBody,
        })
        return
      }
      if (registration.config.kind === 'fake') {
        await (registration.provider as FakeChannelProvider).emit(fakeMessage(registration.provider, payload))
        return
      }
      throw new Error(`Gateway provider ${id} does not expose a webhook endpoint.`)
    },
    async emitFake(id, input) {
      const registration = this.get(id)
      if (!registration || registration.config.kind !== 'fake') throw new Error(`Unknown fake gateway provider ${id}.`)
      await (registration.provider as FakeChannelProvider).emit(fakeMessage(registration.provider, input))
    },
  }
}

function providerHealthy(provider: ChannelProvider) {
  return provider.health ? provider.health().ok : true
}

function providerHealthError(provider: ChannelProvider) {
  return provider.health ? provider.health().error || null : null
}

function createProvider(config: GatewayProviderConfig, gateway: GatewayConfig): ChannelProvider {
  if (config.kind === 'fake') {
    return new FakeChannelProvider({
      capabilities: {
        maxFileBytes: gateway.server.maxRequestBodyBytes,
        maxFileSizeBytes: gateway.server.maxRequestBodyBytes,
      },
    })
  }

  if (config.kind === 'webhook') {
    return new WebhookProvider({
      providerId: channelProviderConfigId(config),
      deliveryUrl: requiredSetting(config, 'deliveryUrl'),
      deliveryUrlAllowedHosts: optionalStringList(config.settings.deliveryUrlAllowedHosts),
      sharedSecret: config.credentials.sharedSecret,
      maxAttachmentBytes: optionalNumber(config.settings.maxAttachmentBytes) || optionalNumberString(config.settings.maxAttachmentBytes) || gateway.server.maxRequestBodyBytes,
      deliveryTimeoutMs: gateway.timeouts.webhookDeliveryMs,
      allowPrivateDelivery: readBoolean(config.settings.allowPrivateDelivery, false),
    })
  }

  if (isBridgeWebhookProviderKind(config.kind)) {
    const bridgeConfig = bridgeProviderConfig(config, gateway)
    if (config.kind === 'discord') return new DiscordProvider(bridgeConfig)
    if (config.kind === 'whatsapp') return new WhatsAppProvider(bridgeConfig)
    return new SignalProvider(bridgeConfig)
  }

  if (config.kind === 'telegram') {
    const mode = settingString(config, 'mode') === 'webhook' ? 'webhook' : 'polling'
    return new TelegramProvider({
      providerId: channelProviderConfigId(config),
      botToken: requiredCredential(config, 'botToken'),
      mode,
      webhook: mode === 'webhook'
        ? {
            publicBaseUrl: requiredSetting(config, 'publicBaseUrl'),
            path: settingString(config, 'webhookPath') || `/webhooks/${encodeURIComponent(config.id)}`,
            secretToken: requiredCredential(config, 'webhookSecret'),
          }
        : undefined,
      respondInGroups: readRespondInGroups(config.settings.respondInGroups),
      observeUnmentionedGroupMessages: config.settings.observeUnmentionedGroupMessages === true,
    })
  }

  if (config.kind === 'slack') {
    return new SlackProvider({
      providerId: channelProviderConfigId(config),
      botToken: requiredCredential(config, 'botToken'),
      signingSecret: requiredCredential(config, 'signingSecret'),
      apiBaseUrl: settingString(config, 'apiBaseUrl') || undefined,
      requestTimeoutMs: gateway.timeouts.webhookDeliveryMs,
    })
  }

  if (config.kind === 'email') {
    return new EmailProvider({
      providerId: channelProviderConfigId(config),
      from: requiredSetting(config, 'from'),
      inboundSecret: requiredCredential(config, 'inboundSecret'),
      maxAttachmentBytes: optionalNumber(config.settings.maxAttachmentBytes) || optionalNumberString(config.settings.maxAttachmentBytes) || gateway.server.maxRequestBodyBytes,
      smtp: {
        host: requiredSetting(config, 'smtpHost'),
        port: optionalNumber(config.settings.smtpPort) || optionalNumberString(config.settings.smtpPort),
        secure: readBoolean(config.settings.smtpSecure, false),
        username: settingString(config, 'smtpUsername') || undefined,
        password: config.credentials.smtpPassword || undefined,
        timeoutMs: gateway.timeouts.smtpMs,
      },
    })
  }

  if (config.kind === 'cli') return new CliProvider({ providerId: channelProviderConfigId(config) })

  throw new Error(`Provider kind ${config.kind} is not implemented by the gateway app yet.`)
}

function isBridgeWebhookProviderKind(kind: GatewayProviderConfig['kind']): kind is 'discord' | 'whatsapp' | 'signal' {
  return kind === 'discord' || kind === 'whatsapp' || kind === 'signal'
}

function bridgeProviderConfig(config: GatewayProviderConfig, gateway: GatewayConfig) {
  return {
    providerId: channelProviderConfigId(config),
    deliveryUrl: requiredSetting(config, 'deliveryUrl'),
    deliveryUrlAllowedHosts: optionalStringList(config.settings.deliveryUrlAllowedHosts),
    sharedSecret: requiredCredential(config, 'sharedSecret'),
    maxAttachmentBytes: optionalNumber(config.settings.maxAttachmentBytes) || optionalNumberString(config.settings.maxAttachmentBytes) || gateway.server.maxRequestBodyBytes,
    deliveryTimeoutMs: gateway.timeouts.webhookDeliveryMs,
    allowPrivateDelivery: readBoolean(config.settings.allowPrivateDelivery, false),
  }
}

function channelProviderConfigId(config: GatewayProviderConfig): ChannelProviderId {
  return config.id as ChannelProviderId
}

function fakeMessage(provider: Pick<ChannelProvider, 'id' | 'kind'>, payload: unknown): IncomingChannelMessage {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const text = typeof record.text === 'string' ? record.text : ''
  const chatId = typeof record.chatId === 'string' && record.chatId ? record.chatId : 'fake-chat'
  const threadId = typeof record.threadId === 'string' ? record.threadId : null
  const userId = typeof record.userId === 'string' && record.userId ? record.userId : 'fake-user'
  const interaction = readFakeInteraction(record)
  const target: ChannelTarget = {
    provider: provider.id,
    providerKind: provider.kind as ChannelProviderKind,
    chatId,
    threadId,
    userId,
  }
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `fake-${Date.now()}`,
    providerInstanceId: provider.id,
    providerEventId: typeof record.id === 'string' && record.id ? record.id : `fake-${Date.now()}`,
    providerMessageId: typeof record.id === 'string' && record.id ? record.id : null,
    provider: provider.id,
    providerKind: provider.kind,
    target,
    sender: {
      providerUserId: userId,
      username: null,
      displayName: null,
    },
    text,
    rawText: text,
    isCommand: text.startsWith('/'),
    command: text.startsWith('/') ? text.slice(1).split(/\s+/)[0] : undefined,
    commandArgs: text.startsWith('/') ? text.slice(1).split(/\s+/).slice(1).join(' ') : undefined,
    attachments: [],
    interaction,
    receivedAt: new Date(),
    raw: payload,
  }
}

function readFakeInteraction(record: Record<string, unknown>): ChannelInteraction | undefined {
  const interaction = record.interaction
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return undefined
  const input = interaction as Record<string, unknown>
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null
  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : null
  const kind = input.kind === 'command' ? 'command' : 'button'
  if (!id || !token) return undefined
  return { id, token, kind }
}

function requiredCredential(config: GatewayProviderConfig, key: string) {
  const value = config.credentials[key]
  if (!value) throw new Error(`Gateway provider ${config.id} requires credential ${key}.`)
  return value
}

function requiredSetting(config: GatewayProviderConfig, key: string) {
  const value = settingString(config, key)
  if (!value) throw new Error(`Gateway provider ${config.id} requires setting ${key}.`)
  return value
}

function settingString(config: GatewayProviderConfig, key: string) {
  const value = config.settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalNumberString(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  const parsed = text ? Number(text) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  return undefined
}

function readBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'true' || text === '1' || text === 'yes') return true
  if (text === 'false' || text === '0' || text === 'no') return false
  return fallback
}

function readRespondInGroups(value: unknown) {
  return value === 'mentions_and_replies' || value === 'all' ? value : 'commands_only'
}
