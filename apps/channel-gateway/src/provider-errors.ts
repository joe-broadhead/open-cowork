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

// Allowlist of KNOWN-transient signals — network/timeout/429/5xx.
const transientPatterns = [
  /\btimed?\s?-?\s?out\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bECONNABORTED\b/i,
  /\bEAI_AGAIN\b/i,
  /\bEPIPE\b/i,
  /socket hang ?up/i,
  /\b429\b/,
  /too many requests/i,
  /\brate.?limit/i,
  /\b5\d{2}\b/,
  /service unavailable/i,
  /bad gateway/i,
  /temporar(?:y|ily)/i,
  /try again/i,
]

// `defaultTransient` decides how an UNKNOWN error (matching neither list) is treated (audit P2-16):
// - The outbound delivery/send path passes false: a non-webhook send carries no idempotency key, so
//   retrying an ambiguous failure after a partial/multi-chunk send can DUPLICATE a user-visible
//   message — only an explicit transient signal earns a retry.
// - The session-render path passes true: re-rendering is idempotent (cursor-gated), so a transient
//   provider outage should be retried rather than silently dropping the event.
export function classifyProviderFailure(error: unknown, options: { defaultTransient?: boolean } = {}): GatewayProviderFailure {
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
  // Match the raw error text (codes survive un-sanitized). Known signals win; unknown falls back to
  // the caller's default (false for outbound sends, true for idempotent re-render).
  const transient = transientPatterns.some((pattern) => pattern.test(raw))
    ? true
    : permanentPatterns.some((pattern) => pattern.test(raw))
      ? false
      : (options.defaultTransient ?? false)
  return { message, transient }
}
