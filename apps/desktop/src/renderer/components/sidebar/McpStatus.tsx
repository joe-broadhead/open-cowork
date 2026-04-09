import { useState } from 'react'
import { useSessionStore } from '../../stores/session'

export function McpStatus() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const [expanded, setExpanded] = useState(false)

  const up = mcpConnections.filter((m) => m.connected).length
  const down = mcpConnections.filter((m) => !m.connected).length
  const total = mcpConnections.length

  if (total === 0) return null

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-[6px] rounded-md text-[13px] text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--color-green)', boxShadow: '0 0 4px var(--color-green)' }} />
            <span className="text-[11px] text-text-muted">{up}</span>
          </div>
          {down > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--color-red)' }} />
              <span className="text-[11px] text-text-muted">{down}</span>
            </div>
          )}
          <span>{total} connections</span>
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
          <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-px ml-1">
          {mcpConnections.map((mcp) => (
            <div key={mcp.name} className="flex items-center gap-2 px-3 py-[3px] text-[11px] text-text-muted">
              <div className="w-[5px] h-[5px] rounded-full shrink-0" style={{
                background: mcp.connected ? 'var(--color-green)' : 'var(--color-red)',
              }} />
              {mcp.name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
