import { type ButtonHTMLAttributes, type ComponentPropsWithoutRef } from 'react'
import { cn } from './utils'

type CardBaseProps = {
  padding?: 'sm' | 'md' | 'lg'
}

type StaticCardProps = ComponentPropsWithoutRef<'div'> & CardBaseProps & {
  interactive?: false
}

type InteractiveCardProps = ButtonHTMLAttributes<HTMLButtonElement> & CardBaseProps & {
  interactive: true
}

export type CardProps = StaticCardProps | InteractiveCardProps

export function Card(props: CardProps) {
  const {
    interactive = false,
    padding = 'md',
    className,
    ...rest
  } = props

  if (interactive) {
    const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>
    return (
      <button
        {...buttonProps}
        type={buttonProps.type || 'button'}
        className={cn('ui-card', `ui-card--${padding}`, 'ui-card--interactive', className)}
      />
    )
  }

  const divProps = rest as ComponentPropsWithoutRef<'div'>
  return (
    <div
      {...divProps}
      className={cn('ui-card', `ui-card--${padding}`, className)}
    />
  )
}
