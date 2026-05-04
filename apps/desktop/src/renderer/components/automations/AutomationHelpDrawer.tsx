import { useRef } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { useFocusTrap } from '../../hooks/useFocusTrap'

type Props = {
  onClose: () => void
}

export function AutomationHelpDrawer({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, { onEscape: onClose })
  return (
    <>
      <ModalBackdrop onDismiss={onClose} className="fixed inset-0 z-40 bg-black/30" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-help-title"
        className="fixed bottom-0 right-0 top-0 z-50 flex w-[460px] max-w-full flex-col border-l border-border-subtle shadow-2xl"
        style={{ background: 'var(--color-base)' }}
      >
        <div className="border-b border-border-subtle px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">How it works</div>
              <h2 id="automation-help-title" className="mt-1 text-[20px] font-semibold text-text">Standing agent programs</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Close help" className="text-[22px] leading-none text-text-muted hover:text-text cursor-pointer">x</button>
          </div>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          {[
            ['1. Enrich', 'Cowork routes the raw ask through OpenCode plan and turns it into an execution-ready brief.'],
            ['2. Review', 'Approvals, missing context, and failures become Inbox items so the automation pauses instead of guessing.'],
            ['3. Execute', 'Approved work runs through OpenCode build and specialist subagents, then lands as in-app delivery.'],
          ].map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-border-subtle p-4" style={{ background: 'var(--color-elevated)' }}>
              <div className="text-[13px] font-semibold text-text">{title}</div>
              <div className="mt-2 text-[12px] leading-6 text-text-secondary">{body}</div>
            </div>
          ))}
          <div className="rounded-2xl border border-border-subtle p-4 text-[12px] leading-6 text-text-secondary">
            Drag a card to another lifecycle column when the board offers a valid shortcut. Risky actions ask for confirmation before Cowork calls the existing automation action.
          </div>
        </div>
      </aside>
    </>
  )
}
