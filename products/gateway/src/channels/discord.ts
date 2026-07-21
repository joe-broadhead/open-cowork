import type { ChannelAdapter, ChannelMessage } from './provider.js'
import { verifyDiscordInteractionSignature } from '@open-cowork/shared/node'
import { DISCORD_ALPHA_CAPABILITIES, discordAdapterCapabilities } from './capabilities.js'
import { planNativeActionDelivery, renderStructuredMessage, type ChannelCapabilities, type MessageAction, type NativeActionDeliveryItem, type RichMessageBlock, type StructuredGatewayMessage } from './renderer.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'
import { allowsAllChannelTargets, hasChannelAllowlist, isTrustedChannelTarget, redactSensitiveText, redactedChannelTargetLabel } from '../security.js'
import { acceptChannelClaimFromMessage, acceptChannelDenialProbeFromMessage } from '../channel-claims.js'
import { isPreTrustChannelCommandText } from '../channel-commands.js'
import { fetchWithTimeout } from '../deadlines.js'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_CONTENT_LIMIT = 2000
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096
const DISCORD_FIELD_LIMIT = 25
const DISCORD_CUSTOM_ID_LIMIT = 100
const DISCORD_COMPONENT_ROW_LIMIT = 5
const DISCORD_COMPONENTS_PER_ROW = 5
const DISCORD_INTERACTION_MAX_SKEW_MS = 5 * 60 * 1000
const DISCORD_API_TIMEOUT_MS = 10_000

let handler: ((msg: ChannelMessage) => Promise<void>) | null = null
let started = false

export interface DiscordConfig {
  enabled: boolean
  botToken: string
  applicationId: string
  publicKey: string
  richMessagesEnabled: boolean
}

export interface DiscordInteractionResponse {
  status: number
  body: Record<string, unknown>
}

export interface DiscordReadiness {
  configured: boolean
  enabled: boolean
  botTokenConfigured: boolean
  publicKeyConfigured: boolean
  trusted: boolean
  unsafeAllowAll: boolean
  ready: boolean
  issues: string[]
  summary: string
}

