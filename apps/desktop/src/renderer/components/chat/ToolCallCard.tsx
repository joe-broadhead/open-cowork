import { useState } from 'react'
import type { ToolCall } from '../../stores/session'

export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  const statusColor =
    toolCall.status === 'complete' ? 'var(--color-green)'
    : toolCall.status === 'error' ? 'var(--color-red)'
    : 'var(--color-accent)'

  const statusText =
    toolCall.status === 'complete' ? 'Done' : toolCall.status === 'error' ? 'Error' : 'Running'

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-[12px] hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 text-text-secondary">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M7 1L10.5 4.5L4 11H1V8L7 1Z" />
          </svg>
          <span className="font-medium text-text">{toolCall.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ color: statusColor, background: `color-mix(in srgb, ${statusColor} 12%, transparent)` }}>
            {statusText}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-text-muted" style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
            <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="px-3.5 pb-3 border-t border-border">
          <pre className="mt-2.5 p-2.5 rounded-md bg-base text-[11px] font-mono text-text-secondary overflow-x-auto">
            {JSON.stringify(toolCall.input, null, 2)}
          </pre>
          {toolCall.output != null && (
            <pre className="mt-2 p-2.5 rounded-md bg-base text-[11px] font-mono text-text-secondary overflow-x-auto">
              {typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
