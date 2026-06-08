import { type ButtonHTMLAttributes, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from './utils.js'

type CardBaseProps = {
  padding?: 'sm' | 'md' | 'lg'
  variant?: 'surface' | 'tile' | 'flat'
  hover?: 'none' | 'lift'
  specular?: boolean
  tile?: ReactNode
  tileLabel?: ReactNode
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
    variant = 'surface',
    hover = interactive ? 'lift' : 'none',
    specular = true,
    tile,
    tileLabel,
    className,
    children,
    ...rest
  } = props
  const cardClassName = cn(
    'ui-card',
    `ui-card--${padding}`,
    `ui-card--variant-${variant}`,
    hover === 'lift' && 'ui-card--hover-lift',
    specular && 'ui-card--specular',
    className,
  )
  const content = (
    <>
      {tile ? (
        <span className="ui-card__tile" aria-label={typeof tileLabel === 'string' ? tileLabel : undefined}>
          {tile}
        </span>
      ) : null}
      {children}
    </>
  )

  if (interactive) {
    const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>
    return (
      <button
        {...buttonProps}
        type={buttonProps.type || 'button'}
        className={cn(cardClassName, 'ui-card--interactive')}
      >
        {content}
      </button>
    )
  }

  const divProps = rest as ComponentPropsWithoutRef<'div'>
  return (
    <div
      {...divProps}
      className={cardClassName}
    >
      {content}
    </div>
  )
}
