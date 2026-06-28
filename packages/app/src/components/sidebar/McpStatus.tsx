import { useState } from 'react'
import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { summarizeMcpConnections } from '../../helpers/mcp-status-summary'
import { Button, Icon } from '../ui'

export function McpStatus() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const [expanded, setExpanded] = useState(false)
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  const summary = summarizeMcpConnections(mcpConnections)
  const up = summary.connected.length
  const down = summary.needsAuth.length + summary.failed.length
  const total = summary.total

  if (total === 0) return null

  const handleReconnect = async (name: string, rawStatus?: string) => {
    setReconnecting(name)
    try {
      if (isMcpAuthRequiredStatus(rawStatus)) {
        await window.coworkApi.mcp.auth(name)
      } else {
        await window.coworkApi.mcp.connect(name)
      }
    } catch {
      // Connection failures are reflected in the next MCP status poll.
    }
    setReconnecting(null)
  }

  return (
    <div>
      <Button
        onClick={() => setExpanded(!expanded)}
        className="w-full justify-between"
        variant="ghost"
        size="sm"
        rightIcon={expanded ? 'chevron-down' : 'chevron-right'}
        aria-label={`${up} ${down} ${total} connections`}
      >
        <span className="flex items-center gap-2">
          <span
            className={`mcp-dot ${down > 0 ? (up === 0 ? 'mcp-dot--down' : 'mcp-dot--degraded') : 'mcp-dot--up'}`}
            aria-hidden
          />
          <span className="tabular font-[560] text-text-secondary text-2xs">
            <span key={up} className="mcp-count inline-block">{up}</span>
            <span className="text-text-muted font-normal">/{total}</span>
          </span>
          <span className="text-2xs uppercase tracking-[0.06em] font-[560] text-text-muted">connections</span>
        </span>
      </Button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-px ms-1">
          {mcpConnections.map((mcp) => {
            const needsAuth = isMcpAuthRequiredStatus(mcp.rawStatus)
            return (
              <div key={mcp.name} className="relative flex items-center justify-between px-3 py-1.5 rounded-[7px] text-2xs text-text-secondary hover:bg-surface-hover transition-colors group/mcp">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex w-4 justify-center shrink-0">
                    {reconnecting === mcp.name ? (
                      <Icon name="loader-circle" size={16} className="text-accent animate-[ui-spin_800ms_linear_infinite]" />
                    ) : (
                      <span
                        className={`mcp-dot ${mcp.connected ? 'mcp-dot--up-static' : (needsAuth ? 'mcp-dot--degraded' : 'mcp-dot--down')}`}
                        aria-hidden
                      />
                    )}
                  </span>
                  <span className="truncate">{mcp.name}</span>
                  {!mcp.connected && mcp.rawStatus && (
                    <span className="text-2xs font-medium uppercase tracking-[0.05em] text-text-muted shrink-0">
                      {mcp.rawStatus.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
                {!mcp.connected && (
                  <Button
                    onClick={() => handleReconnect(mcp.name, mcp.rawStatus)}
                    disabled={reconnecting === mcp.name}
                    size="sm"
                    variant="ghost"
                    loading={reconnecting === mcp.name}
                    className={`shrink-0 group-hover/mcp:text-accent ${needsAuth ? 'opacity-0 group-hover/mcp:opacity-100 focus-within:opacity-100 transition-opacity duration-150' : ''}`}
                  >
                    {needsAuth ? 'Re-auth' : 'Retry'}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
