import type { ChannelAdapter, ChannelMessage } from './provider.js'
import { WHATSAPP_CAPABILITIES } from './capabilities.js'
import { planNativeActionDelivery, renderStructuredMessage, type MessageAction, type NativeActionDeliveryItem, type StructuredGatewayMessage } from './renderer.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'
import { appendWorkEvent } from '../work-store.js'
import { isTransientInboundError, isTrustedChannelTarget, redactedChannelTargetLabel, redactSensitiveText } from '../security.js'
import { acceptChannelClaimFromMessage, acceptChannelDenialProbeFromMessage } from '../channel-claims.js'
import { isPreTrustChannelCommandText } from '../channel-commands.js'
import { fetchWithTimeout } from '../deadlines.js'

const GRAPH_VERSION = 'v20.0'
const WHATSAPP_TEXT_LIMIT = 4096
const WHATSAPP_LIST_ROW_LIMIT = 10
const WHATSAPP_SEND_TIMEOUT_MS = 10_000

let handler: ((msg: ChannelMessage) => Promise<void>) | null = null

export const whatsappChannel: ChannelAdapter & {
  verifyWebhook(url: URL): string | null
  verifySignature(signatureHeader: string | string[] | undefined, rawBody: string): boolean
  handleWebhook(payload: any): Promise<number>
} = {
  name: 'whatsapp',
  capabilities: WHATSAPP_CAPABILITIES,

  async start() {
    const cfg = getWhatsAppConfig()
    if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.verifyToken) {
      console.error('[whatsapp] access token, phone number id, or verify token not set — channel disabled')
      return
    }
    if (!cfg.appSecret) {
      console.error('[whatsapp] app secret not set — inbound POST webhooks will be rejected')
      console.error('[whatsapp] Outbound channel configured; inbound webhook signature verification is blocked')
      queueEvent('WhatsApp outbound ready; inbound webhooks blocked: app secret missing')
      return
    }
    console.error('[whatsapp] Webhook channel ready at /webhooks/whatsapp')
    queueEvent('WhatsApp channel ready: outbound and signed inbound webhooks configured')
  },

  async stop() {},

  async sendMessage(chatId: string, text: string) {
    await sendTextMessage(chatId, text)
  },

  async sendStructuredMessage(chatId: string, message: StructuredGatewayMessage) {
    const rendered = renderStructuredMessage(message, WHATSAPP_CAPABILITIES)
    const rows = whatsappRows(message.actions || [])

    if (rows.length === 0) return sendTextMessage(chatId, rendered.plainText)

    try {
      await sendGraphMessage({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: chatId,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: cleanText(rendered.plainText, WHATSAPP_TEXT_LIMIT) },
          action: {
            button: 'Respond',
            sections: [{ title: cleanText(message.title || 'Gateway', 24), rows }],
          },
        },
      })
    } catch (err: any) {
      queueEvent(`WhatsApp structured message fallback: ${err?.message || err}`)
      await sendTextMessage(chatId, rendered.plainText)
    }
  },

  async sendCommandMenu(chatId: string, text: string, actions: Array<{ label: string; command: string; description?: string }>) {
    const rows = whatsappRows(actions, action => action.description)

    if (rows.length === 0) return sendTextMessage(chatId, text)

    try {
      await sendGraphMessage({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: chatId,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: cleanText(text, WHATSAPP_TEXT_LIMIT) },
          action: {
            button: 'Commands',
            sections: [{ title: 'Gateway', rows }],
          },
        },
      })
    } catch (err: any) {
      queueEvent(`WhatsApp command menu fallback: ${err?.message || err}`)
      await sendTextMessage(chatId, text)
    }
  },

  onMessage(h: (msg: ChannelMessage) => Promise<void>) {
    handler = h
  },

  verifyWebhook(url: URL): string | null {
    const cfg = getWhatsAppConfig()
    if (!cfg.verifyToken) return null
    if (url.searchParams.get('hub.mode') !== 'subscribe') return null
    if (!constantTimeTextEquals(url.searchParams.get('hub.verify_token') || '', cfg.verifyToken)) return null
    return url.searchParams.get('hub.challenge') || ''
  },

  verifySignature(signatureHeader: string | string[] | undefined, rawBody: string): boolean {
    const cfg = getWhatsAppConfig()
    const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
    if (!cfg.appSecret || !header?.startsWith('sha256=')) return false
    const expected = createHmac('sha256', cfg.appSecret).update(rawBody).digest('hex')
    const actual = header.slice('sha256='.length)
    const expectedBuffer = Buffer.from(expected, 'hex')
    const actualBuffer = Buffer.from(actual, 'hex')
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  },

  async handleWebhook(payload: any): Promise<number> {
    if (!handler) throw new Error('WhatsApp channel handler is not registered')
    const messages = mapWhatsAppMessages(payload)
    let handled = 0
    for (const msg of messages) {
      const denialProbe = acceptChannelDenialProbeFromMessage(msg)
      if (denialProbe.status === 'accepted') {
        queueEvent(`WhatsApp denial probe accepted: ${redactedChannelTargetLabel('whatsapp', msg.chatId, msg.threadId)}`)
        handled++
        continue
      }
      if (denialProbe.status === 'denied') continue
      if (!isTrustedChannelTarget('whatsapp', msg.chatId, msg.threadId, getConfig())) {
        const claim = acceptChannelClaimFromMessage(msg)
        if (claim.status === 'accepted') {
          queueEvent(`WhatsApp claim accepted: ${redactedChannelTargetLabel('whatsapp', msg.chatId, msg.threadId)}`)
          handled++
          continue
        }
        if (claim.status === 'denied') continue
        if (isPreTrustChannelCommandText(msg.text)) {
          if (await dispatchInbound(handler, msg)) handled++
          continue
        }
        const target = redactedChannelTargetLabel('whatsapp', msg.chatId, msg.threadId)
        queueEvent(`WhatsApp rejected untrusted inbound: ${target}`)
        safeAuditInboundDenial('whatsapp', msg.chatId, msg.threadId)
        continue
      }
      // A valid claim code from an already-trusted target heals allowlist rules
      // created before per-sender actor policies existed (see addTrustedTarget).
      const trustedClaim = acceptChannelClaimFromMessage(msg)
      if (trustedClaim.status === 'accepted') {
        queueEvent(`WhatsApp claim accepted: ${redactedChannelTargetLabel('whatsapp', msg.chatId, msg.threadId)}`)
        handled++
        continue
      }
      if (trustedClaim.status === 'denied') continue
      if (await dispatchInbound(handler, msg)) handled++
    }
    if (handled > 0) queueEvent(`WhatsApp inbound: ${handled} message(s)`)
    return handled
  },
}

