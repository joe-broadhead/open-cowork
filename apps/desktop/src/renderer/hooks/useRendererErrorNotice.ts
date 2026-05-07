import { useEffect, useState } from 'react'

function rendererErrorNoticeMessage(message: string) {
  const trimmed = message.trim()
  if (!trimmed) return 'An unexpected app error occurred.'
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed
}

export function useRendererErrorNotice() {
  const [rendererErrorNotice, setRendererErrorNotice] = useState<string | null>(null)

  // Global window-level error capture. The React ErrorBoundary catches
  // render-time panics; this covers async handlers and rejected promises.
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || event.error?.message || 'window error'
      setRendererErrorNotice(rendererErrorNoticeMessage(message))
      try {
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message,
          stack: event.error?.stack,
        })
      } catch { /* diagnostics reporting must never throw */ }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        const reason = event.reason
        const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'unhandled rejection'
        setRendererErrorNotice(rendererErrorNoticeMessage(message))
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: `unhandled rejection: ${message}`,
          stack: reason instanceof Error ? reason.stack : undefined,
        })
      } catch { /* never throw */ }
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return [rendererErrorNotice, setRendererErrorNotice] as const
}
