import { useEffect, useMemo, useState } from 'react'
import { t } from '../helpers/i18n'
import { BrandMark } from './BrandMark'
import { Button } from './ui'

export function LoadingScreen({
  brandName,
  stage,
  errorMessage,
  onRetry,
}: {
  brandName: string
  stage: 'boot' | 'auth' | 'config' | 'runtime'
  errorMessage?: string | null
  onRetry?: (() => void | Promise<void>) | null
}) {
  const [elapsed, setElapsed] = useState(0)
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAt)
    }, 500)
    return () => window.clearInterval(timer)
  }, [stage])

  const message = useMemo(() => {
    if (errorMessage) return t('loading.runtimeNeedsAttention', 'Runtime configuration needs attention.')
    if (stage === 'auth') return t('loading.auth', 'Checking authentication...')
    if (stage === 'config') return t('loading.config', 'Loading workspace configuration...')
    if (stage === 'runtime') {
      if (elapsed >= 9_000) return t('loading.almostThere', 'Almost there...')
      if (elapsed >= 3_000) return t('loading.connecting', 'Connecting to runtime...')
      return t('loading.runtime', 'Starting runtime...')
    }
    return t('loading.boot', 'Starting up...')
  }, [elapsed, errorMessage, stage])

  return (
    <div
      className="flex items-center justify-center h-screen w-screen"
      style={{ background: 'var(--color-base)' }}
      aria-busy={errorMessage ? undefined : true}
    >
      <div className="flex flex-col items-center gap-5 text-center px-6">
        <BrandMark size="lg" glow />
        <div className="flex flex-col gap-1.5">
          <div className="text-lg font-semibold text-text">{brandName}</div>
          <div
            className="text-sm text-text-secondary"
            role={errorMessage ? undefined : 'status'}
            aria-live={errorMessage ? undefined : 'polite'}
            aria-atomic={errorMessage ? undefined : true}
          >
            {message}
          </div>
        </div>
        {errorMessage ? (
          <div
            className="max-w-[560px] rounded-xl border border-red/30 bg-red/8 px-4 py-3 text-start"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <div className="text-xs font-medium text-red mb-1">{t('loading.error.title', '{{brandName}} could not start the runtime', { brandName })}</div>
            <div className="text-xs leading-relaxed text-text-secondary">{errorMessage}</div>
            <div className="text-2xs text-text-muted mt-2">{t('loading.error.hint', 'Fix the invalid runtime or config input, then relaunch the app.')}</div>
            {onRetry ? (
              <div className="mt-3">
                <Button variant="secondary" size="sm" leftIcon="rotate-ccw" loading={retrying} onClick={() => void handleRetry()}>
                  {retrying ? t('loading.error.retrying', 'Retrying…') : t('loading.error.tryAgain', 'Try again')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:160ms]" />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:320ms]" />
          </div>
        )}
      </div>
    </div>
  )
}
