type BundleSkill = {
  name: string
  description: string
  badge: 'Skill'
  sourceName: string
}

type BundleApp = {
  name: string
  description: string
  badge: 'App'
}

export type BundleCredentialKey = 'githubToken'

type BundleCredential = {
  key: BundleCredentialKey
  label: string
  description: string
  placeholder?: string
  secret: boolean
}

type BundleHeaderSetting = {
  header: string
  key: BundleCredentialKey
  prefix?: string
}

export type BundleMcp = {
  name: string
  type: 'local' | 'remote'
  description: string
  authMode: 'none' | 'oauth' | 'api_token'
  packageName?: string
  url?: string
  headers?: Record<string, string>
  headerSettings?: BundleHeaderSetting[]
}

export type IntegrationBundle = {
  id: string
  name: string
  icon: string
  description: string
  longDescription?: string
  category: 'Analytics' | 'Productivity' | 'Communication' | 'Developer' | 'Custom'
  author: string
  version: string
  builtin: true
  enabledByDefault: boolean
  apps: BundleApp[]
  skills: BundleSkill[]
  credentials?: BundleCredential[]
  mcps: BundleMcp[]
  allowedTools: string[]
  deniedTools: string[]
}

const VERSION = '1.0.0'

export const BUILTIN_INTEGRATION_BUNDLES: IntegrationBundle[] = [
  {
    id: 'nova-analytics',
    name: 'Nova Analytics',
    icon: 'nova',
    description: 'Query your datalake, discover metrics, and generate reports',
    longDescription: 'Use Nova to search for business metrics and KPIs, execute SQL queries against the data warehouse, validate data quality and lineage, and generate standardized analytical reports with YoY comparisons.',
    category: 'Analytics',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: true,
    apps: [
      { name: 'Nova Datalake', description: 'Search, query, and analyze data from the company datalake via SQL', badge: 'App' },
    ],
    skills: [
      { name: 'Analyst', description: 'Structured workflow for metric discovery, validation, SQL execution, and evidence-based reporting', badge: 'Skill', sourceName: 'analyst' },
      { name: 'Engineer', description: 'Build and modify dbt models with quality gates, impact analysis, and ship checklists', badge: 'Skill', sourceName: 'engineer' },
      { name: 'Governance', description: 'Deterministic metadata audits, compliance gates, and remediation queues', badge: 'Skill', sourceName: 'governance' },
    ],
    mcps: [
      {
        name: 'nova',
        type: 'remote',
        description: 'Remote Nova MCP for warehouse discovery, SQL, lineage, and metadata',
        authMode: 'oauth',
        url: 'https://nova-auth-gateway-aupbaemtcq-ew.a.run.app/mcp',
      },
    ],
    allowedTools: ['mcp__nova__*'],
    deniedTools: ['bash', 'edit', 'write'],
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    icon: 'google',
    description: 'Work across Drive, Docs, Sheets, Gmail, and Calendar',
    longDescription: 'Use Google Workspace as one unified plugin for search, file organization, sharing, Google Docs, Google Sheets, Gmail, and Calendar workflows.',
    category: 'Productivity',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: true,
    apps: [
      { name: 'Gmail', description: 'Send, draft, triage, search, threads, labels, filters, vacation (27 tools)', badge: 'App' },
      { name: 'Google Drive', description: 'Files, folders, permissions, comments, revisions, sharing (23 tools)', badge: 'App' },
      { name: 'Google Docs', description: 'Create, edit, format, tables, headers, footers, page breaks (22 tools)', badge: 'App' },
      { name: 'Google Sheets', description: 'Create, read, write, format, charts, multi-tab workbooks (20 tools)', badge: 'App' },
      { name: 'Google Slides', description: 'Create decks, slides, shapes, images, tables, styling (18 tools)', badge: 'App' },
      { name: 'Google Chat', description: 'Spaces, messages, members, reactions, DM lookup (18 tools)', badge: 'App' },
      { name: 'Google Calendar', description: 'Events, calendars, free/busy, attendees, colors (16 tools)', badge: 'App' },
      { name: 'Google People', description: 'Contacts, directory, groups, batch operations (16 tools)', badge: 'App' },
      { name: 'Google Tasks', description: 'Task lists, tasks, subtasks, reorder, complete (15 tools)', badge: 'App' },
      { name: 'Google Apps Script', description: 'Create, deploy, run, version, manage projects (18 tools)', badge: 'App' },
      { name: 'Google Forms', description: 'Create forms, add questions, collect responses (9 tools)', badge: 'App' },
    ],
    skills: [
      { name: 'Sheets Reporting', description: 'Build professional formatted reports with headers, formatting, charts, and multi-tab workbooks', badge: 'Skill', sourceName: 'sheets-reporting' },
      { name: 'Docs Writing', description: 'Create structured documents with headings, tables, formatting, and template patterns', badge: 'Skill', sourceName: 'docs-writing' },
      { name: 'Slides Presentations', description: 'Build professional slide decks with shapes, images, tables, and template patterns', badge: 'Skill', sourceName: 'slides-presentations' },
      { name: 'Gmail Management', description: 'Triage inbox, drafts, filters, vacation, labels', badge: 'Skill', sourceName: 'gmail-management' },
      { name: 'Calendar Scheduling', description: 'Schedule meetings, check availability, manage calendars', badge: 'Skill', sourceName: 'calendar-scheduling' },
      { name: 'Drive Files', description: 'Search, share, export, manage permissions and revisions', badge: 'Skill', sourceName: 'drive-files' },
      { name: 'Chat Messaging', description: 'Send messages, manage spaces, members, reactions', badge: 'Skill', sourceName: 'chat-messaging' },
      { name: 'Forms Surveys', description: 'Create forms, add questions, review responses', badge: 'Skill', sourceName: 'forms-surveys' },
      { name: 'Tasks Planning', description: 'Manage task lists and to-dos', badge: 'Skill', sourceName: 'tasks-planning' },
      { name: 'Contacts Directory', description: 'Search contacts and company directory', badge: 'Skill', sourceName: 'contacts-directory' },
      { name: 'Charts Visualization', description: 'Create bar charts, line charts, diagrams, and custom visualizations', badge: 'Skill', sourceName: 'charts-visualization' },
      { name: 'Apps Script Automation', description: 'Create scripts, deploy, run automations', badge: 'Skill', sourceName: 'appscript-automation' },
    ],
    mcps: [
      { name: 'google-sheets', type: 'local', packageName: 'google-sheets', description: 'Google Sheets MCP for spreadsheet creation, writes, formatting, and charts', authMode: 'oauth' },
      { name: 'google-docs', type: 'local', packageName: 'google-docs', description: 'Google Docs MCP for structured document creation and editing', authMode: 'oauth' },
      { name: 'google-slides', type: 'local', packageName: 'google-slides', description: 'Google Slides MCP for deck creation and slide editing', authMode: 'oauth' },
      { name: 'google-chat', type: 'local', packageName: 'google-chat', description: 'Google Chat MCP for spaces, messages, and reactions', authMode: 'oauth' },
      { name: 'google-gmail', type: 'local', packageName: 'google-gmail', description: 'Gmail MCP for drafts, sends, and inbox workflows', authMode: 'oauth' },
      { name: 'google-people', type: 'local', packageName: 'google-people', description: 'Google People MCP for contacts and directory lookups', authMode: 'oauth' },
      { name: 'google-calendar', type: 'local', packageName: 'google-calendar', description: 'Google Calendar MCP for events and availability checks', authMode: 'oauth' },
      { name: 'google-drive', type: 'local', packageName: 'google-drive', description: 'Google Drive MCP for file search, sharing, and revisions', authMode: 'oauth' },
      { name: 'google-forms', type: 'local', packageName: 'google-forms', description: 'Google Forms MCP for surveys and response collection', authMode: 'oauth' },
      { name: 'google-tasks', type: 'local', packageName: 'google-tasks', description: 'Google Tasks MCP for task lists and planning workflows', authMode: 'oauth' },
      { name: 'google-appscript', type: 'local', packageName: 'google-appscript', description: 'Apps Script MCP for automations and deployments', authMode: 'oauth' },
    ],
    allowedTools: [
      'mcp__google-sheets__*', 'mcp__google-docs__*',
      'mcp__google-slides__*', 'mcp__google-chat__*', 'mcp__google-gmail__*',
      'mcp__google-people__*', 'mcp__google-calendar__*', 'mcp__google-drive__*',
      'mcp__google-forms__*', 'mcp__google-tasks__*',
      'mcp__google-appscript__*',
      'mcp__charts__*',
    ],
    deniedTools: ['bash'],
  },
  {
    id: 'atlassian-rovo',
    name: 'Atlassian',
    icon: 'atlassian',
    description: 'Use Jira, Confluence, and Compass through the Atlassian Rovo MCP',
    longDescription: 'Connect Cowork to the Atlassian Rovo MCP Server for Jira, Confluence, and Compass workflows. This bundle ships with Atlassian-authored skills for search, status reports, backlog generation, issue triage, and turning meeting notes into Jira work.',
    category: 'Productivity',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: false,
    apps: [
      { name: 'Atlassian Rovo MCP', description: 'Remote MCP for Jira, Confluence, and Compass with OAuth-based authentication', badge: 'App' },
    ],
    skills: [
      { name: 'Capture Tasks From Meeting Notes', description: 'Turn meeting notes or Confluence pages into Jira tasks with assignees', badge: 'Skill', sourceName: 'capture-tasks-from-meeting-notes' },
      { name: 'Generate Status Report', description: 'Create Jira-driven status reports and publish them to Confluence', badge: 'Skill', sourceName: 'generate-status-report' },
      { name: 'Search Company Knowledge', description: 'Search Jira and Confluence for internal documentation and cited answers', badge: 'Skill', sourceName: 'search-company-knowledge' },
      { name: 'Spec to Backlog', description: 'Convert Confluence specifications into Jira epics and implementation tickets', badge: 'Skill', sourceName: 'spec-to-backlog' },
      { name: 'Triage Issue', description: 'Search for duplicate Jira issues, add comments, and file new bugs with context', badge: 'Skill', sourceName: 'triage-issue' },
    ],
    mcps: [
      {
        name: 'atlassian-rovo-mcp',
        type: 'remote',
        description: 'Remote Atlassian Rovo MCP for Jira, Confluence, and Compass',
        authMode: 'oauth',
        url: 'https://mcp.atlassian.com/v1/mcp',
      },
    ],
    allowedTools: ['mcp__atlassian-rovo-mcp__*'],
    deniedTools: ['bash'],
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    icon: 'amplitude',
    description: 'Use Amplitude MCP for product analytics, dashboards, experiments, feedback, and instrumentation planning',
    longDescription: 'Connect Cowork to Amplitude MCP for product analytics, chart and dashboard creation, experiment review, replay investigations, opportunity discovery, and analytics instrumentation workflows. This bundle ships disabled by default and loads its Amplitude skills only when enabled.',
    category: 'Analytics',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: false,
    apps: [
      { name: 'Amplitude MCP', description: 'Remote MCP for Amplitude analytics, dashboards, experiments, replays, and feedback with OAuth authentication', badge: 'App' },
    ],
    skills: [
      { name: 'Add Analytics Instrumentation', description: 'Run the full instrumentation workflow for a feature, branch, diff, or PR', badge: 'Skill', sourceName: 'add-analytics-instrumentation' },
      { name: 'Analyze Account Health', description: 'Summarize usage patterns, risk signals, and growth opportunities for B2B accounts', badge: 'Skill', sourceName: 'analyze-account-health' },
      { name: 'Analyze AI Topics', description: 'Analyze AI-related topic trends and behavior patterns in Amplitude data', badge: 'Skill', sourceName: 'analyze-ai-topics' },
      { name: 'Analyze Chart', description: 'Deep dive into a chart to explain trends, anomalies, and likely drivers', badge: 'Skill', sourceName: 'analyze-chart' },
      { name: 'Analyze Dashboard', description: 'Summarize a dashboard into insights, talking points, and concerns', badge: 'Skill', sourceName: 'analyze-dashboard' },
      { name: 'Analyze Experiment', description: 'Review experiment setup and results with statistical interpretation', badge: 'Skill', sourceName: 'analyze-experiment' },
      { name: 'Analyze Feedback', description: 'Synthesize feedback into themes like bugs, pain points, requests, and praise', badge: 'Skill', sourceName: 'analyze-feedback' },
      { name: 'Compare User Journeys', description: 'Compare behavior across two user journeys or segments', badge: 'Skill', sourceName: 'compare-user-journeys' },
      { name: 'Create Chart', description: 'Create an Amplitude chart from a natural-language analytics request', badge: 'Skill', sourceName: 'create-chart' },
      { name: 'Create Dashboard', description: 'Build a dashboard from goals, metrics, or a target audience', badge: 'Skill', sourceName: 'create-dashboard' },
      { name: 'Daily Brief', description: 'Generate a concise daily product and analytics briefing', badge: 'Skill', sourceName: 'daily-brief' },
      { name: 'Debug Replay', description: 'Use replay and analytics signals together to debug a user session', badge: 'Skill', sourceName: 'debug-replay' },
      { name: 'Diagnose Errors', description: 'Investigate analytics or product errors through Amplitude signals', badge: 'Skill', sourceName: 'diagnose-errors' },
      { name: 'Diff Intake', description: 'Turn a diff or PR into a compact analytics instrumentation brief', badge: 'Skill', sourceName: 'diff-intake' },
      { name: 'Discover Analytics Patterns', description: 'Find existing tracking patterns and conventions before instrumenting', badge: 'Skill', sourceName: 'discover-analytics-patterns' },
      { name: 'Discover Event Surfaces', description: 'Turn a change brief into concrete event candidates and surfaces', badge: 'Skill', sourceName: 'discover-event-surfaces' },
      { name: 'Discover Opportunities', description: 'Mine analytics, experiments, feedback, and replays for product opportunities', badge: 'Skill', sourceName: 'discover-opportunities' },
      { name: 'Instrument Events', description: 'Convert event candidates into a detailed instrumentation plan', badge: 'Skill', sourceName: 'instrument-events' },
      { name: 'Investigate AI Session', description: 'Inspect a specific AI-related session or interaction in Amplitude', badge: 'Skill', sourceName: 'investigate-ai-session' },
      { name: 'Monitor AI Quality', description: 'Track AI quality and behavior signals over time', badge: 'Skill', sourceName: 'monitor-ai-quality' },
      { name: 'Monitor Experiments', description: 'Triage active and recent experiments and flag the ones needing attention', badge: 'Skill', sourceName: 'monitor-experiments' },
      { name: 'Monitor Reliability', description: 'Monitor reliability, errors, and regressions through Amplitude signals', badge: 'Skill', sourceName: 'monitor-reliability' },
      { name: 'Replay UX Audit', description: 'Use session replay to audit UX issues and friction patterns', badge: 'Skill', sourceName: 'replay-ux-audit' },
      { name: 'Review Agent Insights', description: 'Review AI/agent insights and product signals for actionability', badge: 'Skill', sourceName: 'review-agent-insights' },
      { name: 'Taxonomy', description: 'Review or improve event taxonomy and tracking structure', badge: 'Skill', sourceName: 'taxonomy' },
      { name: 'Weekly Brief', description: 'Generate a weekly narrative summary of performance, experiments, and risks', badge: 'Skill', sourceName: 'weekly-brief' },
      { name: 'What Would Lenny Do', description: 'Use Amplitude signals to frame product recommendations in a PM coaching style', badge: 'Skill', sourceName: 'what-would-lenny-do' },
    ],
    mcps: [
      {
        name: 'amplitude',
        type: 'remote',
        description: 'Remote Amplitude MCP for analytics, dashboards, experiments, and replay',
        authMode: 'oauth',
        url: 'https://mcp.eu.amplitude.com/mcp',
      },
    ],
    allowedTools: ['mcp__amplitude__*'],
    deniedTools: ['bash'],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    description: 'Work with repositories, pull requests, issues, Actions, and code security',
    longDescription: 'Connect Cowork to GitHub’s official hosted MCP server. GitHub publishes official toolsets plus MCP prompts and resources, but it does not currently ship Cowork-style SKILL.md bundles. Cowork therefore exposes the official GitHub MCP directly and keeps it disabled by default until a personal access token is configured.',
    category: 'Developer',
    author: 'GitHub',
    version: VERSION,
    builtin: true,
    enabledByDefault: false,
    apps: [
      { name: 'GitHub MCP', description: 'Official hosted GitHub MCP with curated repository, issue, PR, Actions, and security toolsets', badge: 'App' },
    ],
    skills: [],
    credentials: [
      {
        key: 'githubToken',
        label: 'GitHub personal access token',
        description: 'Stored securely in Cowork and sent as a Bearer token to GitHub’s hosted MCP server. Use a token with only the scopes you need.',
        placeholder: 'github_pat_...',
        secret: true,
      },
    ],
    mcps: [
      {
        name: 'github',
        type: 'remote',
        description: 'Official hosted GitHub MCP with bounded repository, issue, PR, Actions, and security toolsets',
        authMode: 'api_token',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          'X-MCP-Toolsets': 'repos,issues,pull_requests,actions,code_security,secret_protection,projects,users,orgs',
        },
        headerSettings: [
          { header: 'Authorization', key: 'githubToken', prefix: 'Bearer ' },
        ],
      },
    ],
    allowedTools: ['mcp__github__*'],
    deniedTools: ['bash'],
  },
  {
    id: 'web-research',
    name: 'Web Research',
    icon: 'search',
    description: 'Search the web and fetch pages for research',
    longDescription: 'Search the web for information, fetch web pages, and synthesize research findings. Useful for market research, competitive analysis, and fact-checking.',
    category: 'Productivity',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: false,
    apps: [],
    skills: [],
    mcps: [],
    allowedTools: ['webfetch', 'websearch'],
    deniedTools: [],
  },
  {
    id: 'code-assistant',
    name: 'Code Assistant',
    icon: 'code',
    description: 'Read, write, and analyze code in your projects',
    longDescription: 'Full code assistant capabilities including reading files, writing code, running commands, and debugging. Intended for engineering teams.',
    category: 'Developer',
    author: 'Cowork',
    version: VERSION,
    builtin: true,
    enabledByDefault: false,
    apps: [],
    skills: [],
    mcps: [],
    allowedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list'],
    deniedTools: [],
  },
]
