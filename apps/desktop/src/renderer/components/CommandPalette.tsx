import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  SessionInfo,
} from '@open-cowork/shared'
import {
  NEW_THREAD_SHORTCUT,
  SEARCH_THREADS_SHORTCUT,
  SETTINGS_SHORTCUT,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'

type View = 'home' | 'chat' | 'agents' | 'capabilities'
type PaletteSection = 'Go To' | 'Create' | 'Modes' | 'Commands' | 'Agents'

type RuntimeCommand = {
  name: string
  description?: string
  source?: string
}

type PaletteItem = {
  id: string
  title: string
  subtitle: string
  section: PaletteSection
  badge: string
  hint?: string
  keywords: string
  run: () => Promise<boolean | void> | boolean | void
}

const SECTION_ORDER: PaletteSection[] = ['Go To', 'Create', 'Modes', 'Commands', 'Agents']

function formatShortcutLabel(shortcut: string) {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
  return shortcut
    .replace('CmdOrCtrl', isMac ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ')
}

function compactDescription(value: string, maxLength = 96) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function formatAgentLabel(name: string) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

interface CommandPaletteProps {
  onClose: () => void
  onNavigate: (view: View) => void
  onCreateThread: (directory?: string) => Promise<SessionInfo | null>
  onEnsureSession: () => Promise<boolean>
  onInsertComposer: (text: string) => void
  onSetAgentMode: (mode: 'build' | 'plan') => void
}

export function CommandPalette({
  onClose,
  onNavigate,
  onCreateThread,
  onEnsureSession,
  onInsertComposer,
  onSetAgentMode,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [commands, setCommands] = useState<RuntimeCommand[]>([])
  const [builtinAgents, setBuiltinAgents] = useState<BuiltInAgentDetail[]>([])
  const [customAgents, setCustomAgents] = useState<CustomAgentSummary[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )

  useEffect(() => {
    inputRef.current?.focus()

    const contextOptions = currentProjectDirectory ? { directory: currentProjectDirectory } : undefined
    Promise.all([
      window.openCowork.command.list().catch(() => [] as RuntimeCommand[]),
      window.openCowork.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
      window.openCowork.agents.list(contextOptions).catch(() => [] as CustomAgentSummary[]),
    ]).then(([runtimeCommands, runtimeBuiltinAgents, runtimeCustomAgents]) => {
      setCommands(runtimeCommands || [])
      setBuiltinAgents(runtimeBuiltinAgents || [])
      setCustomAgents(runtimeCustomAgents || [])
    })
  }, [currentProjectDirectory])

  const items = useMemo<PaletteItem[]>(() => {
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
          const sessionId = useSessionStore.getState().currentSessionId
          if (!sessionId) return false
          return window.openCowork.command.run(sessionId, command.name)
        },
      }))

    const topLevelModes = builtinAgents
      .filter((agent) => !agent.hidden && agent.mode === 'primary' && (agent.name === 'build' || agent.name === 'plan'))
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
        .filter((agent) => !agent.hidden && agent.mode === 'subagent')
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
        subtitle: 'Open the workspace diagnostics dashboard.',
        section: 'Go To',
        badge: 'Navigate',
        keywords: 'home dashboard diagnostics workspace',
        run: () => onNavigate('home'),
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
        hint: formatShortcutLabel(SETTINGS_SHORTCUT),
        keywords: 'settings preferences providers theme models',
        run: () => window.dispatchEvent(new CustomEvent('open-cowork:open-settings')),
      },
      {
        id: 'create:thread',
        title: 'New Thread',
        subtitle: 'Start a new blank thread with the current Cowork runtime.',
        section: 'Create',
        badge: 'Create',
        hint: formatShortcutLabel(NEW_THREAD_SHORTCUT),
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
          const directory = await window.openCowork.dialog.selectDirectory()
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
        hint: formatShortcutLabel(SEARCH_THREADS_SHORTCUT),
        keywords: 'search threads history',
        run: () => window.dispatchEvent(new CustomEvent('open-cowork:toggle-search')),
      },
      ...topLevelModes,
      ...runtimeCommands,
      ...agentItems,
    ]
  }, [builtinAgents, commands, customAgents, onCreateThread, onEnsureSession, onInsertComposer, onNavigate, onSetAgentMode])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return items
    return items.filter((item) =>
      item.keywords.includes(normalizedQuery) ||
      item.title.toLowerCase().includes(normalizedQuery) ||
      item.subtitle.toLowerCase().includes(normalizedQuery),
    )
  }, [items, query])

  const groupedItems = useMemo(() => (
    SECTION_ORDER
      .map((section) => ({
        section,
        items: filteredItems.filter((item) => item.section === section),
      }))
      .filter((group) => group.items.length > 0)
  ), [filteredItems])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    if (selected >= filteredItems.length) {
      setSelected(Math.max(filteredItems.length - 1, 0))
    }
  }, [filteredItems.length, selected])

  const handleSelect = async (item: PaletteItem | undefined) => {
    if (!item) return
    const result = await item.run()
    if (result !== false) onClose()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, filteredItems.length - 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      void handleSelect(filteredItems[selected])
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/45" onClick={onClose} />
      <div className="fixed top-[10%] left-1/2 z-50 w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-2xl theme-popover shadow-2xl">
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search actions, agents, and commands..."
            className="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="max-h-[520px] overflow-y-auto px-2 py-2">
          {groupedItems.length === 0 && (
            <div className="px-4 py-10 text-center text-[12px] text-text-muted">
              No matching actions. Try a broader search.
            </div>
          )}

          {groupedItems.map((group) => (
            <div key={group.section} className="mb-2">
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                {group.section}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const itemIndex = filteredItems.findIndex((entry) => entry.id === item.id)
                  const isSelected = itemIndex === selected
                  return (
                    <button
                      key={item.id}
                      onClick={() => void handleSelect(item)}
                      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors cursor-pointer ${isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-text">{item.title}</span>
                          <span
                            className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em]"
                            style={{
                              background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
                              color: 'var(--color-accent)',
                            }}
                          >
                            {item.badge}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] leading-5 text-text-muted">
                          {item.subtitle}
                        </div>
                      </div>
                      {item.hint && (
                        <div className="mt-0.5 shrink-0 text-[10px] text-text-muted">
                          {item.hint}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t px-4 py-2 text-[11px] text-text-muted" style={{ borderColor: 'var(--color-border-subtle)' }}>
          Enter to run. Esc to close.
        </div>
      </div>
    </>
  )
}