export const discordChannel: ChannelAdapter & {
  isEnabled(): boolean
  readiness(): DiscordReadiness
  verifyInteractionSignature(signatureHeader: string | string[] | undefined, timestampHeader: string | string[] | undefined, rawBody: string): boolean
  handleInteraction(rawBody: string, headers?: Record<string, string | string[] | undefined>): Promise<DiscordInteractionResponse>
  handleGatewayEvent(payload: any): Promise<number>
} = {
  name: 'discord',
  get capabilities() {
    return discordCapabilities()
  },

  isEnabled() {
    return getDiscordConfig().enabled
  },

  readiness() {
    return getDiscordReadiness()
  },

  async start() {
    const cfg = getDiscordConfig()
    const readiness = getDiscordReadiness()
    if (!cfg.enabled) {
      console.error('[discord] alpha channel disabled; set channels.discord.enabled=true or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true to enable')
      return
    }
    if (!cfg.botToken) {
      console.error('[discord] bot token not set; alpha channel disabled')
      queueEvent('Discord alpha channel disabled: bot token is missing.')
      return
    }
    for (const issue of readiness.issues.filter(issue => !/bot token/i.test(issue))) queueEvent(`Discord alpha config warning: ${issue}`)

    try {
      const res = await fetchWithTimeout(`${DISCORD_API}/users/@me`, { headers: discordHeaders(cfg.botToken) }, DISCORD_API_TIMEOUT_MS, 'Discord users/@me')
      const body = await safeJson(res)
      if (!res.ok) {
        const detail = redactSensitiveText(cleanText(JSON.stringify(body) || res.statusText, 500), getConfig())
        console.error(`[discord] startup failed: ${detail}`)
        queueEvent(`Discord startup failed: ${detail}`)
        return
      }
      const username = cleanText(String((body as any)?.username || (body as any)?.id || 'bot'), 128)
      started = true
      console.error(`[discord] Alpha bot ${username} ready`)
      queueEvent(`Discord alpha channel ready: ${username}`)
    } catch (err: any) {
      const detail = redactSensitiveText(cleanText(err?.message || String(err), 500), getConfig())
      console.error(`[discord] startup failed: ${detail}`)
      queueEvent(`Discord startup failed: ${detail}`)
    }
  },

  async stop() {
    started = false
  },

  async sendMessage(chatId: string, text: string, options?: { threadId?: string; idempotencyKey?: string }) {
    const cfg = getDiscordConfig()
    assertDiscordOutboundConfigured(cfg)
    await sendDiscordMessage(targetChannelId(chatId, options?.threadId), { content: chunkDiscordText(text) }, cfg)
  },

  async sendStructuredMessage(chatId: string, message: StructuredGatewayMessage, options?: { threadId?: string }) {
    const capabilities = discordCapabilities()
    const rendered = renderStructuredMessage(message, capabilities)
    if (rendered.mode !== 'rich') {
      await this.sendMessage(chatId, rendered.text, options)
      return
    }

    const payload = buildDiscordMessagePayload(message)
    if (!payload.embeds?.length && !payload.components?.length) {
      await this.sendMessage(chatId, rendered.markdown || rendered.plainText, options)
      return
    }

    try {
      await sendDiscordMessage(targetChannelId(chatId, options?.threadId), payload, getDiscordConfig())
    } catch (err: any) {
      const detail = redactSensitiveText(cleanText(err?.message || String(err), 500), getConfig())
      queueEvent(`Discord rich send degraded: ${detail}`)
      await this.sendMessage(chatId, rendered.markdown || rendered.plainText, options)
    }
  },

  async sendCommandMenu(chatId: string, text: string, actions: Array<{ label: string; command: string; description?: string }>, options?: { threadId?: string }) {
    const components = buildDiscordActionRows(actions.map(action => ({ label: action.label, command: action.command })))
    if (!components.length) {
      await this.sendMessage(chatId, commandMenuFallback(text, actions), options)
      return
    }

    try {
      await sendDiscordMessage(targetChannelId(chatId, options?.threadId), {
        content: chunkDiscordText(text),
        components,
      }, getDiscordConfig())
    } catch (err: any) {
      const detail = redactSensitiveText(cleanText(err?.message || String(err), 500), getConfig())
      queueEvent(`Discord command menu fallback: ${detail}`)
      await this.sendMessage(chatId, commandMenuFallback(text, actions), options)
    }
  },

  onMessage(h: (msg: ChannelMessage) => Promise<void>) {
    handler = h
  },

  verifyInteractionSignature(signatureHeader: string | string[] | undefined, timestampHeader: string | string[] | undefined, rawBody: string): boolean {
    const cfg = getDiscordConfig()
    const signature = headerValue(signatureHeader)
    const timestamp = headerValue(timestampHeader)
    if (!cfg.enabled || !cfg.publicKey || !signature || !timestamp) return false
    if (!isFreshDiscordTimestamp(timestamp)) return false
    return verifyDiscordSignature(cfg.publicKey, signature, timestamp, rawBody)
  },

  async handleInteraction(rawBody: string, headers: Record<string, string | string[] | undefined> = {}) {
    const signedTimestamp = headerValue(headers['x-signature-timestamp'])
    if (!this.verifyInteractionSignature(headers['x-signature-ed25519'], signedTimestamp, rawBody)) {
      return { status: 401, body: { error: 'invalid discord signature' } }
    }
    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return { status: 400, body: { error: 'invalid discord payload' } }
    }
    if (payload?.type === 1) return { status: 200, body: { type: 1 } }

    const text = interactionText(payload)
    if (!text) return { status: 200, body: interactionAck('Unsupported Discord interaction.') }
    const accepted = await acceptDiscordInbound(discordMessageFromInteraction(payload, text, signedTimestamp), { waitForHandler: false })
    if (!accepted) return { status: 200, body: interactionAck('Discord action rejected by Gateway trust policy.') }
    return { status: 200, body: interactionAck('Received.') }
  },

  async handleGatewayEvent(payload: any) {
    if (payload?.t !== 'MESSAGE_CREATE' && payload?.type !== 'MESSAGE_CREATE') return 0
    const data = payload?.d || payload
    const msg = discordMessageFromCreate(data)
    if (!msg || data?.author?.bot === true) return 0
    return await acceptDiscordInbound(msg, { waitForHandler: true }) ? 1 : 0
  },
}

