import {
  isRetryableWebhookDeliveryError,
  WebhookCircuitOpenError,
  WebhookDeliveryBodyError,
  WebhookDeliveryPolicyError,
} from '@open-cowork/gateway-provider-webhook'
import { sanitizeChannelText } from './render/sanitize.js'

export type GatewayProviderFailure = {
  transient: boolean
  message: string
  retryAfterMs?: number
}

const permanentPatterns = [
  /does not support/i,
  /unsupported/i,
  /exceeds .*limit/i,
  /exceeds provider/i,
  /invalid/i,
  /malformed/i,
  /too large/i,
]

export function classifyProviderFailure(error: unknown): GatewayProviderFailure {
  const raw = error instanceof Error ? error.message : String(error)
  const message = sanitizeChannelText(raw || 'Provider delivery failed.', 320)
  if (isRetryableWebhookDeliveryError(error)) {
    return {
      message,
      transient: true,
      retryAfterMs: error instanceof WebhookCircuitOpenError ? Math.max(0, error.retryAfterMs) : undefined,
    }
  }
  if (error instanceof WebhookDeliveryPolicyError || error instanceof WebhookDeliveryBodyError) {
    return {
      message,
      transient: false,
    }
  }
  return {
    message,
    transient: !permanentPatterns.some((pattern) => pattern.test(message)),
  }
}
