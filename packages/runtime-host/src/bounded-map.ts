/**
 * Shared Map bound helpers for hot-path caches (JOE-839).
 *
 * Mirrors the existing permission-tracker / runtime-tool-cache pattern:
 * insertion order is FIFO eviction order; re-set deletes first so the key
 * becomes newest (approximate LRU).
 */

export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export function enforceMapMaxSize<K, V>(map: Map<K, V>, maxEntries: number): void {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
