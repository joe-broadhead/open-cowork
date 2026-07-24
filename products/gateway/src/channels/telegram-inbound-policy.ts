/**
 * Telegram-specific re-export of shared Durable inbound policy (JOE-994).
 * Prefer `channel-inbound-policy.ts` for new call sites.
 */
import {
  processDurableChannelInbound,
  type ChannelInboundDelivery,
} from './channel-inbound-policy.js'
import type { ChannelMessage } from './provider.js'

export type TelegramInboundDelivery = ChannelInboundDelivery

export async function processDurableTelegramInbound(
  msg: ChannelMessage,
  delivery: TelegramInboundDelivery,
): Promise<void> {
  await processDurableChannelInbound('telegram', msg, delivery)
}