function whatsappRows(actions: Array<MessageAction & { description?: string }>, descriptionForAction?: (action: MessageAction & { description?: string }, planned: NativeActionDeliveryItem) => string | undefined): Array<{ id: string; title: string; description?: string }> {
  return planNativeActionDelivery(actions, {
    maxActions: WHATSAPP_LIST_ROW_LIMIT,
    maxLabelChars: 24,
    maxIdentifierChars: 256,
    maxDescriptionChars: 72,
    urlMode: 'callback',
  }).actions.map(planned => {
    const action = actions[planned.sourceIndex]!
    const rawDescription = descriptionForAction ? descriptionForAction(action, planned) : planned.description
    const description = cleanText(rawDescription || '', 72)
    return {
      id: planned.identifier,
      title: planned.label,
      ...(description ? { description } : {}),
    }
  })
}

function safeAuditInboundDenial(provider: string, chatId: string, threadId?: string): void {
  try { appendChannelInboundDenialAudit({ provider, chatId, threadId }) } catch {}
}

/**
 * Dispatches one inbound message to the daemon handler. Transient failures
 * (OpenCode briefly unreachable) propagate so the webhook returns non-2xx and
 * Meta redelivers; permanent (poison) failures are skipped with a redacted
 * note so one bad message cannot wedge webhook delivery.
 */
