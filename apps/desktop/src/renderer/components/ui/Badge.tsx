import { type ComponentPropsWithoutRef } from 'react'
import { cn } from './utils'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: BadgeTone
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      {...props}
      className={cn('ui-badge', `ui-badge--${tone}`, className)}
    />
  )
}
