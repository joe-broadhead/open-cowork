import { useCallback, useEffect, useRef, useState } from 'react'

type RuntimeHealth = {
  runtimeReady: boolean
  runtimeWasReady: boolean
  runtimeError: string | null
  refreshRuntimeState: () => Promise<void>
  handleRuntimeRestart: () => Promise<void>
}

type RuntimeHealthErrorReporter = (notice: string, error: unknown, viewName: string) => void

export function useRuntimeHealth(
  loadSessions: () => Promise<void>,
  reportError?: RuntimeHealthErrorReporter,
  enabled = true,
): RuntimeHealth {
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  // Flipped to true the first time the runtime is successfully ready.
  // Distinguishes "still booting" from "runtime dropped after success".
  const [runtimeWasReady, setRuntimeWasReady] = useState(false)
  const statusRequestId = useRef(0)

  const reportRuntimeStatusError = useCallback((notice: string, err: unknown) => {
    // A rejected status IPC can be a one-off bridge timing issue while
    // the runtime itself remains healthy. Surface it through the app's
    // notice/diagnostics channel, but do not convert it into authoritative
    // runtime state. Successful status payloads and explicit restart
    // failures below still own `runtimeReady` / `runtimeError`.
    reportError?.(notice, err, 'runtime')
  }, [reportError])

  const refreshRuntimeStatus = useCallback(async (
    notice: string,
    options?: { loadOnReady?: boolean; reportFailures?: boolean; isCancelled?: () => boolean },
  ) => {
    const requestId = statusRequestId.current + 1
    statusRequestId.current = requestId
    try {
      const status = await window.coworkApi.runtime.status()
      if (requestId !== statusRequestId.current || options?.isCancelled?.()) return
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        setRuntimeWasReady(true)
        if (options?.loadOnReady) {
          await loadSessions()
        }
      }
    } catch (err) {
      if (requestId !== statusRequestId.current || options?.isCancelled?.()) return
      if (options?.reportFailures !== false) {
        reportRuntimeStatusError(notice, err)
      }
    }
  }, [loadSessions, reportRuntimeStatusError])

  const refreshRuntimeState = useCallback(async () => {
    await refreshRuntimeStatus('Could not query runtime status. Try restarting the app.', { loadOnReady: true })
  }, [refreshRuntimeStatus])

  const handleRuntimeRestart = useCallback(async () => {
    try {
      const status = await window.coworkApi.runtime.restart()
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        setRuntimeWasReady(true)
        await loadSessions()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Runtime restart failed.'
      setRuntimeError(message)
      reportError?.('Runtime restart failed. Try again.', err, 'runtime')
    }
  }, [loadSessions, reportError])

  // Poll runtime health so a mid-session drop surfaces as the offline banner
  // instead of silently hanging the next prompt. Polling is skipped while the
  // app is hidden because there is no visible state to update.
  useEffect(() => {
    if (!enabled || !runtimeWasReady) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        await refreshRuntimeStatus('Could not query runtime status. Try restarting the app.', {
          reportFailures: false,
        })
      } catch {
        /* transient IPC failures shouldn't trip the banner */
      }
    }
    const interval = window.setInterval(() => { void check() }, 10_000)
    const onFocus = () => { void check() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refreshRuntimeStatus, runtimeWasReady])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const unsub = window.coworkApi.on.runtimeReady(() => {
      if (cancelled) return
      statusRequestId.current += 1
      setRuntimeReady(true)
      setRuntimeError(null)
      setRuntimeWasReady(true)
      void loadSessions()
    })

    void refreshRuntimeStatus('Could not initialize runtime status. Try restarting the app.', {
      // App bootstrap already loads the session registry without waiting for
      // runtime startup. Runtime-ready events below still refresh it when the
      // execution layer transitions later.
      loadOnReady: false,
      isCancelled: () => cancelled,
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [enabled, loadSessions, refreshRuntimeStatus])

  return {
    runtimeReady,
    runtimeWasReady,
    runtimeError,
    refreshRuntimeState,
    handleRuntimeRestart,
  }
}
