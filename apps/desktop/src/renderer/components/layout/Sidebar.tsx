import { useState } from 'react'
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

  return (
    <aside className="flex flex-col w-[260px] shrink-0 bg-surface border-r border-border-subtle">
      {showSettings ? (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      ) : (
        <>
          <div className="p-3 pb-1">
            <NewThreadButton onClick={() => onViewChange('chat')} />
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Threads
            </div>
            <ThreadList onSelect={() => onViewChange('chat')} />
          </div>

          <div className="border-t border-border-subtle px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              Connections
            </div>
            <McpStatus />
          </div>

          {/* Plugins button */}
          <button
            onClick={() => onViewChange('plugins')}
            className={`flex items-center gap-2.5 px-4 py-3 text-[13px] transition-colors cursor-pointer border-t border-border-subtle ${
              currentView === 'plugins' ? 'text-text bg-surface-active' : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" />
              <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" />
              <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" />
              <rect x="8" y="8" width="4.5" height="4.5" rx="1" />
            </svg>
            Plugins
          </button>

          {/* Settings button */}
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer border-t border-border-subtle"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" />
              <path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.8 2.8L3.9 3.9M10.1 10.1L11.2 11.2M11.2 2.8L10.1 3.9M3.9 10.1L2.8 11.2" />
            </svg>
            Settings
          </button>
        </>
      )}
    </aside>
  )
}
