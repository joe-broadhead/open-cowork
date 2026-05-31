import type {
  ChannelBindingRecord,
  ChannelDeliveryRecord,
} from './control-plane-store.ts'

export type PublicChannelBindingRecord = Omit<ChannelBindingRecord, 'credentialRef' | 'settings'> & {
  credentialRefConfigured: boolean
  credentialRefKind: 'env' | 'gcp-secret-manager' | 'aws-secrets-manager' | 'azure-key-vault' | 'secret-ref' | null
  settings: Record<string, unknown>
}

export type PublicChannelDeliveryRecord = Omit<ChannelDeliveryRecord, 'target' | 'payload' | 'lastError'> & {
  target: Record<string, unknown>
  payload: Record<string, unknown>
  lastError: string | null
}

function publicCredentialRefKind(ref: string | null | undefined): PublicChannelBindingRecord['credentialRefKind'] {
  const value = ref?.trim()
  if (!value) return null
  if (value.startsWith('env:')) return 'env'
  if (value.startsWith('gcp-sm://')) return 'gcp-secret-manager'
  if (value.startsWith('aws-sm://')) return 'aws-secrets-manager'
  if (value.startsWith('azure-kv://') || isAzureKeyVaultSecretUrl(value)) return 'azure-key-vault'
  return 'secret-ref'
}

function isAzureKeyVaultSecretUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith('.vault.azure.net') && url.pathname.startsWith('/secrets/')
  } catch {
    return false
  }
}

function sanitizePublicString(value: string) {
  return value
    .replace(/\b(?:enc|plain):v1:[A-Za-z0-9_-]+\b/g, '[redacted-secret-envelope]')
    .replace(/\b(?:gcp-sm|aws-sm|azure-kv):\/\/[^\s"'<>]+/gi, '[redacted-secret-ref]')
    .replace(/\bhttps:\/\/[A-Za-z0-9.-]+\.vault\.azure\.net\/secrets\/[^\s"'<>]+/gi, '[redacted-secret-ref]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|password|credential|api[_-]?key|kms[_-]?ref|ciphertext)\s*[:=]\s*['"]?[^'",}\s]+['"]?/gi, (match) => {
      const separator = match.includes(':') ? ':' : '='
      return `${match.split(separator)[0]}${separator}[redacted]`
    })
    .replace(/\boc(?:c|gw)_[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[redacted]')
    .slice(0, 512)
}

function sanitizePublicJson(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[redacted-depth]'
  if (typeof value === 'string') return sanitizePublicString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitizePublicJson(entry, depth + 1))
  if (!value || typeof value !== 'object') return null
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.slice(0, 128)
    if (/(authorization|cookie|token|secret|password|credential|api[_-]?key|kms[_-]?ref|ciphertext|envelope)$/i.test(normalizedKey)) {
      result[normalizedKey] = '[redacted]'
    } else {
      result[normalizedKey] = sanitizePublicJson(entry, depth + 1)
    }
  }
  return result
}

export function publicChannelBinding(binding: ChannelBindingRecord): PublicChannelBindingRecord {
  const { credentialRef, settings, ...publicBinding } = binding
  return {
    ...publicBinding,
    credentialRefConfigured: Boolean(credentialRef),
    credentialRefKind: publicCredentialRefKind(credentialRef),
    settings: sanitizePublicJson(settings) as Record<string, unknown>,
  }
}

export function publicChannelDelivery(delivery: ChannelDeliveryRecord): PublicChannelDeliveryRecord {
  return {
    ...delivery,
    target: sanitizePublicJson(delivery.target) as Record<string, unknown>,
    payload: sanitizePublicJson(delivery.payload) as Record<string, unknown>,
    lastError: delivery.lastError ? sanitizePublicString(delivery.lastError) : null,
  }
}
