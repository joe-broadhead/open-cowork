import { useRef } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { AutomationDropAction } from './automation-board-support'

type Props = {
  action: Extract<AutomationDropAction, { valid: true }>
  onCancel: () => void
  onConfirm: () => void
}

export function AutomationDropConfirmDialog({ action, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { onEscape: onCancel })
  return (
    <>
      <ModalBackdrop onDismiss={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-drop-confirm-title"
        className="fixed left-1/2 top-[28vh] z-50 w-[420px] max-w-[92vw] -translate-x-1/2 rounded-2xl border border-border-subtle p-5 shadow-2xl"
        style={{ background: 'var(--color-base)' }}
      >
        <h2 id="automation-drop-confirm-title" className="text-[16px] font-semibold text-text">{action.title}</h2>
        <p className="mt-2 text-[13px] leading-6 text-text-secondary">{action.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
            Confirm
          </button>
        </div>
      </div>
    </>
  )
}
