/**
 * Shared OpenCode event-pump primitives (JOE-943 progressive).
 *
 * Cloud workers and desktop durable session tails own product-specific
 * subscription topology (who tracks which sessions, projection pipelines).
 * This kernel owns reconnect delay math and abortable waits so backoff cannot
 * drift between authorities. Managed-server spawn remains in
 * `runtime-managed-server-core.ts` (already shared for desktop/cloud spawn).
 *
 * Does not invent classic→V2 shims. Durable Gateway remains on classic root
 * until JOE-941.
 */

/** Own SSE retries so product code can pass durable `after` on every reconnect. */
export const OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS = 1

/** Desktop durable tail defaults (slightly more patient than cloud worker). */
export const OPENCODE_DURABLE_RECONNECT_INITIAL_MS_DESKTOP = 250
export const OPENCODE_DURABLE_RECONNECT_MAX_MS_DESKTOP = 8_000

/** Cloud worker defaults (faster recovery under multi-tenant load). */
export const OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD = 100
export const OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD = 5_000

/**
 * Exponential reconnect delay after consecutive stream failures.
 * `consecutiveFailures` is 1-based (first failure → initialMs).
 */
export function exponentialReconnectDelayMs(
  consecutiveFailures: number,
  initialMs: number,
  maxMs: number,
  options: { maxExponent?: number } = {},
): number {
  const failures = Math.max(1, Math.min(Math.floor(consecutiveFailures), 32))
  const maxExponent = options.maxExponent ?? 8
  const exponent = Math.min(failures - 1, maxExponent)
  return Math.min(maxMs, initialMs * (2 ** exponent))
}

/**
 * Count consecutive failures for reconnect: reset toward 1 after a successful
 * receive window so a healthy stream that later drops does not wait at the cap.
 */
export function nextReconnectFailureCount(
  previousFailures: number,
  receivedEvent: boolean,
  options: { maxConsecutive?: number } = {},
): number {
  const maxConsecutive = options.maxConsecutive ?? 16
  if (receivedEvent) return 1
  return Math.min(previousFailures + 1, maxConsecutive)
}

/** Abortable delay; resolves immediately when `signal` is already aborted. */
export function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const ms = Math.max(0, delayMs)
  if (ms === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}
