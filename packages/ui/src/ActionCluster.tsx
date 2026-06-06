import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'
import { cn } from './utils.js'

export type ActionClusterItem = {
  id: string
  label: string
  icon?: IconName
  pressed?: boolean
  disabled?: boolean
  hidden?: boolean
  title?: string
  tone?: 'neutral' | 'primary' | 'danger'
  onAction?: () => void
}

export type ActionClusterProps = {
  label: string
  items?: ActionClusterItem[]
  children?: ReactNode
  className?: string
}

export function ActionCluster({ label, items = [], children, className }: ActionClusterProps) {
  const visibleItems = items.filter((item) => !item.hidden)
  if (!visibleItems.length && !children) return null

  return (
    <div className={cn('ui-action-cluster', className)} role="toolbar" aria-label={label} data-action-cluster="true">
      {visibleItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={cn('ui-action-cluster__item', item.tone && `ui-action-cluster__item--${item.tone}`)}
          aria-pressed={item.pressed}
          disabled={item.disabled}
          title={item.title}
          onClick={item.onAction}
          data-action-id={item.id}
        >
          {item.icon ? <Icon name={item.icon} size={16} /> : null}
          <span>{item.label}</span>
        </button>
      ))}
      {children}
    </div>
  )
}
