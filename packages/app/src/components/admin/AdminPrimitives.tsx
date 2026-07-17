import type { ReactNode } from 'react'
import { Button, EmptyState, Icon, Skeleton, type IconName } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import type { AdminResourceState } from './useAdminResource'

// Shared, accessible building blocks for every Admin section: a consistent
// section header, the loading/error/empty/permission-gated state surfaces, and a
// semantic table shell. Sections compose these so all seven look and behave the
// same, and every table/panel ships designed non-happy-path states.

export function AdminSectionHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        <p className="mt-1 text-sm text-text-muted">{description}</p>
      </div>
      {actions ? <div className="flex flex-shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function AdminLoading({ label, rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2 py-2">
      <span className="sr-only">{label || t('admin.state.loading', 'Loading…')}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  )
}

export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-red/30 bg-red/10 px-4 py-3 text-sm text-red"
    >
      <div className="flex items-start gap-2">
        <Icon name="alert-circle" size={16} aria-hidden="true" />
        <span>{message}</span>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('admin.state.retry', 'Try again')}
      </Button>
    </div>
  )
}

export function AdminEmpty({
  icon = 'info',
  title,
  body,
  action,
}: {
  icon?: IconName
  title: string
  body: string
  action?: ReactNode
}) {
  return <EmptyState icon={icon} title={title} body={body} action={action} />
}

// Renders the correct state for an async resource: loading → error(retry) →
// empty → content. `isEmpty` lets a section decide emptiness from the data.
export function AdminStateBlock<T>({
  state,
  loadingLabel,
  loadingRows,
  emptyIcon,
  emptyTitle,
  emptyBody,
  emptyAction,
  isEmpty,
  children,
}: {
  state: AdminResourceState<T>
  loadingLabel?: string
  loadingRows?: number
  emptyIcon?: IconName
  emptyTitle: string
  emptyBody: string
  emptyAction?: ReactNode
  isEmpty?: (data: T) => boolean
  children: (data: T) => ReactNode
}) {
  if (state.loading && state.data === null) return <AdminLoading label={loadingLabel} rows={loadingRows} />
  if (state.error) return <AdminError message={state.error} onRetry={state.reload} />
  if (state.data === null) return <AdminLoading label={loadingLabel} rows={loadingRows} />
  if (isEmpty && isEmpty(state.data)) {
    return <AdminEmpty icon={emptyIcon} title={emptyTitle} body={emptyBody} action={emptyAction} />
  }
  return <>{children(state.data)}</>
}

// A permission-gated notice for a section (or action) the caller may not use.
export function AdminPermissionGate({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface px-4 py-6 text-center" role="note">
      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-active text-text-muted" aria-hidden="true">
        <Icon name="shield-check" size={20} />
      </div>
      <div className="text-sm font-semibold text-text">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  )
}

// A semantic, scrollable table shell. `caption` names the table for screen
// readers; `columns` become <th scope="col">.
export function AdminTable({
  caption,
  columns,
  children,
}: {
  caption: string
  columns: string[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-subtle bg-surface text-left">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
