// A per-key task serializer: tasks submitted for the same key run strictly one-at-a-time in
// submission order, while tasks for different keys run concurrently. Used to make a read-modify-write
// that spans awaits safe against lost updates (audit P1-X1) without a coarse global lock.
//
// Each key holds the "tail" of its chain. A new task chains onto that tail (running regardless of the
// previous task's outcome, so one failure can't wedge the lane), becomes the new tail, and the map
// entry self-cleans once it is no longer the live tail — so memory stays bounded by in-flight keys.
export type KeyedSerializer = {
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  /** Number of keys with an in-flight or queued task — for tests/observability. */
  size(): number
}

export function createKeyedSerializer(): KeyedSerializer {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(task, task)
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
    size() {
      return tails.size
    },
  }
}
