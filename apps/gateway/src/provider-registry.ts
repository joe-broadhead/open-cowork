import type { IncomingHttpHeaders } from 'node:http'

import type {
  ChannelInteraction,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
} from '@open-cowork/gateway-channel'
import { TelegramProvider } from '@open-cowork/gateway-provider-telegram'
import { WebhookProvider } from '@open-cowork/gateway-provider-webhook'
import { FakeChannelProvider } from '@open-cowork/gateway-testing'

import type { GatewayConfig, GatewayProviderConfig } from './config.js'

export type ProviderRegistration = {
  config: GatewayProviderConfig
  provider: ChannelProvider
  started: boolean
}

export type GatewayProviderRegistry = {
  readonly registrations: ProviderRegistration[]
  start(handler: (config: GatewayProviderConfig, message: IncomingChannelMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
  get(id: string): ProviderRegistration | null
  handleWebhook(id: string, payload: unknown, headers: IncomingHttpHeaders): Promise<void>
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
    .map((provider) => ({
      config: provider,
      provider: createProvider(provider),
      started: false,
    }))

  return {
    registrations,
    async start(handler) {
      for (const registration of registrations) {
        await registration.provider.start((message) => handler(registration.config, message))
        registration.started = true
        if (registration.config.kind === 'telegram') {
          const provider = registration.provider as TelegramProvider
          await provider.configureWebhook()
        }
      }
    },
    async stop() {
      for (const registration of [...registrations].reverse()) {
        if (!registration.started) continue
        await registration.provider.stop()
        registration.started = false
      }
    },
    get(id) {
      return registrations.find((entry) => entry.config.id === id) || null
    },
    async handleWebhook(id, payload, headers) {
      const registration = this.get(id)
      if (!registration) throw new Error(`Unknown gateway provider ${id}.`)
      if (registration.config.kind === 'telegram') {
        await (registration.provider as TelegramProvider).handleWebhookUpdate(payload, {
          headers,
          secretToken: registration.config.credentials.webhookSecret || null,
        })
        return
      }
      if (registration.config.kind === 'webhook') {
        await (registration.provider as WebhookProvider).handleWebhookPayload(payload, {
          headers,
          sharedSecret: registration.config.credentials.sharedSecret || null,
        })
        return
      }
      if (registration.config.kind === 'fake') {
        await (registration.provider as FakeChannelProvider).emit(fakeMessage(registration.provider.id, payload))
        return
      }
      throw new Error(`Gateway provider ${id} does not expose a webhook endpoint.`)
    },
    async emitFake(id, input) {
      const registration = this.get(id)
      if (!registration || registration.config.kind !== 'fake') throw new Error(`Unknown fake gateway provider ${id}.`)
      await (registration.provider as FakeChannelProvider).emit(fakeMessage(registration.provider.id, input))
    },
  }
}

function createProvider(config: GatewayProviderConfig): ChannelProvider {
  if (config.kind === 'fake') return new FakeChannelProvider()

  if (config.kind === 'webhook') {
    return new WebhookProvider({
      deliveryUrl: requiredSetting(config, 'deliveryUrl'),
      sharedSecret: config.credentials.sharedSecret,
      maxAttachmentBytes: optionalNumber(config.settings.maxAttachmentBytes),
    })
  }

  if (config.kind === 'telegram') {
    const mode = settingString(config, 'mode') === 'webhook' ? 'webhook' : 'polling'
    return new TelegramProvider({
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

  throw new Error(`Provider kind ${config.kind} is not implemented by the gateway app yet.`)
}

function fakeMessage(provider: ChannelProvider['id'], payload: unknown): IncomingChannelMessage {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const text = typeof record.text === 'string' ? record.text : ''
  const chatId = typeof record.chatId === 'string' && record.chatId ? record.chatId : 'fake-chat'
  const threadId = typeof record.threadId === 'string' ? record.threadId : null
  const userId = typeof record.userId === 'string' && record.userId ? record.userId : 'fake-user'
  const interaction = readFakeInteraction(record)
  const target: ChannelTarget = {
    provider,
    chatId,
    threadId,
    userId,
  }
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `fake-${Date.now()}`,
    provider,
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

function readRespondInGroups(value: unknown) {
  return value === 'mentions_and_replies' || value === 'all' ? value : 'commands_only'
}
