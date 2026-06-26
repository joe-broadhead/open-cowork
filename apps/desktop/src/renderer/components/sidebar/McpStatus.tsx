import { useState } from 'react'
import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { summarizeMcpConnections } from '../../helpers/mcp-status-summary'
import { Badge, Button, Icon } from '../ui'

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
          <Badge tone="success">{up}</Badge>
          {down > 0 && (
            <Badge tone="danger">{down}</Badge>
          )}
          <span>{total} connections</span>
        </span>
      </Button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-px ms-1">
          {mcpConnections.map((mcp) => {
            const needsAuth = isMcpAuthRequiredStatus(mcp.rawStatus)
            return (
              <div key={mcp.name} className="flex items-center justify-between px-3 py-[3px] text-2xs text-text-muted group/mcp">
                <div className="flex items-center gap-2">
                  <Icon name={mcp.connected ? 'check' : 'circle-x'} size={16} className={mcp.connected ? 'text-text-muted' : 'text-red'} />
                  {mcp.name}
                  {!mcp.connected && mcp.rawStatus && (
                    <span className="text-2xs font-medium uppercase tracking-[0.05em] text-text-muted">
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
