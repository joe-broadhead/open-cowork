/**
 * Canonical secret redaction API for Open Cowork surfaces (audit 2026-07-18).
 *
 * Prefer these helpers over local TOKEN regex forks in gateways and products.
 * Token/path patterns live in log-sanitizer; this module adds record-by-key
 * and length-capped export helpers used by internet-facing gateways.
 */
import { sanitizeForExport, sanitizeLogMessage } from './log-sanitizer.js'

const SECRET_KEY_PATTERN = /token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key|verify[_-]?token|bot[_-]?token/i

/** Redact secrets in free-form text (logs, diagnostics, error messages). */
export function redactSecretText(value: string, maxLength = 8_000): string {
  const cleaned = sanitizeForExport(String(value || ''))
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength)}…[truncated]`
}

/** Lighter redaction for on-disk logs (keeps home paths for local debugging). */
export function redactSecretTextForLog(value: string, maxLength = 8_000): string {
  const cleaned = sanitizeLogMessage(String(value || ''))
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength)}…[truncated]`
}

/**
 * Recursively redact object fields whose keys look like secrets and scrub string
 * values with the export sanitizer.
 */
export function redactSecretRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, redactSecretValue(key, value)]),
  )
}

export function redactSecretValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    if (typeof value === 'string') return value ? `[redacted:${value.length} chars]` : value
    if (value == null) return value
    return '[redacted]'
  }
  if (typeof value === 'string') return redactSecretText(value)
  if (Array.isArray(value)) return value.map((entry) => redactSecretValue(key, entry))
  if (value && typeof value === 'object') return redactSecretRecord(value as Record<string, unknown>)
  return value
}