export function getDiscordConfig(): DiscordConfig {
  const config = getConfig()
  const cfg = config.channels.discord || { enabled: false }
  const enabled = process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true' || cfg.enabled === true
  return {
    enabled,
    botToken: process.env['DISCORD_BOT_TOKEN'] || cfg.botToken || '',
    applicationId: process.env['DISCORD_APPLICATION_ID'] || cfg.applicationId || '',
    publicKey: process.env['DISCORD_PUBLIC_KEY'] || cfg.publicKey || '',
    richMessagesEnabled: config.channels.richMessages.enabled !== false && cfg.richMessages?.enabled !== false,
  }
}

export function getDiscordReadiness(): DiscordReadiness {
  const config = getConfig()
  const cfg = config.channels.discord || { enabled: false }
  const enabled = process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true' || cfg.enabled === true
  const botTokenConfigured = Boolean(process.env['DISCORD_BOT_TOKEN'] || cfg.botToken)
  const publicKeyConfigured = Boolean(process.env['DISCORD_PUBLIC_KEY'] || cfg.publicKey)
  const applicationConfigured = Boolean(process.env['DISCORD_APPLICATION_ID'] || cfg.applicationId)
  const configured = enabled || botTokenConfigured || publicKeyConfigured || applicationConfigured
  const trusted = hasChannelAllowlist('discord', config) || allowsAllChannelTargets('discord', config)
  const unsafeAllowAll = allowsAllChannelTargets('discord', config)
  const issues: string[] = []
  if (!configured) {
    issues.push('Discord alpha credentials are not configured; adapter disabled.')
  } else if (!enabled) {
    issues.push('Discord alpha is configured but disabled; set channels.discord.enabled=true or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true.')
  } else {
    if (!botTokenConfigured) issues.push('Discord bot token is missing; outbound notifications stay disabled.')
    if (!publicKeyConfigured) issues.push('Discord public key is missing; signed interaction webhooks are rejected.')
    if (!trusted) issues.push('No Discord channel allowlist is configured; inbound targets fail closed.')
    if (unsafeAllowAll) issues.push('Unsafe Discord allow-all override is enabled; rotate to explicit allowlists before promotion.')
  }
  const ready = configured && enabled && botTokenConfigured && publicKeyConfigured && trusted && !unsafeAllowAll
  return {
    configured,
    enabled,
    botTokenConfigured,
    publicKeyConfigured,
    trusted,
    unsafeAllowAll,
    ready,
    issues,
    summary: ready ? 'Discord alpha configured with explicit trust and signed interactions.' : issues[0] || 'Discord alpha adapter disabled.',
  }
}

export function buildDiscordMessagePayload(message: StructuredGatewayMessage): { content: string; embeds?: any[]; components?: any[] } {
  const rendered = renderStructuredMessage(message, DISCORD_ALPHA_CAPABILITIES)
  const embed = buildDiscordEmbed(message)
  const components = buildDiscordActionRows(message.actions || [])
  const payload: { content: string; embeds?: any[]; components?: any[] } = {
    content: chunkDiscordText(message.summary || rendered.markdown || rendered.plainText),
  }
  if (embed) payload.embeds = [embed]
  if (components.length) payload.components = components
  return payload
}

