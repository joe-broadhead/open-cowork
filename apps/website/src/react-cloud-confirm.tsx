import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog } from '@open-cowork/ui'

export type CloudConfirmRequest = {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
}

type CloudConfirmState = CloudConfirmRequest & {
  resolve: (confirmed: boolean) => void
}

/**
 * Cloud-side confirmation hook built on the shared `Dialog` + `Button`
 * primitives (the desktop `ConfirmDialog` is desktop-only). Mirrors the desktop
 * danger-confirm UX for irreversible-but-not-token-gated actions: disconnect a
 * channel, delete a watch, archive a playbook. `confirm()` resolves to `true`
 * only after the user confirms; cancel/close/Esc resolve `false` so the caller
 * aborts cleanly. The underlying mutation stays with the caller (which already
 * surfaces status), so this only gates it behind an explicit confirmation.
 */
export function useCloudConfirm() {
  const [state, setState] = useState<CloudConfirmState | null>(null)
  const pendingRef = useRef<CloudConfirmState | null>(null)

  const settle = useCallback((confirmed: boolean) => {
    const pending = pendingRef.current
    pendingRef.current = null
    setState(null)
    pending?.resolve(confirmed)
  }, [])

  const confirm = useCallback((request: CloudConfirmRequest) => {
    // If a confirm is already open, decline the prior one before replacing it so
    // its caller is never left awaiting a promise that can no longer resolve.
    pendingRef.current?.resolve(false)
    return new Promise<boolean>((resolve) => {
      const next: CloudConfirmState = { ...request, resolve }
      pendingRef.current = next
      setState(next)
    })
  }, [])

  const dialog = state ? (
    <Dialog
      title={state.title}
      size="sm"
      onClose={() => settle(false)}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => settle(false)}>
            {state.cancelLabel || 'Cancel'}
          </Button>
          <Button
            variant={state.tone === 'primary' ? 'primary' : 'danger'}
            size="sm"
            onClick={() => settle(true)}
          >
            {state.confirmLabel || 'Confirm'}
          </Button>
        </>
      }
    >
      {state.body ? <p className="cloud-confirm-body">{state.body}</p> : null}
    </Dialog>
  ) : null

  return { confirm, dialog }
}
