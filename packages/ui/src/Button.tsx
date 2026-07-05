import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { DisabledHint } from './DisabledHint.js'
import { Icon, type IconName, type IconSize } from './Icon.js'
import { Tooltip } from './Tooltip.js'
import { cn } from './utils.js'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  leftIcon?: IconName
  rightIcon?: IconName
  fullWidth?: boolean
  disabledReason?: string | null
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function ButtonPrimitive({
  variant = 'secondary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth = false,
  disabledReason,
  disabled,
  children,
  className,
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const hintId = useId()
  const isDisabled = disabled || loading || Boolean(disabledReason)
  const disabledHintId = `${hintId}-disabled`
  const describedBy = [ariaDescribedBy, disabledReason ? disabledHintId : undefined].filter(Boolean).join(' ') || undefined
  // Scale the icon with the button height (sm/md keep the 16px glyph; lg steps up
  // to 20px) so the icon never looks lost in the larger control — mirrors how
  // IconButton scales its glyph.
  const iconSize: IconSize = size === 'lg' ? 20 : 16
  const button = (
    <button
      {...props}
      ref={ref}
      className={cn(
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        fullWidth && 'ui-button--full',
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-describedby={describedBy}
      type={props.type || 'button'}
    >
      {loading ? <Icon name="loader-circle" size={iconSize} className="ui-spin" /> : leftIcon ? <Icon name={leftIcon} size={iconSize} /> : null}
      <span>{children}</span>
      {rightIcon ? <Icon name={rightIcon} size={iconSize} /> : null}
    </button>
  )

  if (!disabledReason) return button

  return (
    <span className={cn('ui-control-stack', fullWidth && 'ui-button--full')}>
      <Tooltip content={disabledReason} delay={0}>
        <span>{button}</span>
      </Tooltip>
      <DisabledHint id={disabledHintId} reason={disabledReason} />
    </span>
  )
})

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  icon: IconName
  label: string
  size?: ButtonSize
  variant?: ButtonVariant
  badge?: ReactNode
  loading?: boolean
  disabledReason?: string | null
}

function iconButtonGlyphSize(size: ButtonSize): IconSize {
  if (size === 'lg') return 24
  if (size === 'sm') return 16
  return 20
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButtonPrimitive({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  badge,
  loading = false,
  disabled,
  disabledReason,
  className,
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const hintId = useId()
  const isDisabled = disabled || loading || Boolean(disabledReason)
  const disabledHintId = `${hintId}-disabled`
  const describedBy = [ariaDescribedBy, disabledReason ? disabledHintId : undefined].filter(Boolean).join(' ') || undefined
  const button = (
    <button
      {...props}
      ref={ref}
      type={props.type || 'button'}
      className={cn(
        'ui-icon-button',
        `ui-icon-button--${variant}`,
        `ui-icon-button--${size}`,
        className,
      )}
      aria-label={label}
      aria-busy={loading || undefined}
      aria-describedby={describedBy}
      disabled={isDisabled}
    >
      {loading ? <Icon name="loader-circle" size={iconButtonGlyphSize(size)} className="ui-spin" /> : <Icon name={icon} size={iconButtonGlyphSize(size)} />}
      {badge ? <span className="ui-icon-button__badge">{badge}</span> : null}
    </button>
  )

  if (!disabledReason) return button

  return (
    <span className="ui-control-stack">
      <Tooltip content={disabledReason} delay={0}>
        <span>{button}</span>
      </Tooltip>
      <DisabledHint id={disabledHintId} reason={disabledReason} />
    </span>
  )
})
