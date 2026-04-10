import type { PendingApproval } from '../../stores/session'
import { useSessionStore } from '../../stores/session'

// Map tool names to user-friendly descriptions
function describeAction(tool: string, input: Record<string, unknown>): { verb: string; detail: string } {
  const name = tool.toLowerCase()
  if (name.includes('gmail') || name.includes('send') || name.includes('email')) {
    const to = input.to as string || ''
    const subject = input.subject as string || ''
    return { verb: 'Send email', detail: to ? `To: ${to}${subject ? ` — "${subject}"` : ''}` : '' }
  }
  if (name.includes('sheets') && name.includes('create')) {
    return { verb: 'Create spreadsheet', detail: (input.title as string) || '' }
  }
  if (name.includes('docs') && name.includes('create')) {
    return { verb: 'Create document', detail: (input.title as string) || '' }
  }
  if (name.includes('slides') && name.includes('create')) {
    return { verb: 'Create presentation', detail: (input.title as string) || '' }
  }
  if (name.includes('delete')) {
    return { verb: 'Delete', detail: tool }
  }
  if (name.includes('share') || name.includes('permission')) {
    return { verb: 'Share file', detail: (input.emailAddress as string) || '' }
  }
  if (name.includes('calendar') && name.includes('create')) {
    return { verb: 'Create event', detail: (input.summary as string) || '' }
  }
  return { verb: 'Allow action', detail: tool }
}

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const removeApproval = useSessionStore((s) => s.removeApproval)

  const respond = async (allowed: boolean) => {
    try {
      await window.cowork.permission.respond(approval.id, allowed)
      removeApproval(approval.id)
    } catch {}
  }

  const { verb, detail } = describeAction(approval.tool, approval.input)

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'color-mix(in srgb, var(--color-amber) 25%, var(--color-border))' }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-amber)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 1.5L12 11.5H2L7 1.5Z" /><line x1="7" y1="5.5" x2="7" y2="8" /><circle cx="7" cy="9.5" r="0.4" fill="var(--color-amber)" />
            </svg>
          </div>
          <div>
            <div className="text-[13px] font-medium text-text">{verb}</div>
            {detail && <div className="text-[11px] text-text-muted">{detail}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => respond(false)} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary bg-surface-hover hover:bg-surface-active transition-colors cursor-pointer">
            Deny
          </button>
          <button onClick={() => respond(true)} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white transition-colors cursor-pointer" style={{ background: 'var(--color-green)' }}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
