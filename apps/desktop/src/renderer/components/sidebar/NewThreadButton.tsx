import { useState } from 'react'
import { useSessionStore } from '../../stores/session'

export function NewThreadButton({ onClick }: { onClick?: () => void }) {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const [showMenu, setShowMenu] = useState(false)

  const createThread = async (directory?: string) => {
    try {
      const session = await window.openCowork.session.create(directory)
      addSession(session)
      setCurrentSession(session.id)
      onClick?.()
    } catch (err) {
      console.error('Failed to create session:', err)
    }
    setShowMenu(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-secondary rounded-lg border border-border-subtle hover:bg-surface-hover hover:text-text transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="6" y1="2" x2="6" y2="10" />
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
        New Thread
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border shadow-xl overflow-hidden"
            style={{ background: '#1a1a1a', borderColor: 'var(--color-border)' }}>
            <button
              onClick={() => createThread()}
              className="w-full text-left px-3 py-2.5 text-[12px] text-text hover:bg-surface-hover cursor-pointer transition-colors flex items-center gap-2.5"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-text-muted">
                <circle cx="7" cy="7" r="5" />
                <path d="M7 4.5v5M4.5 7h5" />
              </svg>
              <div>
                <div className="font-medium">Sandbox</div>
                <div className="text-[10px] text-text-muted mt-px">Data analysis, email, docs — no local files</div>
              </div>
            </button>
            <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
            <button
              onClick={async () => {
                const dir = await window.openCowork.dialog.selectDirectory()
                if (dir) createThread(dir)
                else setShowMenu(false)
              }}
              className="w-full text-left px-3 py-2.5 text-[12px] text-text hover:bg-surface-hover cursor-pointer transition-colors flex items-center gap-2.5"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                <path d="M2 3.5C2 2.67 2.67 2 3.5 2H5.5L7 3.5H10.5C11.33 3.5 12 4.17 12 5V10.5C12 11.33 11.33 12 10.5 12H3.5C2.67 12 2 11.33 2 10.5V3.5Z" />
              </svg>
              <div>
                <div className="font-medium">Open Project</div>
                <div className="text-[10px] text-text-muted mt-px">Choose a directory — agent can read and edit files</div>
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
