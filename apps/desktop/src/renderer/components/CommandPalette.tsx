import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  SessionInfo,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import {
  buildCommandPaletteItems,
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
      platform: typeof navigator !== 'undefined' ? navigator.platform : '',
      onNavigate,
      onCreateThread,
      onEnsureSession,
      onInsertComposer,
      onSetAgentMode,
      onSelectDirectory: () => window.coworkApi.dialog.selectDirectory(),
      onOpenSettings: () => window.dispatchEvent(new CustomEvent('open-cowork:open-settings')),
      onToggleSearch: () => window.dispatchEvent(new CustomEvent('open-cowork:toggle-search')),
      onRunCommand: async (name) => {
        const sessionId = useSessionStore.getState().currentSessionId
        if (!sessionId) return false
        return window.coworkApi.command.run(sessionId, name)
      },
    })
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
