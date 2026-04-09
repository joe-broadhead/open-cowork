import { useSessionStore } from '../../stores/session'

export function TitleBar() {
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)

  return (
    <div className="drag flex items-center h-[48px] shrink-0 select-none bg-surface border-b border-border-subtle">
      <div className="flex items-center pl-[76px] gap-2">
        <button
          onClick={toggleSidebar}
          className="no-drag flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="11" height="9" rx="1.5" />
            <line x1="5.5" y1="3" x2="5.5" y2="12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 text-center text-[12px] font-medium text-text-muted tracking-wide uppercase">
        Cowork
      </div>
      <div className="w-[100px]" />
    </div>
  )
}
