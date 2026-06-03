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
import { formatAgentLabel } from '../helpers/agent-label.ts'
import { compactDescription } from '../helpers/format.ts'

export type View = 'home' | 'chat' | 'threads' | 'workflows' | 'agents' | 'capabilities' | 'health' | 'ui-primitives'
export type PaletteSection = 'Go To' | 'Create' | 'Modes' | 'Commands' | 'Agents'
const COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH = 96

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

type NavigatorPlatformSource = {
  platform?: string
  userAgentData?: {
    platform?: string
  }
}

export function getShortcutPlatform(source: NavigatorPlatformSource | undefined = typeof navigator !== 'undefined' ? navigator as NavigatorPlatformSource : undefined) {
  const userAgentPlatform = source?.userAgentData?.platform?.trim()
  if (userAgentPlatform) return userAgentPlatform
  return source?.platform || ''
}

function formatShortcutLabel(shortcut: string, platform = getShortcutPlatform()) {
  const isMac = platform.toLowerCase().includes('mac')
  return shortcut
    .replace('CmdOrCtrl', isMac ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ')
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
      subtitle: compactDescription(command.description || 'Run a saved command in the active thread.', COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
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
    .filter((agent) => !agent.hidden && agent.surface !== 'workflow' && agent.mode === 'primary' && (agent.name === 'build' || agent.name === 'plan'))
    .map((agent) => ({
      id: `mode:${agent.name}`,
      title: `Use ${agent.label}`,
      subtitle: compactDescription(agent.description, COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
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
      .filter((agent) => !agent.hidden && agent.surface !== 'workflow' && agent.mode === 'subagent')
      .map((agent) => ({
        id: `builtin-agent:${agent.name}`,
        title: agent.label,
        subtitle: compactDescription(agent.description, COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
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
        subtitle: compactDescription(agent.description || 'Custom delegated agent', COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
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

  const navigationItems: PaletteItem[] = [
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
      id: 'nav:threads',
      title: 'Threads',
      subtitle: 'Search, filter, tag, and rediscover past work.',
      section: 'Go To',
      badge: 'Navigate',
      hint: formatShortcutLabel(SEARCH_THREADS_SHORTCUT, platform),
      keywords: 'threads search history tags filters',
      run: () => onNavigate('threads'),
    },
    {
      id: 'nav:workflows',
      title: 'Workflows',
      subtitle: 'Repeatable work created from setup threads, schedules, and webhooks.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'workflows setup thread workflow designer runs scheduled recurring webhook',
      run: () => onNavigate('workflows'),
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
      title: 'Tools & Skills',
      subtitle: 'Browse tools, skills, and MCP-backed capabilities.',
      section: 'Go To',
      badge: 'Navigate',
      hint: 'Cmd + Shift + C',
      keywords: 'capabilities tools skills mcps',
      run: () => onNavigate('capabilities'),
    },
    {
      id: 'nav:health',
      title: 'Health Center',
      subtitle: 'Check setup paths, execution authorities, sync, and operator readiness.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'health setup onboarding readiness doctor smoke workspace authority',
      run: () => onNavigate('health'),
    },
    {
      id: 'nav:ui-primitives',
      title: 'UI Primitives',
      subtitle: 'Open the internal design-system gallery for visual QA.',
      section: 'Go To',
      badge: 'QA',
      keywords: 'ui primitives design system gallery components',
      run: () => {
        window.location.hash = '#/ui-primitives'
        onNavigate('ui-primitives')
      },
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
  ]

  return [
    ...navigationItems,
    {
      id: 'create:thread',
      title: 'New Thread',
      subtitle: 'Start a new blank thread with the current execution engine.',
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
