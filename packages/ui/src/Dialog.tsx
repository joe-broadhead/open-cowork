import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useFocusTrap } from './useFocusTrap.js'
import { IconButton } from './Button.js'
import { cn } from './utils.js'

export type DialogProps = {
  title: string
  children: ReactNode
  onClose: () => void
  size?: 'sm' | 'md' | 'lg'
  variant?: 'modal' | 'drawer'
  side?: 'right' | 'left'
  footer?: ReactNode
}

export function Dialog({
  title,
  children,
  onClose,
  size = 'md',
  variant = 'modal',
  side = 'right',
  footer,
}: DialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { onEscape: onClose })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [onClose])

  return (
    <>
      <div
        aria-hidden="true"
        className={cn('ui-dialog-backdrop', variant === 'drawer' && 'ui-dialog-backdrop--drawer')}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('ui-dialog', `ui-dialog--${size}`, `ui-dialog--${variant}`, variant === 'drawer' && `ui-dialog--drawer-${side}`)}
      >
        <div className="ui-dialog__header">
          <h2 id={titleId} className="ui-dialog__title">{title}</h2>
          <IconButton icon="x" label="Close dialog" onClick={onClose} />
        </div>
        <div className="ui-dialog__body">
          {children}
        </div>
        {footer ? <div className="ui-dialog__footer">{footer}</div> : null}
      </div>
    </>
  )
}
