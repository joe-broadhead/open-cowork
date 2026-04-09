import { useState } from 'react'
import type { ToolCall } from '../../stores/session'

interface Props {
  tools: ToolCall[]
}

function summarize(tools: ToolCall[]): string {
  const counts: Record<string, number> = {}
  for (const t of tools) {
    // Simplify tool names: "nova_execute_sql" -> "query", "nova_search" -> "search", etc.
    const name = t.name
      .replace(/^(mcp__)?nova_/, '')
      .replace(/^(mcp__)?google-workspace_/, 'gws:')
      .replace('execute_sql', 'query')
      .replace('get_columns', 'inspect')
      .replace('get_entity', 'inspect')
      .replace('get_lineage', 'lineage')
      .replace('get_context', 'context')
      .replace('find_by_path', 'find')
      .replace('sheets_create', 'sheets')
      .replace('sheets_append', 'sheets')
      .replace('gmail_send', 'email')
      .replace('gmail_list', 'email')

    const category = name.includes('search') ? 'search'
      : name.includes('query') ? 'query'
      : name.includes('read') ? 'read'
      : name.includes('bash') ? 'command'
      : name.includes('grep') ? 'search'
      : name.includes('inspect') || name.includes('context') ? 'inspect'
      : name.includes('sheets') ? 'sheets'
      : name.includes('email') ? 'email'
      : 'tool'

    counts[category] = (counts[category] || 0) + 1
  }

  const parts: string[] = []
  for (const [cat, count] of Object.entries(counts)) {
    if (cat === 'query') parts.push(`${count} ${count === 1 ? 'query' : 'queries'}`)
    else if (cat === 'search') parts.push(`${count} ${count === 1 ? 'search' : 'searches'}`)
    else if (cat === 'read') parts.push(`${count} ${count === 1 ? 'file read' : 'file reads'}`)
    else if (cat === 'command') parts.push(`${count} ${count === 1 ? 'command' : 'commands'}`)
    else if (cat === 'inspect') parts.push(`${count} ${count === 1 ? 'inspection' : 'inspections'}`)
    else if (cat === 'sheets') parts.push(`${count} sheets ${count === 1 ? 'action' : 'actions'}`)
    else if (cat === 'email') parts.push(`${count} ${count === 1 ? 'email' : 'emails'}`)
    else parts.push(`${count} ${count === 1 ? 'tool call' : 'tool calls'}`)
  }

  return parts.join(', ')
}

export function ToolTrace({ tools }: Props) {
  const [expanded, setExpanded] = useState(false)
  const allDone = tools.every((t) => t.status === 'complete' || t.status === 'error')
  const hasError = tools.some((t) => t.status === 'error')

  return (
    <div className="py-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[12px] cursor-pointer group"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {!allDone && (
          <span className="inline-block w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--color-text-muted)', borderTopColor: 'transparent' }} />
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

      {expanded && (
        <div className="mt-1.5 ml-0.5 flex flex-col gap-0.5">
          {tools.map((tool) => {
            const statusIcon = tool.status === 'complete' ? '✓'
              : tool.status === 'error' ? '✗'
              : '…'
            const statusColor = tool.status === 'complete' ? 'var(--color-text-muted)'
              : tool.status === 'error' ? 'var(--color-red)'
              : 'var(--color-text-muted)'

            // Build description from tool name and key input
            const inputSummary = tool.input
              ? Object.entries(tool.input)
                  .filter(([k]) => ['query', 'statement', 'id_or_name', 'title', 'to', 'command'].includes(k))
                  .map(([, v]) => String(v).slice(0, 80))
                  .join(' ')
              : ''

            return (
              <div key={tool.id} className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                <span style={{ color: statusColor }}>{statusIcon}</span>
                {' '}
                <span>{tool.name}</span>
                {inputSummary && (
                  <span className="ml-1 opacity-60">{inputSummary.slice(0, 100)}{inputSummary.length > 100 ? '…' : ''}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
