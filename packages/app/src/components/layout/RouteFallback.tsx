import { t } from '../../helpers/i18n'

export function RouteFallback({ label }: { label?: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center px-6 py-10 text-xs text-text-muted"
      role="status"
      aria-live="polite"
    >
      {label || t('common.loading', 'Loading…')}
    </div>
  )
}

export function PaletteFallback() {
  return (
    <div
      className="fixed top-[10%] left-1/2 z-50 w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg theme-popover px-4 py-6 text-sm text-text-muted shadow-2xl"
      role="status"
      aria-live="polite"
    >
      {t('commandPalette.loading', 'Loading command palette…')}
    </div>
  )
}
