type InflightSessionSync<T> = {
  promise: Promise<T>
  queuedForce: boolean
  lastOptions?: Record<string, unknown>
}

export function createSessionSyncCoordinator<T, TOptions extends { force?: boolean } = { force?: boolean }>(
  sync: (sessionId: string, options: Omit<TOptions, 'force'> & { force: boolean }) => Promise<T>,
) {
  const inflight = new Map<string, InflightSessionSync<T>>()

  return function run(sessionId: string, options?: TOptions) {
    const existing = inflight.get(sessionId)
    if (existing) {
      if (options?.force) existing.queuedForce = true
      if (options) existing.lastOptions = { ...existing.lastOptions, ...options }
      return existing.promise
    }

    const pending: InflightSessionSync<T> = {
      promise: Promise.resolve(null as T),
      queuedForce: false,
      lastOptions: options ? { ...options } : undefined,
    }

    pending.promise = (async () => {
      let nextOptions = {
        ...(pending.lastOptions || {}),
        force: Boolean(options?.force),
      } as Omit<TOptions, 'force'> & { force: boolean }
      while (true) {
        const result = await sync(sessionId, nextOptions)
        if (!pending.queuedForce) {
          return result
        }
        pending.queuedForce = false
        nextOptions = {
          ...(pending.lastOptions || {}),
          force: true,
        } as Omit<TOptions, 'force'> & { force: boolean }
      }
    })().finally(() => {
      inflight.delete(sessionId)
    })

    inflight.set(sessionId, pending)
    return pending.promise
  }
}
