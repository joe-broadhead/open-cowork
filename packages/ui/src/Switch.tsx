import { type ComponentPropsWithoutRef } from 'react'

import { cn } from './utils.js'

export type SwitchProps = Omit<ComponentPropsWithoutRef<'button'>, 'onChange'> & {
  /** Controlled on/off state. */
  checked: boolean
  /** Called with the next state when the control is toggled. */
  onCheckedChange?: (next: boolean) => void
}

/**
 * The canonical on/off toggle. Wraps the token-driven `.ui-switch` track + thumb
 * so settings panels, workflow rows, and capability toggles share one material
 * instead of re-emitting the markup. Pass an `aria-label` (or `aria-labelledby`)
 * for an accessible name.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  onClick,
  ...rest
}: SwitchProps) {
  return (
    <button
      type="button"
      {...rest}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) onCheckedChange?.(!checked)
      }}
      className={cn('ui-switch shrink-0', checked && 'ui-switch--on', className)}
    >
      <span className="ui-switch__thumb" />
    </button>
  )
}
