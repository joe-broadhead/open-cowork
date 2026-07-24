/**
 * JOE-994 Phase 3: Durable WhatsApp ChannelAdapter façade over monorepo
 * `@open-cowork/gateway-provider-whatsapp` (signed webhook bridge mode).
 *
 * Not Meta Graph native — requires an external relay that verifies Meta
 * signatures, then re-signs normalized payloads for Gateway. Default Durable
 * path remains Graph API + Meta hub webhooks.
 */
import { WhatsAppProvider } from '@open-cowork/gateway-provider-whatsapp'
import type { IncomingChannelMessage } from '@open-cowork/gateway-channel'
import type { ChannelAdapter, ChannelMessage } from './provider.js'
import { renderStructuredMessage } from './renderer.js'
import { WHATSAPP_CAPABILITIES } from './capabilities.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { processDurableChannelInbound } from './channel-inbound-policy.js'

export type WhatsAppBridgeChannel = ChannelAdapter & {
  verifyWebhook(url: URL): string | null
  verifySignature(signatureHeader: string | string[] | undefined, rawBody: string): boolean
  handleWebhook(payload: any): Promise<number>
  handleBridgeWebhook(rawBody: string, headers?: Record<string, string | string[] | undefined>): Promise<number>
  isMonorepoBridge(): boolean
}

function mapIncoming(incoming: IncomingChannelMessage): ChannelMessage {
  return {
    provider: 'whatsapp',
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
  const cfg = getConfig().channels.whatsapp
  const deliveryUrl = process.env['OPEN_COWORK_WHATSAPP_BRIDGE_DELIVERY_URL'] || cfg.bridgeDeliveryUrl || ''
  const sharedSecret = process.env['OPEN_COWORK_WHATSAPP_BRIDGE_SHARED_SECRET'] || cfg.bridgeSharedSecret || ''
  if (!deliveryUrl.trim() || !sharedSecret.trim()) return null
  return { deliveryUrl: deliveryUrl.trim(), sharedSecret: sharedSecret.trim() }
}

export function createWhatsAppMonorepoChannelAdapter(): WhatsAppBridgeChannel {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null
  let provider: WhatsAppProvider | null = null

  const adapter: WhatsAppBridgeChannel = {
    name: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
    isMonorepoBridge() {
      return true
    },
    async start() {
      const bridge = bridgeConfig()
      if (!bridge) {
        console.error('[whatsapp] monorepo bridge credentials missing — façade disabled')
        queueEvent('WhatsApp monorepo bridge disabled: delivery URL or shared secret missing')
        return
      }
      if (provider) return
      queueEvent('WhatsApp monorepo protocol stack enabled (JOE-994 Phase 3 bridge façade)')
      const next = new WhatsAppProvider({
        deliveryUrl: bridge.deliveryUrl,
        sharedSecret: bridge.sharedSecret,
      })
      provider = next
      await next.start(async (incoming) => {
        if (!handler) return
        const msg = mapIncoming(incoming)
        await processDurableChannelInbound('whatsapp', msg, {
          deliver: (accepted) => handler!(accepted),
        })
      })
      queueEvent('WhatsApp channel ready via monorepo webhook bridge')
    },
    async stop() {
      const current = provider
      provider = null
      if (current) await current.stop()
    },
    async sendMessage(chatId, text) {
      if (!provider) throw new Error('WhatsApp monorepo bridge is not started')
      const limit = Math.max(1, Math.min(provider.capabilities.maxTextLength || 4096, 4096))
      for (let i = 0; i < text.length; i += limit) {
        await provider.sendText({
          provider: 'whatsapp',
          chatId,
          threadId: null,
          userId: null,
          messageId: null,
        }, text.slice(i, i + limit))
      }
    },
    async sendStructuredMessage(chatId, message) {
      const rendered = renderStructuredMessage(message, WHATSAPP_CAPABILITIES)
      await adapter.sendMessage(chatId, rendered.plainText || rendered.text || message.summary || message.title || '')
    },
    async sendCommandMenu(chatId, text) {
      await adapter.sendMessage(chatId, text)
    },
    onMessage(h) {
      handler = h
    },
    verifyWebhook() {
      // Meta hub challenge is native-stack only.
      return null
    },
    verifySignature() {
      // Meta hub HMAC is native-stack only; bridge uses WebhookProvider auth.
      return false
    },
    async handleWebhook() {
      throw new Error('native Meta hub webhooks disabled on monorepo bridge stack; POST bridge payloads with gateway webhook HMAC headers')
    },
    async handleBridgeWebhook(rawBody, headers = {}) {
      if (!provider) throw new Error('WhatsApp monorepo bridge is not started')
      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        throw new Error('invalid whatsapp bridge payload')
      }
      await provider.handleWebhookPayload(payload, { headers, rawBody })
      return 1
    },
  }
  return adapter
}

