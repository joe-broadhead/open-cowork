type ProviderCredentialBag = Record<string, string>

export const CREDENTIAL_MASK = '••••••••'

export function isCredentialMask(value: string | null | undefined) {
  return value === CREDENTIAL_MASK
}

export function credentialFieldIsSecret(credential: { secret?: boolean }) {
  return credential.secret !== false
}

export function mergeFetchedProviderCredentials(
  current: ProviderCredentialBag | undefined,
  fetched: ProviderCredentialBag,
  dirtyKeys: ReadonlySet<string> | undefined,
): ProviderCredentialBag {
  if (!dirtyKeys?.size) return fetched
  const next: ProviderCredentialBag = { ...fetched }
  for (const key of dirtyKeys) {
    const value = current?.[key]
    if (value !== undefined) next[key] = value
  }
  return next
}

export function stripMaskedProviderCredentials(
  credentials: Record<string, ProviderCredentialBag>,
): Record<string, ProviderCredentialBag> {
  const next: Record<string, ProviderCredentialBag> = {}
  for (const [providerId, values] of Object.entries(credentials)) {
    const clean: ProviderCredentialBag = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === CREDENTIAL_MASK) continue
      clean[key] = value
    }
    next[providerId] = clean
  }
  return next
}
