import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
// Plugin type and registry — duplicated from @cowork/shared/plugins to avoid
// cross-package import issues with vite-plugin-electron's main process build.
interface Plugin {
  id: string
  name: string
  icon: string
  description: string
  longDescription?: string
  category: string
  author: string
  version: string
  builtin: boolean
  installed: boolean
  apps: Array<{ name: string; description: string; badge: string }>
  skills: Array<{ name: string; description: string; badge: string }>
  allowedTools: string[]
  deniedTools: string[]
}

const BUILTIN_PLUGINS: Plugin[] = [
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
    allowedTools: ['mcp__nova__*'],
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
      { name: 'Google Sheets', description: 'Create, read, and append data to Google Sheets', badge: 'App' },
      { name: 'Gmail', description: 'Send and list Gmail messages', badge: 'App' },
      { name: 'Google Drive', description: 'Search and list files in Drive', badge: 'App' },
      { name: 'Google Calendar', description: 'List and create calendar events', badge: 'App' },
    ],
    skills: [
      { name: 'Sheets Reporting', description: 'Create spreadsheets with formatted data and share with team', badge: 'Skill' },
      { name: 'Team Email', description: 'Draft and send professional team emails with links', badge: 'Skill' },
    ],
    allowedTools: ['mcp__google-workspace__*'],
    deniedTools: ['bash'],
  },
  {
    id: 'web-research',
    name: 'Web Research',
    icon: '🔍',
    description: 'Search the web and fetch pages for research',
    longDescription: 'Search the web for information, fetch web pages, and synthesize research findings.',
    category: 'Productivity',
    author: 'Cowork',
    version: '1.0.0',
    builtin: true,
    installed: false,
    apps: [],
    skills: [
      { name: 'Research', description: 'Structured web research with source attribution', badge: 'Skill' },
    ],
    allowedTools: ['webfetch', 'websearch'],
    deniedTools: [],
  },
  {
    id: 'code-assistant',
    name: 'Code Assistant',
    icon: '💻',
    description: 'Read, write, and analyze code in your projects',
    longDescription: 'Full code assistant capabilities including reading files, writing code, running commands, and debugging.',
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
import { log } from './logger'

function getPluginStatePath(): string {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'plugins.json')
}

interface PluginState {
  installed: string[] // list of installed plugin IDs
}

function loadState(): PluginState {
  const path = getPluginStatePath()
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {}
  }
  // Default: built-in plugins that are installed by default
  return {
    installed: BUILTIN_PLUGINS.filter((p) => p.installed).map((p) => p.id),
  }
}

function saveState(state: PluginState) {
  writeFileSync(getPluginStatePath(), JSON.stringify(state, null, 2))
}

export function getInstalledPlugins(): Plugin[] {
  const state = loadState()
  return BUILTIN_PLUGINS.map((p) => ({
    ...p,
    installed: state.installed.includes(p.id),
  }))
}

export function installPlugin(id: string): boolean {
  const plugin = BUILTIN_PLUGINS.find((p) => p.id === id)
  if (!plugin) {
    log('plugin', `Plugin not found: ${id}`)
    return false
  }

  const state = loadState()
  if (!state.installed.includes(id)) {
    state.installed.push(id)
    saveState(state)
    log('plugin', `Installed ${id}`)
  }
  return true
}

export function uninstallPlugin(id: string): boolean {
  const plugin = BUILTIN_PLUGINS.find((p) => p.id === id)
  if (!plugin) return false

  const state = loadState()
  state.installed = state.installed.filter((i) => i !== id)
  saveState(state)
  log('plugin', `Uninstalled ${id}`)
  return true
}

/**
 * Get the combined tool ACLs from all installed plugins.
 * Returns { allowed: string[], denied: string[] }
 */
export function getPluginToolACLs(): { allowed: string[]; denied: string[] } {
  const state = loadState()
  const allowed: string[] = []
  const denied: string[] = []

  for (const plugin of BUILTIN_PLUGINS) {
    if (state.installed.includes(plugin.id)) {
      allowed.push(...plugin.allowedTools)
      denied.push(...plugin.deniedTools)
    }
  }

  return { allowed, denied }
}