export function buildDiscordActionRows(actions: MessageAction[]): any[] {
  const buttons = planNativeActionDelivery(actions, {
    maxActions: DISCORD_COMPONENT_ROW_LIMIT * DISCORD_COMPONENTS_PER_ROW,
    maxLabelChars: 80,
    maxIdentifierChars: DISCORD_CUSTOM_ID_LIMIT,
    urlMode: 'native',
  }).actions
    .map(action => discordButton(action))
    .filter((button): button is Record<string, unknown> => Boolean(button))
  const rows = []
  for (let i = 0; i < buttons.length && rows.length < DISCORD_COMPONENT_ROW_LIMIT; i += DISCORD_COMPONENTS_PER_ROW) {
    rows.push({ type: 1, components: buttons.slice(i, i + DISCORD_COMPONENTS_PER_ROW) })
  }
  return rows
}

export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, rawBody: string): boolean {
  return verifyDiscordInteractionSignature(publicKeyHex, signatureHex, timestamp, rawBody)
}

function isFreshDiscordTimestamp(timestamp: string): boolean {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return false
  return Math.abs(Date.now() - seconds * 1000) <= DISCORD_INTERACTION_MAX_SKEW_MS
}

function discordCapabilities(): ChannelCapabilities {
  const cfg = getDiscordConfig()
  return discordAdapterCapabilities({ enabled: cfg.enabled, richMessagesEnabled: cfg.richMessagesEnabled })
}

async function sendDiscordMessage(channelId: string, payload: Record<string, unknown>, cfg: DiscordConfig): Promise<void> {
  assertDiscordOutboundConfigured(cfg)
  const res = await fetchWithTimeout(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: discordHeaders(cfg.botToken),
    body: JSON.stringify(payload),
  }, DISCORD_API_TIMEOUT_MS, 'Discord sendMessage')
  if (!res.ok) throw new Error(`Discord send failed: HTTP ${res.status}: ${cleanText(await safeResponseText(res), 500)}`)
}

function assertDiscordOutboundConfigured(cfg: DiscordConfig): void {
  if (!cfg.enabled) throw new Error('Discord outbound delivery is not configured: alpha channel is disabled')
  if (!cfg.botToken) throw new Error('Discord outbound delivery is not configured: bot token is missing')
}

async function acceptDiscordInbound(message: ChannelMessage | null, options: { waitForHandler?: boolean } = {}): Promise<boolean> {
  if (!message || !handler) return false
  if (!getDiscordConfig().enabled) return false
  if (!started) started = true
  const denialProbe = acceptChannelDenialProbeFromMessage(message)
  if (denialProbe.status === 'accepted') {
    queueEvent(`Discord denial probe accepted: ${redactedChannelTargetLabel('discord', message.chatId, message.threadId)}`)
    return true
  }
  if (denialProbe.status === 'denied') return false
  if (!isTrustedChannelTarget('discord', message.chatId, message.threadId, getConfig())) {
    const claim = acceptChannelClaimFromMessage(message)
    if (claim.status === 'accepted') {
      queueEvent(`Discord claim accepted: ${redactedChannelTargetLabel('discord', message.chatId, message.threadId)}`)
      return true
    }
    if (claim.status === 'denied') return false
    if (isPreTrustChannelCommandText(message.text)) {
      if (options.waitForHandler === false) dispatchDiscordInbound(message)
      else await handler(message)
      return true
    }
    const target = redactedChannelTargetLabel('discord', message.chatId, message.threadId)
    queueEvent(`Discord rejected untrusted inbound: ${target}`)
    safeAuditInboundDenial('discord', message.chatId, message.threadId)
    return false
  }
  // A valid claim code from an already-trusted target heals allowlist rules
  // created before per-sender actor policies existed by merging the claimant
  // into the rule's userIds (see addTrustedTarget in channel-claims). This is
  // the only in-band recovery path for a legacy Discord DM rule, whose channel
  // id never equals the author id and so cannot satisfy the DM actor fallback.
  const trustedClaim = acceptChannelClaimFromMessage(message)
  if (trustedClaim.status === 'accepted') {
    queueEvent(`Discord claim accepted: ${redactedChannelTargetLabel('discord', message.chatId, message.threadId)}`)
    return true
  }
  if (trustedClaim.status === 'denied') return false
  if (options.waitForHandler === false) dispatchDiscordInbound(message)
  else await handler(message)
  return true
}

