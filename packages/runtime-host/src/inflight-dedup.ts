// In-flight promise dedup keyed by string. Concurrent callers for the same
// key share a single promise; once it settles (fulfilled or rejected) the
// key is cleared so the next call can start a new unit of work.
//
// Used by the dynamic provider-catalog refresh path so repeated
// synchronous reads of `getProviderDescriptors()` during boot don't
// trigger parallel HTTPS fetches to the same catalog URL. Kept in its
// own file so tests can exercise the concurrency contract without
// pulling the Electron-dependent config-loader transitively.
export function dedupByKey<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing
  const promise = (async () => {
    try {
      return await run()
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, promise)
  return promise
}
