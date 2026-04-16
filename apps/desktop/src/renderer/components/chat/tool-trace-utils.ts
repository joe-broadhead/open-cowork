type ToolNameLike = {
  name: string
}

export type ParsedChartOutput =
  | { type: 'vega-lite' | 'vega'; spec: Record<string, unknown>; title?: string }
  | { type: 'mermaid'; diagram: string; title?: string }

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export const AGENT_LABELS: Record<string, string> = {
  build: 'Build',
  general: 'General',
  plan: 'Plan',
  explore: 'Explore',
}

export const SUB_AGENT_IDS = new Set(['general', 'explore'])

export function tryParseChartOutput(output: unknown): ParsedChartOutput | null {
  if (!output) return null

  let parsed: any = output
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output)
    } catch {
      return null
    }
  }

  if ((parsed?.type === 'vega-lite' || parsed?.type === 'vega') && parsed?.spec) {
    if (typeof parsed.spec === 'string') {
      try {
        const spec = asObjectRecord(JSON.parse(parsed.spec))
        if (!spec) return null
        return {
          ...parsed,
          spec,
        }
      } catch {
        return null
      }
    }
    const spec = asObjectRecord(parsed.spec)
    if (!spec) return null
    return {
      ...parsed,
      spec,
    }
  }

  if (parsed?.type === 'mermaid' && parsed?.diagram) return parsed
  return null
}

export function toolCategory(rawName: string) {
  const name = rawName.toLowerCase()

  if (rawName === 'skill') return 'skill'
  if (rawName === 'task') return 'task'

  if (name.includes('bash') || name === 'command') return 'command'

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
  if (name.startsWith('mcp__perplexity__') || name.startsWith('perplexity_')) {
    if (name.includes('research')) return 'perplexity research'
    if (name.includes('reason')) return 'perplexity reasoning'
    if (name.includes('search')) return 'perplexity search'
    if (name.includes('ask')) return 'perplexity answer'
    return 'perplexity research'
  }

  if (name === 'webfetch' || name.startsWith('web_') || name.startsWith('web-') || name.includes('websearch')) return 'web lookup'
  if (name === 'read' || name.startsWith('read_') || name.includes('_read') || name.includes('_get') || name.includes('view_file')) return 'file read'
  if (name === 'grep' || name.includes('grep')) return 'file search'
  if (name === 'glob' || name.includes('glob')) return 'file scan'
  if (name === 'ls' || name === 'list' || name.includes('list_dir') || name.includes('directory_list')) return 'directory listing'
  if (name === 'edit' || name === 'write' || name.includes('patch') || name.includes('multi_edit') || name.includes('str_replace')) return 'file edit'
  if (name.includes('search')) return 'search'
  if (name.includes('query')) return 'query'
  if (name.includes('inspect') || name.includes('context')) return 'inspection'

  return 'tool call'
}

export function summarizeTools(tools: ToolNameLike[]): string {
  const counts: Record<string, number> = {}
  for (const tool of tools) {
    const category = toolCategory(tool.name)
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
    else if (cat === 'perplexity search') parts.push(`${count} ${count === 1 ? 'perplexity search' : 'perplexity searches'}`)
    else if (cat === 'perplexity answer') parts.push(`${count} ${count === 1 ? 'perplexity answer' : 'perplexity answers'}`)
    else if (cat === 'perplexity reasoning') parts.push(`${count} ${count === 1 ? 'perplexity reasoning run' : 'perplexity reasoning runs'}`)
    else if (cat === 'perplexity research') parts.push(`${count} ${count === 1 ? 'perplexity research run' : 'perplexity research runs'}`)
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