function dispatchDiscordInbound(message: ChannelMessage): void {
  const currentHandler = handler
  if (!currentHandler) return
  Promise.resolve()
    .then(() => currentHandler(message))
    .catch(err => {
      const detail = redactSensitiveText(cleanText(err?.message || String(err), 500), getConfig())
      queueEvent(`Discord inbound handler failed: ${detail}`)
    })
}

function discordMessageFromCreate(message: any): ChannelMessage | null {
  const text = cleanText(String(message?.content || ''), 4000)
  const userId = message?.author?.id ? String(message.author.id) : ''
  const target = discordTargetFromPayload(message)
  const chatId = target.chatId
  if (!text || !userId || !chatId) return null
  return {
    provider: 'discord',
    chatId,
    threadId: target.threadId,
    messageId: message?.id ? String(message.id) : undefined,
    userId,
    text,
    attachments: discordAttachments(message?.attachments),
    timestamp: message?.timestamp ? new Date(message.timestamp).toISOString() : new Date().toISOString(),
  }
}

function discordMessageFromInteraction(payload: any, text: string, signedTimestamp?: string): ChannelMessage {
  const target = discordTargetFromPayload(payload)
  return {
    provider: 'discord',
    chatId: target.chatId,
    threadId: target.threadId,
    messageId: payload?.id ? String(payload.id) : undefined,
    userId: String(payload?.member?.user?.id || payload?.user?.id || 'unknown'),
    text,
    attachments: [],
    timestamp: discordTimestampIso(signedTimestamp),
  }
}

function discordTimestampIso(timestamp?: string): string {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString()
  return new Date(seconds * 1000).toISOString()
}

function discordTargetFromPayload(payload: any): { chatId: string; threadId?: string } {
  const channelId = optionalString(payload?.channel_id || payload?.message?.channel_id || payload?.channel?.id)
  const explicitThreadId = optionalString(payload?.thread_id || payload?.message?.thread_id || payload?.thread?.id)
  const parentId = optionalString(payload?.parent_id || payload?.channel?.parent_id || payload?.message?.channel?.parent_id)
  if (explicitThreadId) return { chatId: channelId, threadId: explicitThreadId }
  if (parentId && channelId && parentId !== channelId) return { chatId: parentId, threadId: channelId }
  return { chatId: channelId }
}

function interactionText(payload: any): string {
  if (payload?.type === 3) return cleanText(String(payload?.data?.custom_id || ''), 4000)
  if (payload?.type === 2 && payload?.data?.name) {
    const options = (payload.data.options || []).map((option: any) => `${option.name}:${option.value}`).join(' ')
    return cleanText(`/${payload.data.name}${options ? ` ${options}` : ''}`, 4000)
  }
  return ''
}

function interactionAck(content: string): Record<string, unknown> {
  return { type: 4, data: { content, flags: 64 } }
}

function buildDiscordEmbed(message: StructuredGatewayMessage): any | null {
  const embed: any = {
    title: cleanText(message.title, 256),
    description: cleanText(message.summary || '', DISCORD_EMBED_DESCRIPTION_LIMIT),
    color: discordColor(message.severity),
    fields: [],
  }
  for (const block of message.blocks) appendDiscordBlock(embed, block)
  if (!embed.description && !embed.fields.length && !embed.image) return null
  embed.fields = embed.fields.slice(0, DISCORD_FIELD_LIMIT)
  if (!embed.fields.length) delete embed.fields
  if (!embed.description) delete embed.description
  return embed
}

