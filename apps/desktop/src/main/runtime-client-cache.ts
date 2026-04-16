type DirectoryClientCacheOptions<T> = {
  baseClient: T | null
  serverUrl: string | null
  directory: string | null
  runtimeHomeDir: string | null
  cache: Map<string, T>
  maxEntries: number
  createClient: (baseUrl: string, directory: string) => T
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
      cache.delete(oldestKey)
    }
  }
  cache.set(directory, scopedClient)
  return scopedClient
}
