import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from './logger'
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
    icon: 'nova',
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
      { name: 'Engineer', description: 'Build and modify dbt models with quality gates, impact analysis, and ship checklists', badge: 'Skill' },
      { name: 'Governance', description: 'Deterministic metadata audits, compliance gates, and remediation queues', badge: 'Skill' },
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
    version: '1.0.0',
    builtin: true,
    installed: true,
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
      { name: 'Sheets Reporting', description: 'Build professional formatted reports with headers, formatting, charts, and multi-tab workbooks', badge: 'Skill' },
      { name: 'Docs Writing', description: 'Create structured documents with headings, tables, formatting, and template patterns', badge: 'Skill' },
      { name: 'Slides Presentations', description: 'Build professional slide decks with shapes, images, tables, and template patterns', badge: 'Skill' },
      { name: 'Gmail Management', description: 'Triage inbox, drafts, filters, vacation, labels', badge: 'Skill' },
      { name: 'Calendar Scheduling', description: 'Schedule meetings, check availability, manage calendars', badge: 'Skill' },
      { name: 'Drive Files', description: 'Search, share, export, manage permissions and revisions', badge: 'Skill' },
      { name: 'Chat Messaging', description: 'Send messages, manage spaces, members, reactions', badge: 'Skill' },
      { name: 'Forms Surveys', description: 'Create forms, add questions, review responses', badge: 'Skill' },
      { name: 'Tasks Planning', description: 'Manage task lists and to-dos', badge: 'Skill' },
      { name: 'Contacts Directory', description: 'Search contacts and company directory', badge: 'Skill' },
      { name: 'Apps Script Automation', description: 'Create scripts, deploy, run automations', badge: 'Skill' },
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
]

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
    } catch (e: any) { log('error', `Plugin state: ${e?.message}`) }
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
