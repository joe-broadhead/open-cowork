export interface ToolTraceMatcher {
  exact?: string[]
  prefixes?: string[]
  contains?: string[]
}

export interface ToolTraceRule {
  id: string
  label: string
  pluralLabel?: string
  match: ToolTraceMatcher[]
}

export interface ToolTraceConfig {
  rules?: ToolTraceRule[]
  additionalRules?: ToolTraceRule[]
}

export const DEFAULT_TOOL_TRACE_RULES: ToolTraceRule[] = [
  { id: 'skill', label: 'skill call', pluralLabel: 'skill calls', match: [{ exact: ['skill'] }] },
  { id: 'task', label: 'delegation', pluralLabel: 'delegations', match: [{ exact: ['task'] }] },
  { id: 'command', label: 'command', pluralLabel: 'commands', match: [{ exact: ['bash', 'command'] }, { contains: ['bash'] }] },
  { id: 'chart', label: 'chart', pluralLabel: 'charts', match: [{ prefixes: ['charts_', 'mcp__charts__'] }] },
  { id: 'time', label: 'time lookup', pluralLabel: 'time lookups', match: [{ prefixes: ['time-keep_', 'mcp__time-keep__'] }] },
  { id: 'skill bundle', label: 'skill bundle action', pluralLabel: 'skill bundle actions', match: [{ prefixes: ['skills_', 'mcp__skills__'] }] },
  { id: 'agent config', label: 'agent config action', pluralLabel: 'agent config actions', match: [{ prefixes: ['agents_', 'mcp__agents__'] }] },
  { id: 'workflow', label: 'workflow action', pluralLabel: 'workflow actions', match: [{ prefixes: ['workflows_', 'mcp__workflows__'] }] },
  { id: 'knowledge', label: 'knowledge action', pluralLabel: 'knowledge actions', match: [{ prefixes: ['knowledge_', 'mcp__knowledge__'] }] },
  { id: 'ui status', label: 'UI status action', pluralLabel: 'UI status actions', match: [{ prefixes: ['semantic-ui_', 'mcp__semantic-ui__'] }] },
  { id: 'query', label: 'query', pluralLabel: 'queries', match: [{ prefixes: ['nova_execute_sql', 'mcp__nova__execute_sql'] }] },
  {
    id: 'inspection',
    label: 'inspection',
    pluralLabel: 'inspections',
    match: [{
      prefixes: ['nova_', 'mcp__nova__'],
      contains: ['get_columns', 'get_entity', 'get_context', 'lineage', 'metadata', 'coverage', 'undocumented', 'health'],
    }],
  },
  { id: 'data lookup', label: 'data lookup', pluralLabel: 'data lookups', match: [{ prefixes: ['nova_', 'mcp__nova__'] }] },
  { id: 'sheet action', label: 'sheet action', pluralLabel: 'sheet actions', match: [{ prefixes: ['google-sheets_', 'mcp__google-sheets__'] }, { contains: ['google-workspace_sheets_'] }] },
  { id: 'doc action', label: 'doc action', pluralLabel: 'doc actions', match: [{ prefixes: ['google-docs_', 'mcp__google-docs__'] }, { contains: ['google-workspace_docs_'] }] },
  { id: 'slide action', label: 'slide action', pluralLabel: 'slide actions', match: [{ prefixes: ['google-slides_', 'mcp__google-slides__'] }, { contains: ['google-workspace_slides_'] }] },
  { id: 'drive action', label: 'drive action', pluralLabel: 'drive actions', match: [{ prefixes: ['google-drive_', 'mcp__google-drive__'] }, { contains: ['google-workspace_drive_'] }] },
  { id: 'email action', label: 'email action', pluralLabel: 'email actions', match: [{ prefixes: ['google-gmail_', 'mcp__google-gmail__'] }, { contains: ['google-workspace_gmail_'] }] },
  { id: 'calendar action', label: 'calendar action', pluralLabel: 'calendar actions', match: [{ prefixes: ['google-calendar_', 'mcp__google-calendar__'] }, { contains: ['google-workspace_calendar_'] }] },
  { id: 'chat action', label: 'chat action', pluralLabel: 'chat actions', match: [{ prefixes: ['google-chat_', 'mcp__google-chat__'] }, { contains: ['google-workspace_chat_'] }] },
  { id: 'contact action', label: 'contact action', pluralLabel: 'contact actions', match: [{ prefixes: ['google-people_', 'mcp__google-people__'] }, { contains: ['google-workspace_people_'] }] },
  { id: 'form action', label: 'form action', pluralLabel: 'form actions', match: [{ prefixes: ['google-forms_', 'mcp__google-forms__'] }, { contains: ['google-workspace_forms_'] }] },
  { id: 'task action', label: 'task action', pluralLabel: 'task actions', match: [{ prefixes: ['google-tasks_', 'mcp__google-tasks__'] }, { contains: ['google-workspace_tasks_'] }] },
  { id: 'script action', label: 'script action', pluralLabel: 'script actions', match: [{ prefixes: ['google-appscript_', 'mcp__google-appscript__'] }, { contains: ['google-workspace_appscript_'] }] },
  { id: 'atlassian search', label: 'atlassian search', pluralLabel: 'atlassian searches', match: [{ prefixes: ['mcp__atlassian-rovo-mcp__', 'atlassian-rovo-mcp_'], contains: ['search', 'query', 'lookup'] }] },
  { id: 'atlassian lookup', label: 'atlassian lookup', pluralLabel: 'atlassian lookups', match: [{ prefixes: ['mcp__atlassian-rovo-mcp__', 'atlassian-rovo-mcp_'], contains: ['get', 'fetch', 'list'] }] },
  { id: 'atlassian action', label: 'atlassian action', pluralLabel: 'atlassian actions', match: [{ prefixes: ['mcp__atlassian-rovo-mcp__', 'atlassian-rovo-mcp_'] }] },
  { id: 'amplitude search', label: 'amplitude search', pluralLabel: 'amplitude searches', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['search', 'query', 'lookup'] }] },
  { id: 'amplitude chart', label: 'amplitude chart action', pluralLabel: 'amplitude chart actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['chart'] }] },
  { id: 'amplitude dashboard', label: 'amplitude dashboard action', pluralLabel: 'amplitude dashboard actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['dashboard'] }] },
  { id: 'amplitude experiment', label: 'amplitude experiment action', pluralLabel: 'amplitude experiment actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['experiment'] }] },
  { id: 'amplitude replay', label: 'amplitude replay action', pluralLabel: 'amplitude replay actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['replay', 'session'] }] },
  { id: 'amplitude feedback', label: 'amplitude feedback action', pluralLabel: 'amplitude feedback actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'], contains: ['feedback'] }] },
  { id: 'amplitude analysis', label: 'amplitude analysis action', pluralLabel: 'amplitude analysis actions', match: [{ prefixes: ['mcp__amplitude__', 'amplitude_'] }] },
  { id: 'github pr', label: 'github PR action', pluralLabel: 'github PR actions', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['pull_request', 'review', 'pr_'] }] },
  { id: 'github issue', label: 'github issue action', pluralLabel: 'github issue actions', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['issue'] }] },
  { id: 'github actions', label: 'github Actions operation', pluralLabel: 'github Actions operations', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['workflow', 'check_run', 'action'] }] },
  { id: 'github security', label: 'github security action', pluralLabel: 'github security actions', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['security', 'secret', 'dependabot', 'advis'] }] },
  { id: 'github org', label: 'github org lookup', pluralLabel: 'github org lookups', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['org', 'team', 'user', 'member'] }] },
  { id: 'github collaboration', label: 'github collaboration action', pluralLabel: 'github collaboration actions', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['project', 'label', 'notification', 'discussion', 'gist'] }] },
  { id: 'github repo', label: 'github repo action', pluralLabel: 'github repo actions', match: [{ prefixes: ['mcp__github__', 'github_'], contains: ['repo', 'file', 'branch', 'commit', 'release', 'tag', 'content'] }] },
  { id: 'github action', label: 'github action', pluralLabel: 'github actions', match: [{ prefixes: ['mcp__github__', 'github_'] }] },
  { id: 'perplexity research', label: 'perplexity research run', pluralLabel: 'perplexity research runs', match: [{ prefixes: ['mcp__perplexity__', 'perplexity_'], contains: ['research'] }] },
  { id: 'perplexity reasoning', label: 'perplexity reasoning run', pluralLabel: 'perplexity reasoning runs', match: [{ prefixes: ['mcp__perplexity__', 'perplexity_'], contains: ['reason'] }] },
  { id: 'perplexity search', label: 'perplexity search', pluralLabel: 'perplexity searches', match: [{ prefixes: ['mcp__perplexity__', 'perplexity_'], contains: ['search'] }] },
  { id: 'perplexity answer', label: 'perplexity answer', pluralLabel: 'perplexity answers', match: [{ prefixes: ['mcp__perplexity__', 'perplexity_'], contains: ['ask'] }] },
  { id: 'web lookup', label: 'web lookup', pluralLabel: 'web lookups', match: [{ exact: ['webfetch'] }, { prefixes: ['web_', 'web-'] }, { contains: ['websearch'] }] },
  { id: 'file read', label: 'file read', pluralLabel: 'file reads', match: [{ exact: ['read'] }, { prefixes: ['read_'] }, { contains: ['_read', '_get', 'view_file'] }] },
  { id: 'file search', label: 'file search', pluralLabel: 'file searches', match: [{ exact: ['grep'] }, { contains: ['grep'] }] },
  { id: 'file scan', label: 'file scan', pluralLabel: 'file scans', match: [{ exact: ['glob'] }, { contains: ['glob'] }] },
  { id: 'directory listing', label: 'directory listing', pluralLabel: 'directory listings', match: [{ exact: ['ls', 'list'] }, { contains: ['list_dir', 'directory_list'] }] },
  { id: 'file edit', label: 'file edit', pluralLabel: 'file edits', match: [{ exact: ['edit', 'write'] }, { contains: ['patch', 'multi_edit', 'str_replace'] }] },
  { id: 'search', label: 'search', pluralLabel: 'searches', match: [{ contains: ['search'] }] },
  { id: 'query', label: 'query', pluralLabel: 'queries', match: [{ contains: ['query'] }] },
  { id: 'inspection', label: 'inspection', pluralLabel: 'inspections', match: [{ contains: ['inspect', 'context'] }] },
]
