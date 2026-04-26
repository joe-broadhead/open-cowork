import { useEffect, useMemo, useState } from 'react'
import { t } from '../helpers/i18n'

export function LoadingScreen({
  brandName,
  stage,
  errorMessage,
}: {
  brandName: string
  stage: 'boot' | 'auth' | 'config' | 'runtime'
  errorMessage?: string | null
}) {
  const [elapsed, setElapsed] = useState(0)

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
    <div className="flex items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
      <div className="flex flex-col items-center gap-5 text-center px-6">
        <div
          className="relative flex items-center justify-center w-18 h-18 rounded-[22px] border"
          style={{
            width: 72,
            height: 72,
            background: 'color-mix(in srgb, var(--color-elevated) 88%, var(--color-accent) 12%)',
            borderColor: 'color-mix(in srgb, var(--color-accent) 18%, var(--color-border))',
          }}
        >
          <span className="text-[28px] font-semibold text-accent">O</span>
          <span
            className="absolute inset-0 rounded-[22px] animate-pulse"
            style={{ boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-accent) 16%, transparent), 0 0 26px color-mix(in srgb, var(--color-accent) 16%, transparent)' }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[16px] font-semibold text-text">{brandName}</div>
          <div className="text-[13px] text-text-secondary">{message}</div>
        </div>
        {errorMessage ? (
          <div className="max-w-[560px] rounded-xl border border-red/30 bg-red/8 px-4 py-3 text-start">
            <div className="text-[12px] font-medium text-red mb-1">{t('loading.error.title', '{{brandName}} could not start the runtime', { brandName })}</div>
            <div className="text-[12px] leading-relaxed text-text-secondary">{errorMessage}</div>
            <div className="text-[11px] text-text-muted mt-2">{t('loading.error.hint', 'Fix the invalid runtime or config input, then relaunch the app.')}</div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:160ms]" />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:320ms]" />
          </div>
        )}
      </div>
    </div>
  )
}
