import {
  NEW_THREAD_SHORTCUT,
  SEARCH_THREADS_SHORTCUT,
  SETTINGS_SHORTCUT,
} from '@open-cowork/shared'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  SessionInfo,
} from '@open-cowork/shared'
import { compactDescription as compactTextDescription } from '../helpers/format.ts'

export type View = 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse'
export type PaletteSection = 'Go To' | 'Create' | 'Modes' | 'Commands' | 'Agents'

export type RuntimeCommand = {
  name: string
  description?: string
  source?: string
}

export type PaletteItem = {
  id: string
  title: string
  subtitle: string
  section: PaletteSection
  badge: string
  hint?: string
  keywords: string
  run: () => Promise<boolean | void> | boolean | void
}

export const SECTION_ORDER: PaletteSection[] = ['Go To', 'Create', 'Modes', 'Commands', 'Agents']

export function formatShortcutLabel(shortcut: string, platform = typeof navigator !== 'undefined' ? navigator.platform : '') {
  const isMac = platform.toLowerCase().includes('mac')
  return shortcut
    .replace('CmdOrCtrl', isMac ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ')
}

export function compactDescription(value: string, maxLength = 96) {
  return compactTextDescription(value, maxLength)
}

export function formatAgentLabel(name: string) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

type BuildPaletteItemsInput = {
  commands: RuntimeCommand[]
  builtinAgents: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
  platform?: string
  onNavigate: (view: View) => void
  onCreateThread: (directory?: string) => Promise<SessionInfo | null>
  onEnsureSession: () => Promise<boolean>
  onInsertComposer: (text: string) => void
  onSetAgentMode: (mode: 'build' | 'plan') => void
  onSelectDirectory: () => Promise<string | null>
  onOpenSettings: () => void
  onToggleSearch: () => void
  onRunCommand: (name: string) => Promise<boolean | void> | boolean | void
}

export function buildCommandPaletteItems(input: BuildPaletteItemsInput): PaletteItem[] {
  const {
    commands,
    builtinAgents,
    customAgents,
    platform = '',
    onNavigate,
    onCreateThread,
    onEnsureSession,
    onInsertComposer,
    onSetAgentMode,
    onSelectDirectory,
    onOpenSettings,
    onToggleSearch,
    onRunCommand,
  } = input

  const runtimeCommands = commands
    .filter((command) => !command.source || command.source === 'command')
    .map((command) => ({
      id: `command:${command.name}`,
      title: command.name,
      subtitle: compactDescription(command.description || 'Run a saved runtime command in the active thread.'),
      section: 'Commands' as const,
      badge: 'Command',
      keywords: `${command.name} ${command.description || ''}`.toLowerCase(),
      run: async () => {
        const ok = await onEnsureSession()
        if (!ok) return false
        return onRunCommand(command.name)
      },
    }))

  const topLevelModes = builtinAgents
    .filter((agent) => !agent.hidden && agent.surface !== 'automation' && agent.mode === 'primary' && (agent.name === 'build' || agent.name === 'plan'))
    .map((agent) => ({
      id: `mode:${agent.name}`,
      title: `Use ${agent.label}`,
      subtitle: compactDescription(agent.description),
      section: 'Modes' as const,
      badge: 'Mode',
      keywords: `${agent.name} ${agent.label} ${agent.description}`.toLowerCase(),
      run: () => {
        onSetAgentMode(agent.name as 'build' | 'plan')
        onNavigate('chat')
      },
    }))

  const agentItems = [
    ...builtinAgents
      .filter((agent) => !agent.hidden && agent.surface !== 'automation' && agent.mode === 'subagent')
      .map((agent) => ({
        id: `builtin-agent:${agent.name}`,
        title: agent.label,
        subtitle: compactDescription(agent.description),
        section: 'Agents' as const,
        badge: 'Built-in',
        keywords: `${agent.name} ${agent.label} ${agent.description}`.toLowerCase(),
        run: async () => {
          const ok = await onEnsureSession()
          if (!ok) return false
          onNavigate('chat')
          onInsertComposer(`@${agent.name} `)
        },
      })),
    ...customAgents
      .filter((agent) => agent.enabled && agent.valid)
      .map((agent) => ({
        id: `custom-agent:${agent.name}`,
        title: formatAgentLabel(agent.name),
        subtitle: compactDescription(agent.description || 'Custom delegated agent'),
        section: 'Agents' as const,
        badge: 'Custom',
        keywords: `${agent.name} ${agent.description || ''} ${agent.instructions}`.toLowerCase(),
        run: async () => {
          const ok = await onEnsureSession()
          if (!ok) return false
          onNavigate('chat')
          onInsertComposer(`@${agent.name} `)
        },
      })),
  ].sort((a, b) => a.title.localeCompare(b.title))

  return [
    {
      id: 'nav:home',
      title: 'Home',
      subtitle: 'Start a new conversation or pick up a recent thread.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'home welcome new thread start',
      run: () => onNavigate('home'),
    },
    {
      id: 'nav:automations',
      title: 'Automations',
      subtitle: 'Recurring work, inbox items, work items, and execution runs.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'automations inbox work items runs scheduled recurring',
      run: () => onNavigate('automations'),
    },
    {
      id: 'nav:pulse',
      title: 'Pulse',
      subtitle: 'Workspace health, usage, and runtime diagnostics.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'pulse dashboard diagnostics workspace runtime health usage metrics',
      run: () => onNavigate('pulse'),
    },
    {
      id: 'nav:agents',
      title: 'Agents',
      subtitle: 'Inspect built-in and custom agents.',
      section: 'Go To',
      badge: 'Navigate',
      hint: 'Cmd + Shift + A',
      keywords: 'agents built-in custom',
      run: () => onNavigate('agents'),
    },
    {
      id: 'nav:capabilities',
      title: 'Capabilities',
      subtitle: 'Browse tools, skills, and MCP-backed capabilities.',
      section: 'Go To',
      badge: 'Navigate',
      hint: 'Cmd + Shift + C',
      keywords: 'capabilities tools skills mcps',
      run: () => onNavigate('capabilities'),
    },
    {
      id: 'nav:settings',
      title: 'Settings',
      subtitle: 'Open desktop, provider, model, and theme settings.',
      section: 'Go To',
      badge: 'Navigate',
      hint: formatShortcutLabel(SETTINGS_SHORTCUT, platform),
      keywords: 'settings preferences providers theme models',
      run: () => onOpenSettings(),
    },
    {
      id: 'create:thread',
      title: 'New Thread',
      subtitle: 'Start a new blank thread with the current Cowork runtime.',
      section: 'Create',
      badge: 'Create',
      hint: formatShortcutLabel(NEW_THREAD_SHORTCUT, platform),
      keywords: 'new thread blank thread create',
      run: async () => !!(await onCreateThread()),
    },
    {
      id: 'create:project',
      title: 'Open Project',
      subtitle: 'Choose a directory and start a project-bound thread.',
      section: 'Create',
      badge: 'Create',
      keywords: 'open project directory codebase thread',
      run: async () => {
        const directory = await onSelectDirectory()
        if (!directory) return false
        return !!(await onCreateThread(directory))
      },
    },
    {
      id: 'create:search',
      title: 'Search Threads',
      subtitle: 'Search your recent threads and jump back into work.',
      section: 'Create',
      badge: 'Action',
      hint: formatShortcutLabel(SEARCH_THREADS_SHORTCUT, platform),
      keywords: 'search threads history',
      run: () => onToggleSearch(),
    },
    ...topLevelModes,
    ...runtimeCommands,
    ...agentItems,
  ]
}
