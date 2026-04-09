import { useState } from 'react'
import { useSessionStore } from '../../stores/session'

export function McpStatus() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const [authInProgress, setAuthInProgress] = useState<string | null>(null)

  const handleAuth = async (name: string) => {
    setAuthInProgress(name)
    try {
      await window.cowork.mcp.auth(name)
    } catch (err) {
      console.error('MCP auth failed:', err)
    } finally {
      setAuthInProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-px">
      {mcpConnections.map((mcp) => (
        <div key={mcp.name} className="flex items-center justify-between px-3 py-[6px] rounded-md text-[13px] text-text-secondary">
          <div className="flex items-center gap-2.5">
            <div
              className="w-[6px] h-[6px] rounded-full shrink-0"
              style={{
                background: mcp.connected ? 'var(--color-green)' : 'var(--color-text-muted)',
                boxShadow: mcp.connected ? '0 0 5px var(--color-green)' : 'none',
              }}
            />
            {mcp.name}
          </div>
          {!mcp.connected && (
            <button
              onClick={() => handleAuth(mcp.name)}
              disabled={authInProgress === mcp.name}
              className="text-[10px] px-1.5 py-0.5 rounded text-accent hover:text-accent-hover cursor-pointer"
            >
              {authInProgress === mcp.name ? '...' : 'Connect'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
