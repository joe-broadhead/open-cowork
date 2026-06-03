import { type ComponentPropsWithoutRef } from 'react'
import { cn } from './utils'

export function Kbd({
  className,
  ...props
}: ComponentPropsWithoutRef<'kbd'>) {
  return <kbd {...props} className={cn('ui-kbd', className)} />
}
