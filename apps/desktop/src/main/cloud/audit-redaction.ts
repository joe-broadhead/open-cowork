import { sanitizeLogMessage } from '../log-sanitizer.ts'

const SENSITIVE_AUDIT_FIELD = /token|secret|key|password|credential|ref|ciphertext|envelope/i

export function redactAuditMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [field, entry] of Object.entries(value || {})) {
    if (SENSITIVE_AUDIT_FIELD.test(field)) {
      redacted[field] = '[redacted]'
    } else if (entry && typeof entry === 'object') {
      redacted[field] = '[object]'
    } else if (typeof entry === 'string') {
      const sanitized = sanitizeLogMessage(entry)
        .replace(/\b(?:enc|plain):v1:[A-Za-z0-9_-]+\b/g, '[REDACTED_SECRET]')
        .replace(/\b(?:gcp-sm|aws-sm|azure-kv):\/\/[^\s"'<>]+/gi, '[REDACTED_SECRET_REF]')
        .replace(/\bhttps:\/\/[A-Za-z0-9.-]+\.vault\.azure\.net\/secrets\/[^\s"'<>]+/gi, '[REDACTED_SECRET_REF]')
      redacted[field] = sanitized.length > 256 ? `${sanitized.slice(0, 253)}...` : sanitized
    } else {
      redacted[field] = entry
    }
  }
  return redacted
}
