import { useSessionStore } from '../../stores/session'

export function TitleBar() {
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)

  return (
    <div className="drag flex items-center h-[38px] shrink-0 select-none border-b border-border-subtle">
      <div className="flex items-center pl-[72px] gap-1.5">
        <button
          onClick={toggleSidebar}
          className="no-drag flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="2" y="3" width="10" height="8" rx="1.5" />
            <line x1="5" y1="3" x2="5" y2="11" />
          </svg>
        </button>
      </div>
      <div className="flex-1" />
      <div className="w-[100px]" />
    </div>
  )
}
