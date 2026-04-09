import { useSessionStore } from '../../stores/session'

export function NewThreadButton({ onClick }: { onClick?: () => void }) {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)

  const handleNew = async () => {
    try {
      const session = await window.cowork.session.create()
      addSession(session)
      setCurrentSession(session.id)
      clearMessages()
      onClick?.()
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }

  return (
    <button
      onClick={handleNew}
      className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-secondary rounded-lg border border-border-subtle hover:bg-surface-hover hover:text-text transition-colors cursor-pointer"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="6" y1="2" x2="6" y2="10" />
        <line x1="2" y1="6" x2="10" y2="6" />
      </svg>
      New Thread
    </button>
  )
}
