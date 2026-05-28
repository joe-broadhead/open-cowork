import { sanitizeChannelText } from './render/sanitize.js'

export type GatewayProviderFailure = {
  transient: boolean
  message: string
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
  return {
    message,
    transient: !permanentPatterns.some((pattern) => pattern.test(message)),
  }
}
