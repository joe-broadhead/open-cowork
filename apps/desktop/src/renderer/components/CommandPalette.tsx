import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  SessionInfo,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { t } from '../helpers/i18n'
import type { PrimaryAgentMode } from '../stores/session'
import { Badge, EmptyState, Input, Kbd } from './ui'
import { ModalBackdrop } from './layout/ModalBackdrop'
import {
  buildCommandPaletteItems,
  getShortcutPlatform,
  SECTION_ORDER,
  type PaletteItem,
  type RuntimeCommand,
  type View,
} from './command-palette-items'

interface CommandPaletteProps {
  onClose: () => void
  onNavigate: (view: View) => void
  onCreateThread: (directory?: string) => Promise<SessionInfo | null>
  onEnsureSession: () => Promise<boolean>
  onInsertComposer: (text: string) => void
  onSetAgentMode: (mode: PrimaryAgentMode) => void
  onStartAgentChat: (agentName: string, directory?: string | null) => Promise<void> | void
  onOpenSettings: () => void
  onToggleSearch: () => void
}

export function CommandPalette({
  onClose,
  onNavigate,
  onCreateThread,
  onEnsureSession,
  onInsertComposer,
  onSetAgentMode,
  onStartAgentChat,
  onOpenSettings,
  onToggleSearch,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [commands, setCommands] = useState<RuntimeCommand[]>([])
  const [builtinAgents, setBuiltinAgents] = useState<BuiltInAgentDetail[]>([])
  const [customAgents, setCustomAgents] = useState<CustomAgentSummary[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = 'command-palette-results'
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const setSessionPrimaryAgent = useSessionStore((s) => s.setSessionPrimaryAgent)

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )

  useEffect(() => {
    inputRef.current?.focus()

    const contextOptions = currentProjectDirectory ? { directory: currentProjectDirectory } : undefined
    void Promise.all([
      window.coworkApi.command.list().catch(() => [] as RuntimeCommand[]),
      window.coworkApi.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
      window.coworkApi.agents.list(contextOptions).catch(() => [] as CustomAgentSummary[]),
    ]).then(([runtimeCommands, runtimeBuiltinAgents, runtimeCustomAgents]) => {
      setCommands(runtimeCommands || [])
      setBuiltinAgents(runtimeBuiltinAgents || [])
      setCustomAgents(runtimeCustomAgents || [])
    })
  }, [currentProjectDirectory])

  const items = useMemo<PaletteItem[]>(() => {
    return buildCommandPaletteItems({
      commands,
      builtinAgents,
      customAgents,
      currentProjectDirectory,
      platform: getShortcutPlatform(),
      devMode: import.meta.env.DEV,
      onNavigate,
      onCreateThread,
      onEnsureSession,
      onInsertComposer,
      onClearSessionPrimaryAgent: async () => {
        const state = useSessionStore.getState()
        const sessionId = state.currentSessionId
        if (!sessionId) return true
        const previousAgent = state.sessions.find((session) => session.id === sessionId)?.composerAgentName
          || state.sessionPrimaryAgents[sessionId]
          || null
        if (!previousAgent) return true
        setSessionPrimaryAgent(sessionId, null)
        try {
          await window.coworkApi.session.setComposerPreferences(sessionId, { agentName: null })
          return true
        } catch {
          setSessionPrimaryAgent(sessionId, previousAgent)
          useSessionStore.getState().addGlobalError('Could not switch agent mode. Please try again.')
          return false
        }
      },
      onSetAgentMode,
      onStartAgentChat,
      onSelectDirectory: () => window.coworkApi.dialog.selectDirectory(),
      onOpenSettings,
      onToggleSearch,
      onRunCommand: async (name) => {
        const sessionId = useSessionStore.getState().currentSessionId
        if (!sessionId) return false
        return window.coworkApi.command.run(sessionId, name)
      },
    })
  }, [builtinAgents, commands, customAgents, currentProjectDirectory, onCreateThread, onEnsureSession, onInsertComposer, onNavigate, setSessionPrimaryAgent, onSetAgentMode, onStartAgentChat, onOpenSettings, onToggleSearch])

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

  const selectedItem = filteredItems[selected]
  const activeOptionId = selectedItem ? `${listboxId}-option-${selectedItem.id}` : undefined

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
      <ModalBackdrop onDismiss={onClose} className="fixed inset-0 z-50 bg-black/45" />
      <div className="fixed top-[10%] left-1/2 z-50 w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg theme-popover shadow-2xl">
        <div className="border-b border-border-subtle px-3 py-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            type="search"
            role="searchbox"
            leftIcon="search"
            aria-label={t('commandPalette.searchLabel', 'Search command palette')}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            placeholder={t('commandPalette.search', 'Search actions, coworkers, and commands...')}
          />
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label={t('commandPalette.results', 'Command palette results')}
          className="max-h-[520px] overflow-y-auto px-2 py-2"
        >
          {groupedItems.length === 0 && (
            <div className="px-4 py-8">
              <EmptyState
                icon="search"
                title={t('commandPalette.noMatchesTitle', 'No matching actions')}
                body={t('commandPalette.noMatches', 'No matching actions. Try a broader search.')}
              />
            </div>
          )}

          {groupedItems.map((group) => (
            <div key={group.section} role="group" aria-label={group.section} className="mb-2">
              <div className="px-3 py-2 text-2xs font-semibold uppercase tracking-[0.06em] text-text-muted">
                {group.section}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const itemIndex = filteredItems.findIndex((entry) => entry.id === item.id)
                  const isSelected = itemIndex === selected
                  return (
                    <button
                      key={item.id}
                      id={`${listboxId}-option-${item.id}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => void handleSelect(item)}
                      className="ui-popover-item ui-popover-item--two-line"
                    >
                      <span className="ui-popover-item__content">
                        <span className="ui-popover-item__label">
                          <span className="text-sm font-medium text-text">{item.title}</span>
                          <Badge tone={isSelected ? 'accent' : 'muted'}>{item.badge}</Badge>
                        </span>
                        <span className="text-2xs leading-5 text-text-muted">
                          {item.subtitle}
                        </span>
                      </span>
                      {item.hint && (
                        <Kbd className="shrink-0">{item.hint}</Kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-border-subtle px-4 py-2 text-2xs text-text-muted">
          {t('commandPalette.hint', 'Enter to run. Esc to close.')}
        </div>
      </div>
    </>
  )
}