async function dispatchInbound(h: (msg: ChannelMessage) => Promise<void>, msg: ChannelMessage): Promise<boolean> {
  try {
    await h(msg)
    return true
  } catch (err: any) {
    if (isTransientInboundError(err)) throw err
    const detail = cleanText(redactSensitiveText(String(err?.message || err), getConfig()), 500)
    queueEvent(`WhatsApp inbound message failed and was skipped: ${detail}`)
    try { appendWorkEvent('whatsapp.inbound.skipped', 'whatsapp:webhook', { error: detail }) } catch {}
    return false
  }
}

export function mapWhatsAppMessages(payload: any, now = new Date()): ChannelMessage[] {
  const messages: ChannelMessage[] = []
  for (const entry of asArray(payload?.entry)) {
    for (const change of asArray(entry?.changes)) {
      const value = change?.value || {}
      for (const message of asArray(value.messages)) {
        const text = messageText(message)
        if (!message?.from || !text) continue
        messages.push({
          provider: 'whatsapp',
          chatId: String(message.from),
          messageId: message.id ? String(message.id) : undefined,
          userId: String(message.from),
          text,
          attachments: messageAttachments(message),
          timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : now.toISOString(),
        })
      }
    }
  }
  return messages
}

function messageText(message: any): string {
  if (message?.type === 'text') return String(message.text?.body || '')
  if (message?.type === 'button') return String(message.button?.payload || message.button?.text || '')
  if (message?.type === 'interactive') {
    return String(message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '')
  }
  const media = message?.[message?.type]
  if (media?.caption) return String(media.caption)
  return ''
}

function messageAttachments(message: any): ChannelMessage['attachments'] {
  const type = String(message?.type || '')
  if (!['audio', 'document', 'image', 'sticker', 'video'].includes(type)) return []
  const media = message[type] || {}
  if (!media.id) return []
  return [{ name: media.filename || `${type}-${media.id}`, url: String(media.id), mimeType: media.mime_type || type }]
}

function getWhatsAppConfig() {
  const cfg = getConfig().channels.whatsapp || {}
  return {
    accessToken: process.env['WHATSAPP_ACCESS_TOKEN'] || cfg.accessToken || '',
    phoneNumberId: process.env['WHATSAPP_PHONE_NUMBER_ID'] || cfg.phoneNumberId || '',
    verifyToken: process.env['WHATSAPP_VERIFY_TOKEN'] || cfg.verifyToken || '',
    appSecret: process.env['WHATSAPP_APP_SECRET'] || cfg.appSecret || '',
  }
}

async function sendGraphMessage(body: Record<string, unknown>): Promise<void> {
  const cfg = getWhatsAppConfig()
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    throw new Error('WhatsApp outbound delivery is not configured: access token and phone number ID are required')
  }
  const res = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, WHATSAPP_SEND_TIMEOUT_MS, 'WhatsApp sendMessage')
  if (!res.ok) throw new Error(`WhatsApp send failed: HTTP ${res.status}: ${cleanText(await safeResponseText(res), 500)}`)
}

async function sendTextMessage(chatId: string, text: string): Promise<void> {
  const chunks = chunk(text, 4000)
  for (const body of chunks) {
    await sendGraphMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'text',
      text: { preview_url: false, body: cleanText(body, WHATSAPP_TEXT_LIMIT) },
    })
  }
}

async function safeResponseText(res: Response): Promise<string> {
  try { return await res.text() } catch { return res.statusText || 'unknown error' }
}

function cleanText(value: string, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ch => ch === '\n' ? '\n' : ' ').trim()
  return text.length <= maxLength ? text : text.substring(0, maxLength)
}

// Constant-time string comparison with length equalization: hash both sides to a
// fixed-length digest before timingSafeEqual, matching the repo's bearer-token
// comparison posture without leaking length via an early return.
function constantTimeTextEquals(a: string, b: string): boolean {
  const aDigest = createHash('sha256').update(String(a)).digest()
  const bDigest = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(aDigest, bDigest)
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : []
}

function chunk(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.substring(i, i + size))
  return chunks.length ? chunks : ['']
}
