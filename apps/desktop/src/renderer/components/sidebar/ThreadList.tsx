import { useSessionStore } from '../../stores/session'

export function ThreadList() {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)

  if (sessions.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-text-muted text-center">
        No threads yet
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-px">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId
        return (
          <button
            key={session.id}
            onClick={() => {
              setCurrentSession(session.id)
              clearMessages()
            }}
            className={`w-full text-left px-3 py-[7px] rounded-md text-[13px] truncate transition-colors cursor-pointer ${
              isActive
                ? 'bg-surface-active text-text'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text'
            }`}
          >
            {session.title || `Thread ${session.id.slice(0, 6)}`}
          </button>
        )
      })}
    </div>
  )
}
