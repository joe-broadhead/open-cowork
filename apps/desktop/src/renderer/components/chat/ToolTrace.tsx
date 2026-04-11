import { useState, useEffect } from 'react'
import type { ToolCall } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { VegaChart } from './VegaChart'

function tryParseChartOutput(output: unknown): { type: string; spec?: any; diagram?: string; title?: string } | null {
  if (!output) return null
  // Output might be a string (needs parsing) or already an object
  let parsed: any = output
  if (typeof output === 'string') {
    try { parsed = JSON.parse(output) } catch { return null }
  }
  if (parsed?.type === 'vega-lite' && parsed?.spec) return parsed
  if (parsed?.type === 'mermaid' && parsed?.diagram) return parsed
  return null
}

interface Props {
  tools: ToolCall[]
  compact?: boolean
}

const AGENT_LABELS: Record<string, string> = {
  analyst: 'Analyst',
  cowork: 'Cowork',
  plan: 'Plan',
  explore: 'Explore',
  'sheets-builder': 'Sheets',
  'docs-writer': 'Docs',
  'gmail-drafter': 'Gmail',
}

const SUB_AGENT_IDS = new Set(['analyst', 'explore', 'sheets-builder', 'docs-writer', 'gmail-drafter'])

function toolCategory(rawName: string) {
  const name = rawName.toLowerCase()

  if (rawName === 'skill') return 'skill'
  if (rawName === 'task') return 'task'

  if (name.includes('bash') || name === 'command') return 'command'
  if (name === 'webfetch' || name.startsWith('web_') || name.startsWith('web-') || name.includes('websearch')) return 'web lookup'
  if (name === 'read' || name.startsWith('read_') || name.includes('_read') || name.includes('_get') || name.includes('view_file')) return 'file read'
  if (name === 'grep' || name.includes('grep')) return 'file search'
  if (name === 'glob' || name.includes('glob')) return 'file scan'
  if (name === 'ls' || name === 'list' || name.includes('list_dir') || name.includes('directory_list')) return 'directory listing'
  if (name === 'edit' || name === 'write' || name.includes('patch') || name.includes('multi_edit') || name.includes('str_replace')) return 'file edit'
  if (name.includes('search')) return 'search'

  if (name.startsWith('charts_') || name.startsWith('mcp__charts__')) return 'chart'

  if (name.startsWith('nova_execute_sql') || name.startsWith('mcp__nova__execute_sql')) return 'query'
  if (name.startsWith('nova_') || name.startsWith('mcp__nova__')) {
    if (
      name.includes('get_columns')
      || name.includes('get_entity')
      || name.includes('get_context')
      || name.includes('lineage')
      || name.includes('metadata')
      || name.includes('coverage')
      || name.includes('undocumented')
      || name.includes('health')
    ) {
      return 'inspection'
    }
    return 'data lookup'
  }

  if (name.startsWith('google-sheets_') || name.startsWith('mcp__google-sheets__') || name.includes('google-workspace_sheets_')) return 'sheet action'
  if (name.startsWith('google-docs_') || name.startsWith('mcp__google-docs__') || name.includes('google-workspace_docs_')) return 'doc action'
  if (name.startsWith('google-slides_') || name.startsWith('mcp__google-slides__') || name.includes('google-workspace_slides_')) return 'slide action'
  if (name.startsWith('google-drive_') || name.startsWith('mcp__google-drive__') || name.includes('google-workspace_drive_')) return 'drive action'
  if (name.startsWith('google-gmail_') || name.startsWith('mcp__google-gmail__') || name.includes('google-workspace_gmail_')) return 'email action'
  if (name.startsWith('google-calendar_') || name.startsWith('mcp__google-calendar__') || name.includes('google-workspace_calendar_')) return 'calendar action'
  if (name.startsWith('google-chat_') || name.startsWith('mcp__google-chat__') || name.includes('google-workspace_chat_')) return 'chat action'
  if (name.startsWith('google-people_') || name.startsWith('mcp__google-people__') || name.includes('google-workspace_people_')) return 'contact action'
  if (name.startsWith('google-forms_') || name.startsWith('mcp__google-forms__') || name.includes('google-workspace_forms_')) return 'form action'
  if (name.startsWith('google-tasks_') || name.startsWith('mcp__google-tasks__') || name.includes('google-workspace_tasks_')) return 'task action'
  if (name.startsWith('google-appscript_') || name.startsWith('mcp__google-appscript__') || name.includes('google-workspace_appscript_')) return 'automation action'
  if (name.startsWith('mcp__atlassian-rovo-mcp__') || name.startsWith('atlassian-rovo-mcp_')) {
    if (name.includes('search') || name.includes('query') || name.includes('lookup')) return 'atlassian search'
    if (name.includes('get') || name.includes('fetch') || name.includes('list')) return 'atlassian lookup'
    if (name.includes('create') || name.includes('update') || name.includes('comment') || name.includes('transition')) return 'atlassian action'
    return 'atlassian action'
  }
  if (name.startsWith('mcp__amplitude__') || name.startsWith('amplitude_')) {
    if (name.includes('search') || name.includes('query') || name.includes('lookup')) return 'amplitude search'
    if (name.includes('chart')) return 'amplitude chart'
    if (name.includes('dashboard')) return 'amplitude dashboard'
    if (name.includes('experiment')) return 'amplitude experiment'
    if (name.includes('replay') || name.includes('session')) return 'amplitude replay'
    if (name.includes('feedback')) return 'amplitude feedback'
    return 'amplitude analysis'
  }
  if (name.startsWith('mcp__github__') || name.startsWith('github_')) {
    if (name.includes('pull_request') || name.includes('review') || name.includes('pr_')) return 'github pr'
    if (name.includes('issue')) return 'github issue'
    if (name.includes('workflow') || name.includes('check_run') || name.includes('action')) return 'github actions'
    if (name.includes('security') || name.includes('secret') || name.includes('dependabot') || name.includes('advis')) return 'github security'
    if (name.includes('org') || name.includes('team') || name.includes('user') || name.includes('member')) return 'github org'
    if (name.includes('project') || name.includes('label') || name.includes('notification') || name.includes('discussion') || name.includes('gist')) return 'github collaboration'
    if (name.includes('repo') || name.includes('file') || name.includes('branch') || name.includes('commit') || name.includes('release') || name.includes('tag') || name.includes('content')) return 'github repo'
    return 'github action'
  }

  if (name.includes('query')) return 'query'
  if (name.includes('inspect') || name.includes('context')) return 'inspection'

  return 'tool call'
}

