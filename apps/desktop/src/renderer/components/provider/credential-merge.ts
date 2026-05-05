export type ProviderCredentialBag = Record<string, string>

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
