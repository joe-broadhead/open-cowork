// A tiny promise-serialization primitive: `createPromiseChain()` returns a
// `runSerially(task)` function that awaits all previously-submitted tasks
// before running the next one. Used by `ensureRuntimeForDirectory` so
// concurrent callers observing different target directories compose
// their reboots in submission order instead of racing the
// `runtimeProjectDirectory` write.
//
// Errors don't break the chain — a failed task's rejection is absorbed by
// the internal `.catch(() => {})` so subsequent tasks still run. The
// rejection still flows back to that task's own awaiter.

export type SerialRunner = <T>(task: () => Promise<T>) => Promise<T>

export function createPromiseChain(): SerialRunner {
  let chain: Promise<unknown> = Promise.resolve()
  return function runSerially<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }
}

export function createSingleFlight() {
  let inflight: Promise<unknown> | null = null
  return function runOnce<T>(task: () => Promise<T>): Promise<T> {
    if (inflight) return inflight as Promise<T>
    inflight = (async () => task())().finally(() => {
      inflight = null
    })
    return inflight as Promise<T>
  }
}

export function createKeyedPromiseChain() {
  const chains = new Map<string, { chain: Promise<unknown>; pending: number }>()
  return function runSeriallyForKey<T>(key: string, task: () => Promise<T>): Promise<T> {
    let state = chains.get(key)
    if (!state) {
      state = { chain: Promise.resolve(), pending: 0 }
      chains.set(key, state)
    }
    state.pending += 1
    const next = state.chain.then(task, task)
    state.chain = next.catch(() => {}).finally(() => {
      state.pending -= 1
      if (state.pending === 0 && chains.get(key) === state) {
        chains.delete(key)
      }
    })
    return next
  }
}
