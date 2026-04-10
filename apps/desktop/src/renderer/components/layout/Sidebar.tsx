import { useState, useEffect } from 'react'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { SettingsPanel } from '../sidebar/SettingsPanel'

interface Props {
  currentView: 'chat' | 'plugins'
  onViewChange: (view: 'chat' | 'plugins') => void
}

export function Sidebar({ currentView, onViewChange }: Props) {
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  // Listen for Cmd+K toggle
  useEffect(() => {
    const handler = () => { setShowSearch(s => !s); setSearchQuery('') }
    window.addEventListener('cowork:toggle-search', handler)
    return () => window.removeEventListener('cowork:toggle-search', handler)
  }, [])

  return (
    <aside className="flex flex-col w-[252px] shrink-0 border-r border-border-subtle glass-panel" style={{ background: 'color-mix(in srgb, var(--color-base) 60%, transparent)' }}>
      {showSettings ? (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      ) : (
        <>
          <div className="p-3 pb-1 flex gap-2">
            <div className="flex-1">
              <NewThreadButton onClick={() => onViewChange('chat')} />
            </div>
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-border-subtle transition-colors cursor-pointer ${showSearch ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              title="Search threads (⌘K)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="6" cy="6" r="4.5" />
                <line x1="9.2" y1="9.2" x2="12" y2="12" />
              </svg>
            </button>
          </div>

          {showSearch && (
            <div className="px-3 pb-1">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
                placeholder="Search threads..."
                className="w-full px-3 py-1.5 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          {/* Plugins */}
          <div className="px-2 pt-2 pb-1">
            <button onClick={() => onViewChange('plugins')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'plugins' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <rect x="1.5" y="1.5" width="4" height="4" rx="1" /><rect x="7.5" y="1.5" width="4" height="4" rx="1" /><rect x="1.5" y="7.5" width="4" height="4" rx="1" /><rect x="7.5" y="7.5" width="4" height="4" rx="1" />
              </svg>
              Plugins
            </button>
          </div>

          {/* Threads */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Threads</div>
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div>

          {/* Connections */}
          <div className="border-t border-border-subtle px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Connections</div>
            <McpStatus />
          </div>

          {/* Settings */}
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer border-t border-border-subtle">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" /><path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.8 2.8L3.9 3.9M10.1 10.1L11.2 11.2M11.2 2.8L10.1 3.9M3.9 10.1L2.8 11.2" />
            </svg>
            Settings
          </button>
        </>
      )}
    </aside>
  )
}
