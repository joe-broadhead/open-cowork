/**
 * JOE-994 Phase 2: Durable ChannelAdapter façade over monorepo
 * `@open-cowork/gateway-provider-telegram`.
 *
 * Transport/protocol lives in the monorepo provider; Durable product policy
 * (trust, claims, denial probes) stays in `telegram-inbound-policy.ts`.
 *
 * Default path remains the legacy Durable adapter (`telegram.ts`). Enable this
 * façade via `channels.telegram.protocolStack: "monorepo"` or
 * `OPEN_COWORK_TELEGRAM_PROTOCOL_STACK=monorepo`.
 *
 * Residuals (documented, not regressions of the default path):
 * - Poll offset is grammy/process-local (not HA operational-sidecar cursor).
 * - Rich/structured Telegram HTML payload falls back to plain/markdown text.
 * - Native setMyCommands registration is not mirrored (slash text still works).
 */
import { TelegramProvider } from '@open-cowork/gateway-provider-telegram'
import type { IncomingChannelMessage } from '@open-cowork/gateway-channel'
import type { ChannelAdapter, ChannelMessage } from './provider.js'
import {
  createStructuredMessage,
  renderStructuredMessage,
  type ChannelCapabilities,
} from './renderer.js'
import { telegramAdapterCapabilities } from './capabilities.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { processDurableTelegramInbound } from './telegram-inbound-policy.js'
import { CHANNEL_ACTION_TYPING_HEARTBEAT_MS, CHANNEL_ACTION_TYPING_TIMEOUT_MS } from '../channel-actions.js'

function getToken(): string {
  return process.env['TELEGRAM_BOT_TOKEN'] || getConfig().channels.telegram.botToken || ''
}

function telegramCapabilities(): ChannelCapabilities {
  const config = getConfig()
  const richEnabled = config.channels.richMessages.enabled !== false && config.channels.telegram.richMessages?.enabled !== false
  return telegramAdapterCapabilities({ richMessagesEnabled: richEnabled })
}

function mapIncomingToDurableMessage(incoming: IncomingChannelMessage): ChannelMessage {
  const attachments = (incoming.attachments || []).map((a) => ({
    name: a.filename || a.providerFileId || 'attachment',
    url: a.downloadUrl || '',
    mimeType: a.mimeType || 'application/octet-stream',
  }))
  return {
    provider: 'telegram',
    chatId: incoming.target.chatId,
    threadId: incoming.target.threadId ?? undefined,
    messageId: incoming.providerMessageId || incoming.providerEventId || incoming.id,
    userId: incoming.sender.providerUserId,
    text: incoming.text || incoming.rawText || '',
    attachments,
    timestamp: (incoming.receivedAt instanceof Date ? incoming.receivedAt : new Date()).toISOString(),
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.substring(i, size + i))
  }
  return chunks.length ? chunks : ['']
}

export function createTelegramMonorepoChannelAdapter(): ChannelAdapter {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null
  let provider: TelegramProvider | null = null
  let lastTypingFailureEventAt = 0

  const adapter: ChannelAdapter = {
    name: 'telegram',
    get capabilities() {
      return telegramCapabilities()
    },

    async start() {
      const token = getToken()
      if (!token) {
        console.error('[telegram] bot token not set — monorepo façade disabled')
        return
      }
      if (provider) return

      queueEvent('Telegram monorepo protocol stack enabled (JOE-994 Phase 2 façade)')
      const next = new TelegramProvider({
        botToken: token,
        mode: 'polling',
        // Durable policy is the trust gate; monorepo must not pre-filter group traffic.
        respondInGroups: 'all',
        observeUnmentionedGroupMessages: true,
      })
      provider = next

      try {
        await next.start(async (incoming) => {
          if (!handler) return
          const msg = mapIncomingToDurableMessage(incoming)
          await processDurableTelegramInbound(msg, {
            deliver: (accepted) => handler!(accepted),
            withTyping: async (accepted, task) => {
              await withMonorepoTyping(next, accepted, task, () => {
                const now = Date.now()
                if (now - lastTypingFailureEventAt < 60_000) return
                lastTypingFailureEventAt = now
              })
            },
          })
        })
        const health = next.health?.()
        if (health && health.ok === false) {
          queueEvent(`Telegram monorepo provider degraded: ${health.error || 'unknown'}`)
        } else {
          queueEvent('Telegram channel ready via monorepo provider (polling)')
        }
      } catch (err: unknown) {
        provider = null
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] monorepo façade startup failed: ${detail}`)
        queueEvent(`Telegram monorepo façade startup failed: ${detail}`)
      }
    },

    async stop() {
      const current = provider
      provider = null
      if (current) {
        try {
          await current.stop()
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err)
          queueEvent(`Telegram monorepo façade stop failed: ${detail}`)
        }
      }
    },

    async sendMessage(chatId, text, options) {
      const active = requireProvider(provider)
      const limit = Math.max(1, Math.min(active.capabilities.maxTextLength || 4096, 4000))
      for (const part of chunkText(text, limit)) {
        await active.sendText(
          {
            provider: 'telegram',
            chatId,
            threadId: options?.threadId ?? null,
            userId: null,
            messageId: null,
          },
          part,
          options?.idempotencyKey ? { deliveryId: options.idempotencyKey } : undefined,
        )
      }
    },

    async sendStructuredMessage(chatId, message, options) {
      const capabilities = telegramCapabilities()
      const rendered = renderStructuredMessage(message, capabilities)
      const text = rendered.markdown || rendered.plainText || rendered.text || message.summary || message.title || ''
      await adapter.sendMessage(chatId, text, options)
    },

    async sendCommandMenu(chatId, text, actions, options) {
      const message = createStructuredMessage({
        kind: 'status',
        title: 'Gateway Commands',
        summary: text,
        blocks: [
          { type: 'heading', text: 'Gateway Commands', level: 2 },
          { type: 'text', text },
          {
            type: 'facts',
            facts: actions.slice(0, 12).map((action) => ({
              label: action.label,
              value: action.description || action.command,
            })),
          },
        ],
        actions: actions.map((action) => ({ label: action.label, command: action.command })),
      })
      await adapter.sendStructuredMessage?.(chatId, message, options)
    },

    onMessage(h) {
      handler = h
    },
  }

  return adapter
}

function requireProvider(provider: TelegramProvider | null): TelegramProvider {
  if (!provider) {
    throw new Error('Telegram monorepo provider is not started')
  }
  return provider
}

async function withMonorepoTyping(
  provider: TelegramProvider,
  msg: ChannelMessage,
  task: () => Promise<void>,
  onFailureThrottle: () => void,
): Promise<void> {
  let active = true
  const startedAt = Date.now()
  const target = {
    provider: 'telegram' as const,
    chatId: msg.chatId,
    threadId: msg.threadId ?? null,
    userId: null,
    messageId: null,
  }
  const send = () =>
    provider.setTyping?.(target).catch((err: unknown) => {
      onFailureThrottle()
      const detail = err instanceof Error ? err.message : String(err)
      queueEvent(`Telegram typing feedback degraded: ${detail}`)
    })
  await send()
  const timer = setInterval(() => {
    if (!active) return
    if (Date.now() - startedAt >= CHANNEL_ACTION_TYPING_TIMEOUT_MS) {
      clearInterval(timer)
      return
    }
    void send()
  }, CHANNEL_ACTION_TYPING_HEARTBEAT_MS)
  try {
    await task()
  } finally {
    active = false
    clearInterval(timer)
  }
}

/** Test helper: pure inbound mapping without starting grammy. */
export const __telegramMonorepoTest = {
  mapIncomingToDurableMessage,
}
