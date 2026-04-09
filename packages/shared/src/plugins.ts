// Plugin system types

export interface PluginSkill {
  name: string
  description: string
  badge: 'Skill'
}

export interface PluginApp {
  name: string
  description: string
  badge: 'App'
}

export interface Plugin {
  id: string
  name: string
  icon: string // emoji or URL
  description: string
  longDescription?: string
  category: 'Analytics' | 'Productivity' | 'Communication' | 'Developer' | 'Custom'
  author: string
  version: string
  builtin: boolean
  installed: boolean
  apps: PluginApp[]
  skills: PluginSkill[]
  // Tool ACLs — which tools this plugin's skills are allowed to use
  allowedTools: string[]
  // Which tools this plugin's skills are NOT allowed to use
  deniedTools: string[]
}

// Built-in plugins that ship with Cowork
export const BUILTIN_PLUGINS: Plugin[] = [
  {
    id: 'nova-analytics',
    name: 'Nova Analytics',
    icon: '📊',
    description: 'Query your datalake, discover metrics, and generate reports',
    longDescription: 'Use Nova to search for business metrics and KPIs, execute SQL queries against the data warehouse, validate data quality and lineage, and generate standardized analytical reports with YoY comparisons.',
    category: 'Analytics',
    author: 'Cowork',
    version: '1.0.0',
    builtin: true,
    installed: true,
    apps: [
      { name: 'Nova Datalake', description: 'Search, query, and analyze data from the company datalake via SQL', badge: 'App' },
    ],
    skills: [
      { name: 'Analyst', description: 'Structured workflow for metric discovery, validation, SQL execution, and evidence-based reporting', badge: 'Skill' },
    ],
    allowedTools: [
      'mcp__nova__*',
    ],
    deniedTools: ['bash', 'edit', 'write'],
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    icon: '📝',
    description: 'Work across Drive, Docs, Sheets, Gmail, and Calendar',
    longDescription: 'Use Google Workspace as one unified plugin for search, file organization, sharing, Google Docs, Google Sheets, Gmail, and Calendar workflows.',
    category: 'Productivity',
    author: 'Cowork',
    version: '1.0.0',
    builtin: true,
    installed: true,
    apps: [
      { name: 'Google Sheets', description: 'Create, read, and append data to Google Sheets spreadsheets', badge: 'App' },
      { name: 'Gmail', description: 'Send and list Gmail messages', badge: 'App' },
      { name: 'Google Drive', description: 'Search and list files in Google Drive', badge: 'App' },
      { name: 'Google Calendar', description: 'List and create calendar events', badge: 'App' },
    ],
    skills: [
      { name: 'Sheets Reporting', description: 'Create spreadsheets with formatted data, charts, and share with team', badge: 'Skill' },
      { name: 'Team Email', description: 'Draft and send professional team emails with attachments and links', badge: 'Skill' },
    ],
    allowedTools: [
      'mcp__google-workspace__*',
    ],
    deniedTools: ['bash'],
  },
  {
    id: 'web-research',
    name: 'Web Research',
    icon: '🔍',
    description: 'Search the web and fetch pages for research',
    longDescription: 'Search the web for information, fetch web pages, and synthesize research findings. Useful for market research, competitive analysis, and fact-checking.',
    category: 'Productivity',
    author: 'Cowork',
    version: '1.0.0',
    builtin: true,
    installed: false,
    apps: [],
    skills: [
      { name: 'Research', description: 'Structured web research with source attribution and synthesis', badge: 'Skill' },
    ],
    allowedTools: ['webfetch', 'websearch'],
    deniedTools: [],
  },
  {
    id: 'code-assistant',
    name: 'Code Assistant',
    icon: '💻',
    description: 'Read, write, and analyze code in your projects',
    longDescription: 'Full code assistant capabilities including reading files, writing code, running commands, and debugging. Intended for engineering teams.',
    category: 'Developer',
    author: 'Cowork',
    version: '1.0.0',
    builtin: true,
    installed: false,
    apps: [],
    skills: [],
    allowedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list'],
    deniedTools: [],
  },
]
