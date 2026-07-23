/**
 * Telegram channel adapter.
 *
 * Setup:
 *   1. Create a bot via @BotFather → get BOT_TOKEN
 *   2. Set env: TELEGRAM_BOT_TOKEN=xxx
 *   3. Run: opencode-gateway start
 *
 * The bot listens for messages and forwards them to the gateway.
 * Responses from OpenCode sessions are sent back to the user.
 */

import { createHash } from 'node:crypto'
import type { ChannelAdapter, ChannelMessage } from './provider.js'
import { createStructuredMessage, planNativeActionDelivery, renderStructuredMessage, type ChannelCapabilities, type MessageAction, type NativeActionDeliveryItem, type RichMessageBlock, type StructuredGatewayMessage } from './renderer.js'
import { telegramAdapterCapabilities } from './capabilities.js'
import { getConfig } from '../config.js'
import {
  clearChannelPollCursor,
  loadChannelPollCursor,
  operationalSidecarPath,
  saveChannelPollCursor,
} from '../operational-sidecar-store.js'
import { queueEvent } from '../wakeup.js'
import { appendWorkEvent, listRecentWorkEvents } from '../work-store.js'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'
import { isTransientInboundError, isTrustedChannelTarget, redactedChannelTargetLabel, redactSensitiveText } from '../security.js'
import { acceptChannelClaimFromMessage, acceptChannelDenialProbeFromMessage } from '../channel-claims.js'
import { isPreTrustChannelCommandText } from '../channel-commands.js'
import { CHANNEL_ACTION_TYPING_HEARTBEAT_MS, CHANNEL_ACTION_TYPING_TIMEOUT_MS, telegramNativeSlashCommandManifest } from '../channel-actions.js'
import { fetchWithTimeout } from '../deadlines.js'

let handler: ((msg: ChannelMessage) => Promise<void>) | null = null
let polling = false
let lastUpdateId = 0
let lastTypingFailureEventAt = 0
const TYPING_FAILURE_EVENT_INTERVAL_MS = 60_000
const TRANSIENT_RETRY_BACKOFF_MS = 5000
let transientRetryBackoffMs = TRANSIENT_RETRY_BACKOFF_MS
const COMMAND_REGISTRATION_SUBJECT = 'telegram:commands'
const COMMAND_REGISTRATION_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const COMMAND_REGISTRATION_RATE_LIMIT_TTL_MS = 60 * 60 * 1000
const TELEGRAM_STARTUP_TIMEOUT_MS = 5_000
const TELEGRAM_SEND_TIMEOUT_MS = 10_000
const TELEGRAM_LONG_POLL_TIMEOUT_MS = 35_000
const TELEGRAM_CONTROL_TIMEOUT_MS = 5_000

