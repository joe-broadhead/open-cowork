// Pure AbortSignal helpers for the cloud session service: throw the abort reason
// if a signal is already aborted, and register an abort callback returning an
// unsubscribe. Extracted from session-service.ts; no service state, no deps
// beyond the AbortSignal contract.

export function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new Error(typeof reason === 'string' && reason.trim() ? reason : 'Cloud worker command execution was aborted.')
}

export function runOnAbort(signal: AbortSignal | undefined, callback: () => Promise<void> | void) {
  if (!signal) return () => undefined
  const abort = () => {
    void Promise.resolve(callback()).catch(() => undefined)
  }
  if (signal.aborted) {
    abort()
    return () => undefined
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}
