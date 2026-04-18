import { useState, useEffect } from 'react'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { SettingsPanel } from '../sidebar/SettingsPanel'
import { t } from '../../helpers/i18n'

interface Props {
  currentView: 'home' | 'chat' | 'agents' | 'capabilities'
  onViewChange: (view: 'home' | 'chat' | 'agents' | 'capabilities') => void
}

export function Sidebar({ currentView, onViewChange }: Props) {
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  // Listen for Cmd+K toggle
  useEffect(() => {
    const handler = () => { setShowSearch(s => !s); setSearchQuery('') }
    window.addEventListener('open-cowork:toggle-search', handler)
    return () => window.removeEventListener('open-cowork:toggle-search', handler)
  }, [])

  useEffect(() => {
    const handler = () => setShowSettings(true)
    window.addEventListener('open-cowork:open-settings', handler)
    return () => window.removeEventListener('open-cowork:open-settings', handler)
  }, [])

  return (
    <aside
      className={`flex flex-col shrink-0 border-r border-border-subtle transition-[width] duration-200 ${showSettings ? 'w-[640px]' : 'w-[252px]'}`}
      style={{ background: 'color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%)' }}
    >
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
              title={t('sidebar.searchTitle', 'Search threads (⌘K)')}
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
                placeholder={t('sidebar.search', 'Search threads...')}
                className="w-full px-3 py-1.5 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          <div className="px-2 pt-2 pb-1">
            <button onClick={() => onViewChange('home')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'home' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5.5 6.5 2 11 5.5V11a.75.75 0 0 1-.75.75H2.75A.75.75 0 0 1 2 11V5.5Z" />
                <path d="M5 11.75V8h3v3.75" />
              </svg>
              {t('sidebar.home', 'Home')}
            </button>
            <button onClick={() => onViewChange('agents')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'agents' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="4" r="1.5" />
                <circle cx="9" cy="4" r="1.5" />
                <path d="M1.8 10.8C2.2 9.4 3.3 8.5 4.6 8.5H5.3C6.7 8.5 7.8 9.4 8.2 10.8" />
                <path d="M7.5 10.8C7.8 9.9 8.5 9.3 9.4 9.3H9.8C10.8 9.3 11.5 9.9 11.8 10.8" />
              </svg>
              {t('sidebar.agents', 'Agents')}
            </button>
            <button onClick={() => onViewChange('capabilities')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'capabilities' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="3.25" cy="3.25" r="1.25" />
                <circle cx="9.75" cy="3.25" r="1.25" />
                <circle cx="6.5" cy="9.75" r="1.25" />
                <path d="M4.5 3.25H8.5" />
                <path d="M4 4.2 5.8 8.7" />
                <path d="M9 4.2 7.2 8.7" />
              </svg>
              {t('sidebar.capabilities', 'Capabilities')}
            </button>
          </div>

          {/* Threads — ThreadList owns its own scroll container so it
              can virtualize rows without fighting the parent over the
              scroll element reference. */}
          <div className="flex-1 min-h-0 flex flex-col px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.threads', 'Threads')}</div>
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div>

          {/* Connections */}
          <div className="border-t border-border-subtle px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.connections', 'Connections')}</div>
            <McpStatus />
          </div>

          {/* Settings */}
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer border-t border-border-subtle">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" /><path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.8 2.8L3.9 3.9M10.1 10.1L11.2 11.2M11.2 2.8L10.1 3.9M3.9 10.1L2.8 11.2" />
            </svg>
            {t('sidebar.settings', 'Settings')}
          </button>
        </>
      )}
    </aside>
  )
}
