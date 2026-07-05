// Single source for scrubbing secrets out of operational/audit text (channel delivery
// errors, managed-worker error summaries, provider-event errors) before it is persisted
// in the control plane. Previously copy-pasted across the postgres + in-memory store
// domains (8 copies that had begun to drift); a single definition keeps the redaction
// rules from diverging silently on one code path.
//
// Redacts: Bearer tokens, api-key/token/secret/password/authorization=value, secret-manager
// refs (gcp-sm/aws-sm/azure-kv/env:), sk-/occ_/ocw_ tokens, and any remaining 32+ char
// high-entropy run. The trailing generic rule is the catch-all that covers provider keys
// without per-provider patterns. Truncates (with an ellipsis) rather than throwing on
// over-length text, so a long error summary can never fail the surrounding write.
export function redactOperationalText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const redacted = value.trim()
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9._-]{6,}|oc[wc]_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength <= 3 ? maxLength : maxLength - 3)}${maxLength <= 3 ? '' : '...'}`
}
