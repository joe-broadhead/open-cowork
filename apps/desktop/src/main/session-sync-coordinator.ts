type InflightSessionSync<T> = {
  promise: Promise<T>
  queuedForce: boolean
}

export function createSessionSyncCoordinator<T>(
  sync: (sessionId: string, options: { force: boolean }) => Promise<T>,
) {
  const inflight = new Map<string, InflightSessionSync<T>>()

  return function run(sessionId: string, options?: { force?: boolean }) {
    const existing = inflight.get(sessionId)
    if (existing) {
      if (options?.force) existing.queuedForce = true
      return existing.promise
    }

    const pending: InflightSessionSync<T> = {
      promise: Promise.resolve(null as T),
      queuedForce: false,
    }

    pending.promise = (async () => {
      let force = Boolean(options?.force)
      while (true) {
        const result = await sync(sessionId, { force })
        if (!pending.queuedForce) {
          return result
        }
        pending.queuedForce = false
        force = true
      }
    })().finally(() => {
      inflight.delete(sessionId)
    })

    inflight.set(sessionId, pending)
    return pending.promise
  }
}
