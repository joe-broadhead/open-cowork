import { type ReactNode } from 'react'
import { Button } from './Button.js'
import { Icon, type IconName } from './Icon.js'

export type ErrorStateProps = {
  /** Short headline — what happened. */
  title: string
  /** Plain-language detail of the failure. */
  message: string
  /** Optional guidance on how to recover. */
  hint?: string
  icon?: IconName
  /** When provided, renders a primary retry affordance. */
  onRetry?: () => void
  retryLabel?: string
  /** Extra actions rendered next to (or instead of) retry. */
  action?: ReactNode
}

/**
 * On-brand error surface. Unlike a bare red string, it names what happened
 * AND how to fix it, and offers an inline recovery action so a failed panel
 * is never a dead end.
 */
export function ErrorState({
  title,
  message,
  hint,
  icon = 'alert-circle',
  onRetry,
  retryLabel = 'Try again',
  action,
}: ErrorStateProps) {
  return (
    <div className="ui-error-state" role="alert">
      <div className="ui-error-state__icon" aria-hidden="true">
        <Icon name={icon} size={24} />
      </div>
      <div>
        <div className="ui-error-state__title">{title}</div>
        <div className="ui-error-state__body">{message}</div>
        {hint ? <div className="ui-error-state__hint">{hint}</div> : null}
      </div>
      {(onRetry || action) ? (
        <div className="ui-error-state__actions">
          {onRetry ? (
            <Button size="sm" variant="secondary" leftIcon="rotate-ccw" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  )
}
