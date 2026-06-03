import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react'
import { useSessionStore, type SessionError } from '../../stores/session'
import { Button, IconButton } from './Button'

export type ToastTone = 'error' | 'warning' | 'success' | 'info'

export type ToastAction = {
  label: string
  onClick: () => void
}

export type ToastOptions = {
  id?: string
  title?: string
  message: string
  tone?: ToastTone
  action?: ToastAction
  durationMs?: number
}

type ToastRecord = {
  id: string
  title: string
  message: string
  tone: ToastTone
  action?: ToastAction
  durationMs: number
  order: number
}

const TOAST_EVENT = 'open-cowork:toast'
const DEFAULT_DURATION_MS = 5000
const MAX_VISIBLE = 3

export function toast(options: ToastOptions) {
  if (typeof window === 'undefined') return
  const message = options.message.trim()
  if (!message) return
  window.dispatchEvent(new CustomEvent<ToastOptions>(TOAST_EVENT, {
    detail: {
      ...options,
      message,
    },
  }))
}

function toastTitle(tone: ToastTone) {
  switch (tone) {
    case 'success': return 'Done'
    case 'warning': return 'Warning'
    case 'info': return 'Note'
    case 'error':
    default:
      return 'App error'
  }
}

function globalErrorToToast(error: SessionError): ToastRecord {
  return {
    id: `global:${error.id}`,
    title: 'App error',
    message: error.message,
    tone: 'error',
    durationMs: DEFAULT_DURATION_MS,
    order: error.order,
  }
}

function localToastToRecord(options: ToastOptions): ToastRecord {
  const tone = options.tone || 'info'
  return {
    id: options.id || `local:${crypto.randomUUID()}`,
    title: options.title || toastTitle(tone),
    message: options.message,
    tone,
    action: options.action,
    durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
    order: Date.now(),
  }
}

const toneStyles: Record<ToastTone, CSSProperties> = {
  error: {
    '--toast-color': 'var(--color-red)',
    '--toast-bg': 'color-mix(in srgb, var(--color-red) 13%, var(--color-elevated))',
    '--toast-border': 'color-mix(in srgb, var(--color-red) 42%, var(--color-border))',
  } as CSSProperties,
  warning: {
    '--toast-color': 'var(--color-amber)',
    '--toast-bg': 'color-mix(in srgb, var(--color-amber) 12%, var(--color-elevated))',
    '--toast-border': 'color-mix(in srgb, var(--color-amber) 38%, var(--color-border))',
  } as CSSProperties,
  success: {
    '--toast-color': 'var(--color-green)',
    '--toast-bg': 'color-mix(in srgb, var(--color-green) 12%, var(--color-elevated))',
    '--toast-border': 'color-mix(in srgb, var(--color-green) 36%, var(--color-border))',
  } as CSSProperties,
  info: {
    '--toast-color': 'var(--color-info)',
    '--toast-bg': 'color-mix(in srgb, var(--color-info) 12%, var(--color-elevated))',
    '--toast-border': 'color-mix(in srgb, var(--color-info) 34%, var(--color-border))',
  } as CSSProperties,
}

function ToastCard({
  record,
  onDismiss,
}: {
  record: ToastRecord
  onDismiss: (id: string) => void
}) {
  const [paused, setPaused] = useState(false)
  const remainingMsRef = useRef(record.durationMs)
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    remainingMsRef.current = record.durationMs
    startedAtRef.current = null
  }, [record.id, record.durationMs])

  useEffect(() => {
    if (record.durationMs <= 0 || paused) return undefined
    startedAtRef.current = Date.now()
    const timer = window.setTimeout(() => onDismiss(record.id), remainingMsRef.current)

    return () => {
      window.clearTimeout(timer)
      if (startedAtRef.current !== null) {
        remainingMsRef.current = Math.max(0, remainingMsRef.current - (Date.now() - startedAtRef.current))
        startedAtRef.current = null
      }
    }
  }, [onDismiss, paused, record.durationMs, record.id])

  const onButtonBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setPaused(false)
  }

  const isError = record.tone === 'error'

  return (
    <section
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-label={`${record.title}: ${record.message}`}
      className="ui-toast-card toast-enter pointer-events-auto"
      style={toneStyles[record.tone]}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="ui-toast-indicator shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">{record.title}</div>
          <div className="mt-1 text-xs text-text-secondary">{record.message}</div>
          {record.action ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onFocus={() => setPaused(true)}
              onBlur={onButtonBlur}
              onClick={() => {
                record.action?.onClick()
                onDismiss(record.id)
              }}
            >
              {record.action.label}
            </Button>
          ) : null}
        </div>
        <IconButton
          icon="x"
          label="Dismiss"
          size="sm"
          className="no-drag -mr-1 -mt-1"
          onFocus={() => setPaused(true)}
          onBlur={onButtonBlur}
          onClick={() => onDismiss(record.id)}
        />
      </div>
    </section>
  )
}

export function Toaster() {
  const globalErrors = useSessionStore((state) => state.globalErrors)
  const dismissGlobalError = useSessionStore((state) => state.dismissGlobalError)
  const [localToasts, setLocalToasts] = useState<ToastRecord[]>([])

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ToastOptions>).detail
      if (!detail || typeof detail.message !== 'string') return
      const next = localToastToRecord(detail)
      setLocalToasts((current) => [...current.filter((entry) => entry.id !== next.id), next])
    }
    window.addEventListener(TOAST_EVENT, listener)
    return () => window.removeEventListener(TOAST_EVENT, listener)
  }, [])

  const dismissToast = useCallback((id: string) => {
    if (id.startsWith('global:')) {
      dismissGlobalError(id.slice('global:'.length))
      return
    }
    setLocalToasts((current) => current.filter((entry) => entry.id !== id))
  }, [dismissGlobalError])

  const visibleToasts = useMemo(() => {
    return [
      ...globalErrors.map(globalErrorToToast),
      ...localToasts,
    ]
      .sort((a, b) => a.order - b.order)
  }, [globalErrors, localToasts])

  if (visibleToasts.length === 0) return null

  const hiddenCount = visibleToasts.length > MAX_VISIBLE
    ? visibleToasts.length - (MAX_VISIBLE - 1)
    : 0
  const records = hiddenCount > 0
    ? visibleToasts.slice(-(MAX_VISIBLE - 1))
    : visibleToasts.slice(-MAX_VISIBLE)

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className="ui-toaster pointer-events-none flex flex-col items-end gap-2"
    >
      {hiddenCount > 0 ? (
        <div className="pointer-events-auto rounded-full border border-border-subtle bg-elevated px-3 py-1 text-xs font-semibold text-text-muted shadow-card">
          +{hiddenCount} earlier {hiddenCount === 1 ? 'notice' : 'notices'}
        </div>
      ) : null}
      {records.map((entry) => (
        <ToastCard key={entry.id} record={entry} onDismiss={dismissToast} />
      ))}
    </div>
  )
}
