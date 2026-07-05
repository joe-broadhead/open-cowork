import { useState, type ReactNode } from 'react'
import { Button, Dialog } from './ui'

export type ConfirmDialogProps = {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/**
 * The shared, on-system confirmation modal for irreversible-but-not-token-gated
 * actions (disconnect a channel, delete a watch, archive a playbook, wipe a
 * sandbox, discard unsaved settings). Re-entry-guarded so a double-click can't
 * fire the action twice. The token flow (confirm.requestDestructive) stays for
 * server-gated deletes; everything else routes through here instead of one-click.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={() => void confirm()} loading={busy}>{confirmLabel}</Button>
        </div>
      }
    >
      {body ? <div className="text-sm text-text-secondary leading-relaxed">{body}</div> : null}
    </Dialog>
  )
}
