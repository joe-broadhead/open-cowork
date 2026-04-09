import type { PendingApproval } from '../../stores/session'
import { useSessionStore } from '../../stores/session'

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const removeApproval = useSessionStore((s) => s.removeApproval)

  const respond = async (allowed: boolean) => {
    try {
      await window.cowork.permission.respond(approval.id, allowed)
      removeApproval(approval.id)
    } catch (err) {
      console.error('Permission response failed:', err)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden" style={{ borderColor: 'color-mix(in srgb, var(--color-amber) 25%, var(--color-border))' }}>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--color-amber)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6.5 1.5L11.5 10.5H1.5L6.5 1.5Z" />
          <line x1="6.5" y1="5" x2="6.5" y2="7" />
          <circle cx="6.5" cy="8.5" r="0.4" fill="var(--color-amber)" />
        </svg>
        <span className="text-[12px] font-medium" style={{ color: 'var(--color-amber)' }}>Approval</span>
        <span className="text-[12px] text-text-secondary">{approval.tool}</span>
      </div>
      <div className="px-3.5 py-2.5 text-[13px] text-text">
        {approval.description}
      </div>
      {Object.keys(approval.input).length > 0 && (
        <div className="px-3.5 pb-2.5">
          <pre className="p-2.5 rounded-md bg-base text-[11px] font-mono text-text-secondary overflow-x-auto">
            {JSON.stringify(approval.input, null, 2)}
          </pre>
        </div>
      )}
      <div className="flex justify-end gap-2 px-3.5 py-2.5 border-t border-border">
        <button onClick={() => respond(false)} className="px-3 py-1 rounded-md text-[12px] font-medium text-text-secondary bg-surface-hover hover:bg-surface-active transition-colors cursor-pointer">
          Deny
        </button>
        <button onClick={() => respond(true)} className="px-3 py-1 rounded-md text-[12px] font-medium text-white transition-colors cursor-pointer" style={{ background: 'var(--color-green)' }}>
          Approve
        </button>
      </div>
    </div>
  )
}
