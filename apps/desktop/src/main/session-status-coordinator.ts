type SessionStatusType = string | null

type SessionStatusReconcilerOptions = {
  initialDelayMs?: number
  maxDelayMs?: number
  onIdle: () => void | Promise<void>
  onError?: (err: unknown) => void
}

type PendingSessionStatusReconciliation = {
  attempt: number
  initialDelayMs: number
  maxDelayMs: number
  onIdle: () => void | Promise<void>
  onError?: (err: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

function nextDelayMs(attempt: number, initialDelayMs: number, maxDelayMs: number) {
  return Math.min(maxDelayMs, initialDelayMs + (attempt * 500))
}

export function createSessionStatusReconciler(
  lookupStatus: (sessionId: string) => Promise<SessionStatusType>,
) {
  const inflight = new Map<string, PendingSessionStatusReconciliation>()

  async function run(sessionId: string, pending: PendingSessionStatusReconciliation) {
    let status: SessionStatusType
    try {
      status = await lookupStatus(sessionId)
    } catch (err) {
      if (inflight.get(sessionId) !== pending) return
      pending.onError?.(err)
      pending.attempt += 1
      pending.timer = setTimeout(() => {
        void run(sessionId, pending)
      }, nextDelayMs(pending.attempt, pending.initialDelayMs, pending.maxDelayMs))
      return
    }

    if (inflight.get(sessionId) !== pending) return

    if (status === 'idle') {
      inflight.delete(sessionId)
      await pending.onIdle()
      return
    }

    pending.attempt += 1
    pending.timer = setTimeout(() => {
      void run(sessionId, pending)
    }, nextDelayMs(pending.attempt, pending.initialDelayMs, pending.maxDelayMs))
  }

  function start(sessionId: string, options: SessionStatusReconcilerOptions) {
    if (inflight.has(sessionId)) return

    const pending: PendingSessionStatusReconciliation = {
      attempt: 0,
      initialDelayMs: options.initialDelayMs ?? 1200,
      maxDelayMs: options.maxDelayMs ?? 4000,
      onIdle: options.onIdle,
      onError: options.onError,
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
