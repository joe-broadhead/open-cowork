/**
 * Durable product policy for Telegram inbound (trust, claims, denial probes).
 * Shared by the legacy Durable poll loop and the monorepo-provider façade
 * (JOE-994 Phase 2) so protocol transport can change without forking policy.
 */
import type { ChannelMessage } from './provider.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'
import { acceptChannelClaimFromMessage, acceptChannelDenialProbeFromMessage } from '../channel-claims.js'
import { isPreTrustChannelCommandText } from '../channel-commands.js'
import { isTrustedChannelTarget, redactedChannelTargetLabel } from '../security.js'

export type TelegramInboundDelivery = {
  /** Final delivery into the gateway session pipeline (after policy accepts). */
  deliver: (msg: ChannelMessage) => Promise<void>
  /**
   * Optional typing wrapper (legacy uses sendChatAction heartbeat; monorepo
   * path can use TelegramProvider.setTyping).
   */
  withTyping?: (msg: ChannelMessage, task: () => Promise<void>) => Promise<void>
}

/**
 * Apply Durable Telegram inbound policy, then deliver accepted messages.
 * Returns without calling deliver when the message is a claim/probe/denial.
 */
export async function processDurableTelegramInbound(
  msg: ChannelMessage,
  delivery: TelegramInboundDelivery,
): Promise<void> {
  const chatId = msg.chatId
  const threadId = msg.threadId
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
      await delivery.deliver(msg)
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

  if (delivery.withTyping) {
    await delivery.withTyping(msg, () => delivery.deliver(msg))
    return
  }
  await delivery.deliver(msg)
}

function safeAuditInboundDenial(provider: string, chatId: string, threadId?: string): void {
  try { appendChannelInboundDenialAudit({ provider, chatId, threadId }) } catch {}
}
