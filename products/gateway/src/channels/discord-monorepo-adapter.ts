/**
 * JOE-994 Phase 3: Durable Discord ChannelAdapter façade over monorepo
 * `@open-cowork/gateway-provider-discord` (signed webhook bridge mode).
 *
 * Not a native Discord Interactions client — requires an external relay that
 * verifies Discord signatures, then re-signs normalized payloads for Gateway.
 * Default Durable path remains native Interactions + bot REST.
 */
import { DiscordProvider } from '@open-cowork/gateway-provider-discord'
import type { IncomingChannelMessage } from '@open-cowork/gateway-channel'
import type { ChannelAdapter, ChannelMessage } from './provider.js'
import {
  createStructuredMessage,
  renderStructuredMessage,
  type ChannelCapabilities,
} from './renderer.js'
import { discordAdapterCapabilities } from './capabilities.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { processDurableChannelInbound } from './channel-inbound-policy.js'
import type { DiscordInteractionResponse, DiscordReadiness } from './discord.js'
import { getDiscordConfig, getDiscordReadiness } from './discord.js'

export type DiscordBridgeChannel = ChannelAdapter & {
  isEnabled(): boolean
  readiness(): DiscordReadiness
  verifyInteractionSignature(signatureHeader: string | string[] | undefined, timestampHeader: string | string[] | undefined, rawBody: string): boolean
  handleInteraction(rawBody: string, headers?: Record<string, string | string[] | undefined>): Promise<DiscordInteractionResponse>
  handleGatewayEvent(payload: any): Promise<number>
  /** Bridge-mode ingress (HMAC webhook payload). */
  handleBridgeWebhook(rawBody: string, headers?: Record<string, string | string[] | undefined>): Promise<number>
  isMonorepoBridge(): boolean
}

function mapIncoming(incoming: IncomingChannelMessage): ChannelMessage {
  return {
    provider: 'discord',
    chatId: incoming.target.chatId,
    threadId: incoming.target.threadId ?? undefined,
    messageId: incoming.providerMessageId || incoming.providerEventId || incoming.id,
    userId: incoming.sender.providerUserId,
    text: incoming.text || incoming.rawText || '',
    attachments: (incoming.attachments || []).map((a) => ({
      name: a.filename || a.providerFileId || 'attachment',
      url: a.downloadUrl || '',
      mimeType: a.mimeType || 'application/octet-stream',
    })),
    timestamp: (incoming.receivedAt instanceof Date ? incoming.receivedAt : new Date()).toISOString(),
  }
}

function bridgeConfig(): { deliveryUrl: string; sharedSecret: string } | null {
  const cfg = getConfig().channels.discord
  const deliveryUrl = process.env['OPEN_COWORK_DISCORD_BRIDGE_DELIVERY_URL'] || cfg.bridgeDeliveryUrl || ''
  const sharedSecret = process.env['OPEN_COWORK_DISCORD_BRIDGE_SHARED_SECRET'] || cfg.bridgeSharedSecret || ''
  if (!deliveryUrl.trim() || !sharedSecret.trim()) return null
  return { deliveryUrl: deliveryUrl.trim(), sharedSecret: sharedSecret.trim() }
}

export function createDiscordMonorepoChannelAdapter(): DiscordBridgeChannel {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null
  let provider: DiscordProvider | null = null

  const adapter: DiscordBridgeChannel = {
    name: 'discord',
    get capabilities(): ChannelCapabilities {
      const cfg = getDiscordConfig()
      return discordAdapterCapabilities({ enabled: cfg.enabled, richMessagesEnabled: cfg.richMessagesEnabled })
    },
    isEnabled() {
      return getDiscordConfig().enabled
    },
    readiness() {
      const base = getDiscordReadiness()
      const bridge = bridgeConfig()
      if (!bridge) {
        return {
          ...base,
          ready: false,
          issues: [
            ...base.issues,
            'Monorepo Discord stack requires bridgeDeliveryUrl + bridgeSharedSecret (or OPEN_COWORK_DISCORD_BRIDGE_* env).',
          ],
          summary: 'Discord monorepo bridge credentials missing.',
        }
      }
      return {
        ...base,
        summary: base.enabled
          ? 'Discord monorepo bridge stack enabled (relay must verify native Discord signatures).'
          : base.summary,
      }
    },
    isMonorepoBridge() {
      return true
    },
    async start() {
      const cfg = getDiscordConfig()
      if (!cfg.enabled) {
        console.error('[discord] alpha channel disabled; monorepo bridge not started')
        return
      }
      const bridge = bridgeConfig()
      if (!bridge) {
        console.error('[discord] monorepo bridge credentials missing — façade disabled')
        queueEvent('Discord monorepo bridge disabled: delivery URL or shared secret missing')
        return
      }
      if (provider) return
      queueEvent('Discord monorepo protocol stack enabled (JOE-994 Phase 3 bridge façade)')
      const next = new DiscordProvider({
        deliveryUrl: bridge.deliveryUrl,
        sharedSecret: bridge.sharedSecret,
      })
      provider = next
      await next.start(async (incoming) => {
        if (!handler) return
        const msg = mapIncoming(incoming)
        await processDurableChannelInbound('discord', msg, {
          deliver: (accepted) => handler!(accepted),
        })
      })
      queueEvent('Discord channel ready via monorepo webhook bridge')
    },
    async stop() {
      const current = provider
      provider = null
      if (current) await current.stop()
    },
    async sendMessage(chatId, text, options) {
      if (!provider) throw new Error('Discord monorepo bridge is not started')
      const limit = Math.max(1, Math.min(provider.capabilities.maxTextLength || 2000, 2000))
      for (let i = 0; i < text.length; i += limit) {
        const part = text.slice(i, i + limit)
        await provider.sendText({
          provider: 'discord',
          chatId,
          threadId: options?.threadId ?? null,
          userId: null,
          messageId: null,
        }, part, options?.idempotencyKey ? { deliveryId: options.idempotencyKey } : undefined)
      }
    },
    async sendStructuredMessage(chatId, message, options) {
      const rendered = renderStructuredMessage(message, adapter.capabilities)
      await adapter.sendMessage(chatId, rendered.markdown || rendered.plainText || rendered.text || message.summary || message.title || '', options)
    },
    async sendCommandMenu(chatId, text, actions, options) {
      const message = createStructuredMessage({
        kind: 'status',
        title: 'Gateway Commands',
        summary: text,
        blocks: [
          { type: 'heading', text: 'Gateway Commands', level: 2 },
          { type: 'text', text },
          { type: 'facts', facts: actions.slice(0, 12).map((a) => ({ label: a.label, value: a.description || a.command })) },
        ],
        actions: actions.map((a) => ({ label: a.label, command: a.command })),
      })
      await adapter.sendStructuredMessage?.(chatId, message, options)
    },
    onMessage(h) {
      handler = h
    },
    verifyInteractionSignature() {
      // Native Discord interaction verify is disabled on monorepo bridge stack.
      return false
    },
    async handleInteraction() {
      return {
        status: 400,
        body: {
          error: 'native Discord interactions disabled on monorepo bridge stack; relay signed bridge payloads to this endpoint with webhook HMAC headers',
        },
      }
    },
    async handleGatewayEvent() {
      return 0
    },
    async handleBridgeWebhook(rawBody, headers = {}) {
      if (!provider) throw new Error('Discord monorepo bridge is not started')
      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        throw new Error('invalid discord bridge payload')
      }
      await provider.handleWebhookPayload(payload, { headers, rawBody })
      return 1
    },
  }
  return adapter
}

