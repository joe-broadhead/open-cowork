import { sanitizeLogMessage } from '@open-cowork/shared'
const SENSITIVE_AUDIT_FIELD = /token|secret|key|password|credential|ref|ciphertext|envelope/i

// Local filesystem paths that must never leave the org boundary in an export.
// Applied at EXPORT time (not write time — the stored path is legitimately part
// of the audit trail), and skipped only for the explicit, itself-audited
// unredacted admin export.
const LOCAL_PATH_PATTERNS = [
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,
]

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

// Redact local filesystem paths out of a string for the default (redacted) export.
export function redactAuditPathString(value: string): string {
  let redacted = value
  for (const pattern of LOCAL_PATH_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const prefix = match.match(/^(\/Users|\/home|[A-Z]:\\Users)/i)?.[0] || '[home]'
      return `${prefix}/[redacted]`
    })
  }
  return redacted
}

// Export-time redaction of a whole audit record's metadata: secrets are already
// scrubbed at write time (redactAuditMetadata), so this layer strips local
// filesystem paths that are legitimately stored but must not leave the tenant.
export function redactAuditMetadataForExport(value: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [field, entry] of Object.entries(value || {})) {
    redacted[field] = typeof entry === 'string' ? redactAuditPathString(entry) : entry
  }
  return redacted
}
