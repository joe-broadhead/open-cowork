import { useState } from 'react'
import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { mcpStatusTone, summarizeMcpConnections } from '../../helpers/mcp-status-summary'
import { t } from '../../helpers/i18n'

const toneColor = {
  muted: 'var(--color-text-muted)',
  success: 'var(--color-green)',
  warning: 'var(--color-amber)',
  error: 'var(--color-red)',
}

export function McpStatusBadge() {
  const connections = useSessionStore((s) => s.mcpConnections)
  const [open, setOpen] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const summary = summarizeMcpConnections(connections)
  if (summary.total === 0) return null

  const tone = mcpStatusTone(summary)
  const failedCount = summary.failed.length
  const needsAuthCount = summary.needsAuth.length
  const label = `${summary.connected.length}/${summary.total} MCP${summary.total === 1 ? '' : 's'}`
  const badgeLabel = [
    label,
    needsAuthCount > 0 ? `${needsAuthCount} auth` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
  ].filter(Boolean).join(' ')

  const handleAction = async (name: string, rawStatus?: string) => {
    setBusyName(name)
    try {
      if (isMcpAuthRequiredStatus(rawStatus)) await window.coworkApi.mcp.auth(name)
      else await window.coworkApi.mcp.connect(name)
    } catch {
      // The next mcp:status poll is the source of truth for failures.
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={badgeLabel}
        className="inline-flex h-[20px] items-center gap-1.5 rounded-md border border-border-subtle px-2 text-2xs text-text-muted hover:bg-surface-hover"
        title={t('mcpStatus.badgeTitle', 'MCP status')}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: toneColor[tone], boxShadow: tone === 'success' ? `0 0 5px ${toneColor[tone]}` : 'none' }}
        />
        <span>{label}</span>
        {needsAuthCount > 0 && <span style={{ color: 'var(--color-amber)' }}>{needsAuthCount} auth</span>}
        {failedCount > 0 && <span style={{ color: 'var(--color-red)' }}>{failedCount} failed</span>}
      </button>
      {open && (
        <div
          className="absolute bottom-[25px] right-0 z-50 w-[260px] rounded-lg border border-border-subtle bg-elevated p-2 text-2xs shadow-xl"
        >
          <div className="mb-1 px-2 py-1 text-2xs font-semibold uppercase text-text-muted">MCP status</div>
          <div className="max-h-[220px] overflow-auto">
            {connections.map((connection) => {
              const needsAuth = isMcpAuthRequiredStatus(connection.rawStatus)
              return (
                <div key={connection.name} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                  <div className="min-w-0">
                    <div className="truncate text-text-secondary">{connection.name}</div>
                    <div className="truncate text-2xs text-text-muted">
                      {connection.connected ? 'connected' : (connection.rawStatus || 'failed').replace(/_/g, ' ')}
                    </div>
                  </div>
                  {!connection.connected && (
                    <button
                      type="button"
                      disabled={busyName === connection.name}
                      onClick={() => handleAction(connection.name, connection.rawStatus)}
                      className="rounded border border-border-subtle px-2 py-1 text-2xs text-accent hover:bg-accent/10 disabled:opacity-50"
                    >
                      {busyName === connection.name ? '...' : needsAuth ? 'Auth' : 'Retry'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
