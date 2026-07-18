import { appendAuditEvent } from './work-store.js'
import { channelTargetFingerprint, redactedChannelTargetLabel } from './security.js'

export interface ChannelInboundDenialAuditInput {
  provider: string
  chatId: string
  threadId?: string
  reason?: string
}

export function appendChannelInboundDenialAudit(input: ChannelInboundDenialAuditInput): number {
  const provider = input.provider
  const target = redactedChannelTargetLabel(provider, input.chatId, input.threadId)
  const targetHash = channelTargetFingerprint(provider, input.chatId, input.threadId)
  return appendAuditEvent({
    actor: provider,
    source: target,
    operation: 'channel.inbound',
    target,
    result: 'denied',
    details: {
      provider,
      target,
      targetHash,
      reason: input.reason || 'untrusted_target',
      evidence: 'provider-native',
      redacted: true,
    },
  })
}
