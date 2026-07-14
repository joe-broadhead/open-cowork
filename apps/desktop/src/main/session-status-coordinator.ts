// Polling reconciler with bounded linear backoff. It is a safety net behind the
// native session events: if the SSE stream briefly lags, this loop confirms
// idle via the authoritative `/api/session/active` process-owned drain list.
// Do not remove without measuring event-stream reliability first; idle-state
// confirmation is load-bearing for the question-reply and post-run UI flows.
type SessionStatusType = string | null

// After this many consecutive misses (a null status — the session record is
// gone or the runtime is unavailable — or a lookup error), stop reconciling.
// A genuinely running session reports a non-null status string, which resets
// the counter, so only truly abandoned sessions hit the cap. ~15 misses at the
// 4s ceiling is ~60s, which tolerates a runtime reboot without polling forever.
const DEFAULT_MAX_CONSECUTIVE_MISSES = 15

type SessionStatusReconcilerOptions = {
  initialDelayMs?: number
  maxDelayMs?: number
  maxConsecutiveMisses?: number
  onIdle: () => void | Promise<void>
  onError?: (err: unknown) => void
  onAbandon?: (reason: 'misses-exceeded') => void
}

type PendingSessionStatusReconciliation = {
  attempt: number
  consecutiveMisses: number
  initialDelayMs: number
  maxDelayMs: number
  maxConsecutiveMisses: number
  onIdle: () => void | Promise<void>
  onError?: (err: unknown) => void
  onAbandon?: (reason: 'misses-exceeded') => void
  timer: ReturnType<typeof setTimeout> | null
}

function nextDelayMs(attempt: number, initialDelayMs: number, maxDelayMs: number) {
  return Math.min(maxDelayMs, initialDelayMs + (attempt * 500))
}

export function createSessionStatusReconciler(
  lookupStatus: (sessionId: string) => Promise<SessionStatusType>,
) {
  const inflight = new Map<string, PendingSessionStatusReconciliation>()

  function scheduleOrAbandon(sessionId: string, pending: PendingSessionStatusReconciliation) {
    if (pending.consecutiveMisses > pending.maxConsecutiveMisses) {
      inflight.delete(sessionId)
      pending.onAbandon?.('misses-exceeded')
      return
    }
    pending.attempt += 1
    pending.timer = setTimeout(() => {
      void run(sessionId, pending)
    }, nextDelayMs(pending.attempt, pending.initialDelayMs, pending.maxDelayMs))
  }

  async function run(sessionId: string, pending: PendingSessionStatusReconciliation) {
    let status: SessionStatusType
    try {
      status = await lookupStatus(sessionId)
    } catch (err) {
      if (inflight.get(sessionId) !== pending) return
      pending.onError?.(err)
      pending.consecutiveMisses += 1
      scheduleOrAbandon(sessionId, pending)
      return
    }

    if (inflight.get(sessionId) !== pending) return

    if (status === 'idle') {
      inflight.delete(sessionId)
      await pending.onIdle()
      return
    }

    // A null status means the session record is gone or the runtime is
    // unavailable — count it as a miss so a deleted session cannot poll
    // forever. A real running status resets the counter.
    pending.consecutiveMisses = status === null ? pending.consecutiveMisses + 1 : 0
    scheduleOrAbandon(sessionId, pending)
  }

  function start(sessionId: string, options: SessionStatusReconcilerOptions) {
    if (inflight.has(sessionId)) return

    const pending: PendingSessionStatusReconciliation = {
      attempt: 0,
      consecutiveMisses: 0,
      initialDelayMs: options.initialDelayMs ?? 1200,
      maxDelayMs: options.maxDelayMs ?? 4000,
      maxConsecutiveMisses: options.maxConsecutiveMisses ?? DEFAULT_MAX_CONSECUTIVE_MISSES,
      onIdle: options.onIdle,
      onError: options.onError,
      onAbandon: options.onAbandon,
      timer: null,
    }

    inflight.set(sessionId, pending)
    pending.timer = setTimeout(() => {
      void run(sessionId, pending)
    }, pending.initialDelayMs)
  }

  function stop(sessionId: string) {
    const pending = inflight.get(sessionId)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    inflight.delete(sessionId)
  }

  function has(sessionId: string) {
    return inflight.has(sessionId)
  }

  return {
    start,
    stop,
    has,
  }
}
