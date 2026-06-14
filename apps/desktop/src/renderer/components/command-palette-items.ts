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
import type { AppNavigationTarget } from '../app-types.ts'
import { formatAgentLabel } from '../helpers/agent-label.ts'
import { compactDescription } from '../helpers/format.ts'
import { isPrimaryAgentMode } from '../helpers/primary-agent-mode.ts'
import type { PrimaryAgentMode } from '../stores/session.ts'

export type View = AppNavigationTarget
export type PaletteSection = 'Go To' | 'Create' | 'Modes' | 'Commands' | 'Coworkers'
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

export const SECTION_ORDER: PaletteSection[] = ['Go To', 'Create', 'Modes', 'Commands', 'Coworkers']

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
  currentProjectDirectory?: string | null
  platform?: string
  onNavigate: (view: View) => void
  onCreateThread: (directory?: string) => Promise<SessionInfo | null>
  onEnsureSession: () => Promise<boolean>
  onInsertComposer: (text: string) => void
  onClearSessionPrimaryAgent: () => Promise<boolean | void> | boolean | void
  onSetAgentMode: (mode: PrimaryAgentMode) => void
  onStartAgentChat: (agentName: string, directory?: string | null) => Promise<void> | void
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
    currentProjectDirectory = null,
    platform = '',
    onNavigate,
    onCreateThread,
    onEnsureSession,
    onInsertComposer,
    onClearSessionPrimaryAgent,
    onSetAgentMode,
    onStartAgentChat,
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
      subtitle: compactDescription(command.description || 'Run a saved command in the active project chat.', COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
      section: 'Commands' as const,
      badge: 'Command',
      keywords: `${command.name} ${command.description || ''}`.toLowerCase(),
      run: async () => {
        const ok = await onEnsureSession()
        if (!ok) return false
        return onRunCommand(command.name)
      },
    }))

  const topLevelModes = [
    ...builtinAgents
      .filter((agent) => !agent.hidden && agent.surface !== 'workflow' && agent.mode === 'primary' && isPrimaryAgentMode(agent.name))
      .map((agent) => ({
        id: `mode:${agent.name}`,
        title: `Use ${agent.label}`,
        subtitle: compactDescription(agent.description, COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
        section: 'Modes' as const,
        badge: 'Mode',
        keywords: `${agent.name} ${agent.label} ${agent.description}`.toLowerCase(),
        run: async () => {
          if (!isPrimaryAgentMode(agent.name)) return
          const cleared = await onClearSessionPrimaryAgent()
          if (cleared === false) return false
          onSetAgentMode(agent.name)
          onNavigate('chat')
        },
      })),
    ...customAgents
      .filter((agent) => agent.enabled && agent.valid && agent.mode === 'primary')
      .map((agent) => ({
        id: `custom-mode:${agent.name}`,
        title: `Use ${formatAgentLabel(agent.name)}`,
        subtitle: compactDescription(agent.description || 'Custom lead coworker', COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
        section: 'Modes' as const,
        badge: 'Custom',
        keywords: `${agent.name} ${agent.description || ''} ${agent.instructions}`.toLowerCase(),
        run: () => {
          void Promise.resolve(onStartAgentChat(
            agent.name,
            agent.scope === 'project' ? agent.directory || currentProjectDirectory : currentProjectDirectory,
          )).catch(() => undefined)
        },
      })),
  ].sort((a, b) => a.title.localeCompare(b.title))

  const agentItems = [
    ...builtinAgents
      .filter((agent) => !agent.hidden && agent.surface !== 'workflow' && agent.mode === 'subagent')
      .map((agent) => ({
        id: `builtin-agent:${agent.name}`,
        title: agent.label,
        subtitle: compactDescription(agent.description, COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
        section: 'Coworkers' as const,
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
      .filter((agent) => agent.enabled && agent.valid && agent.mode !== 'primary')
      .map((agent) => ({
        id: `custom-agent:${agent.name}`,
        title: formatAgentLabel(agent.name),
        subtitle: compactDescription(agent.description || 'Custom delegated coworker', COMMAND_PALETTE_DESCRIPTION_MAX_LENGTH),
        section: 'Coworkers' as const,
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
      subtitle: 'Start a new chat or pick up recent work.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'home welcome new chat thread start',
      run: () => onNavigate('home'),
    },
    {
      id: 'nav:projects',
      title: 'Projects',
      subtitle: 'Search, filter, tag, and rediscover project chats.',
      section: 'Go To',
      badge: 'Navigate',
      hint: formatShortcutLabel(SEARCH_THREADS_SHORTCUT, platform),
      keywords: 'projects chats threads search history tags filters work',
      run: () => onNavigate('projects'),
    },
    {
      id: 'nav:approvals',
      title: 'Approvals',
      subtitle: 'Review pending permissions and questions from the active coworking session.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'approvals permissions questions review needs input',
      run: () => onNavigate('approvals'),
    },
    {
      id: 'nav:playbooks',
      title: 'Playbooks',
      subtitle: 'Repeatable work created from setup chats, schedules, and webhooks.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'playbooks workflows setup chat thread workflow designer runs scheduled recurring webhook',
      run: () => onNavigate('playbooks'),
    },
    {
      id: 'nav:team',
      title: 'Team',
      subtitle: 'Inspect built-in and custom coworkers.',
      section: 'Go To',
      badge: 'Navigate',
      hint: 'Cmd + Shift + A',
      keywords: 'team agents coworkers built-in custom',
      run: () => onNavigate('team'),
    },
    {
      id: 'nav:channels',
      title: 'Channels',
      subtitle: 'Check Gateway and workspace channels for Desktop, Cloud, and external entry points.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'channels gateway workspace cloud desktop paired',
      run: () => onNavigate('channels'),
    },
    {
      id: 'nav:tools',
      title: 'Tools & Skills',
      subtitle: 'Browse tools, skills, and MCP-backed capabilities.',
      section: 'Go To',
      badge: 'Navigate',
      hint: 'Cmd + Shift + C',
      keywords: 'capabilities tools skills mcps',
      run: () => onNavigate('tools'),
    },
    {
      id: 'nav:artifacts',
      title: 'Artifacts',
      subtitle: 'Review generated files, charts, and Cloud-safe artifacts for the active chat.',
      section: 'Go To',
      badge: 'Navigate',
      keywords: 'artifacts files charts downloads review deliverables',
      run: () => onNavigate('artifacts'),
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
      title: 'New Chat',
      subtitle: 'Start a new coworking chat with the current OpenCode runtime.',
      section: 'Create',
      badge: 'Create',
      hint: formatShortcutLabel(NEW_THREAD_SHORTCUT, platform),
      keywords: 'new chat thread blank thread create',
      run: async () => !!(await onCreateThread()),
    },
    {
      id: 'create:project',
      title: 'Open Project',
      subtitle: 'Choose a directory and start a project-bound chat.',
      section: 'Create',
      badge: 'Create',
      keywords: 'open project directory codebase chat thread',
      run: async () => {
        const directory = await onSelectDirectory()
        if (!directory) return false
        return !!(await onCreateThread(directory))
      },
    },
    {
      id: 'create:search',
      title: 'Search Projects',
      subtitle: 'Search your recent project chats and jump back into work.',
      section: 'Create',
      badge: 'Action',
      hint: formatShortcutLabel(SEARCH_THREADS_SHORTCUT, platform),
      keywords: 'search projects chats threads history',
      run: () => onToggleSearch(),
    },
    ...topLevelModes,
    ...runtimeCommands,
    ...agentItems,
  ]
}