export function summarizeTools(tools: ToolCall[]): string {
  const counts: Record<string, number> = {}
  for (const t of tools) {
    const category = toolCategory(t.name)
    counts[category] = (counts[category] || 0) + 1
  }

  const parts: string[] = []
  for (const [cat, count] of Object.entries(counts)) {
    if (cat === 'query') parts.push(`${count} ${count === 1 ? 'query' : 'queries'}`)
    else if (cat === 'search') parts.push(`${count} ${count === 1 ? 'search' : 'searches'}`)
    else if (cat === 'inspection') parts.push(`${count} ${count === 1 ? 'inspection' : 'inspections'}`)
    else if (cat === 'data lookup') parts.push(`${count} ${count === 1 ? 'data lookup' : 'data lookups'}`)
    else if (cat === 'sheet action') parts.push(`${count} ${count === 1 ? 'sheet action' : 'sheet actions'}`)
    else if (cat === 'doc action') parts.push(`${count} ${count === 1 ? 'doc action' : 'doc actions'}`)
    else if (cat === 'slide action') parts.push(`${count} ${count === 1 ? 'slide action' : 'slide actions'}`)
    else if (cat === 'drive action') parts.push(`${count} ${count === 1 ? 'drive action' : 'drive actions'}`)
    else if (cat === 'email action') parts.push(`${count} ${count === 1 ? 'email action' : 'email actions'}`)
    else if (cat === 'calendar action') parts.push(`${count} ${count === 1 ? 'calendar action' : 'calendar actions'}`)
    else if (cat === 'chat action') parts.push(`${count} ${count === 1 ? 'chat action' : 'chat actions'}`)
    else if (cat === 'contact action') parts.push(`${count} ${count === 1 ? 'contact action' : 'contact actions'}`)
    else if (cat === 'form action') parts.push(`${count} ${count === 1 ? 'form action' : 'form actions'}`)
    else if (cat === 'task action') parts.push(`${count} ${count === 1 ? 'task action' : 'task actions'}`)
    else if (cat === 'automation action') parts.push(`${count} ${count === 1 ? 'automation action' : 'automation actions'}`)
    else if (cat === 'atlassian search') parts.push(`${count} ${count === 1 ? 'atlassian search' : 'atlassian searches'}`)
    else if (cat === 'atlassian lookup') parts.push(`${count} ${count === 1 ? 'atlassian lookup' : 'atlassian lookups'}`)
    else if (cat === 'atlassian action') parts.push(`${count} ${count === 1 ? 'atlassian action' : 'atlassian actions'}`)
    else if (cat === 'amplitude search') parts.push(`${count} ${count === 1 ? 'amplitude search' : 'amplitude searches'}`)
    else if (cat === 'amplitude chart') parts.push(`${count} ${count === 1 ? 'amplitude chart action' : 'amplitude chart actions'}`)
    else if (cat === 'amplitude dashboard') parts.push(`${count} ${count === 1 ? 'amplitude dashboard action' : 'amplitude dashboard actions'}`)
    else if (cat === 'amplitude experiment') parts.push(`${count} ${count === 1 ? 'amplitude experiment action' : 'amplitude experiment actions'}`)
    else if (cat === 'amplitude replay') parts.push(`${count} ${count === 1 ? 'amplitude replay action' : 'amplitude replay actions'}`)
    else if (cat === 'amplitude feedback') parts.push(`${count} ${count === 1 ? 'amplitude feedback action' : 'amplitude feedback actions'}`)
    else if (cat === 'amplitude analysis') parts.push(`${count} ${count === 1 ? 'amplitude analysis action' : 'amplitude analysis actions'}`)
    else if (cat === 'github repo') parts.push(`${count} ${count === 1 ? 'github repo action' : 'github repo actions'}`)
    else if (cat === 'github issue') parts.push(`${count} ${count === 1 ? 'github issue action' : 'github issue actions'}`)
    else if (cat === 'github pr') parts.push(`${count} ${count === 1 ? 'github PR action' : 'github PR actions'}`)
    else if (cat === 'github actions') parts.push(`${count} ${count === 1 ? 'github Actions operation' : 'github Actions operations'}`)
    else if (cat === 'github security') parts.push(`${count} ${count === 1 ? 'github security action' : 'github security actions'}`)
    else if (cat === 'github org') parts.push(`${count} ${count === 1 ? 'github org lookup' : 'github org lookups'}`)
    else if (cat === 'github collaboration') parts.push(`${count} ${count === 1 ? 'github collaboration action' : 'github collaboration actions'}`)
    else if (cat === 'github action') parts.push(`${count} ${count === 1 ? 'github action' : 'github actions'}`)
    else if (cat === 'file read') parts.push(`${count} ${count === 1 ? 'file read' : 'file reads'}`)
    else if (cat === 'file search') parts.push(`${count} ${count === 1 ? 'file search' : 'file searches'}`)
    else if (cat === 'file scan') parts.push(`${count} ${count === 1 ? 'file scan' : 'file scans'}`)
    else if (cat === 'directory listing') parts.push(`${count} ${count === 1 ? 'directory listing' : 'directory listings'}`)
    else if (cat === 'file edit') parts.push(`${count} ${count === 1 ? 'file edit' : 'file edits'}`)
    else if (cat === 'web lookup') parts.push(`${count} ${count === 1 ? 'web lookup' : 'web lookups'}`)
    else if (cat === 'chart') parts.push(`${count} ${count === 1 ? 'chart' : 'charts'}`)
    else parts.push(`${count} ${cat}${count > 1 ? 's' : ''}`)
  }
  return parts.join(', ')
}

