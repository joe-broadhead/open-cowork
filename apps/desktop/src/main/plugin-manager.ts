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
      { name: 'Google Sheets', description: 'Full Sheets API: create, read, write, format, charts, multi-tab workbooks (16 tools)', badge: 'App' },
      { name: 'Google Docs', description: 'Full Docs API: create, edit, format, tables, images, headings, lists (13 tools)', badge: 'App' },
      { name: 'Google Slides', description: 'Full Slides API: create decks, slides, shapes, images, tables, styling (17 tools)', badge: 'App' },
      { name: 'Gmail', description: 'Send, reply, forward, read, triage, search, threads, labels (13 tools)', badge: 'App' },
      { name: 'Google Drive', description: 'List, search, create, share, export, comments, permissions (12 tools)', badge: 'App' },
      { name: 'Google Calendar', description: 'Events, quick add, free/busy, calendars (9 tools)', badge: 'App' },
      { name: 'Google Chat', description: 'Spaces, messages, members — send and manage Chat (10 tools)', badge: 'App' },
      { name: 'Google People', description: 'Contacts: list, search, create, update, groups (8 tools)', badge: 'App' },
      { name: 'Google Forms', description: 'Create forms, manage questions, collect responses (6 tools)', badge: 'App' },
      { name: 'Google Keep', description: 'Create, read, list, and delete notes (5 tools)', badge: 'App' },
      { name: 'Google Tasks', description: 'Task lists, create, update, complete, reorder tasks (12 tools)', badge: 'App' },
      { name: 'Google Apps Script', description: 'Create, deploy, and run Apps Script automations (16 tools)', badge: 'App' },
    ],
    skills: [
      { name: 'Sheets Reporting', description: 'Build professional formatted reports with headers, formatting, charts, and multi-tab workbooks', badge: 'Skill' },
      { name: 'Docs Writing', description: 'Create structured documents with headings, tables, formatting, and template patterns', badge: 'Skill' },
      { name: 'Slides Presentations', description: 'Build professional slide decks with shapes, images, tables, and template patterns', badge: 'Skill' },
      { name: 'Gmail Management', description: 'Triage inbox, search, compose, reply, forward with best practices', badge: 'Skill' },
      { name: 'Calendar Scheduling', description: 'Schedule meetings, check availability, manage events', badge: 'Skill' },
      { name: 'Drive Files', description: 'Search, share, export, manage permissions and comments', badge: 'Skill' },
      { name: 'Apps Script Automation', description: 'Create scripts, custom Sheet functions, automations, deployments', badge: 'Skill' },
    ],
    allowedTools: [
      'mcp__google-workspace__*', 'mcp__google-sheets__*', 'mcp__google-docs__*',
      'mcp__google-slides__*', 'mcp__google-chat__*', 'mcp__google-gmail__*',
      'mcp__google-people__*', 'mcp__google-calendar__*', 'mcp__google-drive__*',
      'mcp__google-forms__*', 'mcp__google-keep__*', 'mcp__google-tasks__*',
      'mcp__google-appscript__*',
    ],
    deniedTools: ['bash'],
  },
  {
    id: 'web-research',
    name: 'Web Research',
    icon: 'search',
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
    icon: 'code',
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
