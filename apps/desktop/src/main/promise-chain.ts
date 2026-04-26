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
