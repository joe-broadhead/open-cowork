import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'

export type EmptyStateProps = {
  icon: IconName
  title: string
  body: string
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <div className="ui-empty-state__icon" aria-hidden="true">
        <Icon name={icon} size={24} />
      </div>
      <div>
        <div className="ui-empty-state__title">{title}</div>
        <div className="ui-empty-state__body">{body}</div>
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  )
}
