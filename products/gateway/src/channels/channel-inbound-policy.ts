/**
 * Durable product policy for channel inbound (trust, claims, denial probes).
 * Shared across Telegram / Discord / WhatsApp stacks and monorepo façades
 * (JOE-994 Phase 2–3) so protocol transport can change without forking policy.
 */
import type { ChannelMessage } from './provider.js'
import { getConfig } from '../config.js'
import { queueEvent } from '../wakeup.js'
import { appendChannelInboundDenialAudit } from '../channel-audit.js'
import { acceptChannelClaimFromMessage, acceptChannelDenialProbeFromMessage } from '../channel-claims.js'
import { isPreTrustChannelCommandText } from '../channel-commands.js'
import { isTrustedChannelTarget, redactedChannelTargetLabel } from '../security.js'

export type DurableChannelProviderName = 'telegram' | 'discord' | 'whatsapp'

export type ChannelInboundDelivery = {
  /** Final delivery into the gateway session pipeline (after policy accepts). */
  deliver: (msg: ChannelMessage) => Promise<void>
  /** Optional typing / side-effect wrapper around accepted delivery. */
  withTyping?: (msg: ChannelMessage, task: () => Promise<void>) => Promise<void>
}

export type ChannelInboundPolicyResult =
  | { outcome: 'delivered' }
  | { outcome: 'claim_accepted' }
  | { outcome: 'denial_probe_accepted' }
  | { outcome: 'denied' }
  | { outcome: 'rejected_untrusted' }

/**
 * Apply Durable inbound policy, then deliver accepted messages.
 * Returns a structured outcome so webhook handlers can count handled messages.
 */
export async function processDurableChannelInbound(
  provider: DurableChannelProviderName,
  msg: ChannelMessage,
  delivery: ChannelInboundDelivery,
): Promise<ChannelInboundPolicyResult> {
  const label = providerLabel(provider)
  const chatId = msg.chatId
  const threadId = msg.threadId
  const denialProbe = acceptChannelDenialProbeFromMessage(msg)
  if (denialProbe.status === 'accepted') {
    queueEvent(`${label} denial probe accepted: ${redactedChannelTargetLabel(provider, chatId, threadId)}`)
    return { outcome: 'denial_probe_accepted' }
  }
  if (denialProbe.status === 'denied') return { outcome: 'denied' }
  if (!isTrustedChannelTarget(provider, chatId, threadId, getConfig())) {
    const claim = acceptChannelClaimFromMessage(msg)
    if (claim.status === 'accepted') {
      queueEvent(`${label} claim accepted: ${redactedChannelTargetLabel(provider, chatId, threadId)}`)
      return { outcome: 'claim_accepted' }
    }
    if (claim.status === 'denied') return { outcome: 'denied' }
    if (isPreTrustChannelCommandText(msg.text)) {
      await runDelivery(msg, delivery)
      return { outcome: 'delivered' }
    }
    const target = redactedChannelTargetLabel(provider, chatId, threadId)
    queueEvent(`${label} rejected untrusted inbound: ${target}`)
    safeAuditInboundDenial(provider, chatId, threadId)
    return { outcome: 'rejected_untrusted' }
  }
  // A valid claim code from an already-trusted target heals allowlist rules
  // created before per-sender actor policies existed by merging the claimant
  // into the rule's userIds (see addTrustedTarget in channel-claims).
  const trustedClaim = acceptChannelClaimFromMessage(msg)
  if (trustedClaim.status === 'accepted') {
    queueEvent(`${label} claim accepted: ${redactedChannelTargetLabel(provider, chatId, threadId)}`)
    return { outcome: 'claim_accepted' }
  }
  if (trustedClaim.status === 'denied') return { outcome: 'denied' }

  await runDelivery(msg, delivery)
  return { outcome: 'delivered' }
}

async function runDelivery(msg: ChannelMessage, delivery: ChannelInboundDelivery): Promise<void> {
  if (delivery.withTyping) {
    await delivery.withTyping(msg, () => delivery.deliver(msg))
    return
  }
  await delivery.deliver(msg)
}

function providerLabel(provider: DurableChannelProviderName): string {
  if (provider === 'telegram') return 'Telegram'
  if (provider === 'discord') return 'Discord'
  return 'WhatsApp'
}

function safeAuditInboundDenial(provider: string, chatId: string, threadId?: string): void {
  try { appendChannelInboundDenialAudit({ provider, chatId, threadId }) } catch {}
}
