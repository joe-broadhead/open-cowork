import { Skeleton } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'

/**
 * Skeleton-shaped lazy-route fallback (JOE-865) so major pages do not flash a
 * single muted line before their real layout mounts.
 */
export function RouteFallback({
  label,
  compact = false,
  variant = 'page',
}: {
  label?: string
  compact?: boolean
  /** page = full main column; panel = side/inspector-like; compact = thin strip */
  variant?: 'page' | 'panel' | 'list'
}) {
  if (compact) {
    return (
      <div
        className="flex h-[26px] shrink-0 items-center justify-center border-t border-border-subtle px-3 text-2xs text-text-muted"
        role="status"
        aria-live="polite"
        aria-label={label || t('common.loading', 'Loading…')}
      >
        <Skeleton className="h-3 w-24" />
      </div>
    )
  }

  if (variant === 'panel') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" role="status" aria-live="polite" aria-label={label || t('common.loading', 'Loading…')}>
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (variant === 'list') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4" role="status" aria-live="polite" aria-label={label || t('common.loading', 'Loading…')}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-8"
      role="status"
      aria-live="polite"
      aria-label={label || t('common.loading', 'Loading…')}
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  )
}

export function PaletteFallback() {
  return (
    <div
      className="fixed top-[10%] left-1/2 z-50 w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg theme-popover px-4 py-6 shadow-2xl"
      role="status"
      aria-live="polite"
      aria-label={t('commandPalette.loading', 'Loading command palette…')}
    >
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-5/6" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    </div>
  )
}
