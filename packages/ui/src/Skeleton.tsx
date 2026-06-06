import { type ComponentPropsWithoutRef } from 'react'
import { cn } from './utils.js'

export type SkeletonProps = ComponentPropsWithoutRef<'span'> & {
  variant?: 'text' | 'block' | 'card'
}

export function Skeleton({
  variant = 'text',
  className,
  ...props
}: SkeletonProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={cn('ui-skeleton', `ui-skeleton--${variant}`, className)}
    />
  )
}
