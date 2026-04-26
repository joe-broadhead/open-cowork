type DirectoryClientCacheOptions<T> = {
  baseClient: T | null
  serverUrl: string | null
  directory: string | null
  runtimeHomeDir: string | null
  cache: Map<string, T>
  maxEntries: number
  createClient: (baseUrl: string, directory: string) => T
  onCreate?: (client: T, directory: string) => void
  onEvict?: (client: T, directory: string) => void
}

export function getOrCreateDirectoryClient<T>(
  options: DirectoryClientCacheOptions<T>,
): T | null {
  const {
    baseClient,
    serverUrl,
    directory,
    runtimeHomeDir,
    cache,
    maxEntries,
    createClient,
    onCreate,
    onEvict,
  } = options

  if (!baseClient) return null
  if (!directory || directory === runtimeHomeDir) return baseClient

  const existing = cache.get(directory)
  if (existing) {
    cache.delete(directory)
    cache.set(directory, existing)
    return existing
  }

  if (!serverUrl) return baseClient

  const scopedClient = createClient(serverUrl, directory)
  if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) {
      const evicted = cache.get(oldestKey)
      cache.delete(oldestKey)
      if (evicted) onEvict?.(evicted, oldestKey)
    }
  }
  cache.set(directory, scopedClient)
  onCreate?.(scopedClient, directory)
  return scopedClient
}
