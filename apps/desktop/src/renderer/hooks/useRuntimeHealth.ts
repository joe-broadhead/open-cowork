import { useCallback, useEffect, useState } from 'react'

type RuntimeHealth = {
  runtimeReady: boolean
  runtimeWasReady: boolean
  runtimeError: string | null
  refreshRuntimeState: () => Promise<void>
  handleRuntimeRestart: () => Promise<void>
}

export function useRuntimeHealth(loadSessions: () => Promise<void>): RuntimeHealth {
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  // Flipped to true the first time the runtime is successfully ready.
  // Distinguishes "still booting" from "runtime dropped after success".
  const [runtimeWasReady, setRuntimeWasReady] = useState(false)

  const refreshRuntimeState = useCallback(async () => {
    return window.coworkApi.runtime.status().then(async (status) => {
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        setRuntimeWasReady(true)
        await loadSessions()
      }
    }).catch((err) => console.error('Failed to query runtime status:', err))
  }, [loadSessions])

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
    }
  }, [loadSessions])

  // Poll runtime health so a mid-session drop surfaces as the offline banner
  // instead of silently hanging the next prompt. Polling is skipped while the
  // app is hidden because there is no visible state to update.
  useEffect(() => {
    if (!runtimeWasReady) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const status = await window.coworkApi.runtime.status()
        setRuntimeReady(status.ready)
        setRuntimeError(status.error || null)
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
  }, [runtimeWasReady])

  useEffect(() => {
    let cancelled = false
    const unsub = window.coworkApi.on.runtimeReady(() => {
      if (cancelled) return
      setRuntimeReady(true)
      setRuntimeError(null)
      void loadSessions()
    })

    void window.coworkApi.runtime.status().then((status) => {
      if (cancelled) return
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        void loadSessions()
      }
    }).catch((err) => console.error('Failed to initialize runtime status:', err))

    return () => {
      cancelled = true
      unsub()
    }
  }, [loadSessions])

  return {
    runtimeReady,
    runtimeWasReady,
    runtimeError,
    refreshRuntimeState,
    handleRuntimeRestart,
  }
}