export function ToolTrace({ tools, compact = false }: Props) {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const allDone = tools.every((t) => t.status === 'complete' || t.status === 'error')
  const [expanded, setExpanded] = useState(!allDone)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)

  // Auto-expand while running so user sees progress
  useEffect(() => {
    if (!allDone) setExpanded(true)
  }, [allDone, tools.length])

  const toolAgents = tools.map((tool) => tool.agent).filter(Boolean) as string[]
  const agentName = toolAgents[0] || activeAgent || null

  const agentLabel = agentName ? AGENT_LABELS[agentName] || agentName : null
  const actorTypeLabel = agentName && SUB_AGENT_IDS.has(agentName) ? 'Sub-Agent' : 'Agent'

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {agentLabel && (
          <>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.06em] border"
              style={{
                background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                color: 'var(--color-text-secondary)',
                borderColor: 'var(--color-border)',
              }}
            >
              {actorTypeLabel}
            </span>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              }}
            >
              {agentLabel}
            </span>
          </>
        )}
        <span className="text-[11px] text-text-muted">{summarizeTools(tools)}</span>
      </div>
    )
  }

  return (
    <div className="py-px">
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
          <>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.06em] border"
              style={{
                background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                color: 'var(--color-text-secondary)',
                borderColor: 'var(--color-border)',
              }}
            >
              {actorTypeLabel}
            </span>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              }}
            >
              {agentLabel}
            </span>
          </>
        )}
        <span className="font-medium group-hover:text-text-secondary transition-colors">
          {summarizeTools(tools)}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"
          style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}
        >
          <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
        </svg>
      </button>

      {/* Charts always visible regardless of expand state */}
      {tools.map((tool) => {
        const chart = tryParseChartOutput(tool.output)
        if (chart?.type === 'vega-lite' && chart.spec) {
          return (
            <div key={`chart-${tool.id}`} className="mt-1 mb-1 rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
              <VegaChart spec={chart.spec} />
            </div>
          )
        }
        // Image attachments always visible
        if (tool.attachments?.some(a => a.mime?.startsWith('image/'))) {
          return (
            <div key={`att-${tool.id}`}>
              {tool.attachments.filter(a => a.mime?.startsWith('image/')).map((att, i) => (
                <div key={i} className="mt-1 mb-1">
                  <img src={att.url} alt={att.filename || 'attachment'} className="rounded-lg max-w-full border border-border-subtle" style={{ maxHeight: 400 }} />
                </div>
              ))}
            </div>
          )
        }
        return null
      })}

      {/* Tool list (expandable details) */}
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
                    {tool.output != null && !tryParseChartOutput(tool.output) && (
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
