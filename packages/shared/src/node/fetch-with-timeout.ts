/// <reference types="node" />
/**
 * Shared AbortController-based fetch timeout (audit 2026-07-18).
 * Prefer this over per-package AbortController copies.
 */

export type FetchWithTimeoutOptions = {
  timeoutMs?: number
  label?: string
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 10_000,
  label = 'fetch',
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) return fetch(input, init)

  const controller = new AbortController()
  const upstreamSignal = init.signal
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
  if (upstreamSignal?.aborted) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })

  const timeout = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  // Node timers
  ;(timeout as NodeJS.Timeout).unref?.()

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`)
      ;(timeoutError as Error & { cause?: unknown }).cause = err
      throw timeoutError
    }
    throw err
  } finally {
    clearTimeout(timeout)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise
  let timeout: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timeout.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}
