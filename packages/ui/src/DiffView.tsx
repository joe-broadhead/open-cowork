import { type ReactNode } from 'react'
import { Badge } from './Badge.js'
import { cn } from './utils.js'

export type DiffViewFile = {
  id: string
  path: string
  status?: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
  additions?: number
  deletions?: number
  synthetic?: boolean
  meta?: ReactNode
}

export type DiffViewProps = {
  title: string
  subtitle?: ReactNode
  files?: DiffViewFile[]
  children?: ReactNode
  actions?: ReactNode
  empty?: ReactNode
  className?: string
}

const STATUS_LABEL: Record<NonNullable<DiffViewFile['status']>, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  unknown: 'Changed',
}

function diffTone(status: DiffViewFile['status']) {
  if (status === 'added') return 'success'
  if (status === 'deleted') return 'danger'
  if (status === 'renamed') return 'warning'
  return 'neutral'
}

export function DiffView({ title, subtitle, files = [], children, actions, empty, className }: DiffViewProps) {
  return (
    <section className={cn('ui-diff-view', className)} aria-label={title} data-diff-view="true">
      <header className="ui-diff-view__header">
        <div className="ui-diff-view__title">
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="ui-diff-view__actions">{actions}</div> : null}
      </header>
      {files.length ? (
        <div className="ui-diff-view__files" role="list">
          {files.map((file) => (
            <div className="ui-diff-view__file" role="listitem" key={file.id}>
              <div className="ui-diff-view__file-main">
                <Badge tone={diffTone(file.status)}>{STATUS_LABEL[file.status || 'unknown']}</Badge>
                <code>{file.path}</code>
                {file.synthetic ? <span className="ui-diff-view__estimate">estimated</span> : null}
              </div>
              <div className="ui-diff-view__file-meta">
                {typeof file.additions === 'number' ? <span className="ui-diff-view__plus">+{file.additions}</span> : null}
                {typeof file.deletions === 'number' ? <span className="ui-diff-view__minus">-{file.deletions}</span> : null}
                {file.meta}
              </div>
            </div>
          ))}
        </div>
      ) : children ? null : <div className="ui-diff-view__empty">{empty || 'No changes to review.'}</div>}
      {children}
    </section>
  )
}