function appendDiscordBlock(embed: any, block: RichMessageBlock): void {
  if (block.type === 'heading') {
    appendDescription(embed, `**${cleanText(block.text, 256)}**`)
    return
  }
  if (block.type === 'text') {
    appendDescription(embed, cleanText(block.text, 1024))
    return
  }
  if (block.type === 'facts') {
    for (const fact of block.facts) {
      embed.fields.push({ name: cleanText(fact.label, 256), value: cleanText(fact.value, 1024) || '-', inline: true })
    }
    return
  }
  if (block.type === 'table') {
    const header = block.columns.join(' | ')
    const separator = block.columns.map(() => '---').join(' | ')
    const rows = block.rows.slice(0, 10).map(row => row.map(cell => cleanText(cell, 80)).join(' | '))
    embed.fields.push({ name: 'Table', value: codeBlock([header, separator, ...rows].join('\n'), 1024), inline: false })
    return
  }
  if (block.type === 'details') {
    embed.fields.push({ name: cleanText(block.title, 256), value: cleanText(block.body, 1024) || '-', inline: false })
    return
  }
  if (block.type === 'media') {
    const url = safeHttpUrl(block.url)
    if (url && (!block.mimeType || block.mimeType.startsWith('image/'))) embed.image = { url }
    else if (url) embed.fields.push({ name: cleanText(block.alt || 'Media', 256), value: url, inline: false })
    return
  }
  if (block.type === 'divider') appendDescription(embed, '---')
}

function discordButton(action: NativeActionDeliveryItem): Record<string, unknown> | null {
  if (action.kind === 'url') return { type: 2, style: 5, label: action.label, url: action.identifier }
  if (action.kind !== 'callback') return null
  return { type: 2, style: discordButtonStyle(action.style), label: action.label, custom_id: action.identifier }
}

function discordButtonStyle(style: MessageAction['style']): number {
  if (style === 'primary') return 1
  if (style === 'danger') return 4
  return 2
}

function discordAttachments(value: any): ChannelMessage['attachments'] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => ({ name: String(item?.filename || item?.id || 'attachment'), url: String(item?.url || ''), mimeType: String(item?.content_type || 'application/octet-stream') }))
    .filter(item => item.url)
}

function targetChannelId(chatId: string, threadId?: string): string {
  return String(threadId || chatId)
}

function discordHeaders(botToken: string): Record<string, string> {
  return { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }
}

function commandMenuFallback(text: string, actions: Array<{ label: string; command: string }>): string {
  return [text, ...actions.map(action => `- ${action.label}: ${action.command}`)].join('\n')
}

function appendDescription(embed: any, text: string): void {
  const next = [embed.description, text].filter(Boolean).join('\n\n')
  embed.description = cleanText(next, DISCORD_EMBED_DESCRIPTION_LIMIT)
}

function codeBlock(value: string, maxLength: number): string {
  const text = cleanText(value, Math.max(0, maxLength - 8))
  return `\`\`\`\n${text}\n\`\`\``
}

function chunkDiscordText(text: string): string {
  return cleanText(text || ' ', DISCORD_CONTENT_LIMIT)
}

function cleanText(value: string, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ch => ch === '\n' ? '\n' : ' ').trim()
  return text.length <= maxLength ? text : text.substring(0, maxLength)
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function discordColor(severity: StructuredGatewayMessage['severity']): number {
  if (severity === 'critical') return 0xd73a49
  if (severity === 'warning') return 0xf9c513
  if (severity === 'success') return 0x2ea043
  return 0x5865f2
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function optionalString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

async function safeJson(res: Response): Promise<unknown> {
  try { return await res.json() } catch { return {} }
}

async function safeResponseText(res: Response): Promise<string> {
  try { return await res.text() } catch { return res.statusText || 'unknown error' }
}

function safeAuditInboundDenial(provider: string, chatId: string, threadId?: string): void {
  try { appendChannelInboundDenialAudit({ provider, chatId, threadId }) } catch {}
}