export const telegramChannel: ChannelAdapter = {
  name: 'telegram',
  get capabilities() {
    return telegramCapabilities()
  },

  async start() {
    const token = getToken()
    if (!token) {
      console.error('[telegram] bot token not set — channel disabled')
      return
    }
    const api = getApi(token)

    try {
      const verify = await fetchWithTimeout(`${api}/getMe`, {}, TELEGRAM_STARTUP_TIMEOUT_MS, 'Telegram getMe')
      const me = await verify.json() as any
      if (!verify.ok || !me.ok) {
        const detail = cleanText(me?.description || verify.statusText || 'unknown error', 500)
        console.error(`[telegram] startup failed: ${detail}`)
        queueEvent(`Telegram startup failed: ${detail}`)
        return
      }
      console.error(`[telegram] Bot @${me.result.username} started`)
      queueEvent(`Telegram channel ready: @${me.result.username}`)
      await registerTelegramCommands(api)
    } catch (err: any) {
      const detail = cleanText(err?.message || String(err), 500)
      console.error(`[telegram] startup failed: ${detail}`)
      queueEvent(`Telegram startup failed: ${detail}`)
      return
    }

    polling = true
    poll(token)
  },

  async stop() {
    polling = false
  },

  async sendMessage(chatId: string, text: string, options?: { threadId?: string; idempotencyKey?: string }) {
    const token = getToken()
    if (!token) throw new Error('Telegram outbound delivery is not configured: bot token is missing')
    const api = getApi(token)

    // Telegram max message length is 4096
    const chunks = chunk(text, 4000)
    for (const c of chunks) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: c,
        parse_mode: 'Markdown',
      }
      if (options?.threadId) body['message_thread_id'] = options.threadId
      try {
        const res = await fetchWithTimeout(`${api}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, TELEGRAM_SEND_TIMEOUT_MS, 'Telegram sendMessage')
        if (res.ok) continue
        const detail = cleanText(await safeResponseText(res), 500)
        if (body['parse_mode'] && !isTelegramTargetError(res.status, detail)) {
          delete body['parse_mode']
          const retry = await fetchWithTimeout(`${api}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }, TELEGRAM_SEND_TIMEOUT_MS, 'Telegram sendMessage retry')
          if (retry.ok) continue
          throw new Error(`HTTP ${retry.status}: ${cleanText(await safeResponseText(retry), 500)}`)
        }
        throw new Error(`HTTP ${res.status}: ${detail}`)
      } catch (err: any) {
        const detail = cleanText(err?.message || String(err), 500)
        console.error(`[telegram] send failed: ${detail}`)
        queueEvent(`Telegram send failed: ${detail}`)
        throw err
      }
    }
  },

  async sendStructuredMessage(chatId: string, message: StructuredGatewayMessage, options?: { threadId?: string }) {
    const capabilities = telegramCapabilities()
    const rendered = renderStructuredMessage(message, capabilities)
    if (rendered.mode !== 'rich') {
      await this.sendMessage(chatId, rendered.text, options)
      return
    }

    const richPayload = buildTelegramRichPayload(message)
    if (!richPayload) {
      await this.sendMessage(chatId, rendered.markdown || rendered.plainText, options)
      return
    }

    const token = getToken()
    if (!token) throw new Error('Telegram outbound delivery is not configured: bot token is missing')
    const api = getApi(token)
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: {
        html: richPayload.html,
        skip_entity_detection: true,
      },
    }
    if (richPayload.reply_markup) body['reply_markup'] = richPayload.reply_markup
    if (options?.threadId) body['message_thread_id'] = options.threadId

    try {
      const res = await fetchWithTimeout(`${api}/sendRichMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, TELEGRAM_SEND_TIMEOUT_MS, 'Telegram sendRichMessage')
      if (res.ok) return
      const detail = cleanText(await safeResponseText(res), 500)
      if (isTelegramTargetError(res.status, detail)) throw new Error(`HTTP ${res.status}: ${detail}`)
      queueEvent(`Telegram rich send degraded: ${detail}`)
      await this.sendMessage(chatId, rendered.markdown || rendered.plainText, options)
    } catch (err: any) {
      const detail = cleanText(err?.message || String(err), 500)
      console.error(`[telegram] rich send failed: ${detail}`)
      queueEvent(`Telegram rich send failed: ${detail}`)
      if (isTelegramTargetFailureDetail(detail)) throw err
      await this.sendMessage(chatId, rendered.markdown || rendered.plainText, options)
    }
  },

  async sendCommandMenu(chatId: string, text: string, actions: Array<{ label: string; command: string; description?: string }>, options?: { threadId?: string }) {
    const message = createStructuredMessage({
      kind: 'status',
      title: 'Gateway Commands',
      summary: text,
      blocks: [
        { type: 'heading', text: 'Gateway Commands', level: 2 },
        { type: 'text', text },
        { type: 'facts', facts: actions.slice(0, 12).map(action => ({ label: action.label, value: action.description || action.command })) },
      ],
      actions: actions.map(action => ({ label: action.label, command: action.command })),
    })
    await this.sendStructuredMessage?.(chatId, message, options)
  },

  onMessage(h: (msg: ChannelMessage) => Promise<void>) {
    handler = h
  },
}

function getToken(): string {
  return process.env['TELEGRAM_BOT_TOKEN'] || getConfig().channels.telegram.botToken || ''
}

function telegramCapabilities(): ChannelCapabilities {
  const config = getConfig()
  const richEnabled = config.channels.richMessages.enabled !== false && config.channels.telegram.richMessages?.enabled !== false
  return telegramAdapterCapabilities({ richMessagesEnabled: richEnabled })
}

function getApi(token: string): string {
  return `https://api.telegram.org/bot${token}`
}

async function poll(token: string) {
  const api = getApi(token)
  lastUpdateId = Math.max(lastUpdateId, loadTelegramUpdateCursor())
  while (polling) {
    try {
      const res = await fetchWithTimeout(`${api}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, {}, TELEGRAM_LONG_POLL_TIMEOUT_MS, 'Telegram getUpdates').then(r => r.json()) as any
      if (!res.ok || !res.result) { await sleep(1000); continue }

      let deferBatch = false
      for (const update of res.result) {
        const updateId = normalizeUpdateId(update.update_id)
        if (updateId <= lastUpdateId) continue

        try {
          if (update.message?.text && handler) await handleTelegramInboundMessage(update, update.message, update.message.text)
          if (update.callback_query?.data && handler) {
            const callback = update.callback_query
            await handleTelegramInboundMessage(update, callback.message, callback.data, callback.from)
            if (callback.id) acknowledgeTelegramCallback(api, callback.id).catch(() => {})
          }
        } catch (err: any) {
          const detail = cleanText(err?.message || String(err), 500)
          if (isTransientInboundError(err)) {
            // Transient downstream failure (e.g. OpenCode restarting): do NOT
            // advance the cursor. Back off and re-fetch the same update so the
            // message is retried instead of dropped.
            console.error(`[telegram] inbound update ${updateId} deferred (transient); retrying: ${detail}`)
            deferBatch = true
            break
          }
          // A poison update must never block the cursor: log the redacted failure,
          // skip the update, and keep the channel alive for the rest of the queue.
          console.error(`[telegram] inbound update ${updateId} failed; skipping: ${detail}`)
          queueEvent(`Telegram inbound update ${updateId} failed and was skipped: ${detail}`)
          try { appendWorkEvent('telegram.update.skipped', 'telegram:poll', { updateId, error: detail }) } catch {}
        }
        // Advance the persisted cursor past handled and poison-skipped updates only.
        lastUpdateId = updateId
        saveTelegramUpdateCursor(lastUpdateId)
      }
      if (deferBatch) await sleep(transientRetryBackoffMs)
    } catch (err: any) {
      // The bot token rides inside every Telegram API URL, so fetch-layer errors can
      // embed it; redact before this reaches the on-disk service log.
      console.error(`[telegram] polling error: ${cleanText(err?.message || String(err), 500)}`)
      await sleep(5000)
    }
  }
}

function chunk(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.substring(i, i + size))
  }
  return chunks
}

interface TelegramRichPayload {
  html: string
  reply_markup?: { inline_keyboard: TelegramInlineKeyboardButton[][] }
}

type TelegramInlineKeyboardButton =
  | { text: string; url: string; style?: string }
  | { text: string; callback_data: string; style?: string }
  | { text: string; copy_text: { text: string }; style?: string }

function buildTelegramRichPayload(message: StructuredGatewayMessage): TelegramRichPayload | null {
  const blocks: string[] = []
  for (const block of message.blocks) {
    const rendered = renderTelegramRichBlock(block)
    if (rendered === null) return null
    if (rendered) blocks.push(rendered)
  }
  if (!blocks.length) blocks.push(`<h2>${escapeHtml(sanitizeTelegramText(message.title, 256))}</h2>`)
  const html = blocks.join('\n\n').trim()
  if (!html || utf8Length(stripTags(html)) > 32768) return null
  const reply_markup = buildTelegramReplyMarkup(message.actions)
  return reply_markup ? { html, reply_markup } : { html }
}

function renderTelegramRichBlock(block: RichMessageBlock): string | null {
  if (block.type === 'heading') {
    const level = Math.max(1, Math.min(block.level || 2, 3))
    return `<h${level}>${escapeHtml(sanitizeTelegramText(block.text, 512))}</h${level}>`
  }
  if (block.type === 'text') {
    const text = sanitizeTelegramText(block.text, 0)
    return looksLikeCodeBlock(text) ? `<pre>${escapeHtml(stripFence(text))}</pre>` : `<p>${escapeHtml(text)}</p>`
  }
  if (block.type === 'facts') {
    const items = block.facts
      .slice(0, 100)
      .map(fact => `<li><b>${escapeHtml(sanitizeTelegramText(fact.label, 128))}:</b> ${escapeHtml(sanitizeTelegramText(fact.value, 1024))}</li>`)
    return items.length ? `<ul>${items.join('')}</ul>` : ''
  }
  if (block.type === 'table') {
    if (block.columns.length > 20) return null
    const header = `<tr>${block.columns.map(column => `<th>${escapeHtml(sanitizeTelegramText(column, 128))}</th>`).join('')}</tr>`
    const rows = block.rows.slice(0, 200).map(row => `<tr>${block.columns.map((_column, index) => `<td>${escapeHtml(sanitizeTelegramText(row[index] || '', 512))}</td>`).join('')}</tr>`)
    return `<table>${header}${rows.join('')}</table>`
  }
  if (block.type === 'details') {
    return `<details><summary>${escapeHtml(sanitizeTelegramText(block.title, 256))}</summary><p>${escapeHtml(sanitizeTelegramText(block.body, 0))}</p></details>`
  }
  if (block.type === 'media') {
    const url = safeHttpUrl(block.url)
    if (!url) return null
    const tag = mediaTag(block.mimeType, url)
    if (!tag) return null
    return `<figure>${tag}<figcaption>${escapeHtml(sanitizeTelegramText(block.alt, 512))}</figcaption></figure>`
  }
  if (block.type === 'divider') return '<hr/>'
  return null
}

function buildTelegramReplyMarkup(actions: MessageAction[] | undefined): TelegramRichPayload['reply_markup'] | undefined {
  const buttons = planNativeActionDelivery(actions, {
    maxActions: 12,
    maxLabelChars: 64,
    maxIdentifierChars: 256,
    maxCallbackBytes: 64,
    maxCopyTextChars: 256,
    supportsCopyText: true,
    urlMode: 'native',
  }).actions.map(telegramButton)
  if (!buttons.length) return undefined
  const inline_keyboard: TelegramInlineKeyboardButton[][] = []
  for (let i = 0; i < buttons.length; i += 2) inline_keyboard.push(buttons.slice(i, i + 2))
  return { inline_keyboard }
}

function telegramButton(action: NativeActionDeliveryItem): TelegramInlineKeyboardButton {
  const style = telegramButtonStyle(action.style)
  if (action.kind === 'url') return style ? { text: action.label, url: action.identifier, style } : { text: action.label, url: action.identifier }
  if (action.kind === 'copy') return style ? { text: action.label, copy_text: { text: action.identifier }, style } : { text: action.label, copy_text: { text: action.identifier } }
  return style ? { text: action.label, callback_data: action.identifier, style } : { text: action.label, callback_data: action.identifier }
}

function telegramButtonStyle(style: MessageAction['style']): string | undefined {
  if (style === 'primary') return 'primary'
  if (style === 'danger') return 'danger'
  return undefined
}

async function handleTelegramInboundMessage(update: any, rawMessage: any, text: string, from?: any): Promise<void> {
  if (!handler || !rawMessage?.chat) return
  const inboundHandler = handler
  const chatId = String(rawMessage.chat.id)
  const threadId = rawMessage.message_thread_id ? String(rawMessage.message_thread_id) : undefined
  const timestampSeconds = Number(rawMessage.date || update.callback_query?.message?.date || Date.now() / 1000)
  const msg: ChannelMessage = {
    provider: 'telegram',
    chatId,
    threadId,
    messageId: update.callback_query?.id ? String(update.callback_query.id) : rawMessage.message_id ? String(rawMessage.message_id) : String(update.update_id),
    userId: String(from?.id || rawMessage.from?.id || 'unknown'),
    text,
    attachments: [],
    timestamp: new Date(timestampSeconds * 1000).toISOString(),
  }
  const denialProbe = acceptChannelDenialProbeFromMessage(msg)
  if (denialProbe.status === 'accepted') {
    queueEvent(`Telegram denial probe accepted: ${redactedChannelTargetLabel('telegram', chatId, threadId)}`)
    return
  }
  if (denialProbe.status === 'denied') return
  if (!isTrustedChannelTarget('telegram', chatId, threadId, getConfig())) {
    const claim = acceptChannelClaimFromMessage(msg)
    if (claim.status === 'accepted') {
      queueEvent(`Telegram claim accepted: ${redactedChannelTargetLabel('telegram', chatId, threadId)}`)
      return
    }
    if (claim.status === 'denied') return
    if (isPreTrustChannelCommandText(msg.text)) {
      await inboundHandler(msg)
      return
    }
    const target = redactedChannelTargetLabel('telegram', chatId, threadId)
    queueEvent(`Telegram rejected untrusted inbound: ${target}`)
    safeAuditInboundDenial('telegram', chatId, threadId)
    return
  }
  // A valid claim code from an already-trusted target heals allowlist rules
  // created before per-sender actor policies existed by merging the claimant
  // into the rule's userIds (see addTrustedTarget in channel-claims).
  const trustedClaim = acceptChannelClaimFromMessage(msg)
  if (trustedClaim.status === 'accepted') {
    queueEvent(`Telegram claim accepted: ${redactedChannelTargetLabel('telegram', chatId, threadId)}`)
    return
  }
  if (trustedClaim.status === 'denied') return
  const token = getToken()
  if (!token) {
    await inboundHandler(msg)
    return
  }
  await withTelegramTyping(getApi(token), chatId, threadId, () => inboundHandler(msg))
}

function safeAuditInboundDenial(provider: string, chatId: string, threadId?: string): void {
  try { appendChannelInboundDenialAudit({ provider, chatId, threadId }) } catch {}
}

async function registerTelegramCommands(api: string): Promise<void> {
  const manifest = telegramNativeSlashCommandManifest()
  if (!manifest.valid) {
    appendWorkEvent('telegram.command_menu.registration.failed', COMMAND_REGISTRATION_SUBJECT, {
      commandCount: manifest.commandCount,
      violations: manifest.violations,
    })
    queueEvent(`Telegram command menu registration degraded: invalid native command manifest (${manifest.violations.length} violation(s))`)
    return
  }
  const commands = manifest.commands.map(command => ({
    command: command.command,
    description: sanitizeTelegramText(command.description, 256),
  }))
  const commandsHash = hashText(JSON.stringify(commands)).slice(0, 12)
  if (shouldSkipTelegramCommandRegistration(commandsHash)) return
  try {
    const res = await fetchWithTimeout(`${api}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }, TELEGRAM_SEND_TIMEOUT_MS, 'Telegram setMyCommands')
    if (res.ok) {
      appendWorkEvent('telegram.command_menu.registration.succeeded', COMMAND_REGISTRATION_SUBJECT, { commandsHash, commandCount: commands.length })
      return
    }
    const detail = cleanText(await safeResponseText(res), 500)
    const retryAfterSeconds = telegramRetryAfterSeconds(detail)
    if (res.status === 429 || retryAfterSeconds) {
      const retryMs = Math.max(60_000, (retryAfterSeconds || 60) * 1000)
      appendWorkEvent('telegram.command_menu.registration.rate_limited', COMMAND_REGISTRATION_SUBJECT, {
        commandsHash,
        commandCount: commands.length,
        retryUntil: new Date(Date.now() + retryMs).toISOString(),
        detail,
      })
    } else {
      appendWorkEvent('telegram.command_menu.registration.failed', COMMAND_REGISTRATION_SUBJECT, { commandsHash, commandCount: commands.length, detail })
    }
    queueEvent(`Telegram command menu registration degraded: ${detail}`)
  } catch (err: any) {
    const detail = cleanText(err?.message || String(err), 500)
    appendWorkEvent('telegram.command_menu.registration.failed', COMMAND_REGISTRATION_SUBJECT, { commandsHash, commandCount: commands.length, detail })
    queueEvent(`Telegram command menu registration degraded: ${detail}`)
  }
}

function shouldSkipTelegramCommandRegistration(commandsHash: string): boolean {
  const now = Date.now()
  const recentSuccess = listRecentWorkEvents('telegram.command_menu.registration.succeeded', COMMAND_REGISTRATION_SUBJECT, new Date(now - COMMAND_REGISTRATION_SUCCESS_TTL_MS), 10)
    .some(event => event.payload?.['commandsHash'] === commandsHash)
  if (recentSuccess) return true
  const recentRateLimit = listRecentWorkEvents('telegram.command_menu.registration.rate_limited', COMMAND_REGISTRATION_SUBJECT, new Date(now - COMMAND_REGISTRATION_RATE_LIMIT_TTL_MS), 10)
    .find(event => {
      const retryUntil = Date.parse(String(event.payload?.['retryUntil'] || ''))
      return Number.isFinite(retryUntil) && retryUntil > now
    })
  return Boolean(recentRateLimit)
}

function telegramRetryAfterSeconds(detail: string): number | undefined {
  try {
    const parsed = JSON.parse(detail)
    const retryAfter = Number(parsed?.parameters?.retry_after)
    return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
  } catch {}
  const match = detail.match(/retry[_ ]after["':\s]+(\d+)/i)
  if (!match) return undefined
  const retryAfter = Number(match[1])
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function withTelegramTyping<T>(api: string, chatId: string, threadId: string | undefined, task: () => Promise<T>): Promise<T> {
  let active = true
  const startedAt = Date.now()
  const send = () => sendTelegramChatAction(api, chatId, threadId).catch(recordTelegramTypingFailure)
  await send()
  const timer = setInterval(() => {
    if (!active) return
    if (Date.now() - startedAt >= CHANNEL_ACTION_TYPING_TIMEOUT_MS) {
      clearInterval(timer)
      return
    }
    send()
  }, CHANNEL_ACTION_TYPING_HEARTBEAT_MS)
  try {
    return await task()
  } finally {
    active = false
    clearInterval(timer)
  }
}

async function sendTelegramChatAction(api: string, chatId: string, threadId: string | undefined): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    action: 'typing',
  }
  if (threadId) body['message_thread_id'] = threadId
  const res = await fetchWithTimeout(`${api}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, TELEGRAM_CONTROL_TIMEOUT_MS, 'Telegram sendChatAction')
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${cleanText(await safeResponseText(res), 500)}`)
}

function recordTelegramTypingFailure(err: unknown): void {
  const now = Date.now()
  if (now - lastTypingFailureEventAt < TYPING_FAILURE_EVENT_INTERVAL_MS) return
  lastTypingFailureEventAt = now
  const detail = cleanText((err as any)?.message || String(err), 500)
  queueEvent(`Telegram typing feedback degraded: ${detail}`)
}

async function acknowledgeTelegramCallback(api: string, callbackQueryId: string): Promise<void> {
  await fetchWithTimeout(`${api}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }, TELEGRAM_CONTROL_TIMEOUT_MS, 'Telegram answerCallbackQuery')
}

function mediaTag(mimeType: string | undefined, url: string): string | null {
  if (mimeType?.startsWith('video/')) return `<video src="${escapeAttribute(url)}"></video>`
  if (mimeType?.startsWith('audio/')) return `<audio src="${escapeAttribute(url)}"></audio>`
  if (!mimeType || mimeType.startsWith('image/')) return `<img src="${escapeAttribute(url)}"/>`
  return null
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function sanitizeTelegramText(value: string, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const bounded = maxLength > 0 && text.length > maxLength ? text.substring(0, maxLength) : text
  return redactSecrets(bounded)
}

function redactSecrets(value: string): string {
  const configured = [process.env['TELEGRAM_BOT_TOKEN'], getConfig().channels.telegram.botToken].filter(Boolean) as string[]
  let text = String(value || '')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, 'https://api.telegram.org/bot[redacted]')
  text = redactSensitiveText(text, getConfig())
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/<redacted:\d+ chars>/g, '[redacted]')
  for (const secret of configured) text = text.split(secret).join('[redacted]')
  return text
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

function looksLikeCodeBlock(value: string): boolean {
  return value.trim().startsWith('```') && value.trim().endsWith('```')
}

function stripFence(value: string): string {
  return value.trim().replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim()
}

async function safeResponseText(res: Response): Promise<string> {
  try { return await res.text() } catch { return res.statusText || 'unknown error' }
}

function cleanText(value: string, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const bounded = text.length <= maxLength ? text : text.substring(0, maxLength)
  return redactSecrets(bounded)
}

function isTelegramTargetError(status: number, detail: string): boolean {
  if (status !== 400 && status !== 403) return false
  return isTelegramTargetFailureDetail(detail)
}

function isTelegramTargetFailureDetail(detail: string): boolean {
  return /\b(chat not found|bot was blocked|user is deactivated|message thread not found|not enough rights)\b/i.test(detail)
}

// JOE-996 / H8: Telegram long-poll cursor lives in operational-sidecar.sqlite
// (channel_poll_cursors). Legacy telegram-polling.json is imported once.
const TELEGRAM_POLL_PROVIDER = 'telegram'

function normalizeUpdateId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function loadTelegramUpdateCursor(): number {
  try {
    return loadChannelPollCursor(TELEGRAM_POLL_PROVIDER)
  } catch (err: any) {
    queueEvent(`Telegram polling cursor ignored: ${cleanText(err?.message || String(err), 240)}`)
    return 0
  }
}

function saveTelegramUpdateCursor(updateId: number): void {
  const normalized = normalizeUpdateId(updateId)
  if (!normalized) return
  try {
    saveChannelPollCursor(TELEGRAM_POLL_PROVIDER, normalized)
  } catch (err: any) {
    queueEvent(`Telegram polling cursor write failed: ${cleanText(err?.message || String(err), 240)}`)
  }
}

export const __telegramTest = {
  handleInboundMessage: handleTelegramInboundMessage,
  resetTypingFailureThrottle() {
    lastTypingFailureEventAt = 0
  },
  resetPollingCursorForTest() {
    lastUpdateId = 0
    try { clearChannelPollCursor(TELEGRAM_POLL_PROVIDER) } catch {}
  },
  resetInMemoryPollingCursorForTest() {
    lastUpdateId = 0
  },
  setTransientRetryBackoffForTest(ms = TRANSIENT_RETRY_BACKOFF_MS) {
    transientRetryBackoffMs = ms
  },
  /** Durable operational sidecar path (cursor is a row, not a JSON file). */
  pollingCursorPath: operationalSidecarPath,
  getPollingCursor: loadTelegramUpdateCursor,
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
