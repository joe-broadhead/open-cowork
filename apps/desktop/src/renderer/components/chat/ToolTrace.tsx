import { useState, useEffect } from 'react'
import type { ToolCall } from '../../stores/session'
import { useSessionStore } from '../../stores/session'

interface Props {
  tools: ToolCall[]
}

const AGENT_LABELS: Record<string, string> = {
  analyst: 'Analyst',
  workspace: 'Workspace',
  build: 'Build',
  plan: 'Plan',
  explore: 'Explore',
}

function summarize(tools: ToolCall[]): string {
  const counts: Record<string, number> = {}
  for (const t of tools) {
    const name = t.name
      .replace(/^(mcp__)?nova_/, '')
      .replace(/^(mcp__)?google-workspace_/, 'gws:')
      .replace(/^(mcp__)?google-\w+_/, 'gws:')
      .replace('execute_sql', 'query')
      .replace('get_columns', 'inspect')
      .replace('get_entity', 'inspect')
      .replace('get_lineage', 'lineage')
      .replace('get_context', 'context')
      .replace('find_by_path', 'find')

    const category = name.includes('search') ? 'search'
      : name.includes('query') ? 'query'
      : name.includes('read') ? 'read'
      : name.includes('bash') ? 'command'
      : name.includes('grep') ? 'search'
      : name.includes('inspect') || name.includes('context') ? 'inspection'
      : name.includes('sheets') || name.includes('create') ? 'sheets'
      : name.includes('email') || name.includes('send') || name.includes('gmail') ? 'email'
      : name === 'skill' ? 'skill'
      : name === 'task' ? 'task'
      : 'tool call'

    counts[category] = (counts[category] || 0) + 1
  }

  const parts: string[] = []
  for (const [cat, count] of Object.entries(counts)) {
    if (cat === 'query') parts.push(`${count} ${count === 1 ? 'query' : 'queries'}`)
    else if (cat === 'search') parts.push(`${count} ${count === 1 ? 'search' : 'searches'}`)
    else if (cat === 'inspection') parts.push(`${count} ${count === 1 ? 'inspection' : 'inspections'}`)
    else parts.push(`${count} ${cat}${count > 1 ? 's' : ''}`)
  }
  return parts.join(', ')
}

export function ToolTrace({ tools }: Props) {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const allDone = tools.every((t) => t.status === 'complete' || t.status === 'error')
  const [expanded, setExpanded] = useState(!allDone)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)

  // Auto-expand while running so user sees progress
  useEffect(() => {
    if (!allDone) setExpanded(true)
  }, [allDone, tools.length])

  // Detect agent from tool names (Nova tools = analyst, Google tools = workspace)
  const agentName = tools.some(t => t.name.includes('nova'))
    ? 'analyst'
    : tools.some(t => t.name.includes('google') || t.name.includes('gmail') || t.name.includes('sheets') || t.name.includes('calendar') || t.name.includes('drive'))
    ? 'workspace'
    : activeAgent || null

  const agentLabel = agentName ? AGENT_LABELS[agentName] || agentName : null

  return (
    <div className="py-1">
      {/* Summary line with agent badge */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[12px] cursor-pointer group"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {!allDone && (
          <span className="inline-block w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }} />
        )}
        {agentLabel && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              background: agentName === 'analyst' ? 'rgba(79, 143, 247, 0.12)' : 'rgba(52, 211, 153, 0.12)',
              color: agentName === 'analyst' ? 'var(--color-accent)' : 'var(--color-green)',
            }}>
            {agentLabel}
          </span>
        )}
        <span className="font-medium group-hover:text-text-secondary transition-colors">
          {summarize(tools)}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"
          style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}
        >
          <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
        </svg>
      </button>

      {/* Tool list */}
      {expanded && (
        <div className="mt-1.5 ml-0.5 flex flex-col gap-0.5">
          {tools.map((tool) => {
            const statusIcon = tool.status === 'complete' ? '✓'
              : tool.status === 'error' ? '✗' : '…'
            const statusColor = tool.status === 'complete' ? 'var(--color-text-muted)'
              : tool.status === 'error' ? 'var(--color-red)' : 'var(--color-accent)'
            const isToolExpanded = expandedToolId === tool.id

            return (
              <div key={tool.id}>
                <button
                  onClick={() => setExpandedToolId(isToolExpanded ? null : tool.id)}
                  className="flex items-center gap-1.5 text-[11px] leading-relaxed cursor-pointer hover:text-text-secondary transition-colors w-full text-left"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <span style={{ color: statusColor }}>{statusIcon}</span>
                  <span className="font-mono">{tool.name}</span>
                  {isToolExpanded ? (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3" /></svg>
                  ) : (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="3,2 5.5,4 3,6" /></svg>
                  )}
                </button>

                {isToolExpanded && (
                  <div className="ml-4 mt-1 mb-2 rounded-lg border border-border-subtle bg-surface overflow-hidden">
                    {Object.keys(tool.input || {}).length > 0 && (
                      <div className="px-3 py-2 border-b border-border-subtle">
                        <div className="text-[10px] font-medium text-text-muted mb-1">Input</div>
                        <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                          {JSON.stringify(tool.input, null, 2)}
                        </pre>
                      </div>
                    )}
                    {tool.output != null && (
                      <div className="px-3 py-2">
                        <div className="text-[10px] font-medium text-text-muted mb-1">Output</div>
                        <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
                          {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    {Object.keys(tool.input || {}).length === 0 && tool.output == null && (
                      <div className="px-3 py-2 text-[10px] text-text-muted">No details available</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
